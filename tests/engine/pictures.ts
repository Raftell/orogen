// Pictures of fields for a person to look at, in the styles 'grey' and 'hillshade' of testing.md 2.7, for the
// tests of this folder that run before the harness's writePreview exists. The bytes are never compared.
// Not a test file.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = process.env.OROGEN_TEST_OUTPUT ? path.resolve(process.env.OROGEN_TEST_OUTPUT) : path.join(ROOT, 'test-output');

/** An 8-bit RGB PNG; `rgb` holds width × height × 3 bytes, row 0 first. */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);   // every row begins with filter type 0
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bits per channel
  header[9] = 2;   // colour type: RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function save(name: string, width: number, height: number, rgb: Uint8Array): string {
  const file = path.join(OUTPUT, `${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(width, height, rgb));
  return file;
}

/**
 * `range` mapped linearly to black..white; below the range blue, above it red, non-finite magenta.
 * Pixel (x, y) is texel (x, y). Returns the path of the file.
 */
export function writeGrey(name: string, data: Float32Array, width: number, range: readonly [number, number] | 'auto' = [0, 1]): string {
  const height = data.length / width;
  let [lo, hi] = range === 'auto' ? [Infinity, -Infinity] : range;
  if (range === 'auto') {
    for (const v of data) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const span = hi > lo ? hi - lo : 1;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    const grey = Math.round(((v - lo) / span) * 255);
    const [r, g, b] = !Number.isFinite(v) ? [255, 0, 255] : v < lo ? [0, 0, 255] : v > hi ? [255, 0, 0] : [grey, grey, grey];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return save(name, width, height, rgb);
}

/** Lambert shading of the physical surface: light towards (-1, -1, √2), intensity 0.15 + 0.85 max(n·L, 0). */
export function writeHillshade(name: string, heights: Float32Array, width: number, terrainSize: number, heightRange: number): string {
  const height = heights.length / width;
  const cell = terrainSize / Math.max(width - 1, 1);
  const light = [-0.5, -0.5, Math.SQRT1_2];
  const rgb = new Uint8Array(width * height * 3);
  const at = (x: number, y: number): number => heights[Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)]!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const runX = (Math.min(x + 1, width - 1) - Math.max(x - 1, 0)) * cell;
      const runY = (Math.min(y + 1, height - 1) - Math.max(y - 1, 0)) * cell;
      const dx = ((at(x + 1, y) - at(x - 1, y)) * heightRange) / runX;
      const dy = ((at(x, y + 1) - at(x, y - 1)) * heightRange) / runY;
      const norm = Math.hypot(dx, dy, 1);
      const lit = Math.max((-dx * light[0]! - dy * light[1]! + light[2]!) / norm, 0);
      const i = (y * width + x) * 3;
      if (Number.isFinite(lit)) rgb.fill(Math.round((0.15 + 0.85 * lit) * 255), i, i + 3);
      else rgb.set([255, 0, 255], i);
    }
  }
  return save(name, width, height, rgb);
}
