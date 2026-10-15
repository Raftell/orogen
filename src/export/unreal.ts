// The Unreal Engine arithmetic of export-unreal.md section 5: the single implementation of each formula, which
// the pipeline, the manifest writer and the acceptance pattern call. Pure: no Node module, no GPU, no I/O.
//
// Every statement about Unreal behind these formulas carries its mark in the contract; the ones marked [U] are
// unverified, and those marked [T] were seen in the acceptance test's run on Unreal Engine 5.8 (export-unreal.md
// section 11, 9.4).

import { hashCell, hashU32, hashUnit } from '../core/api.ts';
import type { HeightRange, LandscapeLayout } from '../core/runtime.ts';

// ---- 5.2 valid sizes and component layouts ---------------------------------------------------------------------

const QUADS_PER_SECTION = [255, 127, 63, 31, 15, 7] as const;
const SECTIONS_PER_COMPONENT = [2, 1] as const;
const COMPONENTS_MAX = 32;

/** The layout whose vertex count is exactly n with the fewest components, or null. */
export function landscapeLayout(n: number): LandscapeLayout | null {
  let best: LandscapeLayout | null = null;
  for (const q of QUADS_PER_SECTION) {
    for (const s of SECTIONS_PER_COMPONENT) {
      if ((n - 1) % (q * s) !== 0) continue;
      const c = (n - 1) / (q * s);
      if (c < 1 || c > COMPONENTS_MAX) continue;
      if (best === null || c * c < best.totalComponents) {
        best = { quadsPerSection: q, sectionsPerComponent: s, components: c, totalComponents: c * c };
      }
    }
  }
  return best;
}

/**
 * The landscape sizes nearest to `n` that are build resolutions as well (engine.md 1.5): the largest below it and
 * the smallest above it, null where there is none.
 */
export function nearestLandscapeSizes(n: number): { readonly below: number | null; readonly above: number | null } {
  let below: number | null = null, above: number | null = null;
  for (const q of QUADS_PER_SECTION) {
    for (const s of SECTIONS_PER_COMPONENT) {
      for (let c = 1; c <= COMPONENTS_MAX; c++) {
        const size = c * q * s + 1;
        if (size < 129 || size > 8192 || (size - 1) % 16 !== 0) continue;
        if (size < n && (below === null || size > below)) below = size;
        if (size > n && (above === null || size < above)) above = size;
      }
    }
  }
  return { below, above };
}

// ---- 5.4 quantising heights --------------------------------------------------------------------------------------

/** min and max are the measured field minimum and maximum (Engine.stats). heightRange in metres. */
export function heightMapping(range: HeightRange, min: number, max: number, heightRange: number): { a: number; b: number; widened: boolean } {
  let a: number, b: number;
  if (range.mode === 'fixed') { a = range.min; b = range.max; }
  else { const r = max - min; a = min - range.headroom * r; b = max + range.headroom * r; }
  const least = 1 / heightRange;                 // 1 metre, as a normalised height
  if (b - a >= least) return { a, b, widened: false };
  const mid = (a + b) / 2;
  return { a: mid - least / 2, b: mid + least / 2, widened: true };
}

export const DITHER_SEED = 0x4f524f47;

/**
 * Converts one band. src holds rows y0, y0 + 1, ... of a field `width` wide.
 * Returns the number of samples outside [a, b].
 */
export function quantiseHeights(src: Float32Array, dst: Uint16Array, o: { width: number; y0: number; a: number; b: number; dither: boolean }): number {
  const k = 65535 / (o.b - o.a);
  let clipped = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v < o.a || v > o.b) clipped++;
    let q = (v - o.a) * k + 0.5;
    if (o.dither) {
      const h = hashCell(i % o.width, o.y0 + Math.floor(i / o.width), DITHER_SEED);
      q += hashUnit(h) + hashUnit(hashU32(h)) - 1;        // triangular, in (-1, 1)
    }
    dst[i] = q <= 0 ? 0 : q >= 65535 ? 65535 : Math.floor(q);
  }
  return clipped;
}

// ---- 5.5 scale and placement -------------------------------------------------------------------------------------

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }
export interface LandscapeTransform {
  readonly scaleCm: Vec3;             // the actor's scale
  readonly actorLocationCm: Vec3;     // the actor's location: vertex (0, 0) at code 32768
  readonly uiLocationCm: Vec3;        // the terrain's centre in X and Y, the actor's Z
  readonly heightMinM: number;        // world Z of code 0, in metres
  readonly heightMaxM: number;        // world Z of code 65535, in metres
  readonly seaLevelZCm: number;       // world Z of the project's sea level
}

/** The name the manifest gives the Z scale formula below. */
export const Z_SCALE_FORMULA = 'range_cm*128/65535';

