import { decode } from 'fast-png';
import { checkImageSize, reasonOf } from './image.ts';
import type { DecodedImage } from './image.ts';

const GREY = 0;
const RGB = 2;
const PALETTE = 3;
const GREY_ALPHA = 4;
const RGBA = 6;

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  readonly transparency: boolean;      // a tRNS chunk is present
}

/** Walks the chunk list without decoding anything, so that a cut file and an oversized image are refused before the library allocates. */
function readHeader(bytes: Uint8Array): PngHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let ihdr: { width: number; height: number; depth: number; colorType: number } | null = null;
  let transparency = false;
  let hasData = false;
  for (let pos = 8; ; ) {
    // A chunk is its length, its type, its data and a CRC.
    if (pos + 12 > bytes.length) throw new Error('PNG file is truncated');
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (pos + 12 + length > bytes.length) throw new Error('PNG file is truncated');
    if (ihdr === null) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG file does not begin with an IHDR chunk');
      ihdr = {
        width: view.getUint32(pos + 8),
        height: view.getUint32(pos + 12),
        depth: bytes[pos + 16],
        colorType: bytes[pos + 17],
      };
    } else if (type === 'tRNS') transparency = true;
    else if (type === 'IDAT') hasData = true;
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!hasData) throw new Error('PNG file holds no image data');
  return { ...ihdr, transparency };
}

function channelsOf(header: PngHeader): 1 | 3 | 4 {
  const { depth, colorType } = header;
  if (colorType === PALETTE) {
    if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8) {
      throw new Error(`PNG palette image has ${depth} bits per pixel; 1, 2, 4 and 8 are valid`);
    }
    return header.transparency ? 4 : 3;
  }
  if (colorType !== GREY && colorType !== RGB && colorType !== GREY_ALPHA && colorType !== RGBA) {
    throw new Error(`PNG colour type ${colorType} is not valid`);
  }
  if (depth !== 8 && depth !== 16) throw new Error(`PNG has ${depth} bits per channel; 8 and 16 are read`);
  return colorType === RGB ? 3 : colorType === RGBA ? 4 : 1;
}

function describe(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const message = reasonOf(error).replace(/[:\s]+$/, '');
  return cause === undefined ? message : `${message} (${reasonOf(cause)})`;
}

/** 8 and 16 bits per channel; grey, grey with alpha, RGB, RGBA, palette (export-unreal.md 4.7). Uses fast-png. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const header = readHeader(bytes);
  const channels = channelsOf(header);
  const { width, height, depth } = header;
  checkImageSize(width, height, channels);

  let png;
  try {
    png = decode(bytes);
  } catch (error) {
    throw new Error(`PNG file cannot be decoded: ${describe(error)}`);
  }
  const src = png.data;
  const data = new Float32Array(width * height * channels);

  if (header.colorType === PALETTE) {
    const palette = png.palette ?? [];
    // Palette entries are 8 bits per channel whatever the index depth. An entry without alpha is opaque.
    const colors = new Float32Array(palette.length * channels);
    for (let i = 0; i < palette.length; i++) {
      for (let c = 0; c < channels; c++) colors[i * channels + c] = (palette[i][c] ?? 255) / 255;
    }
    // Indices are packed from the high bit down, and every row starts on a byte.
    const bytesPerLine = Math.ceil((width * depth) / 8);
    if (src.length < bytesPerLine * height) throw new Error('PNG file is truncated');
    const mask = (1 << depth) - 1;
    let o = 0;
    for (let y = 0; y < height; y++) {
      const line = y * bytesPerLine;
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const index = (src[line + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
        if (index >= palette.length) throw new Error(`PNG file uses palette entry ${index}, and the palette has ${palette.length}`);
        for (let c = 0; c < channels; c++) data[o++] = colors[index * channels + c];
      }
    }
    return { width, height, channels, data };
  }

  // Grey with alpha has two samples per pixel, of which the first is taken.
  const step = png.channels;
  if (src.length < width * height * step) throw new Error('PNG file is truncated');
  const max = depth === 16 ? 65535 : 255;
  const unit = new Float32Array(max + 1);
  for (let v = 0; v <= max; v++) unit[v] = v / max;
  for (let i = 0, o = 0; o < data.length; i += step) {
    for (let c = 0; c < channels; c++) data[o++] = unit[src[i + c]];
  }
  return { width, height, channels, data };
}
