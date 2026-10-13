// tests/nodes/adjust/equalize.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, decimate, expectClose, expectFinite, expectIdentical, fieldOf, fixtures, renderNode, traceNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/equalize.ts';
import { countValues, extremes, mapValues } from './_reference.ts';

// resolutionDependent: the `resolution` check does not apply to the node, and nothing is opted out of.
conformance(def);

/**
 * Equalization as it is defined, without a sample and without a curve. What lies at the lowest height stays
 * there, and what lies at the highest stays there. Every height between them is moved to its share of the texels
 * that lie strictly between the two: those below it, and half of those exactly at it. In float64.
 */
function ranked(src: FieldData): FieldData {
  const { min: lo, max: hi } = extremes(src);
  const order = Uint32Array.from(src.data.keys()).sort((i, j) => src.data[i] - src.data[j]);
  const n = order.length;
  let below = 0;
  while (below < n && src.data[order[below]] === lo) below++;
  let top = n;
  while (top > below && src.data[order[top - 1]] === hi) top--;
  const data = new Float32Array(n);
  for (let r = 0; r < n; r++) data[order[r]] = r < below ? lo : hi;
  for (let r = below; r < top;) {
    let end = r + 1;
    while (end < top && src.data[order[end]] === src.data[order[r]]) end++;
    const share = (r - below + (end - r) / 2) / (top - below);
    for (let q = r; q < end; q++) data[order[q]] = lo * (1 - share) + hi * share;
    r = end;
  }
  return { ...src, data };
}

/** The share of the texels `counted` in each of ten equal bands between the lowest and the highest height of the field. */
function bands(f: FieldData, counted: (i: number) => boolean = () => true): number[] {
  const { min, max } = extremes(f);
  const shares = new Array<number>(10).fill(0);
  let n = 0;
  for (let i = 0; i < f.data.length; i++) {
    if (!counted(i)) continue;
    shares[Math.min(9, Math.floor(((f.data[i] - min) / (max - min)) * 10))]++;
    n++;
  }
  return shares.map((count) => count / n);
}
const printed = (shares: readonly number[]): string => shares.map((share) => share.toFixed(3)).join(' ');

/** The largest difference between two fields, as a share of the range of the second. */
function apart(a: FieldData, b: FieldData): number {
  const { min, max } = extremes(b);
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
  return worst / (max - min);
}

async function equalized(src: FieldData, strength = 1): Promise<FieldData> {
  return (await renderNode(def, { res: src.width, inputs: { in: src }, params: { strength } })).out;
}

const TERRAIN = fixtures.terrain(257);

// Fractal noise is rendered on the GPU: made by the first test that asks for it, not while the file loads.
const noise = new Map<number, Promise<FieldData>>();
function fbm(res: 257 | 513): Promise<FieldData> {
  let made = noise.get(res);
  if (!made) noise.set(res, made = fixtures.fbm(res));
  return made;
}

/**
 * Terrains whose heights crowd into a small part of their range. A histogram of equal bins between the lowest
 * and the highest height puts nearly all of each into a handful of bins.
 */
async function crowded(): Promise<Readonly<Record<string, FieldData>>> {
  const base = await fbm(257);
  return {
    'one texel far above the rest': { ...base, data: base.data.map((v, i) => (i === 100 * 257 + 100 ? 50 : v)) },
    'a plain with one mountain': fieldOf(257, (u, v) => 0.1 + 0.02 * base.data[Math.round(v * 256) * 257 + Math.round(u * 256)] + 0.9 * Math.max(0, 1 - 6 * Math.hypot(u - 0.5, v - 0.5)) ** 2),
    'heights raised to the sixth power': mapValues(base, (v) => v ** 6),
    'a sea floor far below the land': mapValues(base, (v) => (v > 0.5 ? v : v - 5 * (0.5 - v) ** 0.25)),
  };
}

