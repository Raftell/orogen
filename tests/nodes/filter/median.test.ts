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
  // 3.84 texels at 257, the texels of the disc; and 12.8 texels, 61 texels spread over the disc and then the
  // texels of a disc of 3.2. A window that is its own mirror image has more than half its samples on the side of
  // a straight cliff its centre is on, whichever way the cliff runs.
  const cliff = fieldOf(N, (u) => (u < 0.5 ? 0.2 : 0.8));
  const slanted = fieldOf(N, (u, v) => (u + 0.37 * v < 0.7 ? 0.2 : 0.8));
  // A wall three texels wide: fewer than half the samples of either window.
  const wall = mapField(cliff, (x) => (Math.abs(x - 128) <= 1 ? 1 : 0));
  for (const radius of [0.015, 0.05]) {
    expectIdentical((await renderNode(def, { inputs: { in: cliff }, params: { radius } })).out, cliff);
    // Beyond the border the window reads the border texels again, which is no mirror image of what lies inside.
    expectIdentical(inner((await renderNode(def, { inputs: { in: slanted }, params: { radius } })).out, 13), inner(slanted, 13));
    expectIdentical((await renderNode(def, { inputs: { in: wall }, params: { radius } })).out, fieldOf(N, () => 0));
  }
});

test('filter/median: the median of a terrain turned upside down is the median turned upside down', async () => {
  const src = await fixtures.fbm(N);
  const upside = mapField(src, (x, y) => 1 - at(src, x, y));
  for (const radius of [0.012, 0.05]) {
    const a = await renderNode(def, { inputs: { in: src }, params: { radius } });
    const b = await renderNode(def, { inputs: { in: upside }, params: { radius } });
    expectClose(b.out, mapField(src, (x, y) => 1 - at(a.out, x, y)), { max: 1e-6 });
  }
});

/** The median of every texel within `radius` texels of (x, y). */
function discMedian(src: FieldData, x: number, y: number, radius: number): number {
  const values: number[] = [];
  const reach = Math.ceil(radius);
  for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) if (Math.hypot(i, j) <= radius) values.push(clamped(src, x + i, y + j));
  values.sort((a, b) => a - b);
  return 0.5 * values[Math.floor((values.length - 1) / 2)]! + 0.5 * values[Math.ceil((values.length - 1) / 2)]!;
}

test('filter/median: a radius wider than the window is the median of the disc still, from 61 of its texels', async () => {
  // 10.24 texels at 257: 329 texels in the disc, of which the window reads 61, and then the 37 of a disc of 2.56.
  for (const [name, src] of [['terrain', fixtures.terrain(N)], ['fbm', await fixtures.fbm(N)]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.04 } });
    let error = 0, effect = 0, count = 0;
    for (let y = 0; y <= 256; y += 8) {
      for (let x = 0; x <= 256; x += 8) {
        const exact = discMedian(src, x, y, 10.24);
        error += (at(out, x, y) - exact) ** 2;
        effect += (exact - at(src, x, y)) ** 2;
        count++;
      }
    }
    error = Math.sqrt(error / count);
    effect = Math.sqrt(effect / count);
    // The median of 61 samples of a disc is the median of the disc to within the ranks one sample stands for.
    // Measured: 0.10 to 0.12 of what the median changes.
    assert.ok(effect > 0.01 && error < 0.2 * effect, `${name}: the output differs from the median of the disc by ${error} in the root mean square; the median differs from the terrain by ${effect}`);
  }

  // And it does what a median does: a bump 7 texels across is gone, a plateau 60 across keeps its level, and its
  // edge, which a blur of this radius would spread over 50 texels, stays where it is, as sharp as it was.
  const shapes = fieldOf(N, (u, v) => (Math.hypot(u - 0.25, v - 0.5) < 3.5 / 256 ? 1 : 0) + (Math.abs(u - 0.7) < 30 / 256 && Math.abs(v - 0.5) < 30 / 256 ? 1 : 0));
  const cleaned = await renderNode(def, { inputs: { in: shapes }, params: { radius: 0.04 } });
  assert.ok(at(cleaned.out, 64, 128) < 0.01, `the bump is ${at(cleaned.out, 64, 128)} high`);
  assert.ok(at(cleaned.out, 179, 128) > 0.99, `the plateau is ${at(cleaned.out, 179, 128)} high`);
  assert.equal(at(cleaned.out, 149, 128), 0, 'outside the edge of the plateau');
  assert.equal(at(cleaned.out, 150, 128), 1, 'inside it');
});

test('filter/median: a pattern finer than the radius is flattened whatever its period, and leaves no trace of the window', async () => {
  // A radius of 0.05 is 12.8 texels at 257. Waves of these periods have their crests and troughs in equal
  // shares in every disc of that size. Samples on a grid would meet a wave of their own spacing at one phase
  // and pass it on.
  for (const period of [3, 4, 5, 6.5, 8]) {
    const waves = fieldOf(N, (u) => 0.5 + 0.2 * Math.sin((2 * Math.PI * u * 256) / period));
    const { out } = await renderNode(def, { inputs: { in: waves }, params: { radius: 0.05 } });
    assert.ok(range(inner(out, 16)) < 0.1 * range(inner(waves, 16)), `waves of ${period} texels are left ${range(inner(out, 16))} high of ${range(inner(waves, 16))}`);
  }
  // At 513 a radius of 0.03 is 15.4 texels. Were the samples a grid, the surface would bend at its period.
  const { out } = await renderNode(def, { res: 513, inputs: { in: await fixtures.fbm(513) }, params: { radius: 0.03 } });
  for (const period of [2, 3, 4, 5]) {
    const bend = Array.from({ length: period }, () => 0);
    for (let y = 128; y <= 384; y++) {
      for (let x = 128; x < 368; x++) bend[x % period]! += (at(out, x - 1, y) - 2 * at(out, x, y) + at(out, x + 1, y)) ** 2;
    }
    assert.ok(Math.max(...bend) <= 1.2 * Math.min(...bend), `the surface bends ${Math.max(...bend) / Math.min(...bend)} times as much at one column in ${period} as at another`);
  }
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

test('filter/median: the result is the same at two levels of the ladder, also where only the finer one needs a wider window', async () => {
  // 2.56 texels at 257 and 5.12 at 513, where the window is spread; then 7.68 and 15.36, both spread.
  for (const radius of [0.01, 0.03]) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius } });
    expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
  }
  assert.ok(range(fixtures.terrain(N)) > 0.5);
});
