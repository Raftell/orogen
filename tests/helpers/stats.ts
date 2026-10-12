import type { FieldData } from './field-data.ts';

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
/** Over the finite values of one channel (default 0), in float64. */
export function stats(f: FieldData, channel?: number): Stats {
  throw new Error('not implemented: stats');
}

export type Bound = number | readonly [lo: number, hi: number];      // a number n means [n − 1e-5, n + 1e-5]
export type StatName = 'min' | 'max' | 'mean' | 'std' | 'p01' | 'p50' | 'p99';
export function expectStats(f: FieldData, expected: Partial<Record<StatName, Bound>>, channel?: number): void {
  throw new Error('not implemented: expectStats');
}
export function expectFinite(f: FieldData): void {            // no NaN, no infinity, in any channel
  throw new Error('not implemented: expectFinite');
}
export function expectMask(f: FieldData): void {              // finite, and every value v has 0 <= v <= 1 exactly
  throw new Error('not implemented: expectMask');
}

export interface Diff {
  readonly max: number;          // largest absolute difference
  readonly rms: number;
  readonly differing: number;    // values that are not bit-identical
  readonly worst: { readonly x: number; readonly y: number; readonly channel: number; readonly a: number; readonly b: number };
}
export function diff(a: FieldData, b: FieldData): Diff {                                    // same kind and size, else throws
  throw new Error('not implemented: diff');
}
export function expectClose(a: FieldData, b: FieldData, tol: { max?: number; rms?: number }): Diff {
  throw new Error('not implemented: expectClose');
}
export function expectIdentical(a: FieldData, b: FieldData): void {                         // bit-identical
  throw new Error('not implemented: expectIdentical');
}
