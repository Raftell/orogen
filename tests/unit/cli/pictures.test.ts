// Which pictures `render` makes of an output and how one is written (testing.md 8.6), and what a rendered
// node's record comes to as an exit code. No device: the fields are made here.
//
// Sizes: fields of 65 x 65; one picture of 1300 x 1200 pixels (4.7 MB), written, decoded and compared in a loop.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { decode } from 'fast-png';

import { inputPicture, picturesOf, viewIsLit, writePicture } from '../../../src/cli/pictures.ts';
import { drawPreview, toneOf, type Picture, type Raster } from '../../../src/cli/preview.ts';
import { describeError, exitCodeOf, HARD_CEILING_MS, overran, type RenderResult } from '../../../src/cli/result.ts';
import { NodeFileSink } from '../../../src/platform/node/files.ts';

const RES = 65;
const SCALE = { terrainSize: 4096, heightRange: 1024 };

function field(fn: (u: number, v: number) => number): Raster {
  const data = new Float32Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) data[y * RES + x] = fn(x / (RES - 1), y / (RES - 1));
  return { kind: 'field', width: RES, height: RES, channels: 1, data };
}
function color(fn: (u: number, v: number) => readonly [number, number, number]): Raster {
  const data = new Float32Array(RES * RES * 4);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) data.set([...fn(x / (RES - 1), y / (RES - 1)), 1], (y * RES + x) * 4);
  }
  return { kind: 'color', width: RES, height: RES, channels: 4, data };
}

const hills = field((u, v) => 0.5 + 0.2 * Math.sin(7 * u) * Math.cos(5 * v));
const pixel = (picture: Picture, x: number, y: number): number[] => [...picture.rgb.subarray((y * picture.width + x) * 3, (y * picture.width + x) * 3 + 3)];
const sizes = (pictures: readonly { readonly suffix: string; draw(): Picture }[]): string[] =>
  pictures.map(({ suffix, draw }) => {
    const picture = draw();
    return `${suffix}:${picture.width}x${picture.height}`;
  });

test('a field is a sheet, and with --crop also a hillshade of the centre window at one texel per pixel', () => {
  assert.deepEqual(sizes(picturesOf({}, hills, null, SCALE, null)), [':1808x512']);
  assert.deepEqual(sizes(picturesOf({ role: 'height' }, hills, null, SCALE, 32)), [':1808x512', '-crop:32x32']);
  assert.deepEqual(sizes(picturesOf({ role: 'mask' }, hills, hills, SCALE, 65)), [':1808x512', '-crop:65x65']);
});

test('a colour is a color picture, a 3d view over its terrain when there is one, and with --crop the centre window', () => {
  const paint = color((u, v) => [u, v, 0.25]);
  assert.deepEqual(sizes(picturesOf({}, paint, null, SCALE, null)), [':65x65']);
  assert.deepEqual(sizes(picturesOf({}, paint, hills, SCALE, null)), [':65x65', '-3d:768x512']);
  assert.deepEqual(sizes(picturesOf({}, paint, hills, SCALE, 3)), [':65x65', '-3d:768x512', '-crop:3x3']);

  // The crop is the centre window: its middle pixel is the middle texel of the whole picture, and its corner the texel one up and left.
  const [whole, , crop] = picturesOf({}, paint, hills, SCALE, 3).map(({ draw }) => draw()) as [Picture, Picture, Picture];
  assert.deepEqual(pixel(crop, 1, 1), pixel(whole, 32, 32));
  assert.deepEqual(pixel(crop, 0, 0), pixel(whole, 31, 31));
  assert.deepEqual(pixel(crop, 2, 2), pixel(whole, 33, 33));
  assert.notDeepEqual(pixel(crop, 0, 0), pixel(crop, 2, 2));

  // The 3d view shows the colour on the terrain: it is not grey, and not the background alone.
  const view = picturesOf({}, color(() => [0.8, 0.1, 0.1]), hills, SCALE, null)[1]!.draw();
  let red = 0;
  for (let i = 0; i < view.rgb.length; i += 3) if (view.rgb[i]! > view.rgb[i + 2]! + 40) red++;
  assert.ok(red > 20_000, `${red} of ${view.width * view.height} pixels show the colour`);
});

