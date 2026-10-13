// tests/nodes/filter/_reference.ts
// What the tests of the filter nodes compare with: the same operations on the CPU, in float64.
import { at, fieldOf, stats, type FieldData } from '../../helpers/index.ts';

/** `fn` at every texel of a new field of the size of `like`. */
export function mapField(like: FieldData, fn: (x: number, y: number) => number): FieldData {
  const n = like.width;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = fn(x, y);
  return { kind: 'field', width: n, height: n, channels: 1, data };
}

/** The value range of a field. */
export const range = (f: FieldData): number => stats(f).max - stats(f).min;

/** Texel (x, y) with both indices clamped to the field: what a kernel reads beyond the border. */
export function clamped(f: FieldData, x: number, y: number, channel = 0): number {
  const n = f.width;
  return at(f, Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y)), channel);
}

/** The texels farther than `margin` from every border. */
export function inner(f: FieldData, margin: number): FieldData {
  const size = f.width - 2 * margin;
  const data = new Float32Array(size * size * f.channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < f.channels; c++) data[(y * size + x) * f.channels + c] = at(f, x + margin, y + margin, c);
    }
  }
  return { ...f, width: size, height: size, data };
}

/**
 * The Gaussian of `sigma` texels: weights beyond 3 sigma are dropped and the rest renormalised, reads beyond the
 * border take the border texel; rows first, then columns.
 */
export function gaussian(src: FieldData, sigma: number): FieldData {
  const n = src.width;
  const taps = Math.floor(3 * sigma);
  const weights = Array.from({ length: taps + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = weights.reduce((sum, w, i) => sum + (i === 0 ? w : 2 * w), 0);
  const inside = (i: number): number => Math.min(n - 1, Math.max(0, i));
  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let i = -taps; i <= taps; i++) sum += weights[Math.abs(i)]! * src.data[y * n + inside(x + i)]!;
      rows[y * n + x] = sum / total;
    }
  }
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let i = -taps; i <= taps; i++) sum += weights[Math.abs(i)]! * rows[inside(y + i) * n + x]!;
      data[y * n + x] = sum / total;
    }
  }
  return { ...src, data };
}

/** The bilinear value at the fractional texel position (x, y), clamped to the field. */
export function bilinearAt(f: FieldData, x: number, y: number, channel = 0): number {
  const n = f.width;
  const cx = Math.min(n - 1, Math.max(0, x)), cy = Math.min(n - 1, Math.max(0, y));
  const ix = Math.floor(cx), iy = Math.floor(cy);
  const fx = cx - ix, fy = cy - iy;
  const top = clamped(f, ix, iy, channel) * (1 - fx) + clamped(f, ix + 1, iy, channel) * fx;
  const bottom = clamped(f, ix, iy + 1, channel) * (1 - fx) + clamped(f, ix + 1, iy + 1, channel) * fx;
  return top * (1 - fy) + bottom * fy;
}

export type Edge = 'clamp' | 'mirror' | 'repeat' | 'constant';

/** Index `i` of an axis with texels 0..last under an edge rule; null: outside, under `constant`. */
function edgeIndex(i: number, last: number, edge: Edge): number | null {
  if (i >= 0 && i <= last) return i;
  if (edge === 'constant') return null;
  if (edge === 'mirror') {
    const period = 2 * last;
    const m = ((i % period) + period) % period;
    return m > last ? period - m : m;
  }
  if (edge === 'repeat') return ((i % last) + last) % last;
  return Math.min(last, Math.max(0, i));
}

const catmullRom = (f: number): readonly number[] => [
  -0.5 * f ** 3 + f ** 2 - 0.5 * f, 1.5 * f ** 3 - 2.5 * f ** 2 + 1, -1.5 * f ** 3 + 2 * f ** 2 + 0.5 * f, 0.5 * f ** 3 - 0.5 * f ** 2,
];

/**
 * What the resampling filters read at the fractional texel position (x, y): the Catmull-Rom cubic through the
 * 4 x 4 texels around it, limited to the range of the 2 x 2 texels it lies between.
 */
