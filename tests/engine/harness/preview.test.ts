// writePreview and the five styles of testing.md 2.7, read back from the files it writes: sizes, the colour of
// known texels, that nothing is flipped or mirrored, and that a shaded terrain has mid-tones. The bytes of a
// picture are for a person; these tests decode them only to check what the styles promise. No device.
//
// Sizes: pictures of at most 1808 x 512 pixels; pixels are read one at a time.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decode } from 'fast-png';

import { colorOf, fieldOf, fixtures, writePreview, type FieldData, type PreviewOptions } from '../../helpers/index.ts';

interface Picture { readonly width: number; readonly height: number; at(x: number, y: number): readonly [number, number, number] }

async function draw(name: string, f: FieldData, opts?: PreviewOptions): Promise<Picture> {
  const file = await writePreview(`harness/preview/${name}`, f, opts);
  const png = decode(readFileSync(file));
  assert.deepEqual([png.channels, png.depth], [3, 8], 'an 8-bit RGB PNG');
  const { width, height, data } = png;
  return { width, height, at: (x, y) => [data[(y * width + x) * 3]!, data[(y * width + x) * 3 + 1]!, data[(y * width + x) * 3 + 2]!] };
}

const BACKGROUND = [0x1a, 0x1a, 0x1a];
/** The intensity of 2.7 for a surface whose height rises by `dx` and `dy` metres per metre, as a byte. */
function shade(dx: number, dy: number): number {
  const norm = Math.hypot(dx, dy, 1);
  const wrapped = 0.5 + 0.5 * ((0.5 * dx + 0.5 * dy + Math.SQRT1_2) / norm);
  return Math.round(255 * (0.10 + 0.80 * wrapped * wrapped));
}
const isGrey = (rgb: readonly number[]): boolean => rgb[0] === rgb[1] && rgb[1] === rgb[2];

test('grey: the range from black to white, blue below it, red above, magenta where a value is not finite', async () => {
  // Values by texel: a ramp in x, with marked texels in rows 1 to 3.
  const f = fieldOf(65, (u, v) => (v === 1 / 64 && u === 0.25 ? -0.01 : v === 2 / 64 && u === 0.5 ? 1.01 : v === 3 / 64 && u === 0.75 ? NaN : u));
  const picture = await draw('grey', f, { style: 'grey' });
  assert.deepEqual([picture.width, picture.height], [65, 65], 'pixel (x, y) is texel (x, y)');
  assert.deepEqual(picture.at(0, 0), [0, 0, 0]);
  assert.deepEqual(picture.at(64, 0), [255, 255, 255]);
  assert.deepEqual(picture.at(32, 40), [128, 128, 128]);
  assert.deepEqual(picture.at(16, 1), [0, 0, 255], 'below the range');
  assert.deepEqual(picture.at(32, 2), [255, 0, 0], 'above the range');
  assert.deepEqual(picture.at(48, 3), [255, 0, 255], 'not finite');
  assert.deepEqual(picture.at(48, 4), [191, 191, 191], 'the row below is untouched: nothing is flipped');

  // Row 0 is the top row: a ramp in v is black at the top.
  const down = await draw('grey-rows', fixtures.rampY(33), { style: 'grey' });
  assert.deepEqual([down.at(7, 0), down.at(7, 32)], [[0, 0, 0], [255, 255, 255]]);

  const ranged = await draw('grey-range', fixtures.rampX(65), { style: 'grey', range: [0.25, 0.75] });
  assert.deepEqual([ranged.at(15, 9), ranged.at(16, 9), ranged.at(32, 9), ranged.at(48, 9), ranged.at(49, 9)], [[0, 0, 255], [0, 0, 0], [128, 128, 128], [255, 255, 255], [255, 0, 0]]);
  const auto = await draw('grey-auto', fieldOf(65, (u) => 10 + 5 * u), { style: 'grey', range: 'auto' });
  assert.deepEqual([auto.at(0, 0), auto.at(64, 64)], [[0, 0, 0], [255, 255, 255]], "'auto' is [min, max]");
});

