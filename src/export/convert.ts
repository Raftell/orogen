// Sample conversion and the texel-grid resampler of the build pipeline (export-unreal.md 3.4, 4.6, 5.9). Pure:
// typed arrays in, typed arrays out, one band at a time.

import { SRGB8 } from './unreal.ts';

/** `v - v` is 0 for a finite number and NaN for NaN and for either infinity. */
const isNonFinite = (v: number): boolean => v - v !== 0;

/**
 * Integer samples: `floor(saturate(t) * max + 0.5)` with `t = (v - lo) / (hi - lo)`, and `t = 0` where `lo`
 * equals `hi`. With `lo` 0 and `hi` 1, `t` is the value itself. Arithmetic is in float64. A non-finite sample is
 * stored as 0 and counted. Returns that count and the sum of the codes written.
 */
export function quantiseUnit(src: Float32Array, dst: Uint8Array | Uint16Array, o: { readonly max: 255 | 65535; readonly lo: number; readonly hi: number }): { nonFinite: number; sum: number } {
  if (dst.length !== src.length) throw new RangeError(`quantiseUnit: ${src.length} samples for ${dst.length} codes`);
  const flat = o.hi === o.lo;
  const span = o.hi - o.lo;
  let nonFinite = 0, sum = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNonFinite(v)) {
      nonFinite++;
      dst[i] = 0;
      continue;
    }
    const t = flat ? 0 : (v - o.lo) / span;
    const code = t <= 0 ? 0 : t >= 1 ? o.max : Math.floor(t * o.max + 0.5);
    dst[i] = code;
    sum += code;
  }
  return { nonFinite, sum };
}

/** The number of non-finite samples of a band. */
export function countNonFinite(src: Float32Array): number {
  let count = 0;
  for (let i = 0; i < src.length; i++) if (isNonFinite(src[i])) count++;
  return count;
}

/** 5.9, content 'color': each channel of linear RGB as `SRGB8[floor(saturate(c) * 65535 + 0.5)]`. Returns the non-finite samples, stored as 0. */
export function colorToSrgb8(rgb: Float32Array, dst: Uint8Array): number {
  if (dst.length !== rgb.length) throw new RangeError(`colorToSrgb8: ${rgb.length} samples for ${dst.length} bytes`);
  let nonFinite = 0;
  for (let i = 0; i < rgb.length; i++) {
    const c = rgb[i];
    if (isNonFinite(c)) {
      nonFinite++;
      dst[i] = 0;
      continue;
    }
    dst[i] = SRGB8[c <= 0 ? 0 : c >= 1 ? 65535 : Math.floor(c * 65535 + 0.5)];
  }
  return nonFinite;
}

/**
 * 5.9, content 'normal': each vector normalised, one shorter than 1e-6 taken as (0, 0, 1), and each component
 * stored as `floor((c * 0.5 + 0.5) * 255 + 0.5)`. Returns the non-finite vectors, stored as (0, 0, 1).
 */
export function normalsToRgb8(xyz: Float32Array, dst: Uint8Array): number {
  if (dst.length !== xyz.length || xyz.length % 3 !== 0) throw new RangeError(`normalsToRgb8: ${xyz.length} components for ${dst.length} bytes`);
  let nonFinite = 0;
  for (let i = 0; i < xyz.length; i += 3) {
    let x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
    const length = Math.sqrt(x * x + y * y + z * z);
    if (isNonFinite(length)) nonFinite++;
    if (!(length >= 1e-6)) { x = 0; y = 0; z = 1; }
    else { x /= length; y /= length; z /= length; }
    dst[i] = Math.floor((x * 0.5 + 0.5) * 255 + 0.5);
    dst[i + 1] = Math.floor((y * 0.5 + 0.5) * 255 + 0.5);
    dst[i + 2] = Math.floor((z * 0.5 + 0.5) * 255 + 0.5);
  }
  return nonFinite;
}

// ---- vertex normals, from bands --------------------------------------------------------------------------------

export interface NormalRows {
  /** Takes the next height rows, in order. Returns the normals of the rows now complete: three floats per vertex. */
  push(rows: Float32Array): Float32Array;
  /** Checks that every row was given. Every normal has been returned by then. */
  finish(): void;
}

/**
 * The vertex normals of a field of `size` x `size` heights, as `normalAt` of engine.md 3.8 gives them:
 * `normalize(-sx, -sy, 1)` with the physical slope `(sx, sy)` in metres per metre, from the central difference
 * and, on the border, the one-sided difference of second order. A row's normals need the row before it and the
 * row after it, and the first and the last row the two rows next to them: the result does not depend on where
 * the bands begin.
 */
