import { defineCpuTask } from '../cpu/tasks.ts';
import type { CpuTask } from '../cpu/tasks.ts';
import { checkImageSize } from './image.ts';
import type { DecodedImage } from './image.ts';

const BYTES = { u8: 1, u16: 2, f32: 4 } as const;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Headerless little-endian samples (export-unreal.md 4.7). A core CPU task. */
export const decodeRaw: CpuTask<
  { bytes: Uint8Array; sample: 'u8' | 'u16' | 'f32'; width?: number; height?: number },
  DecodedImage
> = defineCpuTask({
  name: 'core/decode-raw',
  run(args: { bytes: Uint8Array; sample: 'u8' | 'u16' | 'f32'; width?: number; height?: number }): DecodedImage {
    const bytes: unknown = args?.bytes;
    const { sample } = args;
    if (!(bytes instanceof Uint8Array)) throw new Error('decodeRaw needs the bytes of a file as a Uint8Array');
    if (!Object.hasOwn(BYTES, sample)) throw new Error(`raw sample type ${JSON.stringify(sample)} is not one of "u8", "u16" and "f32"`);
    const size = BYTES[sample];
    const what = sample === 'f32' ? '32-bit float' : `${size * 8}-bit`;
    if (bytes.length === 0) throw new Error('raw file is empty');
    if (bytes.length % size !== 0) throw new Error(`raw file has ${bytes.length} bytes, which is not a whole number of ${what} samples`);
    const count = bytes.length / size;

    let { width, height } = args;
    if (width === undefined && height === undefined) {
      const side = Math.round(Math.sqrt(count));
      if (side * side !== count) throw new Error(`raw file holds ${count} samples, which is not a square image; state its width and height`);
      width = height = side;
    } else if (width === undefined || height === undefined) {
      throw new Error('raw file needs both its width and its height, or neither');
    }
    checkImageSize(width, height, 1);
    if (width * height !== count) {
      throw new Error(`raw file has ${bytes.length} bytes; ${width} x ${height} ${what} samples are ${width * height * size}`);
    }

    const data = new Float32Array(count);
    if (sample === 'u8') {
      for (let i = 0; i < count; i++) data[i] = bytes[i] / 255;
    } else if (sample === 'u16') {
      for (let i = 0, p = 0; i < count; i++, p += 2) data[i] = (bytes[p] | (bytes[p + 1] << 8)) / 65535;
    } else {
      if (HOST_LITTLE_ENDIAN) {
        new Uint8Array(data.buffer).set(bytes);
      } else {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < count; i++) data[i] = view.getFloat32(i * 4, true);
      }
      for (let i = 0; i < count; i++) if (!Number.isFinite(data[i])) data[i] = 0;
    }
    return { width, height, channels: 1, data };
  },
});
