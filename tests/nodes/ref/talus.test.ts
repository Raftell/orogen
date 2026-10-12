// tests/nodes/ref/talus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import fbm from '../../../src/core/nodes/ref/fbm.ts';
import def from '../../../src/core/nodes/ref/talus.ts';

conformance(def, {
  resolutionTol: {
    value: 0.2,
    reason: 'Relaxes the slopes it finds: a finer level resolves steeper pairs of the same terrain. Between 257 and 513 `moved` differs by 7 % of its standard deviation on the terrain fixture and by 16 % on a ref/fbm of four octaves.',
  },
});

const sum = (f: FieldData): number => stats(f).mean * f.data.length;

test('ref/talus: a slope below the talus angle is left alone', async () => {
  // With the test settings the ramp rises at 14.04 degrees, and the default talus angle is 35.
  const { out, moved } = await renderNode(def, { inputs: { in: 'rampX' } });
  expectClose(out, fixtures.rampX(257), { max: 1e-6 });
  expectClose(moved, fixtures.zero(257), { max: 1e-6 });
});

test('ref/talus: a cone steeper than the talus angle loses its tip and grows a foot, and no material is lost', async () => {
  // The flank of the cone is at 45 degrees. Along a uniform slope every texel passes on what it receives, so the
  // collapse starts where the slope changes: at the tip and at the foot.
  const cone = fixtures.cone(257);
  const { out, moved } = await renderNode(def, { inputs: { in: cone } });
  assert.equal(at(cone, 128, 128), 1);
  assert.ok(at(out, 128, 128) < 1 - 1e-3, `the tip is at ${at(out, 128, 128)}`);
  assert.equal(at(cone, 192, 128), 0, 'the foot of the cone is the first texel of the floor');
  assert.ok(at(out, 192, 128) > 1e-4, `the floor at the foot is at ${at(out, 192, 128)}`);
  const drift = Math.abs(stats(out).mean - stats(cone).mean);
  assert.ok(drift <= 1e-5, `|mean(out) - mean(in)| is ${drift}; allowed 1e-5`);

  // `moved` is the height that crossed each texel, without sign.
  assert.ok(stats(moved).min >= 0, 'moved is never negative');
  assert.ok(at(moved, 128, 128) > 1e-3, 'material left the tip');
  assert.equal(at(moved, 0, 0), 0, 'nothing moved on the floor far from the cone');
  let changedUnmoved = 0;
  for (let i = 0; i < out.data.length; i++) if (moved.data[i] === 0 && out.data[i] !== cone.data[i]) changedUnmoved++;
  assert.equal(changedUnmoved, 0, 'texels that changed although nothing moved there');
});

test('ref/talus: a longer reach moves more material', async () => {
  const src = await fixtures.fbm(257);
  const short = await renderNode(def, { inputs: { in: src }, params: { reach: 0.005 } });
  const long = await renderNode(def, { inputs: { in: src }, params: { reach: 0.05 } });
  assert.ok(sum(short.moved) > 0, 'a fractal terrain has slopes above 35 degrees');
  assert.ok(sum(long.moved) > 2 * sum(short.moved), `moved ${sum(long.moved)} at reach 0.05 against ${sum(short.moved)} at reach 0.005`);
});

test('ref/talus: a lower talus angle collapses more of the terrain', async () => {
  const src = await fixtures.fbm(257);
  const steep = await renderNode(def, { inputs: { in: src }, params: { talus: 60 } });
  const shallow = await renderNode(def, { inputs: { in: src }, params: { talus: 20 } });
  assert.ok(sum(shallow.moved) > sum(steep.moved));
  // At 90 degrees the threshold is beyond every slope: nothing collapses.
  const never = await renderNode(def, { inputs: { in: src }, params: { talus: 90 } });
  expectIdentical(never.out, src);
});

test('ref/talus: the relaxed terrain and what moved are the same at two levels of the ladder', async () => {
  // `out` within the default tolerance of the `resolution` check (testing.md 3.4), which the node's own is wider than.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
  // `moved` is a height, not an amount per texel: half the cell exchanges half as much per iteration, twice as often.
  const ratio = stats(levels[513].moved).mean / stats(levels[257].moved).mean;
  assert.ok(ratio > 0.85 && ratio < 1.15, `mean(moved) at 513 is ${ratio} of that at 257`);
  expectLadder(levels[257].moved, levels[513].moved, { rel: 0.1 });

  // The terrain and the parameters of acceptance graph 03 (testing.md 10.2), where `moved` is read as a mask.
  const fractal: Record<number, Record<string, FieldData>> = {};
  for (const res of [257, 513]) {
    const { out: terrain } = await renderNode(fbm, { res, params: { octaves: 4 } });
    fractal[res] = await renderNode(def, { res, inputs: { in: terrain }, params: { talus: 30, reach: 0.05 } });
  }
  expectLadder(fractal[257]!.moved!, fractal[513]!.moved!, { rel: 0.2 });
  const fractalRatio = stats(fractal[513]!.moved!).mean / stats(fractal[257]!.moved!).mean;
  assert.ok(fractalRatio > 0.85 && fractalRatio < 1.15, `on a fractal terrain mean(moved) at 513 is ${fractalRatio} of that at 257`);
});

test('ref/talus: the mask of a maskable node scales the change, and leaves `moved` as computed', async () => {
  const plain = await renderNode(def, { inputs: { in: 'cone' } });
  const none = await renderNode(def, { inputs: { in: 'cone' }, mask: 'zero' });
  const full = await renderNode(def, { inputs: { in: 'cone' }, mask: 'one' });
  expectClose(none.out, fixtures.cone(257), { max: 1e-6 });
  expectClose(full.out, plain.out, { max: 1e-6 });
  expectIdentical(none.moved, plain.moved);
});
