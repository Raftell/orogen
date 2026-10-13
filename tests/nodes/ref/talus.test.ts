// tests/nodes/ref/talus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
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

test('ref/talus: a plane gives way when it is steeper than the talus angle and rests when it is gentler, whichever way it faces', async () => {
  // The slope at the middle of a pair is that of the plane, whichever way the plane faces. Between two neighbours
  // alone a plane that faces 22.5 degrees off a row is 8 % gentler than it is: 6 % above the talus slope it rested.
  // With the test settings a height of 1 across the terrain is a slope of 0.25, and the default talus angle is 35.
  const talus = Math.tan((35 * Math.PI) / 180) / 0.25;
  for (const facing of [0, 22.5, 45, 67.5, 90, 200]) {
    const along = Math.cos((facing * Math.PI) / 180), across = Math.sin((facing * Math.PI) / 180);
    const plane = (slope: number): FieldData => fieldOf(257, (u, v) => 0.5 + slope * ((u - 0.5) * along + (v - 0.5) * across));
    // Along a uniform slope every texel passes on what it receives: the plane keeps its shape, and `moved` shows the stream.
    const steeper = await renderNode(def, { inputs: { in: plane(1.06 * talus) }, wants: ['moved'] });
    assert.ok(at(steeper.moved, 128, 128) > 1e-4, `on a plane 6 % steeper than the talus slope that faces ${facing} degrees, ${at(steeper.moved, 128, 128)} crossed the centre`);
    const gentler = await renderNode(def, { inputs: { in: plane(0.94 * talus) } });
    expectIdentical(gentler.out, plane(0.94 * talus));
    assert.equal(stats(gentler.moved).max, 0, `a plane 6 % gentler than the talus slope that faces ${facing} degrees is at rest`);
  }
});

test('ref/talus: a heap comes to rest round, not as an octagon', async () => {
  // A cone 15 texels in radius with a flank of 63 degrees, and a reach long enough for it to spread.
  const heap = fieldOf(257, (u, v) => Math.max(0, 0.48 * (1 - Math.hypot(u - 0.5, v - 0.5) / 0.06)));
  const { out } = await renderNode(def, { inputs: { in: heap }, params: { reach: 0.25 }, wants: ['out'] });
  const top = at(out, 128, 128);
  assert.ok(top < 0.4, `the heap spread: its top is at ${top}`);

  // Where the heap falls below a tenth of its height, in texels from the centre, along a ray: bilinear between texels.
  const height = (x: number, y: number): number => {
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    return (at(out, x0, y0) * (1 - tx) + at(out, x0 + 1, y0) * tx) * (1 - ty) + (at(out, x0, y0 + 1) * (1 - tx) + at(out, x0 + 1, y0 + 1) * tx) * ty;
  };
  const foot = (degrees: number): number => {
    const dx = Math.cos((degrees * Math.PI) / 180), dy = Math.sin((degrees * Math.PI) / 180);
    const STEP = 0.25;
    for (let r = STEP, above = top; r < 100; r += STEP) {
      const here = height(128 + r * dx, 128 + r * dy);
      if (here < 0.1 * top) return r - STEP * (0.1 * top - here) / (above - here);
      above = here;
    }
    return Number.NaN;
  };
  // Along the rows and columns, the diagonals, and between them. With the threshold taken between two texels alone
  // the contour lay 0.25 texels further out on the diagonals than on the rows.
  const feet = [0, 22.5, 45, 67.5, 90, 135, 180, 202.5, 270, 315].map(foot);
  const spread = Math.max(...feet) - Math.min(...feet);
  assert.ok(spread <= 0.1, `the contour at a tenth of the height lies ${Math.min(...feet)} to ${Math.max(...feet)} texels from the centre: ${spread} apart, allowed 0.1`);
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