export function cubicAt(f: FieldData, x: number, y: number, edge: Edge = 'clamp', fill = 0, channel = 0): number {
  const last = f.width - 1;
  const bx = Math.floor(x), by = Math.floor(y);
  const wx = catmullRom(x - bx), wy = catmullRom(y - by);
  const tap = (i: number, j: number): number => {
    const ix = edgeIndex(bx + i, last, edge), iy = edgeIndex(by + j, last, edge);
    return ix === null || iy === null ? fill : at(f, ix, iy, channel);
  };
  let sum = 0, lo = Infinity, hi = -Infinity;
  for (let j = -1; j <= 2; j++) {
    for (let i = -1; i <= 2; i++) {
      const v = tap(i, j);
      sum += wx[i + 1]! * wy[j + 1]! * v;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  return Math.min(hi, Math.max(lo, sum));
}

/** A field resampled by `cubicAt` at the position `source(x, y)` gives for each of its texels. */
export function resampled(f: FieldData, source: (x: number, y: number) => readonly [number, number], edge: Edge = 'clamp', fill = 0): FieldData {
  return mapField(f, (x, y) => {
    const [sx, sy] = source(x, y);
    return cubicAt(f, sx, sy, edge, fill);
  });
}

/**
 * A mountain: one peak with spurs and gullies running down from it, on a floor, 0..1. Unlike the fixtures of the
 * harness it has a fall line to follow and creases across it, which is what the slope-driven filters work on.
 */
export function mountain(res: number): FieldData {
  return fieldOf(res, (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const spurs = 0.5 + 0.5 * Math.cos(7 * angle + 9 * r);
    const cone = Math.max(0, 1 - r / 0.48);
    return cone ** 1.4 * (0.72 + 0.28 * spurs) + 0.02 * Math.sin(40 * u) * Math.sin(37 * v) * cone;
  });
}

/** The standard deviation of the second difference along x and along y: how rough a field is at the scale of a texel. */
export function roughness(f: FieldData): number {
  const n = f.width;
  let sum = 0, count = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const c = at(f, x, y);
      sum += (at(f, x - 1, y) - 2 * c + at(f, x + 1, y)) ** 2 + (at(f, x, y - 1) - 2 * c + at(f, x, y + 1)) ** 2;
      count += 2;
    }
  }
  return Math.sqrt(sum / count);
}

// ---- the slope-driven filters ----------------------------------------------------------------------------------------

/** The test settings of the harness: metres across the terrain and metres of the height range. */
const TERRAIN_SIZE = 4096;
const HEIGHT_RANGE = 1024;
/** Below this slope, in metres per metre, ground counts as level. */
const GENTLE = 0.15;

/** A physical gradient as a step uphill whose length grows from 0 on level ground towards 1 on steep ground. */
function softStep(gx: number, gy: number): readonly [number, number] {
  const scale = 1 / Math.sqrt(gx * gx + gy * gy + GENTLE * GENTLE);
  return [gx * scale, gy * scale];
}

/** The physical gradient at texel (x, y), in metres per metre: central differences, one-sided at the border, as slopeAt of the standard library. */
export function slopeAt(f: FieldData, x: number, y: number): readonly [number, number] {
  const last = f.width - 1;
  const cell = TERRAIN_SIZE / last;
  const x0 = Math.max(x - 1, 0), x1 = Math.min(x + 1, last), y0 = Math.max(y - 1, 0), y1 = Math.min(y + 1, last);
  return [
    ((at(f, x1, y) - at(f, x0, y)) * HEIGHT_RANGE) / (Math.max(x1 - x0, 1) * cell),
    ((at(f, x, y1) - at(f, x, y0)) * HEIGHT_RANGE) / (Math.max(y1 - y0, 1) * cell),
  ];
}

/** The step at texel (x, y). */
export function stepAt(f: FieldData, x: number, y: number): readonly [number, number] {
  return softStep(...slopeAt(f, x, y));
}

/** A physical gradient as a push: itself up to 45 degrees, and of length 1 beyond. */
function capped(gx: number, gy: number): readonly [number, number] {
  const scale = 1 / Math.max(Math.hypot(gx, gy), 1);
  return [gx * scale, gy * scale];
}

/** The push at texel (x, y). */
export function pushAt(f: FieldData, x: number, y: number): readonly [number, number] {
  return capped(...slopeAt(f, x, y));
}

/** The physical gradient at the fractional position (x, y): that of the bilinear surface through the four texels around it. */
function slopeBetween(f: FieldData, x: number, y: number): readonly [number, number] {
  const last = f.width - 1;
  const cx = Math.min(last, Math.max(0, x)), cy = Math.min(last, Math.max(0, y));
  const ix = Math.min(Math.floor(cx), last - 1), iy = Math.min(Math.floor(cy), last - 1);
  const fx = cx - ix, fy = cy - iy;
  const h00 = at(f, ix, iy), h10 = at(f, ix + 1, iy), h01 = at(f, ix, iy + 1), h11 = at(f, ix + 1, iy + 1);
  const scale = HEIGHT_RANGE / (TERRAIN_SIZE / last);
  return [((h10 - h00) * (1 - fy) + (h11 - h01) * fy) * scale, ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * scale];
}

/**
 * The place reached from texel (x, y) by `steps` equal steps up the slope of `guide`, each as long as the push
 * there, `reach` texels in all on ground of 45 degrees or more: the first by the slope at the texel, the others
 * by the slope between texels.
 */
export function pathEnd(guide: FieldData, x: number, y: number, reach: number, steps: number): readonly [number, number] {
  const last = guide.width - 1;
  let p: readonly [number, number] = [x, y];
  let pace = pushAt(guide, x, y);
  for (let i = 0; i < steps; i++) {
    p = [Math.min(last, Math.max(0, p[0] + (reach / steps) * pace[0])), Math.min(last, Math.max(0, p[1] + (reach / steps) * pace[1]))];
    pace = capped(...slopeBetween(guide, p[0], p[1]));
  }
  return p;
}

/** The step at the fractional position (x, y). */
export function stepBetween(f: FieldData, x: number, y: number): readonly [number, number] {
  return softStep(...slopeBetween(f, x, y));
}

/** How long a step is on ground of the given physical slope, in metres per metre. */
export const stepLength = (slope: number): number => slope / Math.hypot(slope, GENTLE);
