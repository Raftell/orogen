// What a picture of the renderer is measured by in look.test.ts: scenes with one thing to judge in each, and the
// number that judges it. Not a test file. Each function takes a rig and leaves it as it found it, but for the
// document, the camera and the display it set.

import type { CameraState, GraphDoc } from '../../../src/core/runtime.ts';
import { project, viewOf } from '../../../src/viewport/camera.ts';
import type { DisplayOptions } from '../../../src/viewport/index.ts';
import { makeDoc, readField, sample, SIZE, type Picture, type ViewRig } from './rig.ts';

export const SUN: DisplayOptions = { verticalScale: 1, showSea: true, sunAzimuth: 195, sunElevation: 38 };
/** As the picture's light is weighed: 0.2126 R + 0.7152 G + 0.0722 B, of the display's values. */
export const grey = (rgb: readonly number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

function at(picture: Picture, x: number, y: number): readonly [number, number, number] {
  const px = Math.min(picture.width - 1, Math.max(0, Math.round(x))), py = Math.min(picture.height - 1, Math.max(0, Math.round(y)));
  const i = (py * picture.width + px) * 4;
  return [picture.rgba[i]!, picture.rgba[i + 1]!, picture.rgba[i + 2]!];
}

const mean = (colours: readonly (readonly number[])[]): [number, number, number] => {
  const sum = [0, 0, 0];
  for (const c of colours) for (let k = 0; k < 3; k++) sum[k]! += c[k]!;
  return [sum[0]! / Math.max(1, colours.length), sum[1]! / Math.max(1, colours.length), sum[2]! / Math.max(1, colours.length)];
};

// ---- a ridge one texel sharp, from near --------------------------------------------------------------------------------

/**
 * A tent across the terrain, a metre a texel, that rises along `angle`: its crest runs across that direction
 * through the middle. At 135 degrees the crest lies on the texels of one diagonal of the grid, each touching the
 * next by a corner, and the two triangles of every quad along it fold down between them: the notches of a
 * sawtooth, whichever way a quad is cut by the mesh's alternating diagonals.
 */
export const ridge = (angle: number): GraphDoc => makeDoc(
  { ridge: { type: 'generate/gradient', params: { mode: 'mirrored', angle, size: 0.25 } } },
  { height: { node: 'ridge', port: 'out' } }, { terrainSize: 252, heightRange: 40, buildResolution: 1009, previewLevel: 2, seaLevel: 0 },
);
/** From fourteen metres, level with the crest and square to it: the crest is the skyline, straight across the picture. */
export const ridgeCamera = (angle: number): CameraState => ({ kind: 'orbit', target: [126, 126, 40], yaw: angle, pitch: 0, distance: 14, fovY: 35 });

/**
 * How far the skyline of the ridge is from a straight line, in pixels (root mean square over the middle of the
 * picture), and how many columns have one. The crest of the field is a straight line; where the bilinear patches
 * between its texels sag, they do by 0.45 m, which from here is some fifty pixels.
 */
export async function crestJaggedness(rig: ViewRig, angle = 135): Promise<{ readonly jagged: number; readonly columns: number; readonly picture: Picture }> {
  rig.setDisplay({ ...SUN, showSea: false, shading: 'clay', sunAzimuth: angle + 180, sunElevation: 40 });
  rig.setCamera(ridgeCamera(angle));
  await rig.show(ridge(angle));
  const picture = await rig.picture();
  const xs: number[] = [], ys: number[] = [];
  for (let x = Math.floor(picture.width * 0.15); x < picture.width * 0.85; x++) {
    // The sky is blue and the clay is not: the first row that is not sky.
    let y = 0;
    while (y < picture.height) {
      const [r, , b] = at(picture, x, y);
      if (b < r + 20) break;
      y++;
    }
    if (y === 0 || y >= picture.height) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  if (n < 10) return { jagged: Infinity, columns: n, picture };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const slope = sxy / sxx;
  let squares = 0;
  for (let i = 0; i < n; i++) squares += (ys[i]! - my - slope * (xs[i]! - mx)) ** 2;
  return { jagged: Math.sqrt(squares / n), columns: n, picture };
}

// ---- the sea -----------------------------------------------------------------------------------------------------------

const SEA_LEVEL = 0.25;
export const ISLAND: GraphDoc = makeDoc({ island: { type: 'generate/island' } }, { height: { node: 'island', port: 'out' } },
  { terrainSize: 4032, heightRange: 1008, buildResolution: 1009, previewLevel: 1, seaLevel: SEA_LEVEL });
/** Straight down on the whole island: a point of the terrain is under a pixel that arithmetic finds. */
export const ABOVE: CameraState = { kind: 'orbit', target: [2016, 2016, 0], yaw: 270, pitch: 89.9, distance: 9000, fovY: 35 };

export interface SeaColours {
  /** The mean colour of the water over a bed two to five metres down, and of the same pixels with the sea hidden. */
  readonly shallow: readonly [number, number, number];
  readonly shallowDry: readonly [number, number, number];
  /** Over a bed sixty metres down and more. */
  readonly deep: readonly [number, number, number];
  /** Where the water is under two metres deep, and the land within three metres above it. */
  readonly shore: readonly [number, number, number];
  readonly land: readonly [number, number, number];
  /** How many points each of the five is the mean of: shallow, deep, shore, land. */
  readonly counts: readonly number[];
  readonly picture: Picture;
}

/** The island in clay under the sea, seen from above: the colours of the water by the depth of its bed. */
export async function seaColours(rig: ViewRig): Promise<SeaColours> {
  rig.setCamera(ABOVE);
  rig.setDisplay({ ...SUN, shading: 'clay' });
  await rig.show(ISLAND);
  const wet = await rig.picture();
  rig.setDisplay({ ...SUN, shading: 'clay', showSea: false });
  const dry = await rig.picture();
  rig.setDisplay({ ...SUN, shading: 'clay' });
  const field = await readField(rig.gpu, ISLAND, { node: 'island', port: 'out' }, 505);
  const view = viewOf(ABOVE, SIZE);
  const sets = { shallow: [] as (readonly number[])[], shallowDry: [] as (readonly number[])[], deep: [] as (readonly number[])[], shore: [] as (readonly number[])[], land: [] as (readonly number[])[] };
  const STEPS = 300;
  for (let j = 1; j < STEPS; j++) {
    for (let i = 1; i < STEPS; i++) {
      const u = i / STEPS, v = j / STEPS;
      const depth = (SEA_LEVEL - sample(field, u, v)) * 1008;
      // Where the pixel of this point of the sea's surface is; of the land, its own.
      const z = depth > 0 ? SEA_LEVEL * 1008 : sample(field, u, v) * 1008;
      const p = project(view, SIZE, [u * 4032, v * 4032, z], 4032);
      if (!p) continue;
      if (depth >= 2 && depth <= 5) {
        sets.shallow.push(at(wet, p.x, p.y));
        sets.shallowDry.push(at(dry, p.x, p.y));
      } else if (depth >= 60) sets.deep.push(at(wet, p.x, p.y));
      if (depth > 0 && depth < 2) sets.shore.push(at(wet, p.x, p.y));
      else if (depth < 0 && depth > -3) sets.land.push(at(wet, p.x, p.y));
    }
  }
  return {
    shallow: mean(sets.shallow), shallowDry: mean(sets.shallowDry), deep: mean(sets.deep), shore: mean(sets.shore), land: mean(sets.land),
    counts: [sets.shallow.length, sets.deep.length, sets.shore.length, sets.land.length], picture: wet,
  };
}

/** The open sea in the corner of the island's terrain, seen from above and at a glance, five degrees over the water: the same water. */
export async function seaAtAGlance(rig: ViewRig): Promise<{ readonly above: readonly number[]; readonly glance: readonly number[]; readonly picture: Picture }> {
  rig.setDisplay(SUN);
  await rig.show(ISLAND);
  const spot: [number, number, number] = [0.06 * 4032, 0.06 * 4032, SEA_LEVEL * 1008];
  const look = async (pitch: number): Promise<{ colour: readonly number[]; picture: Picture }> => {
    const camera: CameraState = { kind: 'orbit', target: spot, yaw: 225, pitch, distance: 900, fovY: 35 };
    rig.setCamera(camera);
    const picture = await rig.picture();
    const p = project(viewOf(camera, SIZE), SIZE, spot, 4032)!;
    return { colour: at(picture, p.x, p.y), picture };
  };
  const above = await look(80), glance = await look(5);
  return { above: above.colour, glance: glance.colour, picture: glance.picture };
}

// ---- the table the slab stands on ---------------------------------------------------------------------------------------

/**
 * The ground beside the slab, at the level of its base, from a camera that stands beyond the slab's +Y edge:
 * just behind that edge, which is the side away from a sun that stands towards −Y; just beside the −X edge,
 * which the sun shines along; and four tenths of the terrain's width out, where nothing stands between the
 * ground and the sky.
 */
export async function tableShade(rig: ViewRig): Promise<{ readonly behind: number; readonly beside: number; readonly open: number; readonly picture: Picture }> {
  const camera: CameraState = { kind: 'orbit', target: [2016, 2016, 100], yaw: 300, pitch: 40, distance: 9500, fovY: 35 };
  rig.setDisplay({ ...SUN, showSea: false, sunAzimuth: 270 });
  rig.setCamera(camera);
  await rig.show(ISLAND);
  const picture = await rig.picture();
  const [low] = rig.renderer.state.heightRange ?? [0, 0];
  // The slab reaches 0.035 of the terrain's width below its lowest ground (renderer.ts SLAB).
  const base = low * 1008 - 0.035 * 4032;
  const view = viewOf(camera, SIZE);
  const ground = (x: number, y: number): number => {
    const p = project(view, SIZE, [x, y, base], 4032)!;
    return grey(at(picture, p.x, p.y));
  };
  return { behind: ground(2016, 4032 * 1.012), beside: ground(-4032 * 0.012, 2016), open: ground(2016, 4032 * 1.4), picture };
}

// ---- light, exposure and the colours of level ground ------------------------------------------------------------------

/** Level ground with a colour draped over it, under a sun at 45 degrees, from above: the colour the picture gives it. */
export async function levelGround(rig: ViewRig, colour: readonly [number, number, number] | null, display: Partial<DisplayOptions> = {}): Promise<{ readonly mean: readonly [number, number, number]; readonly spread: number; readonly picture: Picture }> {
  const doc = makeDoc(
    { flat: { type: 'generate/constant', params: { height: 0.5 } }, ...(colour ? { paint: { type: 'color/constant', params: { color: [...colour] } } } : {}) },
    { height: { node: 'flat', port: 'out' }, ...(colour ? { overlay: { ref: { node: 'paint', port: 'out' }, as: 'color' as const, opacity: 1 } } : {}) },
    { terrainSize: 4032, heightRange: 1008, buildResolution: 1009, previewLevel: 1, seaLevel: 0 },
  );
  rig.setCamera({ kind: 'orbit', target: [2016, 2016, 504], yaw: 270, pitch: 89.9, distance: 6000, fovY: 35 });
  rig.setDisplay({ ...SUN, showSea: false, sunElevation: 45, ...display });
  await rig.show(doc);
  const picture = await rig.picture();
  // The middle half of the terrain, which is 4032 m of the 3784 m the picture is high at this distance: all of it ground.
  const colours: (readonly number[])[] = [];
  let lo = 255, hi = 0;
  for (let y = Math.floor(picture.height * 0.3); y < picture.height * 0.7; y += 2) {
    for (let x = Math.floor(picture.width * 0.35); x < picture.width * 0.65; x += 2) {
      const c = at(picture, x, y);
      colours.push(c);
      lo = Math.min(lo, grey(c));
      hi = Math.max(hi, grey(c));
    }
  }
  return { mean: mean(colours), spread: hi - lo, picture };
}