test('a data output is drawn on the scale of its own values, a mask with 0..1, and both over the terrain they are given', () => {
  // What a simulation reports per texel: small numbers, far from 1.
  const moved = field((u) => 0.002 * u);
  const brightest = (picture: Picture): number => {
    let most = 0;
    // The first panel of a sheet, 512 pixels wide, is the grey picture.
    for (let y = 0; y < 512; y += 8) for (let x = 0; x < 512; x += 8) most = Math.max(most, picture.rgb[(y * picture.width + x) * 3]!);
    return most;
  };
  assert.ok(brightest(picturesOf({ role: 'data' }, moved, null, SCALE, null)[0]!.draw()) >= 250, 'the largest value of a data field is drawn white');
  assert.ok(brightest(picturesOf({ role: 'mask' }, moved, null, SCALE, null)[0]!.draw()) <= 2, 'a mask is drawn on 0..1: one that is nearly 0 everywhere is black');

  // Over a terrain the second panel is that terrain, tinted where the field is high: on the right for this one.
  const over = picturesOf({ role: 'data' }, moved, hills, SCALE, null)[0]!.draw();
  const tint = (x: number): number => {
    const [r, , b] = pixel(over, 512 + 8 + x, 256);
    return r! - b!;
  };
  assert.ok(tint(500) > 40, `the right edge is tinted by ${tint(500)}`);
  assert.ok(Math.abs(tint(4)) <= 6, `the left edge is not tinted: ${tint(4)}`);
  // Without a terrain the field itself is the surface: grey everywhere.
  const alone = picturesOf({ role: 'data' }, moved, null, SCALE, null)[0]!.draw();
  assert.deepEqual([pixel(alone, 512 + 8 + 500, 256)[0]! - pixel(alone, 512 + 8 + 500, 256)[2]!], [0]);
});

test('a data output that spans orders of magnitude is drawn by the logarithm of its values, and its crop on the scale of its sheet', () => {
  // A drainage area: one cell's worth on the slopes, and a stream across the middle that gathers three decades
  // from left to right. The largest value is 150 times the mean: drawn linearly the picture is black.
  const flow = field((u, v) => (Math.abs(v - 0.5) < 0.03 ? 1e-5 * 1000 ** u : 1e-6));
  const tone = toneOf(flow, 'data');
  // White is the largest value. Black is the first percentile of the positive values, the slopes, which is a ten-thousandth of it here.
  assert.deepEqual(tone, { lo: Math.fround(1e-6), hi: Math.fround(1e-2), log: true });
  const [sheet, crop] = picturesOf({ role: 'data' }, flow, null, SCALE, 5);
  assert.deepEqual([sheet!.tone, crop!.tone], [tone, tone], 'the page is told the scale, and the crop has that of the sheet');
  // The grey panel of the sheet, along the stream: every decade has its share of the greys. Drawn linearly the
  // middle of the stream, a thirtieth of the largest value, would be 8 of 255.
  const grey = (picture: Picture, x: number): number => pixel(picture, x, 256)[0]!;
  const drawn = sheet!.draw();
  assert.ok(Math.abs(grey(drawn, 2) - 64) <= 3 && Math.abs(grey(drawn, 256) - 159) <= 6 && grey(drawn, 509) === 255, `the stream is drawn ${grey(drawn, 2)}, ${grey(drawn, 256)} and ${grey(drawn, 509)}`);
  assert.deepEqual(pixel(drawn, 256, 100), [0, 0, 0], 'the slopes are the foot of the scale');
  // The centre window, five texels of the stream of nearly one value: on the scale of the whole field they are one grey, not black to white.
  const window = drawPreview(flow, { style: 'grey', range: crop!.tone!, crop: [30, 30, 5] });
  assert.ok(Math.abs(pixel(window, 0, 2)[0]! - pixel(window, 4, 2)[0]!) < 20 && pixel(window, 2, 2)[0]! > 140, `the window runs from ${pixel(window, 0, 2)[0]} to ${pixel(window, 4, 2)[0]}`);

  // Zero, and whatever lies below the foot of the scale, is nothing: black, and not the blue of a value out of range.
  const rivers = field((u, v) => (Math.abs(v - 0.5) < 0.03 ? 1e-5 * 1000 ** u : 0));
  assert.deepEqual(toneOf(rivers, 'data'), { lo: Math.fround(1e-5), hi: Math.fround(1e-2), log: true });
  const lines = drawPreview(rivers, { style: 'grey', range: 'data' });
  assert.deepEqual([pixel(lines, 32, 4), pixel(lines, 64, 32)], [[0, 0, 0], [255, 255, 255]]);
  assert.ok(pixel(lines, 32, 32)[0]! > 90, `a river a thirtieth as deep as the deepest is drawn ${pixel(lines, 32, 32)[0]}`);
  // A logarithmic scale reaches four decades below the largest value and no further.
  assert.deepEqual(toneOf(field((u, v) => (v < 0.05 ? 10 ** (-9 + 9 * u) : 0)), 'data'), { lo: 1e-4, hi: 1, log: true });
});

