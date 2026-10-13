// tests/nodes/simulate/_erosion-rig.ts
// What the tests of the erosion nodes measure on a field: the steepest pair of neighbours, means and differences.
// Everything here is float64 arithmetic on the data of the harness; no value is handed to an assertion whole.

import type { FieldData } from '../../helpers/index.ts';

/** The test settings (testing.md 2.1): the terrain is 4096 m across and height 1 is 1024 m. */
export const T = 4096, R = 1024;
/** Metres between two texels of a field of the test settings. */
export const cellOf = (f: FieldData): number => T / (f.width - 1);

export const meanOf = (f: FieldData): number => {
  let sum = 0;
  for (let i = 0; i < f.data.length; i++) sum += f.data[i]!;
  return sum / f.data.length;
};

/** The mean of |a - b|. */
export const meanChange = (a: FieldData, b: FieldData): number => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
  return sum / a.data.length;
};

/** a + b, a - b and the like, texel by texel, rounded to float32 as a field stores it. */
export const combine = (a: FieldData, b: FieldData, fn: (x: number, y: number) => number): FieldData => {
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = fn(a.data[i]!, b.data[i]!);
  return { ...a, data };
};

/** How many texels `test` holds for. */
export const count = (f: FieldData, test: (v: number, i: number) => boolean): number => {
  let n = 0;
  for (let i = 0; i < f.data.length; i++) if (test(f.data[i]!, i)) n++;
  return n;
};

/**
 * The steepest slope between two N8 neighbours, as a tangent: metres of height over metres of run. With `where`,
 * only pairs of which both texels pass it count.
 */
export function steepestPair(f: FieldData, where?: (i: number) => boolean): number {
  const res = f.width, cell = cellOf(f);
  let steepest = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if (where && !where(i)) continue;
      // Each pair once: the four neighbours ahead.
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const) {
        const qx = x + dx, qy = y + dy;
        if (qx < 0 || qx >= res || qy >= res) continue;
        const q = qy * res + qx;
        if (where && !where(q)) continue;
        const slope = (Math.abs(f.data[i]! - f.data[q]!) * R) / (cell * Math.hypot(dx, dy));
        if (slope > steepest) steepest = slope;
      }
    }
  }
  return steepest;
}

export const tanDeg = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);

/**
 * How far from the centre of the field, in texels, `f` is still above `level` along the direction `degrees`
 * (0 along +x, 90 along +y), read bilinearly in steps of a quarter texel.
 */
export function reach(f: FieldData, degrees: number, level: number): number {
  const centre = (f.width - 1) / 2, angle = (degrees * Math.PI) / 180;
  let last = 0;
  for (let r = 0; r < centre - 1; r += 0.25) {
    const x = centre + r * Math.cos(angle), y = centre + r * Math.sin(angle);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * f.width + x0;
    const v = (f.data[i]! * (1 - fx) + f.data[i + 1]! * fx) * (1 - fy) + (f.data[i + f.width]! * (1 - fx) + f.data[i + f.width + 1]! * fx) * fy;
    if (v > level) last = r;
  }
  return last;
}

/**
 * A plane through 0.5 at the centre that falls at `degrees` of physical slope towards the direction `facing`
 * (in degrees, 0 along +x), as a function for `fieldOf`.
 */
export const planeFacing = (degrees: number, facing: number) => (u: number, v: number): number => {
  const a = (facing * Math.PI) / 180;
  return 0.5 - ((tanDeg(degrees) * T) / R) * ((u - 0.5) * Math.cos(a) + (v - 0.5) * Math.sin(a));
};
