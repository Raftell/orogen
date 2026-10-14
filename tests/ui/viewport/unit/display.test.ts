// The display options (src/viewport/display.ts) and the sky's numbers (src/viewport/atmosphere.ts), and that the
// panel and the renderer, which may not import each other (runtime.md 8.4), mean the same by them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as panel from '../../../../src/app/panels/viewport/model.ts';
import {
  altitudeOf, ATMOSPHERE, exposureFor, keyLight, luminance, MS_SAMPLES, multipleScattering, skyLight, skyRadiance, sunTransmittance, whiteBalance,
} from '../../../../src/viewport/atmosphere.ts';
import { DEFAULT_DISPLAY, PALETTE_SIZE, PALETTES, paletteTexels, resolveDisplay } from '../../../../src/viewport/display.ts';
import { BAKE_LOADS_MAX, BAKE_LOADS_MIN, BAKE_LOADS_PER_FRAME, lightSize, nextBakeLoads, WALL_TARGET_MS } from '../../../../src/viewport/lighting.ts';
import { backingSize, lightCapFor, multisampleLimitFor, pixelLimitFor } from '../../../../src/viewport/renderer.ts';

test('what the panel sends is what the renderer reads: the same members, values and defaults', () => {
  assert.deepEqual([...panel.PALETTES], [...PALETTES]);
  assert.deepEqual({ ...panel.DEFAULT_DISPLAY }, { ...DEFAULT_DISPLAY });
  assert.deepEqual(resolveDisplay(panel.DEFAULT_DISPLAY), DEFAULT_DISPLAY);
  assert.deepEqual(Object.keys(panel.SHADING_LABELS), ['material', 'clay']);
  assert.deepEqual(Object.keys(panel.TOP_STYLE_LABELS), ['hillshade', 'grey', 'overlay']);
  for (const shading of Object.keys(panel.SHADING_LABELS)) assert.equal(resolveDisplay({ ...panel.DEFAULT_DISPLAY, shading } as never).shading, shading);
  for (const topStyle of Object.keys(panel.TOP_STYLE_LABELS)) assert.equal(resolveDisplay({ ...panel.DEFAULT_DISPLAY, topStyle } as never).topStyle, topStyle);
  for (const palette of PALETTES) assert.ok(panel.PALETTE_LABELS[palette].length > 0);
});

test('the renderer takes the display of runtime.md 7.5 alone, and brings whatever it is sent into range', () => {
  const plain = resolveDisplay({ verticalScale: 2, showSea: false, sunAzimuth: -90, sunElevation: 120 });
  assert.deepEqual(plain, { verticalScale: 2, showSea: false, sunAzimuth: 270, sunElevation: 90, shading: 'material', topStyle: 'hillshade', palette: 'red' });
  const odd = resolveDisplay({ verticalScale: Number.NaN, showSea: 'yes', sunAzimuth: 725, sunElevation: -5, shading: 'chrome', palette: 7 } as never);
  assert.deepEqual(odd, { ...DEFAULT_DISPLAY, sunAzimuth: 5, sunElevation: 0 });
  assert.deepEqual(resolveDisplay(null), DEFAULT_DISPLAY);
  assert.equal(resolveDisplay({ ...DEFAULT_DISPLAY, verticalScale: 0 }).verticalScale, 0.01);
});

test('a palette is 256 opaque colours from its first stop to its last', () => {
  for (const palette of PALETTES) {
    const texels = paletteTexels(palette);
    assert.equal(texels.length, PALETTE_SIZE * 4);
    for (let i = 3; i < texels.length; i += 4) assert.equal(texels[i], 255);
  }
  const grey = paletteTexels('grey');
  assert.deepEqual([grey[0], grey[1], grey[2], grey[255 * 4], grey[128 * 4]], [0, 0, 0, 255, 128]);
  const viridis = paletteTexels('viridis');
  assert.ok(viridis[2]! > viridis[1]! && viridis[255 * 4]! > 240 && viridis[255 * 4 + 2]! < 60, 'viridis runs from violet to yellow');
});