test('adjust/equalize: at 257 every texel is ranked, and the result is within 0.2 % of the range of the exact rank of every height', async () => {
  // The curve goes through the exact ranks a 128th of the terrain apart, and closer at the two ends. Between two
  // knots the curve and the ranks both rise from the rank of the one to that of the other, so whatever the terrain
  // no height is further from its rank than two knots are apart. Where the heights are spread smoothly it is far
  // closer. Measured: 0.06 % on the terrain fixture and 0.08 % on fractal noise.
  for (const [name, src] of [['the terrain fixture', TERRAIN], ['fractal noise', await fbm(257)]] as const) {
    const error = apart(await equalized(src), ranked(src));
    assert.ok(error <= 0.002, `${name}: the result differs from the ranks by ${error} of the range`);
  }
  // The share of the terrain at a height changes abruptly on the basin fixture, where its slope meets the rim of
  // its depression; measured there, 0.35 %.
  const kinked = apart(await equalized(fixtures.basin(257)), ranked(fixtures.basin(257)));
  assert.ok(kinked <= 1 / 128, `the basin fixture: the result differs from the ranks by ${kinked} of the range`);
});

test('adjust/equalize: every tenth of the height range covers a tenth of the terrain', async () => {
  for (const [name, src] of [['the terrain fixture', TERRAIN], ['fractal noise', await fbm(257)]] as const) {
    const before = bands(src), after = bands(await equalized(src));
    assert.ok(Math.max(...before) > 0.15 && Math.min(...before) < 0.05, `${name} is uneven before: ${printed(before)}`);
    assert.ok(Math.max(...after) < 0.102 && Math.min(...after) > 0.098, `${name} after: ${printed(after)}`);
  }
});

for (const name of ['one texel far above the rest', 'a plain with one mountain', 'heights raised to the sixth power', 'a sea floor far below the land']) {
  test(`adjust/equalize: ${name}: heights that crowd into a small part of their range are spread as evenly as any`, async () => {
    const src = (await crowded())[name];
    const before = bands(src);
    assert.ok(Math.max(...before) > 0.4, `the input is crowded: ${printed(before)}`);
    const out = await equalized(src);
    const after = bands(out);
    assert.ok(Math.max(...after) < 0.103 && Math.min(...after) > 0.097, `after: ${printed(after)}`);
    // Measured: 0.08 %, 0.14 %, 0.09 % and 0.24 %.
    const error = apart(out, ranked(src));
    assert.ok(error <= 0.004, `the result differs from the ranks by ${error} of the range`);
  });
}

test('adjust/equalize: the lowest and the highest point stay where they were, and the order of the heights is kept', async () => {
  // Heights outside 0..1 are legal inside a graph: the terrain between -3 and 5.
  const src = mapValues(TERRAIN, (v) => 8 * v - 3.5);
  const out = await equalized(src);
  const before = extremes(src), after = extremes(out);
  assert.ok(after.min === before.min && after.max === before.max, `${before.min}..${before.max} became ${after.min}..${after.max}`);
  const order = Array.from(src.data.keys()).sort((i, j) => src.data[i] - src.data[j]);
  let falls = 0;
  for (let r = 1; r < order.length; r++) if (out.data[order[r]] < out.data[order[r - 1]] - 1e-6) falls++;
  assert.equal(falls, 0, 'a higher point of the input became the lower one');
  // The result is that of the same terrain between 0 and 1, stretched: the node knows no absolute height.
  expectClose(out, mapValues(await equalized(TERRAIN), (v) => 8 * v - 3.5), { max: 2e-4 });
});

test('adjust/equalize: the lowest and the highest level stay, and a level between them takes its place among what lies between', async () => {
  // A quarter of the field at 0.2 and the rest at 0.8: there is nothing between the two to redistribute.
  const two = fieldOf(257, (u) => (u < 0.25 ? 0.2 : 0.8));
  expectIdentical(await equalized(two), two);
  // A fifth of the field at 0.2, half of it at 0.5 and the rest at 0.9. All that lies between the two ends is the
  // one level: half of it counts as below itself, so it goes to the middle of the range.
  const three = fieldOf(257, (u) => (u < 0.2 ? 0.2 : u < 0.7 ? 0.5 : 0.9));
  const out = await equalized(three);
  const lo = Math.fround(0.2), mid = Math.fround(0.5), hi = Math.fround(0.9);
  assert.equal(countValues(out, (v, i) => three.data[i] === lo && v !== lo), 0, 'the lowest level moved');
  assert.equal(countValues(out, (v, i) => three.data[i] === mid && Math.abs(v - (lo + hi) / 2) > 1e-6), 0, 'the middle level is not in the middle of the range');
  assert.equal(countValues(out, (v, i) => three.data[i] === hi && v !== hi), 0, 'the highest level moved');
});

