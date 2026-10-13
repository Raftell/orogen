// tests/nodes/generate/fractal-noise.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, diff, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, renderLadder, renderNode, stats, TEST_SETTINGS,
  type FieldData,
} from '../../helpers/index.ts';
import { mixSeed } from '../../../src/core/api.ts';
import def, { WARP_FADE } from '../../../src/core/nodes/generate/fractal-noise.ts';
import { WARP_REACH, WARP_STEPS } from '../../../src/core/nodes/generate/_noise.ts';
import { lattice, octaveSeed, shift, simplex, soften, turn, warp, type Vec2 } from './_noise-cpu.ts';

conformance(def);

const f = Math.fround;

interface Noise {
  readonly mode: string; readonly size: number; readonly octaves: number; readonly gain: number; readonly lacunarity: number;
  readonly warpStrength: number; readonly warpSize: number; readonly seed: number;
}
const BASE: Noise = { mode: 'fbm', size: 0.25, octaves: 8, gain: 0.5, lacunarity: 2, warpStrength: 0, warpSize: 0.5, seed: 0 };
const render = async (noise: Partial<Noise>, res = 257): Promise<FieldData> => (await renderNode(def, { res, params: { ...BASE, ...noise } })).out;

// The constants of the kernel.
const CREASE = 0.05, FOLD_MEAN = 0.444, SPREAD_PLAIN = 0.31, SPREAD_FOLDED = 0.6, KNEE = 0.4, ROOM = 0.1;
const fold = (n: number): number => (Math.sqrt(n * n + CREASE * CREASE) - CREASE) / (Math.sqrt(1 + CREASE * CREASE) - CREASE);

/** The kernel, written again for the CPU with the twin of its library. `frameSeed` is mixSeed(project seed, node seed). */
function reference(u: number, v: number, noise: Noise, frameSeed: number): number {
  const cells = f(1 / noise.size);
  const reach = f((noise.warpStrength * WARP_REACH * noise.warpSize) / WARP_STEPS);
  let q = lattice([u, v], cells);
  const warped = lattice(warp([u, v], f(1 / noise.warpSize), reach, mixSeed(frameSeed, 1)), cells);
  let bend: Vec2 = [f(warped[0] - q[0]), f(warped[1] - q[1])];
  const lacunarity = f(noise.lacunarity), fade = f(lacunarity * f(WARP_FADE));
  let sum = 0, norm = 0, power = 0, amp = 1, weight = 1;
  for (let i = 0; i < noise.octaves; i++) {
    const s = octaveSeed(mixSeed(frameSeed, 0), i);
    const move = shift(s);
    const n = simplex(f(f(q[0] + bend[0]) + move[0]), f(f(q[1] + bend[1]) + move[1]), s);
    let shaped = n;
    if (noise.mode === 'ridged') {
      const crest = Math.max(1 - fold(n), 0);
      shaped = crest * Math.sqrt(crest) * weight;
      const rise = Math.min(Math.max((2 * (sum + amp * shaped)) / (norm + amp), 0), 1);
      weight = rise * (2 - rise);
    }
    if (noise.mode === 'billow') shaped = fold(n) - FOLD_MEAN;
    sum += amp * shaped;
    norm += amp;
    power += amp * amp;
    amp *= f(noise.gain);
    const tq = turn(q), tb = turn(bend);
    q = [f(tq[0] * lacunarity), f(tq[1] * lacunarity)];
    bend = [f(tb[0] * fade), f(tb[1] * fade)];
  }
  if (noise.mode === 'ridged') return sum / norm;
  return 0.5 + soften(((noise.mode === 'fbm' ? SPREAD_PLAIN : SPREAD_FOLDED) * sum) / Math.sqrt(power), KNEE, ROOM);
}
const referenceField = (res: number, noise: Noise): FieldData => {
  const frameSeed = mixSeed(TEST_SETTINGS.seed, noise.seed);
  return fieldOf(res, (u, v) => reference(f(u), f(v), noise, frameSeed));
};

/** Mean absolute difference between horizontal neighbours: how rough the field is at the scale of a texel. */
function meanStep(field: FieldData): number {
  let sum = 0;
  for (let y = 0; y < field.height; y++) for (let x = 1; x < field.width; x++) sum += Math.abs(at(field, x, y) - at(field, x - 1, y));
  return sum / (field.height * (field.width - 1));
}

