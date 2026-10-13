// tests/nodes/io/import-field.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, decimate, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, memorySource, openGraph, renderGraph, renderLadder,
  renderNode, stats, useNodes, type FieldData,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/io/import-field.ts';
import { exr, grid, png, raw, tiff } from './_images.ts';
import { inner, onGrid, picture, squared, type Picture } from './_reference.ts';

// Paths are relative to tests/. An eroded terrain at 193 as a 16-bit gray PNG, written by a build of Orogen.
const TERRAIN = 'nodes/io/assets/terrain-193.png';

// The defaults cannot run: without a file the node fails, as it documents.
conformance(def, { params: { file: TERRAIN } });
useNodes([def]);

const N = 33;
const SRC = fixtures.terrain(N);
const heights = (x: number, y: number): number => at(SRC, x, y);
/** The code a whole-number file of `max` holds for a height, and the height the decoder returns for it. */
const code = (h: number, max: number): number => Math.round(h * max);
const stored = (h: number, max: number): number => Math.fround(code(h, max) / max);

/** The node with files held in memory, at `res`; fails with the node's own message. */
async function load(files: Readonly<Record<string, Uint8Array>>, params: Readonly<Record<string, ParamValue>>, res = N): Promise<FieldData> {
  const { fields, report } = await renderGraph({ nodes: { img: { type: def.type, params } } }, ['img.out'], { files: memorySource(files), mode: 'build', res });
  const out = fields['img.out'];
  if (!out) throw new Error(report.nodes.img?.error?.message ?? 'the node gave no output');
  return out;
}
const asField = (p: Picture, c = 0): FieldData => fieldOf(p.width, (u, v) => p.data[(Math.round(v * (p.height - 1)) * p.width + Math.round(u * (p.width - 1))) * p.channels + c]!);

test('io/import-field: without a file the node fails with "No file selected"', async () => {
  await assert.rejects(renderNode(def), /^NodeFailure: No file selected$/);
  await assert.rejects(renderNode(def, { params: { file: '' } }), /^NodeFailure: No file selected$/);
});

test('io/import-field: a file that is missing, is no image, or holds raw samples that make no square fails with the reason', async () => {
  await assert.rejects(renderNode(def, { params: { file: 'nodes/io/assets/missing.png' } }), /File not found/);
  await assert.rejects(renderNode(def, { params: { file: 'nodes/io/import-field.test.ts' } }), /not a PNG, TIFF or OpenEXR image/);
  await assert.rejects(load({ 'odd.r16': raw('u16', Array<number>(10).fill(7)) }, { file: 'odd.r16' }), /10 samples, which is not a square image/);
  // A headerless file is told by its extension alone: under another name its bytes are no image.
  await assert.rejects(load({ 'heights.dat': raw('u16', grid(N, N, () => 7)) }, { file: 'heights.dat' }), /not a PNG, TIFF or OpenEXR image/);
});

test('io/import-field: every format gives its samples as heights: whole numbers as 0..1, floats as they are', async () => {
  const of = (max: number): number[] => grid(N, N, (x, y) => code(heights(x, y), max));
  const floats = grid(N, N, heights);
  const files: Readonly<Record<string, readonly [bytes: Uint8Array, max: number | null]>> = {
    'gray8.png': [png({ width: N, height: N, channels: 1, bits: 8, samples: of(255) }), 255],
    'gray16.png': [png({ width: N, height: N, channels: 1, bits: 16, samples: of(65535) }), 65535],
    'u8.tif': [tiff({ width: N, height: N, channels: 1, sample: 'u8', samples: of(255) }), 255],
    'u16.tiff': [tiff({ width: N, height: N, channels: 1, sample: 'u16', samples: of(65535) }), 65535],
    'float.tif': [tiff({ width: N, height: N, channels: 1, sample: 'f32', samples: floats }), null],
    'float.exr': [exr({ width: N, height: N, channels: { Y: floats } }), null],
    'bytes.r8': [raw('u8', of(255)), 255],
    'words.r16': [raw('u16', of(65535)), 65535],
    'words.RAW': [raw('u16', of(65535)), 65535],
    'floats.r32': [raw('f32', floats), null],
  };
  for (const [name, [bytes, max]] of Object.entries(files)) {
    const out = await load({ [name]: bytes }, { file: name });
    // The image has the size of the grid: the output is the upload, texel for texel and row for row.
    const expected = fieldOf(N, (u, v) => (max === null ? heights(Math.round(u * 32), Math.round(v * 32)) : stored(heights(Math.round(u * 32), Math.round(v * 32)), max)));
    try {
      expectIdentical(out, expected);
    } catch (thrown) {
      throw new Error(`${name}: ${(thrown as Error).message}`);
    }
  }
});

