// The display options (src/viewport/display.ts) and the sky's numbers (src/viewport/atmosphere.ts), and that the
// panel and the renderer, which may not import each other (runtime.md 8.4), mean the same by them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as panel from '../../../../src/app/panels/viewport/model.ts';
import { exposureFor, luminance, skyLight, skyRadiance, sunTransmittance } from '../../../../src/viewport/atmosphere.ts';
import { DEFAULT_DISPLAY, PALETTE_SIZE, PALETTES, paletteTexels, resolveDisplay } from '../../../../src/viewport/display.ts';
import { lightSize } from '../../../../src/viewport/lighting.ts';
import { lightCapFor, multisampleLimitFor } from '../../../../src/viewport/renderer.ts';

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

test('the light of the sky and the exposure follow the sun: evening is dimmer than noon, and still shown', () => {
  const noon = skyLight(60), evening = skyLight(4), night = skyLight(0);
  assert.ok(luminance(noon.sun) > luminance(evening.sun) && luminance(evening.sun) > 0);
  assert.ok(luminance(noon.up) > luminance(noon.side) && luminance(noon.side) > 0, 'level ground sees more sky than a wall');
  assert.ok(noon.up[2] > noon.up[0], 'the sky\'s light is blue');
  const lit = (elevation: number, light = skyLight(elevation)): number =>
    exposureFor(light, elevation) * 0.18 * (luminance(light.sun) * Math.sin(elevation * Math.PI / 180) / Math.PI + luminance(light.up));
  assert.ok(lit(60) > 0.2 && lit(60) < 0.6, `sunlit ground at noon is in the middle of the range: ${lit(60)}`);
  assert.ok(lit(4) < lit(60) && lit(4) > 0.25 * lit(60), `evening is darker, and no more than four times: ${lit(4)} against ${lit(60)}`);
  assert.ok(Number.isFinite(exposureFor(night, 0)) && exposureFor(night, 0) > 0);
});

test('what the renderer holds follows the card: finer light maps and multisampling at 4K on a large one, little on a CPU rasteriser', () => {
  const GIB = 2 ** 30;
  const card = (vramBytes: number | null, software = false) => ({ vramBytes, software });
  // The target card (10 GB) and the development card (6 GB); an adapter that does not say is taken for a small one.
  assert.deepEqual([lightCapFor(card(10 * GIB)), lightCapFor(card(6 * GIB)), lightCapFor(card(null)), lightCapFor(card(8 * GIB))], [4096, 2048, 2048, 4096]);
  assert.equal(lightCapFor(card(24 * GIB, true)), 512, 'a software adapter bakes a small grid, whatever memory it reports');
  // The grid of a field: the power of two at or above its resolution, up to the cap.
  assert.deepEqual([1009, 2017, 4033, 8129].map((resolution) => lightSize(resolution, lightCapFor(card(10 * GIB)))), [1024, 2048, 4096, 4096]);
  assert.deepEqual([1009, 2017, 4033, 8129].map((resolution) => lightSize(resolution, lightCapFor(card(6 * GIB)))), [1024, 2048, 2048, 2048]);
  assert.equal(lightSize(33, 2048), 64);

  // Four samples a pixel: up to 2560 × 1440 on a small card, at 3840 × 2160 on a large one, never on a CPU.
  const pixels = { qhd: 2560 * 1440, uhd: 3840 * 2160 };
  assert.ok(pixels.qhd <= multisampleLimitFor(card(6 * GIB)) && pixels.uhd > multisampleLimitFor(card(6 * GIB)));
  assert.ok(pixels.uhd <= multisampleLimitFor(card(10 * GIB)));
  assert.ok(pixels.qhd <= multisampleLimitFor(card(null)) && pixels.uhd > multisampleLimitFor(card(null)));
  assert.equal(multisampleLimitFor(card(10 * GIB, true)), 0);
});
