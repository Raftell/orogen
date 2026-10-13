// tests/nodes/filter/smart-blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/smart-blur.ts';
import { gaussian, mapField, roughness } from './_reference.ts';

conformance(def);

const N = 257;

/** The guided filter of a terrain by itself, on the CPU: every average is the Gaussian of `sigma` texels. */
function guided(src: FieldData, sigma: number, threshold: number): FieldData {
  const mean = gaussian(src, sigma);
  const meanSquare = gaussian(mapField(src, (x, y) => at(src, x, y) ** 2), sigma);
  // Float64 arrays between the steps: a Float32Array would round the variance of gentle ground away.
  const keep = new Float64Array(N * N), rest = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const variance = Math.max(meanSquare.data[i]! - mean.data[i]! ** 2, 0);
    keep[i] = variance / (variance + threshold * threshold);
    rest[i] = (1 - keep[i]!) * mean.data[i]!;
  }
  const keepMean = gaussian({ ...src, data: Float32Array.from(keep) }, sigma);
  const restMean = gaussian({ ...src, data: Float32Array.from(rest) }, sigma);
  return mapField(src, (x, y) => at(keepMean, x, y) * at(src, x, y) + at(restMean, x, y));
}

// Two plateaus with a cliff of 0.4 between them, and ripples of 0.004 all over.
const CLIFF = fieldOf(N, (u, v) => (u < 0.5 ? 0.3 : 0.7) + 0.004 * Math.sin(700 * u) * Math.sin(650 * v));

test('filter/smart-blur: the output is the guided filter of the terrain by itself', async () => {
  // A radius of 0.015 is 3.84 texels at 257. The variance is a difference of two means in float32.
  const src = await fixtures.fbm(N);
  for (const threshold of [0.005, 0.02, 0.1]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.015, threshold } });
    expectClose(out, guided(src, 0.015 * 256, threshold), { max: 2e-4 });
  }
});

test('filter/smart-blur: gentle ground is smoothed and a cliff is kept as steep as it was', async () => {
  const { out } = await renderNode(def, { inputs: { in: CLIFF }, params: { radius: 0.02, threshold: 0.02 } });
  // Away from the cliff the ripples are gone.
  const patch = (f: FieldData, x0: number): FieldData => mapField({ ...f, width: 48, height: 48 }, (x, y) => at(f, x0 + x, 100 + y));
  assert.ok(roughness(patch(out, 30)) < 0.05 * roughness(patch(CLIFF, 30)), `on the plateau the roughness is ${roughness(patch(out, 30))} of ${roughness(patch(CLIFF, 30))}`);
  // The cliff lies between texels 127 and 128. It keeps its height from one texel to the next.
  for (const y of [40, 128, 200]) {
    const drop = at(out, 128, y) - at(out, 127, y);
    assert.ok(drop > 0.38, `row ${y}: the cliff rises ${drop} between two texels; it was 0.4`);
  }
  // A blur of that radius spreads the same cliff over a dozen texels: 0.03 from one texel to the next.
  const blurred = gaussian(CLIFF, 0.02 * 256);
  assert.ok(at(blurred, 128, 128) - at(blurred, 127, 128) < 0.04);
});

test('filter/smart-blur: a larger threshold smooths steeper ground, and the largest is the blur applied twice', async () => {
  const src = await fixtures.fbm(N);
  const change = async (threshold: number): Promise<number> => {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.015, threshold } });
    let sum = 0;
    for (let i = 0; i < N * N; i++) sum += (out.data[i]! - src.data[i]!) ** 2;
    return Math.sqrt(sum / (N * N));
  };
  const [fine, middle, coarse] = [await change(0.002), await change(0.02), await change(0.2)];
  assert.ok(fine < 0.5 * middle && middle < 0.8 * coarse, `the terrain changes by ${fine}, ${middle} and ${coarse} at thresholds of 0.002, 0.02 and 0.2`);

  const all = await renderNode(def, { inputs: { in: src }, params: { radius: 0.015, threshold: 1e6 } });
  expectClose(all.out, gaussian(gaussian(src, 0.015 * 256), 0.015 * 256), { max: 1e-5 });
});

test('filter/smart-blur: a flat terrain and an evenly sloping one within the threshold stay as they are', async () => {
  const flat = fieldOf(N, () => 0.3);
  expectClose((await renderNode(def, { inputs: { in: flat } })).out, flat, { max: 1e-6 });
  // A blur leaves a plane a plane, away from the border it clamps at, whatever share of it is kept.
  const { out } = await renderNode(def, { inputs: { in: 'rampX' } });
  for (let x = 24; x <= 232; x += 16) assert.ok(Math.abs(at(out, x, 128) - x / 256) <= 1e-5);
});

test('filter/smart-blur: below a third of a texel the output is the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const radius of [0.3 / 256, 0, -0.05]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius } });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('filter/smart-blur: the result is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.03, threshold: 0.03 } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});
