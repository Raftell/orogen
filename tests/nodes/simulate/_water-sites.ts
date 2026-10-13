// tests/nodes/simulate/_water-sites.ts
// The rivers of a terrain as simulate/rivers hands them to its kernels: the router task and the course task, run
// in this thread, and the sites read back out of the planes the course task writes. Nothing here touches the GPU.
import { mixSeed } from '../../../src/core/api.ts';
import { route, routeEps } from '../../../src/core/nodes/simulate/_route.ts';
import { RIVER_WIDTH_EXPONENT } from '../../../src/core/nodes/simulate/_water-constants.ts';
import { course, NO_LINK, PLACE_STEPS, RISE_STEPS } from '../../../src/core/nodes/simulate/_water-course.ts';

/** The test settings: 4096 m across, 1024 m of height range, project seed 1. */
export const T = 4096, R = 1024, PROJECT_SEED = 1;

export interface RiverParams {
  readonly catchment: number;
  readonly valleyDepth: number;
  readonly riverWidth: number;
  readonly riverDepth: number;
  readonly bank: number;       // degrees
  readonly seed: number;
}
/** The defaults of simulate/rivers. */
export const RIVER_DEFAULTS: RiverParams = { catchment: 0.001, valleyDepth: 0.1, riverWidth: 0.05, riverDepth: 0.03, bank: 30, seed: 0 };

export interface Site {
  readonly texel: number;      // the texel the site lies in
  readonly x: number;          // where it lies, in texels
  readonly y: number;
  readonly level: number;      // the river's water level, normalised
  readonly share: number;      // the share a river of its width drains; below 0 for a site no texel may take
  readonly width: number;      // metres
  readonly rise: number;       // metres: how far the river lies below the routing surface
  readonly down: number;       // the texel of the next site down the river, or -1
  readonly up: number;         // the texel of the next site up it, or -1
}

export interface Rivers {
  readonly res: number;
  readonly cell: number;                 // metres between two texels
  readonly filled: Float32Array;         // the routing surface
  readonly area: Float32Array;           // the share that drains through each texel
  readonly receivers: Uint8Array;
  readonly sites: ReadonlyMap<number, Site>;
  readonly deepest: number;              // metres
}

/** The texel a link leads to from `texel`, or -1. */
function linked(texel: number, code: number, res: number): number {
  return code === NO_LINK ? -1 : texel + ((code % 3) - 1) + res * (Math.floor(code / 3) - 1);
}

/** The rivers of `height`, a res × res terrain, with the test settings. `weight` is the headwaters, saturated. */
export function riversOf(height: Float32Array, res: number, seaLevel: number, given: Partial<RiverParams> = {}, weight?: Float32Array): Rivers {
  const params = { ...RIVER_DEFAULTS, ...given };
  const cell = T / (res - 1);
  const routed = route.run({
    height: height.slice(), res, eps: routeEps(R), seaLevel, routing: 'single', seed: mixSeed(mixSeed(PROJECT_SEED, params.seed), 0), weight, receivers: true,
  }, { progress() {} });
  const filled = routed.filled.slice(), area = routed.area!.slice(), receivers = routed.receivers!.slice();
  const width = params.riverWidth * T;
  const result = course.run({
    height: height.slice(), filled: routed.filled, area: routed.area!, receivers: routed.receivers!, res, seaLevel,
    catchment: params.catchment, cell, range: R, width, depth: params.riverDepth * R, valley: params.valleyDepth * R,
    bank: Math.tan((params.bank * Math.PI) / 180),
  }, { progress() {} });
  const sites = new Map<number, Site>();
  for (let i = 0; i < res * res; i++) {
    const share = result.share[i]!;
    if (share === 0) continue;
    const place = result.place[i]!, links = result.course[i]!;
    sites.set(i, {
      texel: i,
      x: (i % res) + (place % PLACE_STEPS) / (PLACE_STEPS - 1) - 0.5,
      y: Math.floor(i / res) + Math.floor(place / PLACE_STEPS) / (PLACE_STEPS - 1) - 0.5,
      level: result.level[i]!,
      share,
      width: width * Math.abs(share) ** RIVER_WIDTH_EXPONENT,
      rise: (Math.floor(links / 81) / (RISE_STEPS - 1)) * result.deepest,
      down: linked(i, links % 9, res),
      up: linked(i, Math.floor(links / 9) % 9, res),
    });
  }
  return { res, cell, filled, area, receivers, sites, deepest: result.deepest };
}
