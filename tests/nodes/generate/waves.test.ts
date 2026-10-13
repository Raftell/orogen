// tests/nodes/generate/waves.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, diff, expectIdentical, expectStats, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/waves.ts';
import { WARP_REACH, WARP_STEPS } from '../../../src/core/nodes/generate/_noise.ts';
import { uvOf, warp, type Vec2 } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;
/** The profiles by position t within one wave, 0..1, and the positions at which a profile jumps. */
const PROFILES: Readonly<Record<string, { readonly value: (t: number) => number; readonly jumps: readonly number[] }>> = {
  sine: { value: (t) => 0.5 - 0.5 * Math.cos(2 * Math.PI * t), jumps: [] },
  triangle: { value: (t) => 1 - Math.abs(2 * t - 1), jumps: [] },
  saw: { value: (t) => t, jumps: [0, 1] },
  square: { value: (t) => (t >= 0.25 && t < 0.75 ? 1 : 0), jumps: [0.25, 0.75] },
};
/** The seed of the warp, which the node fixes: it has no seed parameter. */
const WARP_SEED = 1;

interface Waves { readonly mode: string; readonly size: number; readonly angle: number; readonly offset: Vec2; readonly warpStrength: number; readonly warpSize: number }
const BASE: Waves = { mode: 'sine', size: 0.25, angle: 0, offset: [0, 0], warpStrength: 0, warpSize: 0.5 };
const render = async (waves: Partial<Waves>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...waves } })).out;

/** The position within the wave of the terrain coordinate (u, v): the node's definition, warped by the library's twin. */
function position(u: number, v: number, waves: Waves): number {
  const reach = f((waves.warpStrength * WARP_REACH * waves.warpSize) / WARP_STEPS);
  const w = warp([f(u - f(waves.offset[0])), f(v - f(waves.offset[1]))], f(1 / waves.warpSize), reach, WARP_SEED);
  const r = (waves.angle * Math.PI) / 180;
  const along = ((w[0] - 0.5) * Math.cos(r) + (w[1] - 0.5) * Math.sin(r)) / waves.size + 0.5;
  return along - Math.floor(along);
}

/** The largest difference between a render and the definition, away from the jumps of the profile, where a last bit decides the side. */
function worstDifference(out: FieldData, waves: Waves): number {
  const { value, jumps } = PROFILES[waves.mode]!;
  let worst = 0, compared = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const t = position(uvOf(x, out.width), uvOf(y, out.height), waves);
      if (jumps.some((jump) => Math.abs(t - jump) < 1e-3)) continue;
      worst = Math.max(worst, Math.abs(at(out, x, y) - value(t)));
      compared++;
    }
  }
  assert.ok(compared > 0.95 * out.data.length, 'the comparison covers the field');
  return worst;
}

test('generate/waves: the modes of the node are the four of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(PROFILES));
});

for (const mode of Object.keys(PROFILES)) {
  test(`generate/waves: mode ${mode} repeats its profile along the direction, for any wavelength, angle and offset`, async () => {
    for (const [size, angle, offset] of [[0.25, 0, [0, 0]], [0.11, 35, [0.07, -0.2]], [0.6, 250, [-0.4, 0.15]]] as const) {
      const waves = { ...BASE, mode, size, angle, offset };
      const worst = worstDifference(await render(waves), waves);
      assert.ok(worst <= 2e-5, `mode ${mode}, wavelength ${size}: up to ${worst} from the profile; allowed 2e-5`);
    }
  });
}

test('generate/waves: the wavelength is the distance from crest to crest, and a crest runs through the center', async () => {
  // A wavelength of a quarter of the terrain is 64 texels at 257: four waves, the same 64 texels on.
  for (const mode of ['sine', 'triangle', 'square']) {
    const out = await render({ mode });
    expectStats(out, { min: [0, 0], max: [1, 1], mean: [0.49, 0.51] });
    for (const y of [0, 131, 256]) {
      for (const crest of [0, 64, 128, 192, 256]) assert.equal(at(out, crest, y), 1, `mode ${mode}: column ${crest} is a crest`);
      for (const trough of [32, 96, 160, 224]) assert.equal(at(out, trough, y), 0, `mode ${mode}: column ${trough} is a trough`);
      for (let x = 0; x + 64 <= 256; x++) assert.ok(Math.abs(at(out, x, y) - at(out, x + 64, y)) <= 1e-6);
    }
  }
  // The saw climbs through the whole wave and drops at its end: half way up on the center.
  const saw = await render({ mode: 'saw' });
  assert.ok(Math.abs(at(saw, 128, 9) - 0.5) <= 1e-6 && at(saw, 159, 9) > 0.98 && at(saw, 160, 9) < 0.02);
});