export function landscapeTransform(o: {
  resolution: number; terrainSize: number; heightRange: number; seaLevel: number;
  a: number; b: number; zeroAt: 'seaLevel' | 'bottom'; origin: 'center' | 'corner';
}): LandscapeTransform {
  const extentCm = o.terrainSize * 100;
  const scaleXY = extentCm / (o.resolution - 1);          // never by the resolution itself
  const rangeCm = (o.b - o.a) * o.heightRange * 100;
  const scaleZ = rangeCm * 128 / 65535;
  const z0 = o.zeroAt === 'seaLevel' ? o.seaLevel : 0;
  const hMinCm = (o.a - z0) * o.heightRange * 100;
  const actorZ = hMinCm + 256 * scaleZ;
  const actorXY = o.origin === 'center' ? -extentCm / 2 : 0;
  return {
    scaleCm: { x: scaleXY, y: scaleXY, z: scaleZ },
    actorLocationCm: { x: actorXY, y: actorXY, z: actorZ },
    uiLocationCm: { x: actorXY + extentCm / 2, y: actorXY + extentCm / 2, z: actorZ },
    heightMinM: hMinCm / 100,
    heightMaxM: (hMinCm + rangeCm) / 100,
    seaLevelZCm: (o.seaLevel - z0) * o.heightRange * 100,
  };
}

/** 5.3: the world Z, in cm, of a stored code under a transform. */
export function worldZOfCode(code: number, transform: Pick<LandscapeTransform, 'scaleCm' | 'actorLocationCm'>): number {
  return transform.actorLocationCm.z + (code - 32768) / 128 * transform.scaleCm.z;
}

// ---- 5.8 weight layers -------------------------------------------------------------------------------------------

/**
 * Quantises texels offset .. offset + count - 1 of every plane.
 * floorCode = floor(layerFloor * 65535 + 0.5); limit = layerLimit.
 */
export function quantiseWeights(
  planes: readonly Uint16Array[], out: readonly Uint8Array[],
  o: { offset: number; count: number; floorCode: number; limit: number },
): void {
  const L = planes.length, T = 65535;
  const e = new Array<number>(L + 1), w = new Array<number>(L + 1), r = new Array<number>(L + 1);
  for (let t = 0; t < o.count; t++) {
    // 1. Floor, then the base takes what is left of a full weight.
    let s = 0;
    for (let i = 0; i < L; i++) {
      const p = planes[i][o.offset + t];
      e[i + 1] = p >= o.floorCode ? p : 0;
      s += e[i + 1];
    }
    e[0] = Math.max(0, T - s);
    // 2. Keep at most `limit` entries: drop the smallest; among equals the higher index goes first.
    if (o.limit > 0) {
      let kept = 0;
      for (let j = 0; j <= L; j++) if (e[j] > 0) kept++;
      for (; kept > o.limit; kept--) {
        let m = -1;
        for (let j = 0; j <= L; j++) if (e[j] > 0 && (m < 0 || e[j] <= e[m])) m = j;
        e[m] = 0;
      }
    }
    // 3. Largest remainder: floors, then one more unit to the largest remainders; ties to the lower index.
    let total = 0;
    for (let j = 0; j <= L; j++) total += e[j];
    let sum = 0;
    for (let j = 0; j <= L; j++) {
      const p = 255 * e[j];
      w[j] = Math.floor(p / total);
      r[j] = p - w[j] * total;
      sum += w[j];
    }
    for (let missing = 255 - sum; missing > 0; missing--) {
      let m = 0;
      for (let j = 1; j <= L; j++) if (r[j] > r[m]) m = j;
      w[m]++;
      r[m] = -1;
    }
    for (let j = 0; j <= L; j++) out[j][t] = w[j];
  }
}

/** The floor code of quantiseWeights for a landscape item's layerFloor. */
export function weightFloorCode(layerFloor: number): number {
  return Math.floor(layerFloor * 65535 + 0.5);
}

// ---- 5.9 companion textures --------------------------------------------------------------------------------------

/** SRGB8[i] is the 8-bit sRGB code of the linear value i / 65535. */
export const SRGB8 = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  const c = i / 65535;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB8[i] = Math.floor(s * 255 + 0.5);
}

export type TextureSide = 1024 | 2048 | 4096 | 8192;

/** 2.2: the side of a texture in texels. 'auto' is the smallest power of two that is at least resolution − 1, limited to 1024..8192. */
export function textureSide(size: 'auto' | TextureSide, resolution: number): TextureSide {
  if (size !== 'auto') return size;
  for (const side of [1024, 2048, 4096] as const) if (side >= resolution - 1) return side;
  return 8192;
}