test('generate/fractal-noise: the modes of the node are fbm, ridged and billow', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), ['fbm', 'ridged', 'billow']);
});

for (const mode of ['fbm', 'ridged', 'billow']) {
  test(`generate/fractal-noise: mode ${mode} is the sum its definition gives, octave by octave, warped or not`, async () => {
    // The CPU sums in float64 at the lattice coordinates the kernel reaches in float32. Measured, the two differ
    // by up to 1e-5 at the defaults and with a warp, and by 7e-5 where fine octaves are strong (roughness 0.7).
    for (const [change, allowed] of [
      [{}, 3e-5],
      [{ size: 0.07, octaves: 5, gain: 0.7, lacunarity: 2.6, seed: 3 }, 2e-4],
      [{ size: 0.4, octaves: 11, warpStrength: 1, warpSize: 0.3, seed: 11 }, 3e-5],
    ] as const) {
      const noise = { ...BASE, mode, ...change };
      expectClose(await render(noise, 129), referenceField(129, noise), { max: allowed });
    }
  });
}

test('generate/fractal-noise: a larger feature size gives a smoother field, and more roughness a rougher one', async () => {
  const fine = await render({ size: 0.0625 });
  const broad = await render({ size: 0.5 });
  assert.ok(meanStep(broad) < 0.5 * meanStep(fine), `mean step ${meanStep(broad)} at size 0.5 against ${meanStep(fine)} at size 0.0625`);
  const smooth = await render({ gain: 0.25 });
  const rough = await render({ gain: 0.75 });
  assert.ok(meanStep(rough) > 3 * meanStep(smooth), `mean step ${meanStep(rough)} at roughness 0.75 against ${meanStep(smooth)} at 0.25`);
  // Without roughness every octave after the first has amplitude 0: the sum is the first octave.
  expectClose(await render({ gain: 0, octaves: 12 }), await render({ gain: 0.6, octaves: 1 }), { max: 1e-6 });
});

test('generate/fractal-noise: the heights keep their spread for every roughness and every number of octaves, and stay within 0..1', async () => {
  // Small features, so that one field holds a few hundred of them and its statistics are those of the noise.
  // The sum is divided by the root of its summed squares: its standard deviation is 0.31 * 0.54 for every setting.
  for (const mode of ['fbm', 'billow']) {
    for (const [octaves, gain] of [[1, 0.5], [3, 0.3], [8, 0.45], [8, 0.9], [16, 1]] as const) {
      const s = stats(await render({ mode, size: 0.04, octaves, gain }));
      assert.ok(s.std > 0.15 && s.std < 0.18, `mode ${mode}, ${octaves} octaves, roughness ${gain}: standard deviation ${s.std}`);
      assert.ok(Math.abs(s.mean - 0.5) < 0.02 && s.min > 0 && s.max < 1, `mode ${mode}, ${octaves} octaves, roughness ${gain}: ${s.min} to ${s.max}, mean ${s.mean}`);
    }
  }
  // Ridged octaves lie in 0..1 and are averaged by their amplitudes: the result does too. Its valley floors are
  // near 0 and its highest crests near 1, less so where many octaves of equal amplitude must all be at a crest.
  for (const [octaves, gain, top] of [[1, 0.5, 0.99], [8, 0.45, 0.9], [16, 1, 0.6]] as const) {
    const s = stats(await render({ mode: 'ridged', size: 0.04, octaves, gain }));
    assert.ok(s.min >= 0 && s.min < 0.02 && s.max <= 1 && s.max > top, `ridged, ${octaves} octaves, roughness ${gain}: ${s.min} to ${s.max}`);
  }
});