test('generate/waves: the angle is the direction across the crests', async () => {
  // At 90 degrees the waves follow each other down the screen: every row is one height.
  const out = await render({ angle: 90 });
  for (const y of [0, 16, 32, 100]) {
    let spread = 0;
    for (let x = 0; x < 257; x++) spread = Math.max(spread, Math.abs(at(out, x, y) - at(out, 0, y)));
    assert.ok(spread <= 1e-6);
  }
  assert.ok(Math.abs(at(out, 5, 128) - 1) <= 1e-6 && Math.abs(at(out, 5, 96)) <= 1e-6);
});

test('generate/waves: a warp bends the crests as the warp of the noise library does, and without one the waves are straight', async () => {
  expectIdentical(await render({ warpStrength: 0, warpSize: 0.05 }), await render({}));
  for (const [mode, warpStrength, warpSize, offset] of [['sine', 1, 0.5, [0, 0]], ['triangle', 0.4, 0.2, [0.3, -0.1]], ['saw', 1, 1.5, [0, 0]]] as const) {
    const waves = { ...BASE, mode, size: 0.2, angle: 20, offset, warpStrength, warpSize };
    const out = await render(waves);
    const worst = worstDifference(out, waves);
    assert.ok(worst <= 1e-4, `mode ${mode}: up to ${worst} from the warped profile; allowed 1e-4`);
    // Bent, not just moved: against the straight waves the field has changed by a tenth of its range or more.
    assert.ok(diff(out, await render({ ...waves, warpStrength: 0 })).rms > 0.1);
    const s = stats(out);
    assert.ok(s.min < 0.01 && s.max > 0.99, 'the warped waves keep their full height');
  }
});

test('generate/waves: the offset moves the waves and their warp together', async () => {
  // A quarter of the terrain to the right and an eighth down: 64 and 32 texels at 257.
  const waves = { size: 0.13, angle: 70, warpStrength: 1, warpSize: 0.4 };
  const base = await render(waves);
  const moved = await render({ ...waves, offset: [0.25, 0.125] });
  let worst = 0;
  for (let y = 32; y < 257; y++) for (let x = 64; x < 257; x++) worst = Math.max(worst, Math.abs(at(moved, x, y) - at(base, x - 64, y - 32)));
  assert.ok(worst <= 1e-4, `the moved waves differ from the waves by up to ${worst}; allowed 1e-4`);
});

test('generate/waves: the warp at full strength folds the terrain nowhere', () => {
  // The warp carries each point along the contours of a noise. The area a small square of the terrain is
  // carried to, as a part of its own, is the determinant of the map's derivative: 0 or less where the map folds.
  const h = 1 / 2048;
  let smallest = Infinity, furthest = 0;
  for (const warpSize of [0.1, 0.5, 2]) {
    const cells = f(1 / warpSize), reach = f((WARP_REACH * warpSize) / WARP_STEPS);
    for (let j = 0; j <= 160; j++) {
      for (let i = 0; i <= 160; i++) {
        const u = f(i / 160), v = f(j / 160);
        const a = warp([u, v], cells, reach, WARP_SEED), b = warp([f(u + h), v], cells, reach, WARP_SEED), c = warp([u, f(v + h)], cells, reach, WARP_SEED);
        smallest = Math.min(smallest, ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / (h * h));
        furthest = Math.max(furthest, Math.hypot(a[0] - u, a[1] - v) / warpSize);
      }
    }
  }
  assert.ok(smallest > 0.2, `the smallest area ratio is ${smallest}`);
  // It moves a point by up to two fifths of the warp size, and by more than a quarter somewhere.
  assert.ok(furthest > 0.25 && furthest < 0.5, `the largest displacement is ${furthest} warp sizes`);
});