test('the sky: a high sun is white and a low one red, the zenith is blue, and nothing is lit from below the horizon', () => {
  const noon = sunTransmittance(60), low = sunTransmittance(2);
  assert.ok(noon.every((c) => c > 0.6 && c <= 1), `noon: ${noon.join(' ')}`);
  assert.ok(noon[0] > noon[2] && noon[0] - noon[2] < 0.3);
  assert.ok(low[0] > 3 * low[2] && low[0] < noon[0], `a low sun is red: ${low.join(' ')}`);
  assert.deepEqual(sunTransmittance(-5), [0, 0, 0]);

  const zenith = skyRadiance(85, 90, 40);
  assert.ok(zenith[2] > 1.5 * zenith[0] && zenith[2] > zenith[1], `the zenith is blue: ${zenith.join(' ')}`);
  const horizon = skyRadiance(2, 90, 40);
  assert.ok(luminance(horizon) > luminance(zenith), 'the sky is brighter at the horizon');
  const ground = skyRadiance(-30, 90, 40);
  assert.ok(luminance(ground) < 0.5 * luminance(horizon), 'what lies below the horizon is darker than the sky above it');
  for (const c of [...zenith, ...horizon, ...ground]) assert.ok(Number.isFinite(c) && c >= 0);
});

test('the light scattered more than once: a share of the sky that single scattering leaves out, greater in haze, from every altitude', () => {
  const table = multipleScattering(40);
  assert.equal(table.length, MS_SAMPLES * 4);
  assert.ok(altitudeOf(0) === 0 && altitudeOf(MS_SAMPLES - 1) === ATMOSPHERE.topRadius - ATMOSPHERE.groundRadius && altitudeOf(1) < 1000, 'the samples are close together near the ground');
  for (let i = 0; i < MS_SAMPLES; i++) {
    for (let c = 0; c < 3; c++) assert.ok(Number.isFinite(table[i * 4 + c]!) && table[i * 4 + c]! > 0 && table[i * 4 + c]! < 1, `sample ${i}, channel ${c}: ${table[i * 4 + c]}`);
    assert.equal(table[i * 4 + 3], 0);
  }
  // The sky with it and without it: at the zenith, where a ray is short, a quarter to a half of the light was scattered again.
  const light = skyLight(40);
  const none = { table: new Float32Array(MS_SAMPLES * 4), up: light.up };
  const whole = luminance(skyRadiance(88, 90, 40, 24, light)), once = luminance(skyRadiance(88, 90, 40, 24, none));
  assert.ok(once < whole && (whole - once) / whole > 0.15 && (whole - once) / whole < 0.6, `the share at the zenith: ${(whole - once) / whole}`);
  // Under a sun that has set the air high up is still lit, and gives of it: twilight.
  const dusk = multipleScattering(-3);
  assert.ok(dusk[(MS_SAMPLES - 3) * 4 + 2]! > 0 && dusk[2]! < table[2]!);
});

test('the light of the sky and the exposure follow the sun: evening is dimmer than noon, and still shown', () => {
  const noon = skyLight(60), evening = skyLight(4), night = skyLight(0);
  assert.ok(luminance(noon.sun) > luminance(evening.sun) && luminance(evening.sun) > 0);
  assert.ok(luminance(noon.up) > luminance(noon.side) && luminance(noon.side) > 0, 'level ground sees more sky than a wall');
  assert.ok(noon.up[2] > 1.8 * noon.up[0], 'the sky\'s light is blue');
  // A clear day: the sky gives level ground a tenth to a quarter of what the sun gives it.
  const share = luminance(noon.up) / (luminance(noon.sun) * Math.sin(60 * Math.PI / 180) / Math.PI);
  assert.ok(share > 0.08 && share < 0.25, `the sky against the sun on level ground: ${share}`);
  const lit = (elevation: number, light = skyLight(elevation)): number => exposureFor(light, elevation) * 0.18 * luminance(keyLight(light, elevation));
  // Sunlit level ground of the albedo 0.18 is drawn at 0.18 under a sun at 45 degrees: it has the colour it has.
  assert.ok(Math.abs(lit(45) - 0.18) < 1e-9, `${lit(45)}`);
  assert.ok(lit(60) > lit(45) && lit(60) < 0.22, `a higher sun is a little brighter: ${lit(60)}`);
  assert.ok(lit(4) < lit(60) && lit(4) > 0.25 * lit(60), `evening is darker, and no more than four times: ${lit(4)} against ${lit(60)}`);
  assert.ok(Number.isFinite(exposureFor(night, 0)) && exposureFor(night, 0) > 0);
});

