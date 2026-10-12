import { AssertionError } from 'node:assert/strict';

import { checkFieldData, type FieldData } from './field-data.ts';

// Data is compared by loops that report a position and a count. Nothing here hands field data to an
// assertion of node:assert, and no AssertionError carries data as `actual` or `expected` (testing.md 8.2).

export interface Stats {
  readonly count: number;        // finite values
  readonly nonFinite: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly std: number;          // population standard deviation
  readonly p01: number;
  readonly p50: number;
  readonly p99: number;
}

/** A number as a message shows it: seven significant digits, which tell apart two float32 values. */
export function show(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const size = Math.abs(value);
  return size >= 1e-4 && size < 1e7 ? String(Number(value.toPrecision(7))) : value.toExponential(3).replace(/\.?0+e/, 'e');
}

export function fail(message: string): never {
  throw new AssertionError({ message });
}

/** The value at fraction `p` of the sorted finite values, between neighbours linearly. */
function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below);
}

/** Over the finite values of one channel (default 0), in float64. Every statistic is 0 when no value is finite. */
export function stats(f: FieldData, channel = 0): Stats {
  checkFieldData(f, 'stats: the field');
  if (!Number.isInteger(channel) || channel < 0 || channel >= f.channels) throw new RangeError(`stats: channel ${channel} does not exist: the field has ${f.channels}`);
  const total = f.width * f.height;
  const finite = new Float32Array(total);
  let count = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < total; i++) {
    const v = f.data[i * f.channels + channel]!;
    if (!Number.isFinite(v)) continue;
    finite[count++] = v;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return { count: 0, nonFinite: total, min: 0, max: 0, mean: 0, std: 0, p01: 0, p50: 0, p99: 0 };
  const mean = sum / count;
  let squares = 0;
  for (let i = 0; i < count; i++) squares += (finite[i]! - mean) ** 2;
  const sorted = finite.subarray(0, count).sort();
  return {
    count, nonFinite: total - count, min, max, mean, std: Math.sqrt(squares / count),
    p01: percentile(sorted, 0.01), p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99),
  };
}

export type Bound = number | readonly [lo: number, hi: number];      // a number n means [n − 1e-5, n + 1e-5]
export type StatName = 'min' | 'max' | 'mean' | 'std' | 'p01' | 'p50' | 'p99';
const STAT_NAMES: readonly StatName[] = ['min', 'max', 'mean', 'std', 'p01', 'p50', 'p99'];

export function expectStats(f: FieldData, expected: Partial<Record<StatName, Bound>>, channel = 0): void {
  for (const name of Object.keys(expected)) {
    if (!(STAT_NAMES as readonly string[]).includes(name)) throw new TypeError(`expectStats: "${name}" is not a statistic; the statistics are ${STAT_NAMES.join(', ')}`);
  }
  const found = stats(f, channel);
  if (found.nonFinite !== 0) fail(`nonFinite ${found.nonFinite} is not 0: the field holds NaN or infinity`);
  for (const name of STAT_NAMES) {
    const bound = expected[name];
    if (bound === undefined) continue;
    const [lo, hi] = typeof bound === 'number' ? [bound - 1e-5, bound + 1e-5] : bound;
    if (!(lo <= hi)) throw new RangeError(`expectStats: the bound of ${name}, [${lo}, ${hi}], is not a range`);
    const value = found[name];
    if (!(value >= lo && value <= hi)) fail(`${name} ${show(value)} is outside [${show(lo)}, ${show(hi)}]`);
  }
}

const position = (f: FieldData, index: number): string => {
  const texel = Math.floor(index / f.channels);
  const where = `(${texel % f.width}, ${Math.floor(texel / f.width)})`;
  return f.channels === 1 ? where : `${where} channel ${index % f.channels}`;
};

export function expectFinite(f: FieldData): void {            // no NaN, no infinity, in any channel
  checkFieldData(f, 'expectFinite: the field');
  let first = -1, count = 0;
  for (let i = 0; i < f.data.length; i++) {
    if (Number.isFinite(f.data[i]!)) continue;
    if (count++ === 0) first = i;
  }
  if (count > 0) fail(`${count} of ${f.data.length} values are not finite; the first is ${f.data[first]} at ${position(f, first)}`);
}