test("grey with the range 'data': the range of the values, or their logarithm where the largest is more than a hundred times the mean", async () => {
  // What a relaxation moved: the largest value twice the mean, so black to white from its smallest to its largest value, as 'auto' draws it.
  const moved = await draw('grey-data-linear', fieldOf(65, (u) => 0.002 * u), { style: 'grey', range: 'data' });
  assert.deepEqual([moved.at(0, 3), moved.at(32, 3), moved.at(64, 3)], [[0, 0, 0], [128, 128, 128], [255, 255, 255]]);
  // The depth of a river across the middle, three decades from left to right, on a terrain where there is none
  // elsewhere: the middle of it, a thirtieth of the largest value, is mid-grey and not the 8 of 255 a linear
  // scale gives it. Zero is black, and not the blue of a value out of range.
  const river = fieldOf(65, (u, v) => (Math.abs(v - 0.5) < 0.03 ? 1e-5 * 1000 ** u : 0));
  const drawn = await draw('grey-data-log', river, { style: 'grey', range: 'data' });
  assert.deepEqual([drawn.at(64, 32), drawn.at(20, 2)], [[255, 255, 255], [0, 0, 0]]);
  assert.ok(drawn.at(32, 32)[0] > 110 && drawn.at(32, 32)[0] < 145 && isGrey(drawn.at(32, 32)), `the middle is drawn ${drawn.at(32, 32)[0]}`);
  const linear = await draw('grey-data-auto', river, { style: 'grey', range: 'auto' });
  assert.ok(linear.at(32, 32)[0] < 12, "'auto' stays linear whatever the spread");
});

test('hillshade: level ground is one mid-tone, a slope towards the light is brighter, one away from it darker', async () => {
  const level = await draw('hillshade-level', fixtures.one(33), { style: 'hillshade' });
  assert.deepEqual([level.width, level.height], [33, 33]);
  assert.deepEqual(level.at(5, 20), [shade(0, 0), shade(0, 0), shade(0, 0)]);
  assert.equal(shade(0, 0), 174);

  // The light comes from -X, -Y: ground that rises towards +X faces it. With the test settings the ramp rises 0.25 m/m.
  const rising = await draw('hillshade-rising', fixtures.rampX(65), { style: 'hillshade' });
  const falling = await draw('hillshade-falling', fieldOf(65, (u) => 1 - u), { style: 'hillshade' });
  assert.deepEqual(rising.at(30, 30), [shade(0.25, 0), shade(0.25, 0), shade(0.25, 0)]);
  assert.deepEqual(falling.at(30, 30), [shade(-0.25, 0), shade(-0.25, 0), shade(-0.25, 0)]);
  assert.ok(shade(0.25, 0) > shade(0, 0) && shade(0, 0) > shade(-0.25, 0));
  assert.deepEqual((await draw('hillshade-south', fixtures.rampY(65), { style: 'hillshade' })).at(30, 30)[0], shade(0, 0.25), 'and so does ground that rises towards +Y');

  // Slopes are physical: twice the height range on the same terrain size is twice as steep.
  const steeper = await draw('hillshade-steeper', fixtures.rampX(65), { style: 'hillshade', heightRange: 2048 });
  assert.equal(steeper.at(30, 30)[0], shade(0.5, 0));
  const wider = await draw('hillshade-wider', fixtures.rampX(65), { style: 'hillshade', heightRange: 2048, terrainSize: 8192 });
  assert.equal(wider.at(30, 30)[0], shade(0.25, 0));
});

test('hillshade: a terrain with slopes up to 55 degrees is drawn in mid-tones, not in black and white', async () => {
  const picture = await draw('hillshade-terrain', fixtures.terrain(257), { style: 'hillshade' });
  const counts = new Array<number>(256).fill(0);
  let sum = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      const rgb = picture.at(x, y);
      assert.ok(isGrey(rgb));
      counts[rgb[0]]++;
      sum += rgb[0];
    }
  }
  const total = 257 * 257;
  const share = (from: number, to: number): number => counts.slice(from, to + 1).reduce((n, c) => n + c, 0) / total;
  const mean = sum / total;
  const deviation = Math.sqrt(counts.reduce((n, c, value) => n + c * (value - mean) ** 2, 0) / total);
  assert.equal(share(0, 25) + share(230, 255), 0, 'no pixel is clipped: the intensity stays within 0.10..0.90');
  assert.ok(share(64, 200) > 0.6, `${(100 * share(64, 200)).toFixed(0)} % of the pixels are mid-tones`);
  assert.ok(share(26, 110) > 0.05 && share(190, 229) > 0.05, 'and both the shaded and the lit side are there');
  assert.ok(deviation > 25, `the relief is visible: the tones deviate by ${deviation.toFixed(1)}`);
});