test('adjust/equalize: a level sea and a level plateau stay where they are, and the ground between them takes the whole range without a cliff at either', async () => {
  // Everything below 0.45 becomes sea at 0.45 and everything above 0.6 a plateau at 0.6: about a third and a
  // sixth of the fractal noise.
  const base = await fbm(257);
  const sea = Math.fround(0.45), plateau = Math.fround(0.6);
  const src = mapValues(base, (v) => Math.min(Math.max(v, sea), plateau));
  const flooded = countValues(src, (v) => v === sea) / src.data.length, flat = countValues(src, (v) => v === plateau) / src.data.length;
  assert.ok(flooded > 0.2 && flat > 0.1, `the sea is ${flooded} of the field and the plateau ${flat}`);
  const out = await equalized(src);
  assert.equal(countValues(out, (v, i) => src.data[i] === sea && v !== sea), 0, 'the sea moved');
  assert.equal(countValues(out, (v, i) => src.data[i] === plateau && v !== plateau), 0, 'the plateau moved');
  const between = (i: number): boolean => src.data[i] > sea && src.data[i] < plateau;
  const slopes = bands(out, between);
  assert.ok(Math.max(...slopes) < 0.103 && Math.min(...slopes) > 0.097, `the ground between them, after: ${printed(slopes)}`);
  // The lowest ground lies just above the sea and the highest just below the plateau.
  let shore = Infinity, brink = -Infinity;
  for (let i = 0; i < out.data.length; i++) {
    if (!between(i)) continue;
    shore = Math.min(shore, out.data[i]);
    brink = Math.max(brink, out.data[i]);
  }
  assert.ok(shore - sea < 1e-4 && plateau - brink < 1e-4, `the ground between spans ${shore}..${brink}; the sea is at ${sea} and the plateau at ${plateau}`);
  expectClose(out, ranked(src), { max: 0.002 * (plateau - sea) });
});

test('adjust/equalize: a terrain turned over gives the result turned over', async () => {
  const src = await fbm(257);
  const { min, max } = extremes(src);
  const turned = mapValues(src, (v) => min + max - v);
  // The two curves have their knots at the same shares of the terrain, counted from opposite ends.
  expectClose(await equalized(turned), mapValues(await equalized(src), (v) => min + max - v), { max: 0.001 * (max - min) });
});

test('adjust/equalize: above 257 the heights are ranked on every second texel, and the result stays within 0.3 % of the range of the exact one', async () => {
  // At 513 the sample is the level of 257: a quarter of the texels. Measured on fractal noise: 0.10 % from the
  // ranks of all texels.
  const src = await fbm(513);
  const error = apart(await equalized(src), ranked(src));
  assert.ok(error <= 0.003, `the result differs from the ranks of all texels by ${error} of the range`);
});

test('adjust/equalize: the sample is the coarser ladder level, so a preview and its build rank the same points', async () => {
  // A field of 513 that is fractal noise on the vertices it shares with the level of 257 and one height, inside
  // the range of the noise, on all others: three quarters of its texels. Ranked on the shared vertices alone it
  // gives, at those vertices, what the level of 257 gives by itself; ranked on any other texels it would not.
  const base = await fbm(513);
  const { min, max } = extremes(decimate(base));
  const fine = fieldOf(513, (u, v) => {
    const x = Math.round(u * 512), y = Math.round(v * 512);
    return x % 2 === 0 && y % 2 === 0 ? base.data[y * 513 + x] : (min + max) / 2;
  });
  expectClose(decimate(await equalized(fine)), await equalized(decimate(fine)), { max: 1e-6 });
});

