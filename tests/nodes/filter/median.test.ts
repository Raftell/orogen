// tests/nodes/filter/median.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/median.ts';
import { clamped, gaussian, inner, mapField, range } from './_reference.ts';

conformance(def);

const N = 257;

/**
 * The weighted median of the node, in float64: over the lattice points within `radius` steps of `stride` texels,
 * those the edge of the disc crosses counting in part; the mean of the value with half the weight at or below
 * it and the one with half at or above it. Reads clamp to the border.
 */
function median(src: FieldData, radius: number, stride = 1): FieldData {
  const window: { i: number; j: number; w: number }[] = [];
  for (let j = -4; j <= 4; j++) {
    for (let i = -4; i <= 4; i++) {
      const w = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(i, j)));
      if (w > 0) window.push({ i, j, w });
    }
  }
  const total = window.reduce((sum, p) => sum + p.w, 0);
  return mapField(src, (x, y) => {
    const samples = window.map((p) => ({ v: clamped(src, x + stride * p.i, y + stride * p.j), w: p.w })).sort((a, b) => a.v - b.v);
    let below = 0, lower = NaN, upper = NaN;
    for (const s of samples) {
      below += s.w;
      if (Number.isNaN(lower) && below >= total / 2) lower = s.v;
    }
    let above = 0;
    for (const s of samples.toReversed()) {
      above += s.w;
      if (Number.isNaN(upper) && above >= total / 2) upper = s.v;
    }
    return 0.5 * lower + 0.5 * upper;
  });
}

test('filter/median: within the window the output is the median of the heights in a disc of the radius', async () => {
  // Radii of 1.28, 2.56 and 3.84 texels at 257: 9, 29 and 61 samples.
  const src = await fixtures.fbm(N);
  for (const radius of [0.005, 0.01, 0.015]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius } });
    expectClose(out, median(src, radius * 256), { max: 1e-6 });
  }
});

test('filter/median: spikes and pits narrower than the radius are removed, and the terrain under them is not blurred', async () => {
  // The terrain fixture with a spike or a pit of one texel every 16 texels.
  const smooth = fixtures.terrain(N);
  const spiked = mapField(smooth, (x, y) => at(smooth, x, y) + (x % 16 === 8 && y % 16 === 8 ? ((x + y) % 32 === 16 ? 0.5 : -0.5) : 0));
  const { out } = await renderNode(def, { inputs: { in: spiked }, params: { radius: 0.01 } });
  // A median of the smooth terrain differs from it by its curvature over the window only; at the border,
  // where reads clamp, by its slope as well.
  expectClose(inner(out, 4), inner(smooth, 4), { max: 0.01 });
  // A blur of that radius leaves a spike of 0.5 as a hill of 0.012.
  const blurred = gaussian(spiked, 0.01 * 256);
  assert.ok(Math.abs(at(blurred, 136, 136) - at(smooth, 136, 136)) > 0.01);
});

test('filter/median: a cliff stays a cliff, and a ridge narrower than the radius goes', async () => {
  const cliff = fieldOf(N, (u) => (u < 0.5 ? 0.2 : 0.8));
  expectIdentical((await renderNode(def, { inputs: { in: cliff }, params: { radius: 0.015 } })).out, cliff);
  // A wall three texels wide: fewer than half the samples of a window of 3.84 texels.
  const wall = mapField(cliff, (x) => (Math.abs(x - 128) <= 1 ? 1 : 0));
  expectIdentical((await renderNode(def, { inputs: { in: wall }, params: { radius: 0.015 } })).out, fieldOf(N, () => 0));
});

test('filter/median: the median of a terrain turned upside down is the median turned upside down', async () => {
  const src = await fixtures.fbm(N);
  const upside = mapField(src, (x, y) => 1 - at(src, x, y));
  const a = await renderNode(def, { inputs: { in: src }, params: { radius: 0.012 } });
  const b = await renderNode(def, { inputs: { in: upside }, params: { radius: 0.012 } });
  expectClose(b.out, mapField(src, (x, y) => 1 - at(a.out, x, y)), { max: 1e-6 });
});