test('generate/fractal-noise: no direction is preferred: neither the axes of the grid nor its diagonals', async () => {
  // Two measures over eight steps of five texels that the grid holds exactly: along the axes and along the
  // 3-4-5 slants. Roughness: the mean squared difference across a step, which an isotropic field has alike in
  // every direction. Curvature: (h_xx - h_yy) measured along the axes against the same along the slants, a
  // frame turned by 53 degrees; their mean squares are equal in an isotropic field. Gradient noise on a square
  // lattice, the core library's, measures 1.22 for one octave and 1.10 for eight; here it is 1.00 within 0.01.
  const steps = [[5, 0], [0, 5], [3, 4], [4, 3], [-3, 4], [-4, 3], [4, -3], [3, -4]] as const;
  for (const change of [{ mode: 'fbm' }, { mode: 'fbm', octaves: 1 }, { mode: 'ridged' }, { mode: 'billow' }, { mode: 'fbm', warpStrength: 1, warpSize: 0.1 }]) {
    const sums = steps.map(() => 0);
    let axes = 0, slants = 0;
    for (const seed of [0, 1, 2, 3]) {
      const out = await render({ ...change, size: 0.07, seed }, 513);
      for (let y = 8; y < 505; y++) {
        for (let x = 8; x < 505; x++) {
          const h = at(out, x, y);
          steps.forEach(([dx, dy], k) => { sums[k] += (at(out, x + dx, y + dy) - h) ** 2; });
          axes += (at(out, x + 5, y) + at(out, x - 5, y) - at(out, x, y + 5) - at(out, x, y - 5)) ** 2;
          slants += (at(out, x + 3, y + 4) + at(out, x - 3, y - 4) - at(out, x - 4, y + 3) - at(out, x + 4, y - 3)) ** 2;
        }
      }
    }
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    const worst = Math.max(...sums.map((sum) => Math.abs(sum / mean - 1)));
    const settings = JSON.stringify(change);
    assert.ok(worst < 0.03, `${settings}: the roughness along one direction differs from the mean of all by ${(100 * worst).toFixed(1)} %`);
    // A warp draws the features out along its own curves, a few of which cross one terrain: it gets more room.
    assert.ok(Math.abs(axes / slants - 1) < ('warpStrength' in change ? 0.08 : 0.03), `${settings}: curvature along the axes is ${(axes / slants).toFixed(3)} of that along the slants`);
  }
});

test('generate/fractal-noise: the pattern does not repeat across the terrain', async () => {
  // 400 features across. A lattice that repeated, after a power of two of its cells or any other number, would
  // show as a correlation between the field and itself moved over; unrelated noise correlates by 1 / sqrt(samples).
  const out = await render({ size: 0.0025, octaves: 3 }, 513);
  const s = stats(out);
  for (const [dx, dy] of [[64, 0], [128, 0], [256, 0], [0, 128], [0, 256], [100, 37], [256, 256]] as const) {
    let sum = 0, count = 0;
    for (let y = 0; y + dy < 513; y++) for (let x = 0; x + dx < 513; x++) { sum += (at(out, x, y) - s.mean) * (at(out, x + dx, y + dy) - s.mean); count++; }
    const correlation = sum / count / s.std ** 2;
    assert.ok(Math.abs(correlation) < 0.03, `moved by (${dx}, ${dy}) the field correlates with itself by ${correlation}`);
  }
});

test('generate/fractal-noise: ridged puts its detail on the crests and leaves the valley floors smooth', async () => {
  // One octave: a crest wherever billow has a crease, since both fold the same noise. Billow is
  // 0.5 + 0.6 (fold - 0.444), without bending because that stays within 0.1..0.9, and ridged is (1 - fold)^1.5.
  const ridge = await render({ mode: 'ridged', octaves: 1 });
  const billow = await render({ mode: 'billow', octaves: 1 });
  const expected: FieldData = { ...billow, data: billow.data.map((value) => Math.max(1 - ((value - 0.5) / 0.6 + 0.444), 0) ** 1.5) };
  expectClose(ridge, expected, { max: 2e-5 });

  // Eight octaves: the roughness of the ground above half height, where every octave has its full strength,
  // against that of the valley floors, below a tenth. Roughness is what a texel differs by from the mean of
  // its four neighbours.
  const out = await render({ mode: 'ridged', size: 0.2 }, 513);
  let high = 0, highCount = 0, low = 0, lowCount = 0;
  for (let y = 1; y < 512; y++) {
    for (let x = 1; x < 512; x++) {
      const h = at(out, x, y);
      const rough = Math.abs(h - 0.25 * (at(out, x - 1, y) + at(out, x + 1, y) + at(out, x, y - 1) + at(out, x, y + 1)));
      if (h > 0.5) { high += rough; highCount++; }
      if (h < 0.1) { low += rough; lowCount++; }
    }
  }
  assert.ok(highCount > 10000 && lowCount > 10000, `${highCount} texels above 0.5 and ${lowCount} below 0.1`);
  assert.ok(high / highCount > 4 * (low / lowCount), `roughness ${high / highCount} high up against ${low / lowCount} on the valley floors`);
});