export function createNormalRows(o: { readonly size: number; readonly heightRange: number; readonly terrainSize: number }): NormalRows {
  const n = o.size;
  if (!Number.isInteger(n) || n < 3) throw new RangeError(`createNormalRows: a field of ${String(n)} rows has no second-order border`);
  const scale = o.heightRange * (n - 1) / o.terrainSize;
  /** The two rows before the band in hand: rows `taken - 2` and `taken - 1`. */
  const carry = new Float32Array(2 * n);
  let taken = 0;

  return {
    push(rows) {
      if (rows.length % n !== 0) throw new RangeError(`createNormalRows: ${rows.length} samples are not whole rows of ${n}`);
      const count = rows.length / n;
      if (taken + count > n) throw new RangeError(`createNormalRows: ${taken + count} rows for a field of ${n}`);
      const first = taken;
      /** Row `y` of the field: in the band, or one of the two carried rows. */
      const at = (y: number): { readonly data: Float32Array; readonly offset: number } =>
        (y >= first ? { data: rows, offset: (y - first) * n } : { data: carry, offset: (y - first + 2) * n });

      // With the rows up to `last` in hand: row y is complete when row y + 1 is, row 0 when row 2 is, and the last row with itself.
      const last = first + count - 1;
      const from = first <= 2 ? 0 : first - 1;
      const to = last === n - 1 ? n - 1 : last >= 2 ? last - 1 : -1;
      const out = new Float32Array(Math.max(0, to - from + 1) * n * 3);
      for (let y = from, w = 0; y <= to; y++) {
        const here = at(y);
        // The three rows of the difference along y, and its sign and weights (engine.md 3.8, slopeAt).
        const border = y === 0 ? 1 : y === n - 1 ? -1 : 0;
        const near = at(border === 0 ? y + 1 : y + border);
        const far = at(border === 0 ? y - 1 : y + 2 * border);
        for (let x = 0; x < n; x++, w += 3) {
          const c = here.data[here.offset + x];
          const dx = x === 0 ? 0.5 * (4 * here.data[here.offset + 1] - 3 * c - here.data[here.offset + 2])
            : x === n - 1 ? -0.5 * (4 * here.data[here.offset + n - 2] - 3 * c - here.data[here.offset + n - 3])
            : 0.5 * (here.data[here.offset + x + 1] - here.data[here.offset + x - 1]);
          const dy = border === 0 ? 0.5 * (near.data[near.offset + x] - far.data[far.offset + x])
            : border * 0.5 * (4 * near.data[near.offset + x] - 3 * c - far.data[far.offset + x]);
          const sx = dx * scale, sy = dy * scale;
          const inverse = 1 / Math.sqrt(sx * sx + sy * sy + 1);
          out[w] = -sx * inverse;
          out[w + 1] = -sy * inverse;
          out[w + 2] = inverse;
        }
      }

      // The last two rows in hand are what the next band reads behind itself.
      if (count >= 2) carry.set(rows.subarray((count - 2) * n));
      else if (count === 1) {
        carry.copyWithin(0, n);
        carry.set(rows, n);
      }
      taken += count;
      return out;
    },
    finish() {
      if (taken !== n) throw new RangeError(`createNormalRows: finish after ${taken} of ${n} rows`);
    },
  };
}

// ---- 5.9 the texel-grid resampler --------------------------------------------------------------------------------

export interface TexelGridResampler {
  /** Takes the next source rows, in order (row-major, channels interleaved). Returns the output rows now complete. */
  push(rows: Float32Array): Float32Array;
  /** Returns the output rows not yet returned. */
  finish(): Float32Array;
}

/** The taps of every output index along one axis: the source indices with a weight above 0, and the weights divided by their sum. */
interface Taps {
  readonly first: Int32Array;       // the first source index of output i
  readonly count: Int32Array;
  readonly at: Int32Array;          // where the weights of output i begin in `weight`
  readonly weight: Float64Array;
  readonly most: number;            // the largest count
}