test('io/import-field: the channel of a color image is chosen, brightness is its luma, and an image without alpha is opaque', async () => {
  const r = (x: number): number => 3 * x, g = (_x: number, y: number): number => 5 * y, b = 77, a = (x: number, y: number): number => 100 + x + y;
  const rgba = png({ width: N, height: N, channels: 4, bits: 8, samples: grid(N, N, (x, y) => [r(x), g(x, y), b, a(x, y)]).flat() });
  const rgb = png({ width: N, height: N, channels: 3, bits: 8, samples: grid(N, N, (x, y) => [r(x), g(x, y), b]).flat() });
  const gray = png({ width: N, height: N, channels: 1, bits: 8, samples: grid(N, N, (x) => r(x)) });
  const grayAlpha = png({ width: N, height: N, channels: 2, bits: 8, samples: grid(N, N, (x, y) => [r(x), a(x, y)]).flat() });
  const files = { 'rgba.png': rgba, 'rgb.png': rgb, 'gray.png': gray, 'ga.png': grayAlpha };
  const plane = (fn: (x: number, y: number) => number): FieldData => fieldOf(N, (u, v) => fn(Math.round(u * 32), Math.round(v * 32)));
  const f = (c: number): number => Math.fround(c / 255);

  expectIdentical(await load(files, { file: 'rgba.png' }), plane((x) => f(r(x))));                          // red is the default
  expectIdentical(await load(files, { file: 'rgba.png', channel: 'green' }), plane((x, y) => f(g(x, y))));
  expectIdentical(await load(files, { file: 'rgba.png', channel: 'blue' }), plane(() => f(b)));
  expectIdentical(await load(files, { file: 'rgba.png', channel: 'alpha' }), plane((x, y) => f(a(x, y))));
  const luma = plane((x, y) => 0.2126 * f(r(x)) + 0.7152 * f(g(x, y)) + 0.0722 * f(b));
  expectClose(await load(files, { file: 'rgba.png', channel: 'luma' }), luma, { max: 1e-6 });
  expectClose(await load(files, { file: 'rgb.png', channel: 'luma' }), luma, { max: 1e-6 });
  expectIdentical(await load(files, { file: 'rgb.png', channel: 'alpha' }), fixtures.one(N));
  // A gray image has one channel, which every choice but alpha reads; the alpha of a gray image is not kept.
  for (const channel of ['red', 'green', 'blue', 'luma']) {
    expectIdentical(await load(files, { file: 'gray.png', channel }), plane((x) => f(r(x))));
    expectIdentical(await load(files, { file: 'ga.png', channel }), plane((x) => f(r(x))));
  }
  expectIdentical(await load(files, { file: 'gray.png', channel: 'alpha' }), fixtures.one(N));
});

test('io/import-field: the input range of the file becomes 0..1, without clamping, and a range upside down turns the heights over', async () => {
  // Meters in a float file: 100 at one corner, 900 at the other.
  const meters = (x: number, y: number): number => 100 + 20 * x + 5 * y;
  const files = {
    'dem.exr': exr({ width: N, height: N, channels: { Y: grid(N, N, meters) } }),
    'land.png': png({ width: N, height: N, channels: 1, bits: 16, samples: grid(N, N, (x, y) => code(heights(x, y), 65535)) }),
  };
  const plane = (fn: (x: number, y: number) => number): FieldData => fieldOf(N, (u, v) => fn(Math.round(u * 32), Math.round(v * 32)));
  expectIdentical(await load(files, { file: 'dem.exr' }), plane(meters));
  expectClose(await load(files, { file: 'dem.exr', inMin: 0, inMax: 1000 }), plane((x, y) => meters(x, y) / 1000), { max: 1e-6 });
  expectClose(await load(files, { file: 'dem.exr', inMin: 100, inMax: 900 }), plane((x, y) => (meters(x, y) - 100) / 800), { max: 1e-6 });
  expectClose(await load(files, { file: 'dem.exr', inMin: 1000, inMax: 0 }), plane((x, y) => 1 - meters(x, y) / 1000), { max: 1e-6 });
  expectIdentical(await load(files, { file: 'dem.exr', inMin: 500, inMax: 500 }), fixtures.zero(N));

  // A band of a 16-bit file stretched over the whole range: what lies outside it is below 0 and above 1.
  const band = await load(files, { file: 'land.png', inMin: 0.4, inMax: 0.6 });
  expectClose(band, plane((x, y) => (stored(heights(x, y), 65535) - 0.4) / 0.2), { max: 1e-5 });
  assert.ok(stats(band).min < -1 && stats(band).max > 2, `the band reaches from ${stats(band).min} to ${stats(band).max}`);
});