test('hillshade and 3d with `height`: the shaded terrain is tinted by a mask, or carries a colour', async () => {
  const terrain = fixtures.one(65);
  const mask = fieldOf(65, (u) => (u < 0.5 ? 0 : 1));
  const tinted = await draw('hillshade-mask', mask, { style: 'hillshade', height: terrain });
  assert.deepEqual(tinted.at(10, 30), [174, 174, 174], 'a mask of 0 leaves the shading');
  const [r, g, b] = tinted.at(50, 30);
  assert.ok(r === 174 && g < 0.5 * r && b < g, `a mask of 1 tints it: ${[r, g, b].join(', ')}`);

  const color = colorOf(65, (u, v) => [u < 0.5 ? 1 : 0, v < 0.5 ? 1 : 0, 0, 0.3]);
  const painted = await draw('hillshade-color', color, { style: 'hillshade', height: terrain });
  assert.deepEqual([painted.at(10, 10), painted.at(50, 10), painted.at(10, 50), painted.at(50, 50)], [[174, 174, 0], [0, 174, 0], [174, 0, 0], [0, 0, 0]]);
  await assert.rejects(draw('hillshade-mismatch', mask, { style: 'hillshade', height: fixtures.one(33) }), /size/);

  // In the 3d view a colour is lit from the viewer's side, 0.30 + 0.70 ((1 + n.L) / 2)^2 with L = normalize(-1, 1, sqrt 2):
  // level ground keeps 0.81 of it. With `lit: false` it is drawn as it is: a colour that is a lit rendering already.
  const white = colorOf(65, () => [1, 1, 1, 1]);
  const lit = await draw('3d-color-lit', white, { style: '3d', height: terrain });
  const flat = await draw('3d-color-flat', white, { style: '3d', height: terrain, lit: false });
  assert.deepEqual([lit.at(384, 200), flat.at(384, 200)], [[207, 207, 207], [255, 255, 255]]);
  // A slope that faces the viewer, +Y, is brighter than level ground under that light, and darker as a shaded field.
  const facing = fieldOf(65, (_, v) => 1 - v);
  const litSlope = await draw('3d-color-facing', white, { style: '3d', height: facing });
  const shadedSlope = await draw('3d-field-facing', facing, { style: '3d' });
  assert.ok(litSlope.at(384, 256)[0] > 207 && shadedSlope.at(384, 256)[0] < 174, `the slope is drawn ${litSlope.at(384, 256)[0]} under a colour and ${shadedSlope.at(384, 256)[0]} as a field`);
});

test('3d: 768 x 512 on #1a1a1a, +X to the right and row 0 at the back: the top view tilted, not mirrored', async () => {
  // Red where u is high, green where v is high, on level ground at half height.
  const color = colorOf(129, (u, v) => [u > 0.75 ? 1 : 0, v > 0.75 ? 1 : 0, 0, 1]);
  const picture = await draw('3d-axes', color, { style: '3d', height: fieldOf(129, () => 0.5) });
  assert.deepEqual([picture.width, picture.height], [768, 512]);
  for (const [x, y] of [[0, 0], [767, 0], [0, 511], [767, 511], [384, 2]] as const) assert.deepEqual(picture.at(x, y), BACKGROUND, `the background at (${x}, ${y})`);

  const centroid = (wanted: (rgb: readonly [number, number, number]) => boolean): { x: number; y: number; count: number } => {
    let count = 0, sumX = 0, sumY = 0;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 768; x++) {
        if (!wanted(picture.at(x, y))) continue;
        count++;
        sumX += x;
        sumY += y;
      }
    }
    return { x: sumX / Math.max(count, 1), y: sumY / Math.max(count, 1), count };
  };
  const red = centroid(([r, g]) => r > 100 && g < 50), green = centroid(([r, g]) => g > 100 && r < 50), plain = centroid(([r, g, b]) => r < 50 && g < 50 && b < 50 && r + g + b < 5);
  assert.ok(red.count > 2000 && green.count > 2000 && plain.count > 20000, `${red.count} red, ${green.count} green and ${plain.count} unpainted pixels`);
  assert.ok(red.x > plain.x + 100, `high u is on the right: red at x ${red.x.toFixed(0)}, the rest at ${plain.x.toFixed(0)}`);
  assert.ok(green.y > plain.y + 40, `high v is at the front: green at y ${green.y.toFixed(0)}, the rest at ${plain.y.toFixed(0)}`);
  assert.ok(green.x < red.x, 'the view is turned about Z: the front edge runs down to the left');
});