test('a data output whose largest value is within a hundred times its mean, or that holds negative values, keeps the range of its own values', () => {
  // What a relaxation moved: the largest value twice the mean.
  assert.deepEqual(toneOf(field((u) => 0.002 * u), 'data'), { lo: 0, hi: Math.fround(0.002), log: false });
  // A field that spans three decades evenly: its mean is a seventh of its largest value, and the picture is not black.
  assert.equal(toneOf(field((u) => 1e-5 * 1000 ** u), 'data').log, false);
  // A sparse field whose values are of one size: the depth of a lake that takes a thirtieth of the terrain.
  assert.equal(toneOf(field((u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.1 ? 0.03 + 0.02 * u : 0)), 'data').log, false);
  // An index that goes below zero has no logarithm.
  assert.deepEqual(toneOf(field((u, v) => (v < 0.05 ? -2 + 1001 ** u : -1)), 'data'), { lo: -1, hi: 999, log: false });
  // Nothing above zero, a constant, and nothing finite at all.
  assert.deepEqual(toneOf(field(() => 0), 'data'), { lo: 0, hi: 0, log: false });
  assert.deepEqual(toneOf(field(() => 0.25), 'data'), { lo: 0.25, hi: 0.25, log: false });
  assert.deepEqual(toneOf(field(() => Number.NaN), 'data'), { lo: 0, hi: 1, log: false });
  // The other ranges are what they were: 0..1 unless given, and 'auto' the smallest and largest value whatever the spread.
  const flow = field((u, v) => (Math.abs(v - 0.5) < 0.03 ? 1e-5 * 1000 ** u : 1e-6));
  assert.deepEqual([toneOf(flow, undefined), toneOf(flow, [0, 2]), toneOf(flow, 'auto')], [{ lo: 0, hi: 1, log: false }, { lo: 0, hi: 2, log: false }, { lo: Math.fround(1e-6), hi: Math.fround(1e-2), log: false }]);
  assert.throws(() => toneOf(flow, { lo: 0, hi: 1, log: true }), /above 0 for a logarithmic one/);
  assert.throws(() => toneOf(flow, [2, 1]), /not a pair of numbers in order/);
});

test('a colour over its terrain is lit from the viewer\'s side: the slopes the view faces are the bright ones', () => {
  const paint = color(() => [0.5, 0.5, 0.5]);
  /** The centre of the 3d view of the colour over a plane that falls by `fall` heights per terrain width towards the viewer. */
  const centre = (fall: number, lit = true): number => pixel(picturesOf({}, paint, field((_, v) => 0.5 - fall * (v - 0.5)), SCALE, null, lit)[1]!.draw(), 384, 256)[0]!;
  // With the scale of these pictures a fall of one height across the terrain is a slope of 14 degrees.
  const level = centre(0), facing = centre(1), away = centre(-1);
  // Level ground keeps four fifths of the colour, which is 188 of 255 as it is.
  assert.ok(Math.abs(level - 0.81 * 188) <= 2, `level ground is drawn ${level}`);
  assert.ok(facing > level + 8 && facing <= 188, `a slope that faces the viewer is drawn ${facing}, level ground ${level}`);
  assert.ok(away < level - 8, `a slope that faces away is drawn ${away}, level ground ${level}`);
  // The light of a shaded field comes from the far side: there the slope that faces the viewer is the dark one.
  // The view of a field keeps that light, so that it is its top view tilted.
  const shaded = (fall: number): number => pixel(drawPreview(field((_, v) => 0.5 - fall * (v - 0.5)), { style: '3d', ...SCALE }), 384, 256)[0]!;
  assert.ok(shaded(1) < shaded(0) - 15 && shaded(-1) > shaded(0), `as a shaded field the facing slope is drawn ${shaded(1)}, level ground ${shaded(0)}, the slope that faces away ${shaded(-1)}`);

  // A colour that is itself a lit rendering is drawn as it is: its own light and no other.
  assert.deepEqual([viewIsLit('color/hillshade'), viewIsLit('color/natural'), viewIsLit('ref/colorize')], [false, true, true]);
  assert.deepEqual([centre(0, false), centre(1, false), centre(-1, false)], [188, 188, 188]);
});

