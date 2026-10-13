// tests/nodes/color/_reference.ts
// What the tests of this category share: the tolerance of a stored color, and the definitions a test computes
// its expectations from.
import type { GradientStop } from '../../../src/core/api.ts';
import type { FieldData } from '../../helpers/index.ts';

/** What a value stored in a `color` field may differ by from a float32 computation (testing.md 3.4). */
export const COLOR = 2e-3;

/** With the test settings the terrain is 4096 m wide and a height of 1 is 1024 m. */
export const TERRAIN_SIZE = 4096;
export const HEIGHT_RANGE = 1024;

export const radians = (degrees: number): number => (degrees * Math.PI) / 180;
export const saturate = (v: number): number => Math.min(1, Math.max(0, v));

/** The luma of a linear color, as convert_luma defines it (engine.md 3.9). */
export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A gradient as its definition reads: linear between the neighbouring stops, constant before the first and after the last. */
export function gradientAt(stops: readonly GradientStop[], t: number): readonly number[] {
  if (t <= stops[0]!.t) return stops[0]!.color;
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1]!, b = stops[k]!;
    if (t <= b.t) return a.color.map((from, c) => from + ((t - a.t) / (b.t - a.t)) * (b.color[c]! - from));
  }
  return stops[stops.length - 1]!.color;
}

/** A color field whose texel i is `fn(i)`. */
export function colorFrom(like: FieldData, fn: (texel: number) => readonly number[]): FieldData {
  const count = like.width * like.height;
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const rgba = fn(i);
    for (let c = 0; c < 4; c++) data[i * 4 + c] = rgba[c] ?? 1;
  }
  return { kind: 'color', width: like.width, height: like.height, channels: 4, data };
}

/** A field whose texel i is `fn(i)`. */
export function fieldFrom(like: FieldData, fn: (texel: number) => number): FieldData {
  const count = like.width * like.height;
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = fn(i);
  return { kind: 'field', width: like.width, height: like.height, channels: 1, data };
}

/**
 * The physical gradient of a height field in metres per metre, as slopeAt takes it (engine.md 3.8): the central
 * difference, and on the border the one-sided difference of second order.
 */
export function slopes(src: FieldData, terrainSize = TERRAIN_SIZE, heightRange = HEIGHT_RANGE): { readonly gx: Float64Array; readonly gy: Float64Array } {
  const n = src.width;
  const cell = terrainSize / (n - 1);
  const gx = new Float64Array(n * n), gy = new Float64Array(n * n);
  const derivative = (i: number, heightAt: (i: number) => number): number =>
    (i === 0 ? 0.5 * (4 * heightAt(1) - 3 * heightAt(0) - heightAt(2))
      : i === n - 1 ? -0.5 * (4 * heightAt(n - 2) - 3 * heightAt(n - 1) - heightAt(n - 3))
        : 0.5 * (heightAt(i + 1) - heightAt(i - 1))) * heightRange / cell;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      gx[y * n + x] = derivative(x, (i) => src.data[y * n + i]!);
      gy[y * n + x] = derivative(y, (i) => src.data[i * n + x]!);
    }
  }
  return { gx, gy };
}

/**
 * A rough terrain for comparing two levels of the ladder: six octaves of two crossed waves each, with half the
 * amplitude at twice the frequency, from one cycle across the terrain down to 32, which is 8 cells at 257. Made
 * on the CPU from `uv`, it is at one resolution exactly the decimation of itself at a finer one.
 */
export function rough(res: number): FieldData {
  const n = res;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1), v = y / (n - 1);
      let h = 0.5;
      for (let octave = 0; octave < 6; octave++) {
        const cycles = 2 ** octave;
        for (const turn of [0, 1.9]) {
          const angle = 1.1 * octave + turn;
          h += (0.125 / cycles) * Math.sin(2 * Math.PI * cycles * (u * Math.cos(angle) + v * Math.sin(angle)) + 2.3 * octave + turn);
        }
      }
      data[y * n + x] = h;
    }
  }
  return { kind: 'field', width: n, height: n, channels: 1, data };
}
