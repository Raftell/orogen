import { defineCpuTask } from '../cpu/tasks.ts';
import type { CpuTask } from '../cpu/tasks.ts';

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
  readonly data: Float32Array<ArrayBuffer>;   // row-major, 0..1 for integer formats, first row = top row of the image; never shared memory, so its buffer can be transferred
}

const MAX_SIDE = 8192;
const MAX_DECODED_BYTES = 2 ** 30;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TIFF_LITTLE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BIG = [0x4d, 0x4d, 0x00, 0x2a];
const EXR = [0x76, 0x2f, 0x31, 0x01];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/**
 * Recognises PNG, TIFF and OpenEXR from the first bytes and decodes (export-unreal.md 4.7). A core CPU task.
 * Each decoder module, and with it its library, is loaded when the first file of its format arrives: the
 * threads that only name this task never load a decoder.
 */
export const decodeImage: CpuTask<{ bytes: Uint8Array }, Promise<DecodedImage>> = defineCpuTask({
  name: 'core/decode-image',
  async run(args: { bytes: Uint8Array }): Promise<DecodedImage> {
    const bytes: unknown = args?.bytes;
    if (!(bytes instanceof Uint8Array)) throw new Error('decodeImage needs the bytes of a file as a Uint8Array');
    if (startsWith(bytes, PNG)) return (await import('./png.ts')).decodePng(bytes);
    if (startsWith(bytes, TIFF_LITTLE) || startsWith(bytes, TIFF_BIG)) return (await import('./tiff.ts')).decodeTiff(bytes);
    if (startsWith(bytes, EXR)) return (await import('./exr.ts')).decodeExr(bytes);
    throw new Error('file is not a PNG, TIFF or OpenEXR image');
  },
});

/** An ArrayBuffer holding exactly these bytes: the array's own buffer when it covers it whole, else a copy. */
export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
  return bytes.slice().buffer;
}

/** The message of whatever a decoding library threw. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The limits every decoder enforces before it allocates: a side above 8192, decoded data above 1 GiB. Throws the one-sentence Error. */
export function checkImageSize(width: number, height: number, channels: 1 | 3 | 4): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`image is ${width} x ${height}; both sides must be whole numbers of at least 1`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`image is ${width} x ${height}; the largest side is ${MAX_SIDE}`);
  }
  if (width * height * channels * 4 > MAX_DECODED_BYTES) {
    throw new Error(`image is ${width} x ${height} with ${channels} channels; decoded it would exceed 1 GiB`);
  }
}