test('what an input was given is drawn at one pixel per texel: a terrain shaded, the mask black to white, a colouring as its colours, a named feed as what it is', () => {
  const terrain = inputPicture('terrain', hills, SCALE);
  assert.deepEqual([terrain.width, terrain.height], [RES, RES]);
  // Shaded: the slope that faces the light is brighter than the one that faces away, and no pixel is tinted.
  const greys = new Set<number>();
  for (let i = 0; i < terrain.rgb.length; i += 3) {
    assert.ok(terrain.rgb[i] === terrain.rgb[i + 1] && terrain.rgb[i] === terrain.rgb[i + 2], 'a shaded terrain is grey');
    greys.add(terrain.rgb[i]!);
  }
  assert.ok(greys.size > 20, `the relief shows in ${greys.size} shades`);

  // The mask is its values, 0 black and 1 white: a picture of where a node is let act.
  const mask = inputPicture('mask', field((u) => (u < 0.5 ? 0 : 1)), SCALE);
  assert.deepEqual([pixel(mask, 4, 30), pixel(mask, 60, 30)], [[0, 0, 0], [255, 255, 255]]);
  // A colouring is drawn as its colours, whatever kind of input it feeds.
  const paint = inputPicture('color', color(() => [1, 0, 0]), SCALE);
  assert.deepEqual(pixel(paint, 10, 10), [255, 0, 0]);
  assert.deepEqual(pixel(inputPicture('terrain', color(() => [0, 0, 1]), SCALE), 10, 10), [0, 0, 255], 'a colour that feeds an input of either kind');

  // What an input is given by its name: a landform shaded as a terrain is, the snow black to white as the mask is,
  // the drainage on the scale of a data field.
  const stamp = inputPicture('stamp', hills, SCALE);
  let different = 0;
  for (let i = 0; i < stamp.rgb.length; i++) if (stamp.rgb[i] !== terrain.rgb[i]) different++;
  assert.equal(different, 0, 'a landform is drawn as a terrain');
  assert.deepEqual([pixel(inputPicture('snow', field((u) => (u < 0.5 ? 0 : 1)), SCALE), 4, 30), pixel(inputPicture('snow', field((u) => (u < 0.5 ? 0 : 1)), SCALE), 60, 30)], [[0, 0, 0], [255, 255, 255]]);
  const drainage = inputPicture('flow', field((u, v) => (Math.abs(v - 0.5) < 0.03 ? 1e-5 * 1000 ** u : 1e-6)), SCALE);
  assert.ok(Math.abs(pixel(drainage, 32, 32)[0]! - 159) <= 6 && pixel(drainage, 32, 4)[0] === 0, `the middle of the stream is drawn ${pixel(drainage, 32, 32)[0]}`);
});

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-cli-pictures-'));
after(() => fs.rmSync(folder, { recursive: true, force: true }));