test('io/import-field: a coarser image keeps its place on the grid: its texels at the shared vertices, the filter between them', async () => {
  // 9 x 9 onto 33 x 33: every fourth vertex is a texel of the image.
  const coarse = picture(9, 9, 1, (x, y) => heights(4 * x, 4 * y));
  const files = { 'coarse.r32': raw('f32', coarse.data) };
  const linear = await load(files, { file: 'coarse.r32', filter: 'linear' });
  const cubic = await load(files, { file: 'coarse.r32', filter: 'cubic' });
  const nearest = await load(files, { file: 'coarse.r32', filter: 'nearest' });
  for (const out of [linear, cubic, nearest]) expectIdentical(decimate(out, 2), asField(coarse));

  expectClose(linear, onGrid(coarse, N, 'linear'), { max: 1e-6 });
  expectClose(cubic, onGrid(coarse, N, 'cubic'), { max: 1e-5 });
  // Nearest gives blocks: every texel is one of the image's texels around it.
  let foreign = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const around = [[Math.floor(x / 4), Math.floor(y / 4)], [Math.ceil(x / 4), Math.floor(y / 4)], [Math.floor(x / 4), Math.ceil(y / 4)], [Math.ceil(x / 4), Math.ceil(y / 4)]];
      if (!around.some(([i, j]) => at(nearest, x, y) === coarse.data[j! * 9 + i!])) foreign++;
    }
  }
  assert.equal(foreign, 0, 'texels of the nearest reading that are no texel of the image');

  // The cubic follows smooth ground more closely than straight lines do: hills eight texels of the image long.
  const hills = (u: number, v: number): number => 0.5 + 0.3 * Math.sin(2 * Math.PI * u) * Math.cos(2 * Math.PI * v);
  const smooth = { 'hills.r32': raw('f32', grid(9, 9, (x, y) => hills(x / 8, y / 8))) };
  const truth = fieldOf(N, hills);
  const error = (out: FieldData): number => Math.sqrt(out.data.reduce((sum, v, i) => sum + (v - truth.data[i]!) ** 2, 0) / out.data.length);
  const [byCubic, byLines] = [error(await load(smooth, { file: 'hills.r32', filter: 'cubic' })), error(await load(smooth, { file: 'hills.r32', filter: 'linear' }))];
  assert.ok(byCubic < 0.5 * byLines, `rms ${byCubic} with the cubic, ${byLines} with straight lines`);
  // A cubic through heights is not held back: beside a cliff it dips below the foot and rises above the top, by
  // 0.074 of the step at the most (2 / 27). Straight lines never leave the heights of the image.
  const cliff = { 'cliff.r8': raw('u8', grid(9, 9, (x) => (x < 4 ? 0 : 255))) };
  const curved = stats(await load(cliff, { file: 'cliff.r8', filter: 'cubic' }));
  assert.ok(Math.abs(curved.min + 2 / 27) < 0.01 && Math.abs(curved.max - 1 - 2 / 27) < 0.01, `the cubic reaches from ${curved.min} to ${curved.max}`);
  const straight = stats(await load(cliff, { file: 'cliff.r8', filter: 'linear' }));
  assert.deepEqual([straight.min, straight.max], [0, 1]);
});

