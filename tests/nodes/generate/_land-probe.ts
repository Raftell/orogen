// Measurements the landform tests share: values on a circle, shares of texels, roughness.
import { at, type FieldData } from '../../helpers/index.ts';

/** The values of the texels nearest to `samples` points on the circle of `radius` (a length) around (u, v). Points off the field are left out. */
export function ring(f: FieldData, u: number, v: number, radius: number, samples = 360): number[] {
  const last = f.width - 1;
  const values: number[] = [];
  for (let k = 0; k < samples; k++) {
    const angle = (2 * Math.PI * k) / samples;
    const x = Math.round((u + radius * Math.cos(angle)) * last), y = Math.round((v + radius * Math.sin(angle)) * last);
    if (x >= 0 && x <= last && y >= 0 && y <= last) values.push(at(f, x, y));
  }
  return values;
}

export function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / Math.max(values.length, 1);
}

/** The population standard deviation. */
export function deviation(values: readonly number[]): number {
  const m = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - m) ** 2;
  return Math.sqrt(sum / Math.max(values.length, 1));
}

/** The part of the texels for which `test` holds. */
export function share(f: FieldData, test: (value: number, x: number, y: number) => boolean): number {
  let count = 0;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (test(at(f, x, y), x, y)) count++;
  return count / (f.width * f.height);
}

/** Mean absolute difference between horizontal neighbours: how rough the field is at the scale of a texel. */
export function meanStep(f: FieldData): number {
  let sum = 0;
  for (let y = 0; y < f.height; y++) for (let x = 1; x < f.width; x++) sum += Math.abs(at(f, x, y) - at(f, x - 1, y));
  return sum / (f.height * (f.width - 1));
}

/** A field of the same size computed texel by texel from `f`. */
export function mapField(f: FieldData, fn: (value: number, x: number, y: number) => number): FieldData {
  const data = new Float32Array(f.data.length);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) data[y * f.width + x] = fn(at(f, x, y), x, y);
  return { ...f, data };
}