test('3d: true proportions, sides down to height 0, and the shading of hillshade', async () => {
  const flat = await draw('3d-flat', fieldOf(65, () => 0.5), { style: '3d' });
  // The top is level ground under the same light.
  assert.deepEqual(flat.at(384, 200), [174, 174, 174]);
  // Below the front corner the two sides meet: both are drawn, neither is the background nor the top.
  const column = (x: number): string[] => Array.from({ length: 512 }, (_, y) => flat.at(x, y).join(','));
  const tones = new Set(Array.from({ length: 768 }, (_, x) => column(x)).flat());
  tones.delete(BACKGROUND.join(','));
  tones.delete('174,174,174');
  assert.equal(tones.size, 2, `two sides, each of one tone: ${[...tones].join(' | ')}`);

  // One scale for heights and distances: the sides of a block of half the height range are half as tall.
  const sideHeight = async (name: string, height: number): Promise<number> => {
    const block = await draw(name, fieldOf(65, () => height), { style: '3d' });
    let x = 0, tallest = 0;
    for (; x < 768; x++) {
      let run = 0;
      for (let y = 0; y < 512; y++) {
        const tone = block.at(x, y).join(',');
        if (tone !== BACKGROUND.join(',') && tone !== '174,174,174') run++;
      }
      tallest = Math.max(tallest, run);
    }
    return tallest;
  };
  const full = await sideHeight('3d-block-full', 1), half = await sideHeight('3d-block-half', 0.5);
  assert.ok(full > 60 && Math.abs(full - 2 * half) <= 3, `sides of ${full} and ${half} pixels`);

  // The same shape at twice the size is the same picture.
  const terrain = fixtures.terrain(129);
  const a = await draw('3d-terrain', terrain, { style: '3d' });
  const b = await draw('3d-terrain-doubled', terrain, { style: '3d', terrainSize: 8192, heightRange: 2048 });
  let differing = 0;
  for (let y = 0; y < 512; y += 3) for (let x = 0; x < 768; x += 3) if (a.at(x, y).join(',') !== b.at(x, y).join(',')) differing++;
  assert.equal(differing, 0, 'pixels that differ between the two scales');
  // And a terrain covers much of the picture with many tones.
  const seen = new Set<number>();
  for (let y = 0; y < 512; y += 2) for (let x = 0; x < 768; x += 2) seen.add(a.at(x, y)[0]);
  assert.ok(seen.size > 100, `${seen.size} tones`);
});

test('color: linear RGB encoded as sRGB, clamped, alpha ignored', async () => {
  const color = colorOf(9, (u, v) => (v === 0 ? [0.5, 0.2140411, 2, 0] : [u, -1, 0, 7]));
  const picture = await draw('color', color, { style: 'color' });
  assert.deepEqual([picture.width, picture.height], [9, 9]);
  assert.deepEqual(picture.at(3, 0), [188, 127, 255], '0.5 is 188 in sRGB; 2 is clamped to 1');
  assert.deepEqual(picture.at(8, 4), [255, 0, 0]);
  assert.deepEqual(picture.at(0, 4), [0, 0, 0]);
  // A colour is drawn as 'color' when no style is given, and a field cannot be.
  const byDefault = await draw('color-default', color);
  assert.deepEqual([byDefault.width, byDefault.at(3, 0)], [9, [188, 127, 255]]);
  await assert.rejects(writePreview('harness/preview/color-field', fixtures.one(9), { style: 'color' }), TypeError);
});