test('generate/fractal-noise: a warp bends the broad shapes and leaves the heights what they were', async () => {
  // Without strength the warp size means nothing.
  expectIdentical(await render({ warpStrength: 0, warpSize: 0.03 }), await render({}));
  const plain = await render({ size: 0.1 }, 513);
  const warped = await render({ size: 0.1, warpStrength: 1, warpSize: 0.4 }, 513);
  assert.ok(diff(plain, warped).rms > 0.1, 'the warped field is another field');
  const a = stats(plain), b = stats(warped);
  assert.ok(Math.abs(a.mean - b.mean) < 0.03 && Math.abs(a.std / b.std - 1) < 0.1, `mean ${a.mean} and ${b.mean}, standard deviation ${a.std} and ${b.std}`);
  // The fine detail does not follow the warp all the way, so it is not drawn out into streaks: texel to texel
  // the warped field is as rough as the plain one.
  assert.ok(Math.abs(meanStep(warped) / meanStep(plain) - 1) < 0.15, `mean step ${meanStep(warped)} warped against ${meanStep(plain)}`);
});

test('generate/fractal-noise: at full strength the warp folds no octave over itself', () => {
  // Octave i is looked up at the point moved by WARP_FADE^i of the warp's displacement. The area a small
  // square is carried to, as a part of its own, is the determinant of that map's derivative: 0 or less where
  // the terrain is folded and a feature would appear twice with a seam between.
  const h = 1 / 2048;
  const smallest = Array.from({ length: 8 }, () => Infinity);
  for (const warpSize of [0.1, 0.5, 2]) {
    const cells = f(1 / warpSize), reach = f((WARP_REACH * warpSize) / WARP_STEPS);
    for (let j = 0; j <= 120; j++) {
      for (let i = 0; i <= 120; i++) {
        const u = f(i / 120), v = f(j / 120);
        const a = warp([u, v], cells, reach, 7), b = warp([f(u + h), v], cells, reach, 7), c = warp([u, f(v + h)], cells, reach, 7);
        const xx = (b[0] - a[0]) / h - 1, yx = (b[1] - a[1]) / h, xy = (c[0] - a[0]) / h, yy = (c[1] - a[1]) / h - 1;
        smallest.forEach((least, octave) => {
          const share = WARP_FADE ** octave;
          smallest[octave] = Math.min(least, (1 + share * xx) * (1 + share * yy) - share * share * xy * yx);
        });
      }
    }
  }
  smallest.forEach((least, octave) => assert.ok(least > 0.2, `octave ${octave}: the smallest area ratio is ${least}`));
});

test('generate/fractal-noise: the project seed and the node seed each give another terrain', async () => {
  const base = await render({});
  const node = await render({ seed: 1 });
  const project = (await renderNode(def, { settings: { seed: 2 } })).out;
  const share = (a: FieldData, b: FieldData): number => diff(a, b).differing / a.data.length;
  assert.ok(share(node, base) > 0.99 && share(project, base) > 0.99 && share(node, project) > 0.99);
  // Another seed is another terrain of the same kind.
  expectStats(node, { mean: [0.4, 0.6], std: [0.12, 0.21] });
});

test('generate/fractal-noise: the shape lives in a unit box, at every level of the ladder, in every mode', async () => {
  expectIdentical((await renderNode(def, { settings: { terrainSize: 8192, heightRange: 2048 } })).out, await render({}));
  for (const mode of ['fbm', 'ridged', 'billow']) {
    const levels = await renderLadder(def, { resolutions: [129, 257, 513], params: { mode, warpStrength: 0.8, lacunarity: 2.3 } });
    expectLadder(levels[129]!.out, levels[257]!.out, { max: 1e-6 });
    expectLadder(levels[129]!.out, levels[513]!.out, { max: 1e-6 });
  }
  // 128, 255 and 509 are levels of an 8129 build, whose cells are no power of two of the terrain: the terrain
  // coordinate of a shared vertex is the same number at each of them all the same.
  const build = await renderLadder(def, { resolutions: [128, 255, 509], params: { warpStrength: 1 } });
  expectLadder(build[128]!.out, build[255]!.out, { max: 1e-6 });
  expectLadder(build[128]!.out, build[509]!.out, { max: 1e-6 });
});
