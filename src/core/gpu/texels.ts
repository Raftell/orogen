// Conversion between the float32 layout of ctx.read / ctx.write and the bytes of a field format (runtime.md 5.7 rule 3).

export type TexelEncoding = 'f32' | 'f16' | 'unorm8';

export const TEXEL_ENCODING: Readonly<Record<string, TexelEncoding>> = {
  r32float: 'f32', rg32float: 'f32', rgba32float: 'f32',
  r16float: 'f16', rg16float: 'f16', rgba16float: 'f16',
  r8unorm: 'unorm8',
};

const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

/** The IEEE half nearest to `value` (ties to even), as its 16 bits. */
export function floatToHalf(value: number): number {
  scratch[0] = value;
  const bits = scratchBits[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  const e = exponent - 112;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    let half = mantissa >>> shift;
    const rest = mantissa & ((1 << shift) - 1);
    const tie = 1 << (shift - 1);
    if (rest > tie || (rest === tie && (half & 1) === 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  // A carry out of the mantissa raises the exponent, and out of the largest exponent gives infinity: both are right.
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1) === 1)) half++;
  return sign | half;
}

export function halfToFloat(half: number): number {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa !== 0 ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

let halfTable: Float32Array | null = null;
function halves(): Float32Array {
  if (!halfTable) {
    halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) halfTable[h] = halfToFloat(h);
  }
  return halfTable;
}

/** The bytes of `data` (float32, tightly packed) in the given encoding, tightly packed. */
export function packTexels(encoding: TexelEncoding, data: Float32Array): Float32Array | Uint16Array | Uint8Array {
  if (encoding === 'f32') return data;
  if (encoding === 'f16') {
    const out = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = floatToHalf(data[i]!);
    return out;
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(Math.min(Math.max(data[i]!, 0), 1) * 255);
  return out;
}

/** Decodes `count` components that start at `byteOffset` of `source` into `out` at `outOffset`. */
export function unpackTexels(
  encoding: TexelEncoding, source: ArrayBuffer, byteOffset: number, count: number, out: Float32Array, outOffset: number,
): void {
  if (encoding === 'f32') {
    out.set(new Float32Array(source, byteOffset, count), outOffset);
  } else if (encoding === 'f16') {
    const table = halves();
    const view = new Uint16Array(source, byteOffset, count);
    for (let i = 0; i < count; i++) out[outOffset + i] = table[view[i]!]!;
  } else {
    const view = new Uint8Array(source, byteOffset, count);
    for (let i = 0; i < count; i++) out[outOffset + i] = view[i]! / 255;
  }
}