test('the white balance shows the light of the day as white and leaves an evening warm', () => {
  for (const elevation of [70, 38, 15, 4]) {
    const light = skyLight(elevation);
    const key = keyLight(light, elevation), gains = whiteBalance(light, elevation);
    const balanced = key.map((c, i) => c * gains[i]!) as unknown as readonly [number, number, number];
    assert.ok(Math.abs(luminance(balanced) - luminance(key)) < 1e-9 * luminance(key), `${elevation}: the gains keep the light as bright as it is`);
    const before = key[0] / key[2], after = balanced[0] / balanced[2];
    assert.ok(before > 1 && after >= 1 && after - 1 < 0.2 * (before - 1) + 1e-9, `${elevation}: red over blue ${before} is balanced to ${after}`);
    assert.ok(gains.every((gain) => gain > 0.3 && gain < 3));
  }
  const low = skyLight(4);
  const warm = keyLight(low, 4).map((c, i) => c * whiteBalance(low, 4)[i]!);
  assert.ok(warm[0]! > warm[2]!, 'the light of a low sun stays warmer than white');
  // Night: nothing to balance, and nothing breaks.
  assert.deepEqual(whiteBalance({ sun: [0, 0, 0], up: [0, 0, 0], side: [0, 0, 0], table: new Float32Array(MS_SAMPLES * 4) }, 0), [1, 1, 1]);
});

test('what the renderer holds follows the card: finer light maps and multisampling at 4K on a large one, little on a CPU rasteriser', () => {
  const GIB = 2 ** 30;
  const card = (vramBytes: number | null, software = false) => ({ vramBytes, software });
  // The target card (10 GB) and the development card (6 GB); an adapter that does not say is taken for a small one; 2 GB is a tiny one.
  assert.deepEqual([lightCapFor(card(10 * GIB)), lightCapFor(card(6 * GIB)), lightCapFor(card(null)), lightCapFor(card(8 * GIB)), lightCapFor(card(2 * GIB)), lightCapFor(card(0))], [4096, 2048, 2048, 4096, 1024, 2048]);
  assert.equal(lightCapFor(card(24 * GIB, true)), 512, 'a software adapter bakes a small grid, whatever memory it reports');
  // The grid of a field: the power of two at or above its resolution, up to the cap.
  assert.deepEqual([1009, 2017, 4033, 8129].map((resolution) => lightSize(resolution, lightCapFor(card(10 * GIB)))), [1024, 2048, 4096, 4096]);
  assert.deepEqual([1009, 2017, 4033, 8129].map((resolution) => lightSize(resolution, lightCapFor(card(6 * GIB)))), [1024, 2048, 2048, 2048]);
  assert.equal(lightSize(33, 2048), 64);

  // Four samples a pixel: up to 2560 × 1440 on a small card, at 3840 × 2160 on a large one, never on a CPU.
  const pixels = { hd: 1920 * 1080, qhd: 2560 * 1440, uhd: 3840 * 2160 };
  assert.ok(pixels.qhd <= multisampleLimitFor(card(6 * GIB)) && pixels.uhd > multisampleLimitFor(card(6 * GIB)));
  assert.ok(pixels.uhd <= multisampleLimitFor(card(10 * GIB)));
  assert.ok(pixels.qhd <= multisampleLimitFor(card(null)) && pixels.uhd > multisampleLimitFor(card(null)));
  assert.ok(pixels.hd <= multisampleLimitFor(card(2 * GIB)) && pixels.qhd > multisampleLimitFor(card(2 * GIB)));
  assert.equal(multisampleLimitFor(card(10 * GIB, true)), 0);
});

