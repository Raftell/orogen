// tests/nodes/io/import-color.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, colorOf, conformance, decimate, expectClose, expectIdentical, expectLadder, fixtures, memorySource, renderGraph, renderLadder, renderNode,
  stats, useNodes, type FieldData,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/io/import-color.ts';
import { exr, grid, png, tiff } from './_images.ts';
import { onGrid, picture, squared, type Picture } from './_reference.ts';

// Paths are relative to tests/. A terrain colored by its height, 129 x 129, as an 8-bit RGB PNG.
const COLORS = 'nodes/io/assets/colors-129.png';

// The defaults cannot run: without a file the node fails, as it documents.
conformance(def, { params: { file: COLORS } });
useNodes([def]);

const N = 33;
/** A value a color field keeps: rgba16float has 11 significant bits (testing.md 3.4). */
const HALF = 2e-3;
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

async function load(files: Readonly<Record<string, Uint8Array>>, params: Readonly<Record<string, ParamValue>>, res = N): Promise<FieldData> {
  const { fields, report } = await renderGraph({ nodes: { img: { type: def.type, params } } }, ['img.out'], { files: memorySource(files), mode: 'build', res });
  const out = fields['img.out'];
  if (!out) throw new Error(report.nodes.img?.error?.message ?? 'the node gave no output');
  return out;
}
const texel = (u: number, v: number): readonly [number, number] => [Math.round(u * (N - 1)), Math.round(v * (N - 1))];
const opaque = (out: FieldData): void => expectIdentical(channelOf(out, 3), fixtures.one(out.width));

// Codes of an 8-bit image: red rises along x, green along y, blue is level.
const red = (x: number): number => 7 * x, green = (_x: number, y: number): number => 255 - 6 * y, BLUE = 128;

test('io/import-color: without a file the node fails with "No file selected", and with a file that is none with the reason', async () => {
  await assert.rejects(renderNode(def), /^NodeFailure: No file selected$/);
  await assert.rejects(renderNode(def, { params: { file: 'nodes/io/assets/missing.png' } }), /File not found/);
  await assert.rejects(renderNode(def, { params: { file: 'nodes/io/import-color.test.ts' } }), /not a PNG, TIFF or OpenEXR image/);
  // A raw file is heights, not a color image: only the heightmap node reads one.
  await assert.rejects(load({ 'a.r16': new Uint8Array(2 * N * N) }, { file: 'a.r16' }), /not a PNG, TIFF or OpenEXR image/);
});

test('io/import-color: the colors of a PNG and of a whole-number TIFF are sRGB, decoded to linear and opaque, row for row', async () => {
  const codes = grid(N, N, (x, y) => [red(x), green(x, y), BLUE]).flat();
  const expected = colorOf(N, (u, v) => {
    const [x, y] = texel(u, v);
    return [srgbToLinear(red(x) / 255), srgbToLinear(green(x, y) / 255), srgbToLinear(BLUE / 255), 1];
  });
  const files = {
    'rgb.png': png({ width: N, height: N, channels: 3, bits: 8, samples: codes }),
    'rgb16.png': png({ width: N, height: N, channels: 3, bits: 16, samples: codes.map((c) => c * 257) }),
    'rgb.tif': tiff({ width: N, height: N, channels: 3, sample: 'u8', samples: codes }),
    'rgb16.tif': tiff({ width: N, height: N, channels: 3, sample: 'u16', samples: codes.map((c) => c * 257) }),
  };
  for (const file of Object.keys(files)) {
    const out = await load(files, { file });
    assert.equal(out.kind, 'color', file);
    expectClose(out, expected, { max: HALF });
    opaque(out);
  }
  // The middle gray of sRGB is 0.2159 linear, and black and white stay what they are.
  const gray = await load({ 'g.png': png({ width: N, height: N, channels: 3, bits: 8, samples: grid(N, N, (x) => (x < 11 ? [0, 0, 0] : x < 22 ? [128, 128, 128] : [255, 255, 255])).flat() }) }, { file: 'g.png' });
  assert.deepEqual([at(gray, 0, 5, 1), at(gray, 32, 5, 2)], [0, 1]);
  assert.ok(Math.abs(at(gray, 16, 5, 0) - 0.2159) < 1e-3, `sRGB 128 is ${at(gray, 16, 5, 0)} linear`);
});

