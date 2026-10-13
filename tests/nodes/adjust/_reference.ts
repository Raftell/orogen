// tests/nodes/adjust/_reference.ts
// What the tests of this category share: inputs that cover the whole value range, values outside 0..1 included,
// and the application of a CPU reference to a field or to the channels of a color.
import { colorOf, fieldOf, type FieldData } from '../../helpers/index.ts';

export const RES = 257;

/** Every value from -1 to 2: a third of the field lies below 0 and a third above 1, which is legal inside a graph. */
export const WIDE = fieldOf(RES, (u, v) => -1 + 3 * (0.75 * u + 0.25 * v));

/** Two fields that together hold every pair of values from -1 to 2: `a` runs along x and `b` along y. */
export const PAIR_A = fieldOf(RES, (u) => -1 + 3 * u);
export const PAIR_B = fieldOf(RES, (_u, v) => -1 + 3 * v);

/**
 * Two fields that together hold every pair of these heights, up to nearly the largest a field holds: `a` in bands
 * along x and `b` along y. Any finite height is legal, and sums, products and differences of these are no floats.
 */
const HUGE_STEPS = [-3e38, -1e30, -1, 0, 0.5, 1, 1e30, 3e38];
const hugeStep = (t: number): number => HUGE_STEPS[Math.min(HUGE_STEPS.length - 1, Math.floor(t * HUGE_STEPS.length))];
export const HUGE_A = fieldOf(RES, (u) => hugeStep(u));
export const HUGE_B = fieldOf(RES, (_u, v) => hugeStep(v));

/**
 * A value a `color` field holds exactly: a multiple of 1/512 below 4 has the 11 significant bits of a half
 * float. A reference computed from such inputs differs from the node by the rounding of its output alone.
 */
export const half = (x: number): number => Math.round(x * 512) / 512;

/** A color whose channels run from -1 to 2 in three directions and whose alpha is not 1 anywhere but one corner. */
export const WIDE_COLOR = colorOf(RES, (u, v) => [half(-1 + 3 * u), half(-1 + 3 * v), half(2 - 1.5 * (u + v)), half(0.25 + 0.375 * (u + v))]);

/** What a value stored in a `color` field may differ by from a float32 computation (testing.md 3.4), for values up to 4. */
export const COLOR_TOL = 2e-3;

/** `fn` of every value of a field; of a color, of its red, green and blue, with the alpha kept. Computed in float64. */
export function mapValues(src: FieldData, fn: (x: number) => number): FieldData {
  const data = new Float32Array(src.data.length);
  for (let i = 0; i < data.length; i++) data[i] = src.channels === 4 && i % 4 === 3 ? src.data[i] : fn(src.data[i]);
  return { ...src, data };
}

/** `fn` of every pair of values of two fields of one kind; of two colors, channel by channel, with the alpha of `a` kept. */
export function zipValues(a: FieldData, b: FieldData, fn: (x: number, y: number, i: number) => number): FieldData {
  if (a.kind !== b.kind || a.width !== b.width || a.height !== b.height) throw new TypeError('zipValues takes two fields of one kind and size');
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.channels === 4 && i % 4 === 3 ? a.data[i] : fn(a.data[i], b.data[i], Math.floor(i / a.channels));
  return { ...a, data };
}

/** The largest and the smallest value of a field. */
export function extremes(f: FieldData): { readonly min: number; readonly max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of f.data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** How many values of a field satisfy `test`. */
export function countValues(f: FieldData, test: (v: number, i: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < f.data.length; i++) if (test(f.data[i], i)) n++;
  return n;
}

/**
 * Throws unless every value of `actual` is within `rel` of the expected one, relative to its magnitude and never
 * to less than 1: for results that grow large, where a float keeps a number of digits and not a number of decimals.
 * `wrap`, when given, is a period per texel: a difference of exactly one period is accepted, as a sawtooth has
 * where the two computations round to different sides of a step.
 */
export function expectRelative(actual: FieldData, expected: FieldData, rel: number, wrap?: (i: number) => number): void {
  if (actual.data.length !== expected.data.length) throw new TypeError('expectRelative takes two fields of one size');
  let worst = 0, at = -1;
  for (let i = 0; i < actual.data.length; i++) {
    let d = Math.abs(actual.data[i] - expected.data[i]);
    if (wrap) d = Math.min(d, Math.abs(d - Math.abs(wrap(i))));
    const error = d / Math.max(1, Math.abs(expected.data[i]));
    if (!(error <= worst)) {
      worst = error;
      at = i;
    }
  }
  if (!(worst <= rel)) {
    throw new Error(`relative difference ${worst} at value ${at}: ${actual.data[at]} vs ${expected.data[at]}; allowed ${rel}`);
  }
}