test('io/import-field: a strip finer than the grid along one side and coarser along the other is curved along the coarse side', async () => {
  // 129 x 9 onto 33 x 33: four texels of the strip per vertex along x, four vertices per texel along y.
  const hills = (u: number, v: number): number => 0.5 + 0.3 * Math.sin(2 * Math.PI * u) * Math.cos(2 * Math.PI * v);
  const strip = picture(129, 9, 1, (x, y) => hills(x / 128, y / 8));
  // The cubic through the nine rows at every texel of the strip's long side, which the node then averages as it
  // averages any image finer than the grid.
  const curved = onGrid(strip, 129, 'cubic');
  const files = {
    'strip.tif': tiff({ width: 129, height: 9, channels: 1, sample: 'f32', samples: strip.data }),
    'curved.r32': raw('f32', curved.data),
    'upright.tif': tiff({ width: 9, height: 129, channels: 1, sample: 'f32', samples: picture(9, 129, 1, (x, y) => hills(y / 128, x / 8)).data }),
  };
  const cubic = await load(files, { file: 'strip.tif', filter: 'cubic' });
  expectClose(cubic, await load(files, { file: 'curved.r32', filter: 'linear' }), { max: 1e-5 });
  // Straight lines between the nine rows miss the hills between them by more than twice as much.
  const lines = await load(files, { file: 'strip.tif', filter: 'linear' });
  const truth = fieldOf(N, hills);
  const error = (out: FieldData): number => Math.sqrt(out.data.reduce((sum, v, i) => sum + (v - truth.data[i]!) ** 2, 0) / out.data.length);
  assert.ok(error(cubic) < 0.5 * error(lines), `rms ${error(cubic)} with the cubic, ${error(lines)} with straight lines`);
  // The other way round: a strip that stands upright is the same picture turned.
  const upright = await load(files, { file: 'upright.tif', filter: 'cubic' });
  expectClose(upright, fieldOf(N, (u, v) => at(cubic, Math.round(v * (N - 1)), Math.round(u * (N - 1)))), { max: 1e-5 });
});

test('io/import-field: a range far narrower than the values of a float file gives large heights, never ones that are no number', async () => {
  const LARGEST = 3.4028234663852886e38;
  const files = { 'huge.r32': raw('f32', grid(N, N, (x, y) => (x === 0 ? 3e38 : x === 1 ? -3e38 : y === 0 ? 0 : 1))) };
  for (const inMax of [0.25, 1e-300, 5e-324]) {
    const out = await load(files, { file: 'huge.r32', inMin: 0, inMax });
    const { min, max, nonFinite } = stats(out);
    assert.deepEqual([nonFinite, min, max], [0, -LARGEST, LARGEST], `with a range of ${inMax}`);
    // What lies on the minimum stays 0, however narrow the range.
    assert.equal(at(out, 5, 0), 0);
  }
});

test('io/import-field: a finer image is averaged onto the grid, not skipped through; only Nearest takes single texels', async () => {
  // 257 x 257 onto 33 x 33: a slow shape under a checkerboard of single texels, which eight texels a side average away.
  const shape = (u: number, v: number): number => 0.5 + 0.3 * Math.sin(2 * Math.PI * u) * Math.cos(2 * Math.PI * v);
  const fine = grid(257, 257, (x, y) => code(shape(x / 256, y / 256) + ((x + y) % 2 === 0 ? 0.05 : -0.05), 65535));
  const files = { 'fine.r16': raw('u16', fine) };
  const smooth = fieldOf(N, shape);
  const linear = await load(files, { file: 'fine.r16', filter: 'linear' });
  // Inside: on the border the triangle is cut, and holds one color of the checkerboard more than the other.
  expectClose(inner(linear, 1), inner(smooth, 1), { max: 5e-3 });
  assert.ok(Math.abs(at(linear, 0, 0) - 0.5) < 0.03, 'and there it is off by less than the checkerboard');
  expectIdentical(await load(files, { file: 'fine.r16', filter: 'cubic' }), linear);
  const nearest = await load(files, { file: 'fine.r16', filter: 'nearest' });
  // Every eighth texel of the image: all of one color of the checkerboard.
  expectClose(nearest, fieldOf(N, (u, v) => shape(u, v) + 0.05), { max: 2e-5 });
});

