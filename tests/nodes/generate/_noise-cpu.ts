// The WGSL library `generateNoise` (src/core/nodes/generate/_noise.ts) written again for the CPU: what the
// tests of the noise generators compare the kernels with. Coordinates are rounded to float32 where the
// library computes them in float32, so that both evaluate a noise at the same place; values are in float64.
import { hashCell, hashUnit, hashU32, mixSeed } from '../../../src/core/api.ts';
import { WARP_STEPS } from '../../../src/core/nodes/generate/_noise.ts';

const f = Math.fround;

export type Vec2 = readonly [number, number];

export const DENSITY = f(0.759835686);
const LIMIT = 1.0e9;
const F2 = f(0.366025404);
const G2 = f(0.211324865);
const X2 = f(0.577350269);
const NORMALISE = f(99.2);

const GRADIENTS: readonly Vec2[] = Array.from({ length: 16 }, (_, k): Vec2 => {
  const angle = ((k + 0.5) * Math.PI) / 8;
  return [f(Math.cos(angle)), f(Math.sin(angle))];
});
const gradientAt = (x: number, y: number, seed: number): Vec2 => GRADIENTS[hashCell(x, y, seed) >>> 28]!;

/** hash_unit2 of the core library. */
export function hashUnit2(h: number): Vec2 {
  return [hashUnit(h), hashUnit(hashU32(h))];
}

/** A point of the triangular lattice that reaches p: its lattice cell, and the vector from it to p. */
export interface Corner { readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }

/** The three lattice points around p, as generateNoise_simplexD finds them: for a kernel that carries something else on the same lattice. */
export function corners(px: number, py: number): readonly [Corner, Corner, Corner] {
  const qx = Math.min(Math.max(px, -LIMIT), LIMIT);
  const qy = Math.min(Math.max(py, -LIMIT), LIMIT);
  const skew = f(f(qx + qy) * F2);
  const cx = Math.floor(f(qx + skew));
  const cy = Math.floor(f(qy + skew));
  const unskew = f(f(cx + cy) * G2);
  const x0 = f(f(qx - cx) + unskew);
  const y0 = f(f(qy - cy) + unskew);
  const ox = x0 > y0 ? 1 : 0;
  const oy = 1 - ox;
  return [
    { cx, cy, x: x0, y: y0 },
    { cx: cx + ox, cy: cy + oy, x: f(f(x0 - ox) + G2), y: f(f(y0 - oy) + G2) },
    { cx: cx + 1, cy: cy + 1, x: f(x0 - X2), y: f(y0 - X2) },
  ];
}

/** generateNoise_simplexD: [value, d/dx, d/dy]. */
export function simplexD(px: number, py: number, seed: number): readonly [number, number, number] {
  let value = 0, dx = 0, dy = 0;
  for (const { cx, cy, x, y } of corners(px, py)) {
    const g = gradientAt(cx, cy, seed);
    const t = Math.max(0.5 - (x * x + y * y), 0);
    const t2 = t * t;
    const t4 = t2 * t2;
    const ramp = g[0] * x + g[1] * y;
    const fall = -8 * t2 * t * ramp;
    value += t4 * ramp;
    dx += t4 * g[0] + fall * x;
    dy += t4 * g[1] + fall * y;
  }
  return [value * NORMALISE, dx * NORMALISE, dy * NORMALISE];
}
export const simplex = (px: number, py: number, seed: number): number => simplexD(px, py, seed)[0];

/** generateNoise_turn and generateNoise_unturn, in float32 as the library computes them. */
export const turn = (p: Vec2): Vec2 => [f(f(f(0.8) * p[0]) - f(f(0.6) * p[1])), f(f(f(0.6) * p[0]) + f(f(0.8) * p[1]))];
export const unturn = (p: Vec2): Vec2 => [f(f(f(0.8) * p[0]) + f(f(0.6) * p[1])), f(f(f(-0.6) * p[0]) + f(f(0.8) * p[1]))];

export const octaveSeed = (seed: number, i: number): number => mixSeed(seed, i);
export function shift(seedOfOctave: number): Vec2 {
  const u = hashUnit2(mixSeed(seedOfOctave, 0xffff));
  return [u[0] * 16, u[1] * 16];
}
/** generateNoise_lattice. `cells` is the float32 the kernel receives. */
export function lattice(uv: Vec2, cells: number): Vec2 {
  const k = f(f(cells) * DENSITY);
  return turn([f(f(uv[0] - 0.5) * k), f(f(uv[1] - 0.5) * k)]);
}

/** generateNoise_soften. */
export function soften(x: number, knee: number, room: number): number {
  const over = (Math.abs(x) - knee) / room;
  if (over <= 0) return x;
  return Math.sign(x) * (knee + (room * over) / Math.sqrt(1 + over * over));
}

/** generateNoise_warp. `cells` and `reach` are the float32 values the kernel receives. */
export function warp(uv: Vec2, cells: number, reach: number, seed: number): Vec2 {
  if (reach === 0) return uv;
  const s = shift(seed);
  let p: Vec2 = uv;
  for (let k = 0; k < WARP_STEPS; k++) {
    const l = lattice(p, cells);
    const d = simplexD(f(l[0] + s[0]), f(l[1] + s[1]), seed);
    const back = unturn([f(d[2]), f(-d[1])]);
    p = [f(p[0] + f(f(reach) * back[0])), f(p[1] + f(f(reach) * back[1]))];
  }
  return p;
}

/** The terrain coordinate of texel i of a grid of `res` vertices, as a kernel receives it. */
export const uvOf = (i: number, res: number): number => f(i / (res - 1));