test('io/import-color: an OpenEXR file and a float TIFF hold linear colors, which are taken as they are', async () => {
  const value = (x: number, y: number, c: number): number => [x / 40, y / 64, 0.25][c]!;
  const plane = (c: number): number[] => grid(N, N, (x, y) => value(x, y, c));
  const expected = colorOf(N, (u, v) => {
    const [x, y] = texel(u, v);
    return [value(x, y, 0), value(x, y, 1), value(x, y, 2), 1];
  });
  const files = {
    'rgb.exr': exr({ width: N, height: N, channels: { R: plane(0), G: plane(1), B: plane(2) } }),
    'rgba.exr': exr({ width: N, height: N, channels: { R: plane(0), G: plane(1), B: plane(2), A: grid(N, N, () => 0.5) } }),
    'rgb.tif': tiff({ width: N, height: N, channels: 3, sample: 'f32', samples: grid(N, N, (x, y) => [value(x, y, 0), value(x, y, 1), value(x, y, 2)]).flat() }),
  };
  for (const file of Object.keys(files)) {
    const out = await load(files, { file });
    expectClose(out, expected, { max: HALF });
    opaque(out);
  }
});

test('io/import-color: linear values beyond what a color holds are limited to it, so that none becomes infinite', async () => {
  // A color field keeps half floats, whose largest is 65504: a sun of a million would be stored as infinity.
  const files = {
    'sun.exr': exr({ width: N, height: N, channels: { R: grid(N, N, (x) => (x < 16 ? 1e6 : 0.5)), G: grid(N, N, () => -1e6), B: grid(N, N, () => 70000) } }),
  };
  const out = await load(files, { file: 'sun.exr' });
  assert.deepEqual(([0, 1, 2] as const).map((c) => stats(channelOf(out, c)).nonFinite), [0, 0, 0]);
  assert.deepEqual([at(out, 0, 0, 0), at(out, 20, 0, 0), at(out, 0, 0, 1), at(out, 0, 0, 2)], [65504, 0.5, -65504, 65504]);
  opaque(out);
});

test('io/import-color: a gray image is gray, and the transparency of a file is not kept', async () => {
  const level = (x: number, y: number): number => 4 * x + 3 * y;
  const files = {
    'gray.png': png({ width: N, height: N, channels: 1, bits: 8, samples: grid(N, N, level) }),
    'ga.png': png({ width: N, height: N, channels: 2, bits: 8, samples: grid(N, N, (x, y) => [level(x, y), 10]).flat() }),
    'rgba.png': png({ width: N, height: N, channels: 4, bits: 8, samples: grid(N, N, (x, y) => [level(x, y), level(x, y), level(x, y), x]).flat() }),
    'y.exr': exr({ width: N, height: N, channels: { Y: grid(N, N, (x, y) => srgbToLinear(level(x, y) / 255)) } }),
  };
  const expected = colorOf(N, (u, v) => {
    const l = srgbToLinear(level(...texel(u, v)) / 255);
    return [l, l, l, 1];
  });
  for (const file of Object.keys(files)) {
    const out = await load(files, { file });
    expectClose(out, expected, { max: HALF });
    opaque(out);
    expectIdentical(channelOf(out, 0), channelOf(out, 1));
    expectIdentical(channelOf(out, 0), channelOf(out, 2));
  }
});