function tapsOf(n: number, s: number): Taps {
  const rho = Math.max(1, (n - 1) / s);
  const first = new Int32Array(s), count = new Int32Array(s), at = new Int32Array(s);
  const weights: number[] = [];
  let most = 0;
  for (let i = 0; i < s; i++) {
    const c = (i + 0.5) * (n - 1) / s;
    const lo = Math.max(0, Math.floor(c - rho) + 1);
    const hi = Math.min(n - 1, Math.ceil(c + rho) - 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += Math.max(0, 1 - Math.abs(k - c) / rho);
    first[i] = lo;
    count[i] = hi - lo + 1;
    at[i] = weights.length;
    for (let k = lo; k <= hi; k++) weights.push(Math.max(0, 1 - Math.abs(k - c) / rho) / sum);
    most = Math.max(most, count[i]);
  }
  return { first, count, at, weight: Float64Array.from(weights), most };
}

/**
 * Brings rows on the vertex grid of `srcSize` x `srcSize` onto a texel-centred texture of side `dstSize`, with a
 * tent as wide as the reduction and never narrower than a source cell: bilinear interpolation between the four
 * vertices around a texel centre when `dstSize >= srcSize - 1`.
 *
 * Streaming: it keeps the horizontally resampled rows inside its vertical support, `2 * rho + 1` rows at most,
 * and its output does not depend on how the source rows are cut into push calls. `stride` is the number of floats
 * a source texel has, of which the first `channels` are resampled (4 for a colour, whose alpha is dropped);
 * default `channels`.
 *
 * Each sum is taken over differences from its first sample, in float64: the weighted mean
 * `sum(w * src) / sum(w)` of 5.9, and a constant field gives that constant, bit for bit.
 */
export function createTexelGridResampler(o: { srcSize: number; dstSize: number; channels: 1 | 3; stride?: number }): TexelGridResampler {
  const { srcSize: n, dstSize: s, channels } = o;
  const stride = o.stride ?? channels;
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`createTexelGridResampler: the source has ${String(n)} vertices a side; it has at least 2`);
  if (!Number.isInteger(s) || s < 1) throw new RangeError(`createTexelGridResampler: the texture has ${String(s)} texels a side; it has at least 1`);
  if (channels !== 1 && channels !== 3) throw new RangeError(`createTexelGridResampler: ${String(channels)} channels; 1 or 3 are resampled`);
  if (!Number.isInteger(stride) || stride < channels) throw new RangeError(`createTexelGridResampler: a stride of ${String(stride)} floats holds no ${channels} channels`);

  const taps = tapsOf(n, s);
  const width = s * channels;
  // The window: the horizontally resampled source rows l - capacity + 1 .. l, row l in slot l % capacity.
  const capacity = taps.most;
  const window = new Float64Array(capacity * width);
  let pushed = 0;       // source rows taken
  let emitted = 0;      // output rows returned

  /** Source row `row` of `rows`, resampled along x into its slot of the window. */
  const horizontal = (rows: Float32Array, row: number, slot: number): void => {
    const base = row * n * stride;
    let w = slot * width;
    for (let i = 0; i < s; i++) {
      const k0 = base + taps.first[i] * stride;
      const count = taps.count[i], at = taps.at[i];
      for (let c = 0; c < channels; c++, w++) {
        const anchor = rows[k0 + c];
        let sum = 0;
        for (let t = 1; t < count; t++) sum += taps.weight[at + t] * (rows[k0 + t * stride + c] - anchor);
        window[w] = anchor + sum;
      }
    }
  };

  /** Output row `j` from the window, into `out` at `to`. */
  const vertical = (j: number, out: Float32Array, to: number): void => {
    const l0 = taps.first[j], count = taps.count[j], at = taps.at[j];
    const anchorRow = (l0 % capacity) * width;
    for (let x = 0; x < width; x++) {
      const anchor = window[anchorRow + x];
      let sum = 0;
      for (let t = 1; t < count; t++) sum += taps.weight[at + t] * (window[((l0 + t) % capacity) * width + x] - anchor);
      out[to + x] = anchor + sum;
    }
  };

  /** The output rows that are complete once source row `l` is in the window. */
  const readyAfter = (l: number): number => {
    let ready = emitted;
    while (ready < s && taps.first[ready] + taps.count[ready] - 1 <= l) ready++;
    return ready - emitted;
  };

  return {
    push(rows) {
      if (rows.length % (n * stride) !== 0) throw new RangeError(`createTexelGridResampler: ${rows.length} floats are not whole rows of ${n} x ${stride}`);
      const count = rows.length / (n * stride);
      if (pushed + count > n) throw new RangeError(`createTexelGridResampler: ${pushed + count} rows for a source of ${n}`);
      const out = new Float32Array((count === 0 ? 0 : readyAfter(pushed + count - 1)) * width);
      let to = 0;
      for (let row = 0; row < count; row++) {
        const l = pushed + row;
        horizontal(rows, row, l % capacity);
        while (emitted < s && taps.first[emitted] + taps.count[emitted] - 1 <= l) {
          vertical(emitted, out, to);
          to += width;
          emitted++;
        }
      }
      pushed += count;
      return out;
    },
    finish() {
      if (pushed !== n) throw new RangeError(`createTexelGridResampler: finish after ${pushed} of ${n} source rows`);
      // Every output row is complete with the source row that ends its support, so none is left.
      return new Float32Array(0);
    },
  };
}