test('nothing is held by the pixel without a bound: a canvas has as many pixels as the card allows, of the panel\'s shape', () => {
  const GIB = 2 ** 30;
  const card = (vramBytes: number | null, software = false) => ({ vramBytes, software });
  // What a pixel costs: the lit picture (8 bytes) and its depth (4), and with four samples 32 and 12 more.
  const bytes = (c: { vramBytes: number | null; software: boolean }): number => Math.max(pixelLimitFor(c) * 12, Math.min(pixelLimitFor(c), multisampleLimitFor(c)) * 56);
  assert.deepEqual([card(10 * GIB), card(6 * GIB), card(null), card(2 * GIB), card(null, true)].map((c) => Math.round(bytes(c) / 2 ** 20)), [481, 240, 240, 128, 24]);
  assert.ok(pixelLimitFor(card(10 * GIB)) >= 3840 * 2160 && pixelLimitFor(card(6 * GIB)) >= 3840 * 2160, 'a 4K panel is drawn pixel for pixel on both cards');

  // A panel within the bounds is drawn pixel for pixel.
  assert.deepEqual(backingSize(1600, 1000, 1, 8192, 3840 * 2160), [1600, 1000]);
  assert.deepEqual(backingSize(640, 400, 1.5, 8192, 3840 * 2160), [960, 600]);
  // One beyond them keeps its shape: an 8K screen on a small card, a panel wider than a texture may be.
  const [w, h] = backingSize(3840, 2160, 2, 16384, 3840 * 2160);
  assert.deepEqual([w, h], [3840, 2160]);
  const [wide, low] = backingSize(20000, 500, 1, 8192, 3840 * 2160);
  assert.ok(wide === 8192 && Math.abs(low - 500 * 8192 / 20000) <= 1, `${wide} × ${low}`);
  for (const [width, height, dpr] of [[1, 1, 1], [0, 0, 0], [5000, 5000, 3], [3, 90000, 1], [Number.NaN, 10, 1]] as const) {
    const [a, b] = backingSize(width, height, dpr, 8192, 1920 * 1080);
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1 && a <= 8192 && b <= 8192 && a * b <= 1920 * 1080 * 1.01, `${width} × ${height} at ${dpr}: ${a} × ${b}`);
  }
});

test('without a clock on the device the share of a frame that refines the light maps follows the wall clock', () => {
  const start = BAKE_LOADS_PER_FRAME;
  // A frame that took as long as it may leaves the share where it is.
  assert.equal(nextBakeLoads(start, WALL_TARGET_MS, true), start);
  assert.equal(nextBakeLoads(start, 0.8 * WALL_TARGET_MS, true), start);
  // Too long: fewer at once, in proportion, and at most by half.
  assert.ok(Math.abs(nextBakeLoads(start, 2 * WALL_TARGET_MS * 0.75, true) - start / 1.5) < 1);
  assert.equal(nextBakeLoads(start, 10 * WALL_TARGET_MS, true), start / 2);
  assert.equal(nextBakeLoads(start, 10 * WALL_TARGET_MS, false), start / 2, 'whether or not the frame used its share');
  // Short, and the share was used: more, by degrees. Short because there was little to do: nothing is learnt.
  assert.ok(nextBakeLoads(start, 0.2 * WALL_TARGET_MS, true) > start && nextBakeLoads(start, 0.2 * WALL_TARGET_MS, true) <= 1.2 * start);
  assert.equal(nextBakeLoads(start, 0.2 * WALL_TARGET_MS, false), start);
  // A slow adapter comes down to the least within a few frames and stays there; a fast one goes up to the most and no further.
  let slow = start, fast = start;
  for (let frame = 0; frame < 40; frame++) {
    slow = nextBakeLoads(slow, 60, true);
    fast = nextBakeLoads(fast, 1, true);
  }
  assert.deepEqual([slow, fast], [BAKE_LOADS_MIN, BAKE_LOADS_MAX]);
  let frames = 0;
  for (let loads = start; loads > BAKE_LOADS_MIN; loads = nextBakeLoads(loads, 60, true)) frames++;
  assert.ok(frames <= 3, `${frames} frames to the least`);
  // A time that is no time changes nothing.
  for (const ms of [Number.NaN, -1, Infinity]) assert.equal(nextBakeLoads(start, ms, true), start);
});