test('adjust/equalize: the result has no steps in slope where the knots of its curve lie', async () => {
  // One column of the fractal noise is replaced by a ramp from the height below which 30 % of the terrain lies to
  // the one below which 42 % does: along it the result is the curve from height to rank itself, across 15 of its
  // 128 knots, 17 texels to a knot. A curve of straight lines bends at the knots only: its second difference is a
  // spike at every 17th texel and 0 between, and differs from the mean of its two neighbours by twice its own
  // size, summed over the column. The cubic through the knots bends everywhere, by an amount that runs in a
  // straight line from knot to knot, which differs from the mean of its neighbours only where two such lines meet.
  const base = await fbm(257);
  const sorted = Float32Array.from(base.data).sort();
  const from = sorted[Math.round(0.30 * (sorted.length - 1))], to = sorted[Math.round(0.42 * (sorted.length - 1))];
  const src = fieldOf(257, (u, v) => (Math.round(u * 256) === 200 ? from + (to - from) * v : base.data[Math.round(v * 256) * 257 + Math.round(u * 256)]));
  const out = await equalized(src);
  const bend = (y: number): number => out.data[(y - 1) * 257 + 200] - 2 * out.data[y * 257 + 200] + out.data[(y + 1) * 257 + 200];
  let uneven = 0, total = 0;
  for (let y = 2; y < 255; y++) {
    uneven += Math.abs(bend(y) - (bend(y - 1) + bend(y + 1)) / 2);
    total += Math.abs(bend(y));
  }
  assert.ok(total > 1e-4, `the column bends by ${total} in all: the terrain is not spread evenly between those heights`);
  assert.ok(uneven < 0.6 * total, `the bend differs from the mean of its neighbours by ${uneven} in all; the bends sum to ${total}`);
});

test('adjust/equalize: the strength moves every height that far toward its new place', async () => {
  const full = await equalized(TERRAIN);
  // Without strength the input itself is the output: nothing is measured.
  const none = await traceNode(def, { inputs: { in: TERRAIN }, params: { strength: 0 } });
  expectIdentical(none.outputs.out, TERRAIN);
  assert.equal(none.report.nodes.node.peakBytes, 0);
  const halfway = await equalized(TERRAIN, 0.5);
  expectClose(halfway, { ...TERRAIN, data: TERRAIN.data.map((v, i) => v + 0.5 * (full.data[i] - v)) }, { max: 1e-6 });
});

test('adjust/equalize: a flat terrain, which has no heights to redistribute, is passed through', async () => {
  const flat = fieldOf(257, () => 0.375);
  const { outputs, report } = await traceNode(def, { inputs: { in: flat } });
  expectIdentical(outputs.out, flat);
  assert.equal(report.nodes.node.peakBytes, 0);
});

test('adjust/equalize: heights as large as a float holds are ranked like any others', async () => {
  // The range of this field is twice the largest float: no difference of two of its heights may be computed as it stands.
  const src = fieldOf(257, (u, v) => 3e38 * (2 * (0.75 * u + 0.25 * v) - 1));
  const out = await equalized(src);
  expectFinite(out);
  assert.equal(countValues(out, (v, i) => i % 257 > 0 && v < out.data[i - 1]), 0, 'the output falls where the input rises');
  const error = apart(out, ranked(src));
  assert.ok(error <= 0.002, `the result differs from the ranks by ${error} of the range`);
});

test('adjust/equalize: the node holds no more than its result', async () => {
  // The sample of 257 x 257 texels is released before the result is allocated.
  const { report } = await traceNode(def, { res: 513, inputs: { in: await fbm(513) } });
  assert.equal(report.nodes.node.peakBytes, 513 * 513 * 4);
});

test('adjust/equalize: the heights are ranked among those of the evaluated level, so a preview differs from the build', async () => {
  // A plateau one texel wide at 513 lies between the vertices of 257: the coarser level never sees its height.
  const spike = (res: number) => fieldOf(res, (u, v) => (Math.abs(u - 255 / 512) < 1e-9 && Math.abs(v - 255 / 512) < 1e-9 ? 2 : u));
  const coarse = await equalized(spike(257));
  const fine = await equalized(spike(513));
  assert.ok(extremes(coarse).max === 1 && extremes(fine).max === 2);
});
