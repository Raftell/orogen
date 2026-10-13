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

import { inputPicture, picturesOf, writePicture } from '../../../src/cli/pictures.ts';
import type { Picture, Raster } from '../../../src/cli/preview.ts';
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

test('a data output is drawn with the range of its own values, a mask with 0..1, and both over the terrain they are given', () => {
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

test('what an input was given is drawn at one pixel per texel: a terrain shaded, the mask black to white, a colouring as its colours', () => {
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