export function expectMask(f: FieldData): void {              // finite, and every value v has 0 <= v <= 1 exactly
  checkFieldData(f, 'expectMask: the field');
  let first = -1, count = 0;
  for (let i = 0; i < f.data.length; i++) {
    const v = f.data[i]!;
    if (v >= 0 && v <= 1) continue;        // false for NaN as well
    if (count++ === 0) first = i;
  }
  if (count > 0) fail(`${count} of ${f.data.length} values are outside [0, 1]; the first is ${show(f.data[first]!)} at ${position(f, first)}`);
}

export interface Diff {
  readonly max: number;          // largest absolute difference
  readonly rms: number;
  readonly differing: number;    // values that are not bit-identical
  readonly worst: { readonly x: number; readonly y: number; readonly channel: number; readonly a: number; readonly b: number };
}

const bits = (data: Float32Array): Uint32Array => new Uint32Array(data.buffer, data.byteOffset, data.length);

function sameShape(a: FieldData, b: FieldData, what: string): void {
  checkFieldData(a, `${what}: the first field`);
  checkFieldData(b, `${what}: the second field`);
  if (a.kind !== b.kind || a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`${what}: a ${a.kind} of ${a.width} x ${a.height} cannot be compared with a ${b.kind} of ${b.width} x ${b.height}`);
  }
}

/**
 * Same kind and size, else throws. A pair that is not bit-identical and holds a value that is not finite
 * differs by infinity: two different NaNs are not close.
 */
export function diff(a: FieldData, b: FieldData): Diff {
  sameShape(a, b, 'diff');
  const x = bits(a.data), y = bits(b.data);
  let max = 0, squares = 0, differing = 0, worst = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    differing++;
    const d = Math.abs(a.data[i]! - b.data[i]!);
    const distance = Number.isNaN(d) ? Infinity : d;
    squares += distance * distance;
    if (distance > max) {
      max = distance;
      worst = i;
    }
  }
  const texel = Math.floor(worst / a.channels);
  return {
    max, rms: Math.sqrt(squares / Math.max(x.length, 1)), differing,
    worst: { x: texel % a.width, y: Math.floor(texel / a.width), channel: worst % a.channels, a: a.data[worst] ?? 0, b: b.data[worst] ?? 0 },
  };
}

/** `max difference 3.1e-3 at (17, 204): 0.4412 vs 0.4443`, with the channel for a colour. */
export function describeWorst(d: Diff, channels: number): string {
  const where = channels === 1 ? `(${d.worst.x}, ${d.worst.y})` : `(${d.worst.x}, ${d.worst.y}) channel ${d.worst.channel}`;
  return `max difference ${show(d.max)} at ${where}: ${show(d.worst.a)} vs ${show(d.worst.b)}`;
}

export function expectClose(a: FieldData, b: FieldData, tol: { max?: number; rms?: number }): Diff {
  if (tol?.max === undefined && tol?.rms === undefined) throw new TypeError('expectClose: the tolerance needs at least one of max and rms');
  for (const [name, value] of [['max', tol.max], ['rms', tol.rms]] as const) {
    if (value !== undefined && !(value >= 0)) throw new RangeError(`expectClose: the tolerance ${name} is ${String(value)}; it is a number of at least 0`);
  }
  const d = diff(a, b);
  if (tol.max !== undefined && !(d.max <= tol.max)) fail(`${describeWorst(d, a.channels)}; allowed ${show(tol.max)}`);
  if (tol.rms !== undefined && !(d.rms <= tol.rms)) fail(`rms difference ${show(d.rms)} (${describeWorst(d, a.channels)}); allowed ${show(tol.rms)}`);
  return d;
}

export function expectIdentical(a: FieldData, b: FieldData): void {                         // bit-identical
  sameShape(a, b, 'expectIdentical');
  const x = bits(a.data), y = bits(b.data);
  let first = -1, count = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (count++ === 0) first = i;
  }
  if (count > 0) {
    fail(`${count} of ${x.length} values are not bit-identical; the first is at ${position(a, first)}: ${show(a.data[first]!)} vs ${show(b.data[first]!)}`);
  }
}