test('sheet: grey and hillshade at 512 x 512 and the 3d view, side by side on 1808 x 512', async () => {
  const terrain = fixtures.terrain(257);
  const sheet = await draw('sheet', terrain);
  assert.deepEqual([sheet.width, sheet.height], [1808, 512], "'sheet' is the default for a field");
  const grey = await draw('sheet-grey', terrain, { style: 'grey' });
  const hillshade = await draw('sheet-hillshade', terrain, { style: 'hillshade' });
  const view = await draw('sheet-3d', terrain, { style: '3d' });
  // Nearest neighbour: the pixel (i, j) of a panel shows the texel under its centre.
  const texel = (i: number): number => Math.floor(((i + 0.5) * 257) / 512);
  for (const [i, j] of [[0, 0], [511, 511], [100, 300], [317, 42], [256, 256]] as const) {
    assert.deepEqual(sheet.at(i, j), grey.at(texel(i), texel(j)), `grey at (${i}, ${j})`);
    assert.deepEqual(sheet.at(520 + i, j), hillshade.at(texel(i), texel(j)), `hillshade at (${i}, ${j})`);
  }
  for (const [x, y] of [[0, 0], [767, 511], [384, 256], [300, 200], [500, 330]] as const) assert.deepEqual(sheet.at(1040 + x, y), view.at(x, y), `3d at (${x}, ${y})`);
  for (const x of [512, 519, 1032, 1039]) assert.deepEqual(sheet.at(x, 100), BACKGROUND, `the gap at x ${x}`);

  // The sheet of a colour shows the colour where a field shows its grey.
  const painted = await draw('sheet-color', fixtures.color(65), { style: 'sheet', height: fixtures.terrain(65) });
  assert.equal(painted.width, 1808);
  assert.ok(!isGrey(painted.at(400, 100)) && !isGrey(painted.at(520 + 400, 100)));
});

test('crop draws a square window of texels, one to one', async () => {
  const f = fieldOf(129, (u, v) => (u + v) / 2);
  const whole = await draw('crop-whole', f, { style: 'grey' });
  const window = await draw('crop-window', f, { style: 'grey', crop: [40, 70, 32] });
  assert.deepEqual([window.width, window.height], [32, 32]);
  for (const [x, y] of [[0, 0], [31, 31], [5, 20]] as const) assert.deepEqual(window.at(x, y), whole.at(40 + x, 70 + y));
  // The terrain that is shaded is cropped with the data drawn over it.
  const over = await draw('crop-over', fixtures.mask(129), { style: 'hillshade', height: fixtures.one(129), crop: [48, 48, 33] });
  assert.deepEqual([over.width, over.at(16, 16)[0]], [33, 174]);
  assert.equal((await draw('crop-sheet', f, { crop: [0, 0, 64] })).width, 1808);
  for (const crop of [[100, 0, 64], [-1, 0, 8], [0, 0, 0], [0, 0, 1.5]] as const) {
    await assert.rejects(writePreview('harness/preview/crop-bad', f, { style: 'grey', crop }), RangeError, JSON.stringify(crop));
  }
});

test('writePreview writes <output folder>/<name>.png, returns its absolute path, and checks the name', async () => {
  const file = await writePreview('harness/preview/name_1.v2-x', fixtures.one(9), { style: 'grey' });
  assert.ok(path.isAbsolute(file) && file.endsWith(path.join('harness', 'preview', 'name_1.v2-x.png')), file);
  const root = process.env.OROGEN_TEST_OUTPUT ? path.resolve(process.env.OROGEN_TEST_OUTPUT) : path.resolve(import.meta.dirname, '../../../test-output');
  assert.equal(file, path.join(root, 'harness', 'preview', 'name_1.v2-x.png'));
  assert.deepEqual([...readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  for (const name of ['', 'Upper', '/abs', '../up', 'a/../b', 'a//b', 'a b', 'a/./b', '.hidden']) {
    await assert.rejects(writePreview(name, fixtures.one(9)), TypeError, JSON.stringify(name));
  }
  await assert.rejects(writePreview('harness/preview/bad-data', { kind: 'field', width: 4, height: 4, channels: 1, data: new Float32Array(3) }), RangeError);
  await assert.rejects(writePreview('harness/preview/bad-style', fixtures.one(9), { style: 'sepia' as never }), TypeError);
  await assert.rejects(writePreview('harness/preview/bad-range', fixtures.one(9), { style: 'grey', range: [1, 0] }), RangeError);
});
