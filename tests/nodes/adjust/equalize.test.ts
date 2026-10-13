// tests/nodes/adjust/equalize.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, traceNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/equalize.ts';
import { countValues, extremes, mapValues } from './_reference.ts';

// resolutionDependent: the `resolution` check does not apply to the node, and nothing is opted out of.
conformance(def);

const BINS = 256;

/**
 * The node on the CPU, in float64. The cumulative histogram of every `stride`-th texel of each row and column,
 * in 256 bins between the lowest and the highest height of the whole field; every height is then moved to the
 * share of the samples at or below it, read from the cubic B-spline of the cumulative counts.
 */
function reference(src: FieldData, stride = 1): FieldData {
  const n = src.width;
  const { min: lo, max: hi } = extremes(src);
  const width = Math.fround(hi - lo);
  if (!(width > 0)) return src;
  // The upper edge of each bin, in the float arithmetic of the kernel.
  const edge = (bin: number): number => Math.fround(lo + Math.fround(width * ((bin + 1) / BINS)));
  const counts = new Float64Array(BINS);
  let total = 0;
  for (let y = 0; y < n; y += stride) {
    for (let x = 0; x < n; x += stride) {
      const v = src.data[y * n + x];
      let bin = Math.min(BINS - 1, Math.max(0, Math.ceil(((v - lo) / width) * BINS) - 1));
      while (bin < BINS - 1 && v > edge(bin)) bin++;
      while (bin > 0 && v <= edge(bin - 1)) bin--;
      counts[bin]++;
      total++;
    }
  }
  for (let bin = 1; bin < BINS; bin++) counts[bin] += counts[bin - 1];   // cumulative: at or below the upper edge
  const point = (k: number): number => (k === 0 ? 0 : k < 0 ? -counts[0] : k > BINS ? 2 * counts[BINS - 1] - counts[BINS - 2] : counts[k - 1]);
  return mapValues(src, (v) => {
    const t = Math.min(1, Math.max(0, (v - lo) / width)) * BINS;
    const k = Math.min(Math.floor(t), BINS - 1);
    const f = t - k, g = 1 - f;
    const share = (g ** 3 * point(k - 1) + (3 * f ** 3 - 6 * f * f + 4) * point(k) + (3 * g ** 3 - 6 * g * g + 4) * point(k + 1) + f ** 3 * point(k + 2)) / (6 * total);
    return lo + width * Math.min(1, Math.max(0, share));
  });
}

/** The equalization that needs no histogram: every height moved to its rank among all the heights of the field. */
function ranked(src: FieldData): FieldData {
  const { min: lo, max: hi } = extremes(src);
  const order = Array.from(src.data.keys()).sort((i, j) => src.data[i] - src.data[j]);
  const data = new Float32Array(src.data.length);
  for (let r = 0; r < order.length; r++) data[order[r]] = lo + (hi - lo) * (r / (order.length - 1));
  return { ...src, data };
}

/** The share of the field in each of ten equal bands between its lowest and its highest height. */
function bands(f: FieldData): number[] {
  const { min, max } = extremes(f);
  const shares = new Array<number>(10).fill(0);
  for (const v of f.data) shares[Math.min(9, Math.floor(((v - min) / (max - min)) * 10))] += 1 / f.data.length;
  return shares;
}

const largest = (a: FieldData, b: FieldData): number => {
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
  return worst;
};

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

test('adjust/equalize: at 257 the histogram is that of every texel, and the result is the reference', async () => {
  // A height that lies on the edge of a bin to the last bit may be counted on either side: one count of 66 049
  // moves the result by 1.5e-5 of the range.
  for (const src of [TERRAIN, await fbm(257), fixtures.cone(257)]) expectClose(await equalized(src), reference(src), { max: 5e-5 });
});

test('adjust/equalize: every tenth of the height range covers a tenth of the terrain', async () => {
  for (const [name, src] of [['the terrain fixture', TERRAIN], ['fractal noise', await fbm(257)]] as const) {
    const before = bands(src), after = bands(await equalized(src));
    assert.ok(Math.max(...before) > 0.15 && Math.min(...before) < 0.05, `${name} is uneven before: ${before.map((share) => share.toFixed(3)).join(' ')}`);
    assert.ok(Math.max(...after) < 0.102 && Math.min(...after) > 0.098, `${name} after: ${after.map((share) => share.toFixed(3)).join(' ')}`);
  }
});

test('adjust/equalize: the lowest and the highest point stay where they were, and the order of the heights is kept', async () => {
  // Heights outside 0..1 are legal inside a graph: the terrain between -3 and 5.
  const src = mapValues(TERRAIN, (v) => 8 * v - 3.5);
  const out = await equalized(src);
  const before = extremes(src), after = extremes(out);
  assert.ok(after.min === before.min && Math.abs(after.max - before.max) <= 1e-6, `${before.min}..${before.max} became ${after.min}..${after.max}`);
  const order = Array.from(src.data.keys()).sort((i, j) => src.data[i] - src.data[j]);
  let falls = 0;
  for (let r = 1; r < order.length; r++) if (out.data[order[r]] < out.data[order[r - 1]] - 1e-6) falls++;
  assert.equal(falls, 0, 'a higher point of the input became the lower one');
  // The result is that of the same terrain between 0 and 1, stretched: the node knows no absolute height.
  expectClose(out, mapValues(await equalized(TERRAIN), (v) => 8 * v - 3.5), { max: 2e-4 });
});

