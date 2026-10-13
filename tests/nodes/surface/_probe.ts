// Measurements and references the tests of the surface nodes share.
import { at, TEST_SETTINGS, type FieldData } from '../../helpers/index.ts';
import { hashCell, hashUnit, mixSeed } from '../../../src/core/api.ts';
import { BED_UNEVEN } from '../../../src/core/nodes/surface/_beds.ts';

/** `frame.seed` of a node with the given seed parameter under the test settings, and `seedFor(stream)` of its kernels. */
export const frameSeed = (seed = 0): number => mixSeed(TEST_SETTINGS.seed, seed);
export const seedFor = (stream: number, seed = 0): number => mixSeed(frameSeed(seed), stream);

/** A field of the same size computed texel by texel. */
export function mapField(f: FieldData, fn: (value: number, x: number, y: number) => number): FieldData {
  const data = new Float32Array(f.data.length);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) data[y * f.width + x] = fn(at(f, x, y), x, y);
  return { ...f, data };
}

/** The part of the texels for which `test` holds. */
export function share(f: FieldData, test: (value: number, x: number, y: number) => boolean): number {
  let count = 0;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (test(at(f, x, y), x, y)) count++;
  return count / (f.width * f.height);
}

/** The largest difference between two texels next to each other along a row or a column. */
export function steepest(f: FieldData): number {
  let most = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (x + 1 < f.width) most = Math.max(most, Math.abs(at(f, x + 1, y) - at(f, x, y)));
      if (y + 1 < f.height) most = Math.max(most, Math.abs(at(f, x, y + 1) - at(f, x, y)));
    }
  }
  return most;
}

/** The part of the texels, the border left out, that lie level with their four neighbours within `within`. */
export function levelShare(f: FieldData, within = 1e-6): number {
  let count = 0;
  for (let y = 1; y < f.height - 1; y++) {
    for (let x = 1; x < f.width - 1; x++) {
      const v = at(f, x, y);
      if (Math.abs(at(f, x - 1, y) - v) <= within && Math.abs(at(f, x + 1, y) - v) <= within && Math.abs(at(f, x, y - 1) - v) <= within && Math.abs(at(f, x, y + 1) - v) <= within) count++;
    }
  }
  return count / ((f.width - 2) * (f.height - 2));
}

/** The correlation of two fields. */
export function correlation(a: FieldData, b: FieldData): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.data.length; i++) {
    ma += a.data[i]!;
    mb += b.data[i]!;
  }
  ma /= a.data.length;
  mb /= b.data.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.data.length; i++) {
    const da = a.data[i]! - ma, db = b.data[i]! - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return ab / Math.sqrt(Math.max(aa * bb, 1e-300));
}

/** The level at which bed `k` begins, in beds: the library's surfaceBeds_base. */
export function bedBase(k: number, irregularity: number, seed: number): number {
  return k + BED_UNEVEN * irregularity * (hashUnit(hashCell(k, 0, seed)) - 0.5);
}

/** The bed the level `s` lies in: the library's surfaceBeds_find. */
export function bedOf(s: number, irregularity: number, seed: number): { index: number; lo: number; hi: number } {
  let index = Math.floor(s);
  let lo = bedBase(index, irregularity, seed), hi = bedBase(index + 1, irregularity, seed);
  if (s < lo) {
    index -= 1;
    hi = lo;
    lo = bedBase(index, irregularity, seed);
  } else if (s >= hi) {
    index += 1;
    lo = hi;
    hi = bedBase(index + 1, irregularity, seed);
  }
  return { index, lo, hi };
}