test('io/import-field: an image that is not square is stretched, shown whole on level ground, or cut to its middle', async () => {
  const value = (x: number, y: number): number => 0.1 + 0.04 * x + 0.03 * y;
  const wide = picture(17, 9, 1, value), tall = picture(9, 17, 1, value);
  const files = {
    'wide.tif': tiff({ width: 17, height: 9, channels: 1, sample: 'f32', samples: wide.data }),
    'tall.tif': tiff({ width: 9, height: 17, channels: 1, sample: 'f32', samples: tall.data }),
    'square.tif': tiff({ width: 9, height: 9, channels: 1, sample: 'f32', samples: grid(9, 9, value) }),
    // 65 x 33 and 33 x 17: their squares have the size of the grid, so the placing can be read texel by texel.
    'long.tif': tiff({ width: 65, height: 33, channels: 1, sample: 'f32', samples: grid(65, 33, value) }),
    'low.tif': tiff({ width: 33, height: 17, channels: 1, sample: 'f32', samples: grid(33, 17, value) }),
  };
  for (const [name, p] of [['wide.tif', wide], ['tall.tif', tall]] as const) {
    for (const fit of ['stretch', 'contain', 'cover'] as const) {
      for (const filter of ['linear', 'cubic'] as const) {
        const out = await load(files, { file: name, fit, filter });
        // Shown whole and read with the cubic, the picture is read within itself and the ground beside it is level.
        const expected = fit === 'contain' && filter === 'cubic' ? onGrid(p, N, 'cubic', 0, false, { beside: 0 }) : onGrid(squared(p, fit, [0]), N, filter);
        expectClose(out, expected, { max: 1e-5 });
      }
    }
  }
  // The cubic does not reach across the border of a picture that is shown whole: no trench in the level ground
  // along it and no rim on the picture, whose heights here lie between 0.1 and 0.98.
  const whole = stats(await load(files, { file: 'wide.tif', fit: 'contain', filter: 'cubic' }));
  assert.ok(whole.min === 0 && whole.max <= 0.98 + 1e-6, `the heights reach from ${whole.min} to ${whole.max}`);
  // Stretched, the corners of the image are the corners of the terrain.
  const stretched = await load(files, { file: 'wide.tif', fit: 'stretch', filter: 'linear' });
  assert.deepEqual([at(stretched, 0, 0), at(stretched, 32, 0), at(stretched, 0, 32), at(stretched, 32, 32)].map((v) => Math.round(v * 100)), [10, 74, 34, 98]);

  // Cover: the middle 33 columns of 65. Contain: the 17 rows in the middle of 33, and height 0 above and below.
  expectIdentical(await load(files, { file: 'long.tif', fit: 'cover' }), fieldOf(N, (u, v) => value(Math.round(u * 32) + 16, Math.round(v * 32))));
  expectIdentical(await load(files, { file: 'low.tif', fit: 'contain' }), fieldOf(N, (u, v) => {
    const y = Math.round(v * 32);
    return y >= 8 && y <= 24 ? value(Math.round(u * 32), y - 8) : 0;
  }));

  // A square image is placed the same way whatever the fit.
  const square = await load(files, { file: 'square.tif', fit: 'stretch' });
  expectIdentical(await load(files, { file: 'square.tif', fit: 'contain' }), square);
  expectIdentical(await load(files, { file: 'square.tif', fit: 'cover' }), square);
});

test('io/import-field: a file that changes is read again, and one that did not is not', async () => {
  const image = (level: number): Uint8Array => png({ width: N, height: N, channels: 1, bits: 8, samples: grid(N, N, () => level) });
  const files = memorySource({ 'a.png': image(51) });
  const session = await openGraph({ nodes: { img: { type: def.type, params: { file: 'a.png' } } } });
  try {
    const run = async (): Promise<readonly [string, number | null]> => {
      const { fields, report } = await session.evaluate(['img.out'], { files, res: N });
      return [report.nodes.img!.state, fields['img.out'] ? at(fields['img.out'], 5, 5) : null];
    };
    assert.deepEqual(await run(), ['done', Math.fround(0.2)]);
    assert.deepEqual(await run(), ['cached', Math.fround(0.2)], 'an untouched file leaves the node cached');
    // The same bytes saved again: the file's time changed, so the node runs.
    files.put('a.png', image(51));
    assert.deepEqual(await run(), ['done', Math.fround(0.2)]);
    files.put('a.png', image(204));
    assert.deepEqual(await run(), ['done', Math.fround(0.8)], 'other content is other heights');
    assert.deepEqual(await run(), ['cached', Math.fround(0.8)]);
    files.remove('a.png');
    const { report } = await session.evaluate(['img.out'], { files, res: N });
    assert.deepEqual([report.nodes.img!.state, report.nodes.img!.error?.kind], ['error', 'io']);
    assert.match(report.nodes.img!.error!.message, /File not found/);
  } finally {
    await session.close();
  }
});

test('io/import-field: the placed image is the same at two levels of the ladder', async () => {
  for (const filter of ['linear', 'cubic']) {
    const levels = await renderLadder(def, { params: { file: TERRAIN, filter } });
    expectLadder(levels[257]!.out!, levels[513]!.out!, { max: 1e-6 });
  }
  // On a grid coarser than the image the texels are averaged: the levels agree as two averages of one terrain do.
  const levels = await renderLadder(def, { params: { file: TERRAIN }, resolutions: [65, 129] });
  expectLadder(levels[65]!.out!, levels[129]!.out!, { rel: 0.2 });
});