test('adjust/equalize: the result is within 0.2 % of the range of the rank of every height among all heights', async () => {
  // 256 bins and a smooth curve through their counts stand for the exact ranks: measured, 0.05 % on the terrain
  // fixture and 0.07 % on fractal noise.
  for (const src of [TERRAIN, await fbm(257)]) {
    const { min, max } = extremes(src);
    const error = largest(await equalized(src), ranked(src)) / (max - min);
    assert.ok(error <= 0.002, `the result differs from the ranks by ${error} of the range`);
  }
});

test('adjust/equalize: above 257 the histogram is counted on every second texel, and the result stays within 0.3 % of the range of the exact one', async () => {
  // At 513 the sample is the level of 257: a quarter of the texels. Measured on fractal noise: the sample moves
  // the result by 0.09 % of the range, and the result is 0.11 % from the ranks of all texels.
  const src = await fbm(513);
  const out = await equalized(src);
  expectClose(out, reference(src, 2), { max: 5e-5 });
  const { min, max } = extremes(src);
  const sampled = largest(out, reference(src, 1)) / (max - min);
  const exact = largest(out, ranked(src)) / (max - min);
  assert.ok(sampled <= 0.003, `the sample moves the result by ${sampled} of the range`);
  assert.ok(exact <= 0.003, `the result differs from the ranks of all texels by ${exact} of the range`);
});

test('adjust/equalize: the result has no steps in slope where the bins of the histogram meet', async () => {
  // One column of the fractal noise is replaced by a ramp that crosses 64 bins of the histogram in 256 texels:
  // along it the result is the curve of the cumulative histogram itself, four texels to a bin. A table read in
  // straight lines bends at the bin edges only: its second difference is a spike at every fourth texel and 0
  // between, and differs from the mean of its two neighbours by twice its own size, summed over the column. The
  // curve through the counts bends everywhere, by an amount that runs in straight lines from bin to bin, which
  // differs from the mean of its neighbours only where two of those lines meet: by a quarter of its size.
  const base = await fbm(257);
  const { min, max } = extremes(base);
  const src = fieldOf(257, (u, v) => (Math.round(u * 256) === 200 ? min + (max - min) * (0.3 + 0.25 * v) : base.data[Math.round(v * 256) * 257 + Math.round(u * 256)]));
  const out = await equalized(src);
  const bend = (y: number): number => out.data[(y - 1) * 257 + 200] - 2 * out.data[y * 257 + 200] + out.data[(y + 1) * 257 + 200];
  let uneven = 0, total = 0;
  for (let y = 2; y < 255; y++) {
    uneven += Math.abs(bend(y) - (bend(y - 1) + bend(y + 1)) / 2);
    total += Math.abs(bend(y));
  }
  assert.ok(total > 1e-4, `the column bends by ${total} in all: the histogram of the noise is not flat`);
  assert.ok(uneven < 0.6 * total, `the bend differs from the mean of its neighbours by ${uneven} in all; the bends sum to ${total}`);
});

test('adjust/equalize: the strength moves every height that far toward its new place', async () => {
  const full = await equalized(TERRAIN);
  // Without strength the input itself is the output: no histogram is built.
  const none = await traceNode(def, { inputs: { in: TERRAIN }, params: { strength: 0 } });
  expectIdentical(none.outputs.out, TERRAIN);
  assert.equal(none.report.nodes.node.peakBytes, 0);
  const halfway = await equalized(TERRAIN, 0.5);
  expectClose(halfway, { ...TERRAIN, data: TERRAIN.data.map((v, i) => v + 0.5 * (full.data[i] - v)) }, { max: 1e-6 });
});

test('adjust/equalize: a flat terrain, which has no heights to redistribute, is left as it is', async () => {
  const flat = fieldOf(257, () => 0.375);
  expectIdentical(await equalized(flat), flat);
});

test('adjust/equalize: a terrain of two levels is spread by the share of each level', async () => {
  // A quarter of the field at 0.2 and the rest at 0.8: the lowest stays, and so does the highest.
  const src = fieldOf(257, (u) => (u < 0.25 ? 0.2 : 0.8));
  const out = await equalized(src);
  assert.equal(countValues(out, (v, i) => src.data[i] === Math.fround(0.2) && v !== Math.fround(0.2)), 0);
  assert.equal(countValues(out, (v, i) => src.data[i] === Math.fround(0.8) && Math.abs(v - 0.8) > 1e-6), 0);
});

test('adjust/equalize: the histogram is built on the GPU in textures a small fraction of the field', async () => {
  const { report } = await traceNode(def, { res: 513, inputs: { in: await fbm(513) } });
  const field = 513 * 513 * 4;
  // The result, and beside it the counts of 33 x 33 blocks in 16 x 16 bins: 528 x 528 texels.
  assert.ok(report.nodes.node.peakBytes < 2.2 * field, `the node held ${report.nodes.node.peakBytes} bytes; a field of 513 is ${field}`);
});

test('adjust/equalize: the histogram is that of the evaluated level, so a preview differs from the build', async () => {
  // A plateau one texel wide at 513 lies between the vertices of 257: the coarser level never sees its height.
  const spike = (res: number) => fieldOf(res, (u, v) => (Math.abs(u - 255 / 512) < 1e-9 && Math.abs(v - 255 / 512) < 1e-9 ? 2 : u));
  const coarse = await equalized(spike(257));
  const fine = await equalized(spike(513));
  assert.ok(Math.abs(extremes(coarse).max - 1) <= 1e-6 && Math.abs(extremes(fine).max - 2) <= 1e-6);
});