test('filter/median: a radius the window cannot hold texel by texel is the median still, taken on a coarser grid', async () => {
  // 10.24 texels at 257: 329 texels in the disc. The node ranks them on a grid of 98 cells, 2.6 texels each.
  const src = fixtures.terrain(N);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.04 } });
  /** The median of every texel within 10.24 texels of (x, y). */
  const exact = (x: number, y: number): number => {
    const values: number[] = [];
    for (let j = -11; j <= 11; j++) for (let i = -11; i <= 11; i++) if (Math.hypot(i, j) <= 10.24) values.push(clamped(src, x + i, y + j));
    values.sort((a, b) => a - b);
    return values[(values.length - 1) / 2]!;
  };
  let worst = 0, effect = 0;
  for (let y = 0; y <= 256; y += 8) {
    for (let x = 0; x <= 256; x += 8) {
      worst = Math.max(worst, Math.abs(at(out, x, y) - exact(x, y)));
      effect = Math.max(effect, Math.abs(exact(x, y) - at(src, x, y)));
    }
  }
  // The median moves this terrain by up to 0.04. The 61 samples of the window rank in steps, which on its
  // steepest ground are 0.008 apart: the node is the median of the disc within that.
  assert.ok(effect > 0.03 && worst < 0.3 * effect, `the output differs from the median of the disc by up to ${worst}; the median differs from the terrain by up to ${effect}`);

  // And it does what a median does: a bump 7 texels across is gone, a plateau 60 across keeps its level, and its
  // edge, which a blur of this radius would spread over 50 texels, comes back within the radius.
  const shapes = fieldOf(N, (u, v) => (Math.hypot(u - 0.25, v - 0.5) < 3.5 / 256 ? 1 : 0) + (Math.abs(u - 0.7) < 30 / 256 && Math.abs(v - 0.5) < 30 / 256 ? 1 : 0));
  const cleaned = await renderNode(def, { inputs: { in: shapes }, params: { radius: 0.04 } });
  assert.ok(at(cleaned.out, 64, 128) < 0.01, `the bump is ${at(cleaned.out, 64, 128)} high`);
  assert.ok(at(cleaned.out, 179, 128) > 0.99, `the plateau is ${at(cleaned.out, 179, 128)} high`);
  const rise = at(cleaned.out, 154, 128) - at(cleaned.out, 144, 128);
  assert.ok(rise > 0.9, `the edge of the plateau rises ${rise} within 10 texels`);
});

test('filter/median: the grid of a wide radius is the same at every resolution, and leaves no trace of itself', async () => {
  // At 513 a radius of 0.03 is 15.4 texels, ranked on a grid of 130 cells: every 3.94 texels. Were the samples
  // picked out of the terrain's own texels, the surface would bend at that period.
  const { out } = await renderNode(def, { res: 513, inputs: { in: await fixtures.fbm(513) }, params: { radius: 0.03 } });
  const bend = [0, 0, 0, 0];
  for (let y = 128; y <= 384; y++) {
    for (let x = 128; x < 384; x++) bend[x % 4] += (at(out, x - 1, y) - 2 * at(out, x, y) + at(out, x + 1, y)) ** 2;
  }
  assert.ok(Math.max(...bend) <= 1.2 * Math.min(...bend), `the surface bends ${Math.max(...bend) / Math.min(...bend)} times as much at one column in four as at another`);
});

test('filter/median: up to three quarters of a texel the output is the input itself, and a flat terrain stays flat', async () => {
  // The smallest radius, 0.128 texels at 257: no neighbour counts.
  const src = await fixtures.fbm(N);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius: 0.0005 } });
  expectIdentical(outputs.out, src);
  assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  const flat = fieldOf(N, () => 0.3);
  for (const radius of [0.01, 0.05]) expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius } })).out, flat);
});

test('filter/median: the result is the same at two levels of the ladder, also where only the finer one needs a coarser grid', async () => {
  // 2.56 texels at 257 and 5.12 at 513; then 7.68 and 15.36, both on the grid of 130 cells.
  for (const radius of [0.01, 0.03]) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius } });
    expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
  }
  assert.ok(range(fixtures.terrain(N)) > 0.5);
});