test('a picture is written as an 8-bit RGB PNG that decodes to the same pixels, whole or not at all', async () => {
  // Larger than one strip handed to the encoder (4 MiB), so the rows arrive in two calls.
  const width = 1300, height = 1200;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7 + (i >> 9)) & 0xff;
  const sink = NodeFileSink(folder);
  await writePicture(sink, 'nodes/ref/fbm/out-513.png', { width, height, rgb });

  assert.deepEqual(fs.readdirSync(path.join(folder, 'nodes', 'ref', 'fbm')), ['out-513.png'], 'no partial file is left beside it');
  const png = decode(fs.readFileSync(path.join(folder, 'nodes', 'ref', 'fbm', 'out-513.png')));
  assert.deepEqual([png.width, png.height, png.channels, png.depth], [width, height, 3, 8]);
  let differing = 0, first = -1;
  for (let i = 0; i < rgb.length; i++) {
    if (png.data[i] === rgb[i]) continue;
    if (first < 0) first = i;
    differing++;
  }
  assert.equal(differing, 0, `${differing} bytes differ, the first at ${first}`);

  // A path the sink refuses: nothing is written.
  await assert.rejects(writePicture(sink, '../outside.png', { width: 1, height: 1, rgb: new Uint8Array(3) }), /is not a relative path/);
  assert.equal(fs.existsSync(path.join(folder, '..', 'outside.png')), false);
  // A picture whose pixels are not width x height x 3 bytes is refused by the encoder, and its file does not appear.
  await assert.rejects(writePicture(sink, 'broken.png', { width: 4, height: 4, rgb: new Uint8Array(10) }), RangeError);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['nodes']);
});

const base: RenderResult = {
  type: 'ref/fbm', res: 513, status: 'ok', errors: [], wallMs: 3, gpuMs: 1, peakBytes: 1_052_676,
  longestSliceMs: 12, longestSliceKernels: ['ref/fbm'], engineErrors: [], files: [], pictures: {}, views: {}, inputs: [],
};

test('the exit code of a rendered node: 0, 1 for a failed node or a slice above the hard ceiling or a stray GPU error, 3 for a lost device, 130 when cancelled', () => {
  assert.equal(HARD_CEILING_MS, 500);
  assert.equal(exitCodeOf(base), 0);
  assert.equal(exitCodeOf({ ...base, longestSliceMs: 500 }), 0, 'the ceiling itself is allowed');
  assert.equal(exitCodeOf({ ...base, longestSliceMs: 500.5 }), 1);
  assert.equal(exitCodeOf({ ...base, engineErrors: ['Validation error'] }), 1);
  assert.equal(exitCodeOf({ ...base, status: 'errors' }), 1);
  assert.equal(exitCodeOf({ ...base, status: 'aborted', longestSliceMs: 900 }), 130);
  assert.equal(exitCodeOf({ ...base, status: 'device-lost', engineErrors: ['x'] }), 3);
  assert.deepEqual([overran(base), overran({ ...base, longestSliceMs: 501 }), overran({ ...base, engineErrors: ['x'] })], [false, true, true]);
});

test('a failed node in words: the sentence, then the kernel, the place in the shader and the detail', () => {
  assert.equal(
    describeError({ nodeId: 'talus', nodeType: 'ref/talus', kind: 'missing-input', message: 'missing input "in"' }, true),
    'ref/talus (node "talus") failed, missing-input: missing input "in"',
  );
  // The ids of a document made for a node type are random: they are left out.
  assert.equal(describeError({ nodeId: 'k3j2h1g0f9', nodeType: 'ref/image', kind: 'node-exception', message: 'No file selected' }, false), 'ref/image failed, node-exception: No file selected');
  const compile = describeError({
    nodeId: 'a', nodeType: 'filter/blur', kind: 'shader-compile', message: 'kernel "filter/blur.pass": unresolved value',
    kernel: 'filter/blur.pass', detail: 'the whole message\nof the compiler',
    wgsl: { origin: 'code', line: 4, column: 9, length: 3, message: 'unresolved value', excerpt: ['fn compute() {', '  let a = foo;', '}'] },
  }, true);
  assert.deepEqual(compile.split('\n'), [
    'filter/blur (node "a") failed, shader-compile: kernel "filter/blur.pass": unresolved value',
    '  kernel: filter/blur.pass',
    '  code, line 4, column 9: unresolved value',
    '    fn compute() {', '      let a = foo;', '    }',
    '  the whole message', '  of the compiler',
  ]);
  // A detail that only repeats the message is not printed twice, and a long one is cut.
  assert.equal(describeError({ nodeId: 'a', nodeType: 'ref/fail', kind: 'node-exception', message: 'Boom', detail: 'Boom' }, false).split('\n').length, 1);
  const long = describeError({ nodeId: 'a', nodeType: 'ref/fail', kind: 'node-exception', message: 'Boom', detail: Array.from({ length: 40 }, (_, i) => `at frame ${i}`).join('\n') }, false);
  assert.equal(long.split('\n').length, 13);
});