test('io/import-color: a coarser image keeps its place and its filter, each channel like a field, and stays opaque', async () => {
  // Linear values in a float file, 9 x 9 onto 33 x 33.
  const p: Picture = picture(9, 9, 3, (x, y, c) => [x / 8, (y / 8) ** 2, ((x + y) % 2) * 0.5][c]!);
  const plane = (c: number): number[] => grid(9, 9, (x, y) => p.data[(y * 9 + x) * 3 + c]!);
  const files = { 'small.exr': exr({ width: 9, height: 9, channels: { R: plane(0), G: plane(1), B: plane(2) } }) };
  for (const filter of ['linear', 'cubic'] as const) {
    const out = await load(files, { file: 'small.exr', filter });
    for (const c of [0, 1, 2] as const) expectClose(channelOf(out, c), onGrid(p, N, filter, c, true), { max: HALF });
    opaque(out);
    // At the vertices the grids share, the texels of the image.
    for (const c of [0, 1, 2] as const) {
      expectClose(decimate(channelOf(out, c), 2), onGrid(p, 9, 'linear', c), { max: HALF });
    }
  }
  // The cubic stays within the colors it lies between: the checkerboard of blue never leaves 0..0.5.
  const blue = channelOf(await load(files, { file: 'small.exr', filter: 'cubic' }), 2);
  assert.ok(stats(blue).min >= 0 && stats(blue).max <= 0.5 + 1e-4, `blue lies within ${stats(blue).min}..${stats(blue).max}`);
});

test('io/import-color: an image that is not square is stretched, shown whole on opaque black, or cut to its middle', async () => {
  const p: Picture = picture(17, 9, 3, (x, y, c) => [0.2 + 0.04 * x, 0.1 + 0.1 * y, 0.6][c]!);
  const plane = (c: number): number[] => grid(17, 9, (x, y) => p.data[(y * 17 + x) * 3 + c]!);
  const files = { 'wide.exr': exr({ width: 17, height: 9, channels: { R: plane(0), G: plane(1), B: plane(2) } }) };
  for (const fit of ['stretch', 'contain', 'cover'] as const) {
    const out = await load(files, { file: 'wide.exr', fit, filter: 'linear' });
    const placed = squared(p, fit, [0, 0, 0]);
    for (const c of [0, 1, 2] as const) expectClose(channelOf(out, c), onGrid(placed, N, 'linear', c), { max: HALF });
    opaque(out);
  }
  // Shown whole and read with the cubic, the image is read within itself: black beside it, and its own colors up to its border.
  const curved = await load(files, { file: 'wide.exr', fit: 'contain', filter: 'cubic' });
  for (const c of [0, 1, 2] as const) expectClose(channelOf(curved, c), onGrid(p, N, 'cubic', c, true, { beside: 0 }), { max: HALF });
  opaque(curved);
  // Shown whole, the image lies in the middle 17 of 33 rows; beside it the map is black.
  const whole = await load(files, { file: 'wide.exr', fit: 'contain', filter: 'nearest' });
  assert.deepEqual([at(whole, 16, 0, 0), at(whole, 16, 0, 1), at(whole, 16, 0, 2), at(whole, 16, 0, 3)], [0, 0, 0, 1]);
  assert.ok(Math.abs(at(whole, 16, 16, 2) - 0.6) < HALF);
});

test('io/import-color: a finer image is averaged onto the grid in linear light', async () => {
  // 129 x 129 onto 33 x 33: black and white texels in turn. Averaged in linear light that is 0.5; averaged as
  // sRGB codes it would be the middle gray, 0.2159.
  const codes = grid(129, 129, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0])).flat();
  const out = await load({ 'checker.png': png({ width: 129, height: 129, channels: 3, bits: 8, samples: codes }) }, { file: 'checker.png' });
  // Inside: at the border the triangle is cut and holds one color more than the other.
  for (const [x, y] of [[16, 16], [5, 20], [30, 9]] as const) {
    assert.ok(Math.abs(at(out, x, y, 0) - 0.5) < 5e-3, `texel (${x}, ${y}) is ${at(out, x, y, 0)}`);
  }
  opaque(out);
});

test('io/import-color: the placed image is the same at two levels of the ladder', async () => {
  for (const filter of ['linear', 'cubic']) {
    const levels = await renderLadder(def, { params: { file: COLORS, filter } });
    expectLadder(levels[257]!.out!, levels[513]!.out!, { max: 1e-6 });
  }
});
