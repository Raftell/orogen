// The two worked nodes of engine.md section 6, ref/fbm and ref/talus, through the whole product: documents made
// with the commands, the registry of the reference nodes, and the harness's engine on the process's device
// (testing.md section 2): every evaluation is Engine.evaluate on a real Engine, with the Node file source and
// CPU runner. Every expectation is a property the contract states (engine.md 1.7, 3.14, 4.10, 4.13; testing.md
// 3.4 and 10.2 graphs 01 and 03), never a number from an earlier run.
//
// Sizes: fields of 257 x 257 and 513 x 513 floats (1 MiB at most each); no list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { hashCell, mixSeed, type ParamValue } from '../../src/core/api.ts';
import { parseDoc, serializeDoc, type GraphDoc, type ProjectSettings } from '../../src/core/runtime.ts';
import {
  expectNoLeaks, getEngine, makeDoc, openGraph, TEST_SETTINGS, type GraphOptions, type GraphRender, type GraphSession,
} from '../helpers/index.ts';
import { writeGrey, writeHillshade } from './pictures.ts';

const SETTINGS: ProjectSettings = TEST_SETTINGS;
const FIELD_BYTES = (res: number): number => res * res * 4;

// ---- documents, made with the commands of runtime.md 4.6 ----------------------------------------------------------

type Params = Readonly<Record<string, ParamValue>>;

/**
 * ref/fbm → ref/talus, and when `maskSeed` is given a second ref/fbm on the mask input the node gets from
 * `maskable`. The nodes are named `fbm`, `talus` and `mask`.
 */
function terrain(opts: { fbm?: Params; talus?: Params; maskSeed?: number; settings?: Partial<ProjectSettings> } = {}): GraphDoc {
  return makeDoc({
    ...(opts.settings ? { settings: opts.settings } : {}),
    nodes: {
      fbm: { type: 'ref/fbm', ...(opts.fbm ? { params: opts.fbm } : {}) },
      ...(opts.maskSeed !== undefined ? { mask: { type: 'ref/fbm', params: { seed: opts.maskSeed } } } : {}),
      talus: {
        type: 'ref/talus', ...(opts.talus ? { params: opts.talus } : {}),
        inputs: { in: 'fbm.out', ...(opts.maskSeed !== undefined ? { mask: 'mask.out' } : {}) },
      },
    },
  });
}

// ---- evaluations: the harness's sessions, which keep the cache between them (testing.md 2.4) ------------------------

const sessions = new Map<GraphDoc, GraphSession>();
after(async () => {
  for (const session of sessions.values()) await session.close();
});

/**
 * One evaluation of a document, with the cache as the evaluations before it left it. Targets are
 * '<node>.<port>'. As Engine.evaluate decides it, every output is wanted in a preview and the needed ones in a build.
 */
async function evaluate(doc: GraphDoc, targets: readonly string[], opts: GraphOptions & { readonly res: number }): Promise<GraphRender> {
  let session = sessions.get(doc);
  if (!session) sessions.set(doc, session = await openGraph(doc));
  return session.evaluate(targets, { outputs: (opts.mode ?? 'preview') === 'build' ? 'needed' : 'all', ...opts });
}

/** The process's engine, for what a test asks of it beside an evaluation: emptying its cache. */
const engineOf = async (): Promise<Awaited<ReturnType<typeof getEngine>>['engine']> => (await getEngine()).engine;

/** How a node ended: 'run', 'cached', 'error:<kind>' or 'skipped:<reason>'. */
function ending(render: GraphRender, nodeId: string): string {
  const node = render.report.nodes[nodeId];
  if (!node) return 'no final event';
  if (node.state === 'done') return 'run';
  if (node.state === 'error') return `error:${node.error!.kind}`;
  if (node.state === 'skipped') return `skipped:${node.skipReason}`;
  return node.state;
}
const errorsOf = (render: GraphRender): string => JSON.stringify(Object.values(render.report.nodes).flatMap((node) => (node.error ? [node.error] : [])));

// ---- numbers, in float64; a field is never handed to an assertion -------------------------------------------------

interface Stats { readonly min: number; readonly max: number; readonly mean: number; readonly std: number; readonly nonFinite: number }
function statsOf(data: Float32Array): Stats {
  let min = Infinity, max = -Infinity, sum = 0, squares = 0, count = 0;
  for (const v of data) {
    if (!Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    squares += v * v;
    count++;
  }
  const mean = sum / Math.max(count, 1);
  return { min, max, mean, std: Math.sqrt(Math.max(squares / Math.max(count, 1) - mean * mean, 0)), nonFinite: data.length - count };
}

/** The floats of a delivered target. */
function field(render: GraphRender, target: string, res: number): Float32Array {
  const data = render.fields[target]?.data;
  assert.ok(data, `${target} was delivered`);
  assert.equal(data.length, res * res, `${target} holds ${res} x ${res} floats`);
  return data;
}

/** Fails unless the two fields are bit-identical, naming the first float that differs. */
function assertIdentical(a: Float32Array, b: Float32Array, message: string): void {
  assert.equal(a.length, b.length, `${message}: the sizes`);
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  let differing = 0, first = -1;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    differing++;
    if (first < 0) first = i;
  }
  if (differing > 0) assert.fail(`${message}: ${differing} of ${a.length} floats differ; the first is float ${first}: ${a[first]} against ${b[first]}`);
}

/** Largest absolute difference between `a` and `expected(i)`, and where. */
function worst(a: Float32Array, expected: (index: number) => number): { readonly difference: number; readonly index: number } {
  let difference = 0, index = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - expected(i));
    if (!(d <= difference)) {
      difference = d;
      index = i;
    }
  }
  return { difference, index };
}

/** Every second row and column: the vertices a ladder level shares with the next coarser one (engine.md 1.5). */
function decimate(fine: Float32Array, res: number): Float32Array {
  const coarse = (res - 1) / 2 + 1;
  const out = new Float32Array(coarse * coarse);
  for (let y = 0; y < coarse; y++) for (let x = 0; x < coarse; x++) out[y * coarse + x] = fine[2 * y * res + 2 * x]!;
  return out;
}

/**
 * The neighbour pairs of `h` that are steeper than the talus angle, by the threshold ref/talus derives: how many,
 * the sum of what they exceed it by, and the largest excess, in height units.
 */
function steepPairs(h: Float32Array, res: number, talusDegrees: number): { readonly pairs: number; readonly total: number; readonly worst: number } {
  const threshold = (Math.tan((talusDegrees * Math.PI) / 180) * (SETTINGS.terrainSize / (res - 1))) / SETTINGS.heightRange;
  let pairs = 0, total = 0, worstExcess = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const here = h[y * res + x]!;
      // Each pair once: east, south, south-east, south-west.
      for (const [i, j] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const) {
        const qx = x + i, qy = y + j;
        if (qx < 0 || qx >= res || qy >= res) continue;
        const excess = Math.abs(h[qy * res + qx]! - here) - threshold * Math.hypot(i, j);
        if (excess <= 0) continue;
        pairs++;
        total += excess;
        worstExcess = Math.max(worstExcess, excess);
      }
    }
  }
  return { pairs, total, worst: worstExcess };
}

/** The sixteen unit gradients of the library `noise`, 22.5 degrees apart (src/core/wgsl/noise.ts). */
const GRADIENTS = Array.from({ length: 16 }, (_, k) => [Math.cos(((k + 0.5) * Math.PI) / 8), Math.sin(((k + 0.5) * Math.PI) / 8)] as const);

/** engine.md 3.9, noise_gradient, in float64: unit gradients, quintic interpolation, scaled by sqrt 2. */
function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const corner = (cx: number, cy: number): number => {
    const g = GRADIENTS[hashCell(ix + cx, iy + cy, seed) >>> 28]!;
    return g[0] * (fx - cx) + g[1] * (fy - cy);
  };
  const top = corner(0, 0) + (corner(1, 0) - corner(0, 0)) * fade(fx);
  const bottom = corner(0, 1) + (corner(1, 1) - corner(0, 1)) * fade(fx);
  return (top + (bottom - top) * fade(fy)) * Math.SQRT2;
}

/** What ref/fbm stores at terrain coordinate (u, v), by engine.md 6.1, 3.9 and 4.8, computed on the CPU. */
function fbmReference(u: number, v: number, p: { readonly nodeSeed: number; readonly size: number; readonly octaves: number; readonly gain: number }): number {
  const stream = mixSeed(mixSeed(SETTINGS.seed, p.nodeSeed), 0);   // seedFor(0u) of frame.seed
  const cells = 1 / Math.max(p.size, 0.001);
  let sum = 0, norm = 0, amplitude = 1, x = u * cells, y = v * cells;
  for (let i = 0; i < p.octaves; i++) {
    sum += amplitude * gradientNoise(x, y, mixSeed(stream, i));
    norm += amplitude;
    amplitude *= p.gain;
    x *= 2;
    y *= 2;
  }
  return 0.5 + 0.5 * 1.6 * (sum / norm);
}

const TALUS = { talus: 30, reach: 0.05 };   // the parameters of acceptance graph 03 (testing.md 10.2)

interface Reference {
  /** fbm.out at 513, read before ref/talus had ever run. */
  readonly fbm: Float32Array;
  /** fbm.out read again after ref/talus had read it, and the two outputs of ref/talus. */
  readonly fbmAfter: Float32Array;
  readonly out: Float32Array;
  readonly moved: Float32Array;
  readonly endings: readonly string[];
}
let referenceRun: Promise<Reference> | null = null;

/** The 513 results every case compares with, from the first run of the two nodes; made once, whichever case asks first. */
function reference(): Promise<Reference> {
  referenceRun ??= (async () => {
    await (await engineOf()).trim();
    const doc = terrain({ talus: TALUS });
    const alone = await evaluate(doc, ['fbm.out'], { res: 513 });
    assert.equal(alone.report.status, 'ok', errorsOf(alone));
    const all = await evaluate(doc, ['fbm.out', 'talus.out', 'talus.moved'], { res: 513 });
    assert.equal(all.report.status, 'ok', errorsOf(all));
    return {
      fbm: field(alone, 'fbm.out', 513),
      fbmAfter: field(all, 'fbm.out', 513),
      out: field(all, 'talus.out', 513),
      moved: field(all, 'talus.moved', 513),
      endings: [ending(alone, 'fbm'), ending(all, 'fbm'), ending(all, 'talus')],
    };
  })();
  return referenceRun;
}

// ---- ref/fbm --------------------------------------------------------------------------------------------------------

test('ref/fbm: 513 decimated equals 257, and every level is finite and varied', async () => {
  const { fbm: at513 } = await reference();
  const doc = terrain();
  // Whatever ran before, the node is cached at 513 at most: an entry lives at (key, resolution).
  await (await engineOf()).trim({ keepResolution: 513 });
  const coarse = await evaluate(doc, ['fbm.out'], { res: 257 });
  assert.equal(coarse.report.status, 'ok', errorsOf(coarse));
  assert.equal(ending(coarse, 'fbm'), 'run', 'a result at 513 is no hit at 257');
  const at257 = field(coarse, 'fbm.out', 257);

  // testing.md 3.4: a generator at two ladder levels, at shared vertices, max <= 1e-6.
  const shared = decimate(at513, 513);
  const { difference, index } = worst(shared, (i) => at257[i]!);
  assert.ok(difference <= 1e-6, `max difference ${difference} at (${index % 257}, ${Math.floor(index / 257)}): ${shared[index]} against ${at257[index]}; allowed 1e-6`);

  // The values are the function engine.md defines, with the project seed, the node seed and the params in place.
  const defaults = { nodeSeed: 0, size: 0.25, octaves: 8, gain: 0.5 };
  const off = worst(at257, (i) => fbmReference((i % 257) / 256, Math.floor(i / 257) / 256, defaults));
  assert.ok(off.difference <= 1e-5, `the kernel and the CPU differ by ${off.difference} at (${off.index % 257}, ${Math.floor(off.index / 257)}); allowed 1e-5`);

  for (const [name, data, res] of [['257', at257, 257], ['513', at513, 513]] as const) {
    const s = statsOf(data);
    assert.equal(s.nonFinite, 0, `${name}: no NaN and no infinity`);
    assert.ok(s.std > 0.02, `${name}: the field is not flat (std ${s.std})`);
    // Neighbouring texels of a terrain are close: white noise would have a mean step of about 1.1 std.
    let step = 0;
    for (let y = 0; y < res; y++) for (let x = 1; x < res; x++) step += Math.abs(data[y * res + x]! - data[y * res + x - 1]!);
    step /= res * (res - 1);
    assert.ok(step < 0.25 * s.std, `${name}: the mean step between neighbours is ${step}, the std ${s.std}`);
  }

  await writeGrey('worked-nodes/fbm-513-grey', at513, 513);
  await writeHillshade('worked-nodes/fbm-513-hillshade', at513, 513, SETTINGS.terrainSize, SETTINGS.heightRange);
  await expectNoLeaks();
});

test('ref/fbm: the generator range rule holds for the node seeds 0, 1 and 2, and the seeds differ', async () => {
  const results: Float32Array[] = [];
  for (const seed of [0, 1, 2]) {
    const out = await evaluate(terrain({ fbm: { seed } }), ['fbm.out'], { res: 257 });
    const data = field(out, 'fbm.out', 257);
    const s = statsOf(data);
    // engine.md 1.7; testing.md 3.2 generator-range, no further tolerance.
    assert.equal(s.nonFinite, 0);
    assert.ok(s.min >= -0.05, `seed ${seed}: min ${s.min} is below -0.05`);
    assert.ok(s.max <= 1.05, `seed ${seed}: max ${s.max} is above 1.05`);
    assert.ok(s.max - s.min >= 0.5, `seed ${seed}: the span ${s.max - s.min} is below 0.5`);
    assert.ok(s.mean >= 0.25 && s.mean <= 0.75, `seed ${seed}: mean ${s.mean} is outside [0.25, 0.75]`);
    results.push(data);
  }
  for (const [a, b] of [[0, 1], [1, 2], [0, 2]] as const) {
    let differing = 0;
    for (let i = 0; i < results[a]!.length; i++) if (results[a]![i] !== results[b]![i]) differing++;
    assert.ok(differing > 0.01 * results[a]!.length, `seeds ${a} and ${b} differ in ${differing} values; more than 1 % must`);
  }
  await expectNoLeaks();
});

test('the graph describes a shape in a unit box: seeds change it, the terrain size and the height range do not', async () => {
  const render = async (opts: Parameters<typeof terrain>[0]): Promise<{ fbm: Float32Array; talus: Float32Array; endings: string[] }> => {
    const out = await evaluate(terrain({ talus: TALUS, ...opts }), ['fbm.out', 'talus.out'], { res: 257 });
    assert.equal(out.report.status, 'ok', errorsOf(out));
    return { fbm: field(out, 'fbm.out', 257), talus: field(out, 'talus.out', 257), endings: [ending(out, 'fbm'), ending(out, 'talus')] };
  };
  const differing = (a: Float32Array, b: Float32Array): number => a.reduce((count, v, i) => count + (v === b[i] ? 0 : 1), 0);
  const base = await render({});

  // testing.md 10.2 graph 01 item 4: the project seed and the node's seed each change the result, differently.
  const projectSeed = await render({ settings: { seed: 2 } });
  const nodeSeed = await render({ fbm: { seed: 1 } });
  const one = 0.01 * base.fbm.length;
  assert.ok(differing(projectSeed.fbm, base.fbm) > one, 'the project seed changes more than 1 % of the values');
  assert.ok(differing(nodeSeed.fbm, base.fbm) > one, 'the node seed changes more than 1 % of the values');
  assert.ok(differing(projectSeed.fbm, nodeSeed.fbm) > one, 'the two seeds give different results');

  // Item 5, and engine.md 1.6 rule 4: lengths are fractions of the terrain and heights are normalised. Twice the
  // size with twice the height range is the same shape with the same slopes, so the relaxation is the same too.
  const doubled = await render({ settings: { terrainSize: 2 * SETTINGS.terrainSize, heightRange: 2 * SETTINGS.heightRange } });
  assert.deepEqual(doubled.endings, ['run', 'run'], 'both settings are in every key (runtime.md 5.4)');
  assertIdentical(doubled.fbm, base.fbm, 'fbm.out with the terrain size and the height range doubled');
  assertIdentical(doubled.talus, base.talus, 'talus.out with the terrain size and the height range doubled');

  // Slopes are physical (engine.md 1.6 rule 2): twice the height range alone is twice as steep.
  const steeper = await render({ settings: { heightRange: 2 * SETTINGS.heightRange } });
  assertIdentical(steeper.fbm, base.fbm, 'fbm.out with the height range doubled');
  assert.ok(differing(steeper.talus, base.talus) > one, 'ref/talus moves more on a terrain twice as steep');
  await expectNoLeaks();
});

// ---- ref/talus ------------------------------------------------------------------------------------------------------

test('ref/talus: relaxes steep pairs, conserves material, accumulates what moved and leaves its input untouched', async () => {
  const { fbm: input, fbmAfter, out: relaxed, moved, endings } = await reference();
  assert.deepEqual(endings, ['run', 'cached', 'run'], 'fbm ran once, although it was a target twice and an input once');

  // The input was read back after the node had run: the published field is what it was before (engine.md 1.4).
  assertIdentical(fbmAfter, input, 'fbm.out after ref/talus has read it');
  assert.equal(statsOf(relaxed).nonFinite + statsOf(moved).nonFinite, 0, 'both outputs are finite');

  // testing.md 10.2 graph 03 item 6, and the form of simulation.md 5.8 invariant 1.
  let change = 0;
  for (let i = 0; i < relaxed.length; i++) change += Math.abs(relaxed[i]! - input[i]!);
  change /= relaxed.length;
  const drift = Math.abs(statsOf(relaxed).mean - statsOf(input).mean);
  assert.ok(drift <= 1e-5, `|mean(out) - mean(in)| is ${drift}; allowed 1e-5`);
  assert.ok(drift <= 2e-6 + 1e-4 * change, `|mean(out) - mean(in)| is ${drift}; allowed ${2e-6 + 1e-4 * change}`);

  // What the node is for. Material leaves a texel only across a pair steeper than the talus angle, so the excess
  // over that angle shrinks: in sum and at its worst. (A slope many texels wide relaxes by diffusion and stays
  // steeper than the angle after these 26 iterations; the count of steep pairs is therefore not the measure.)
  const before = steepPairs(input, 513, TALUS.talus);
  const afterRun = steepPairs(relaxed, 513, TALUS.talus);
  assert.ok(before.pairs > 0, 'the terrain has pairs steeper than the talus angle');
  assert.ok(afterRun.total < before.total, `the excess over the talus slope went from ${before.total} to ${afterRun.total} in sum`);
  assert.ok(afterRun.worst < before.worst, `the worst excess went from ${before.worst} to ${afterRun.worst}`);
  assert.ok(afterRun.pairs <= before.pairs, `${afterRun.pairs} pairs exceed the talus slope after the run, ${before.pairs} before`);

  // `moved` accumulates the height that crossed the texel: it is never negative, and where it is 0 nothing was exchanged.
  let negative = 0, untouched = 0, changedWhereUntouched = 0, touched = 0;
  for (let i = 0; i < moved.length; i++) {
    if (moved[i]! < 0) negative++;
    if (moved[i] === 0) {
      untouched++;
      if (relaxed[i] !== input[i]) changedWhereUntouched++;
    } else touched++;
  }
  assert.equal(negative, 0, 'moved is never negative');
  assert.equal(changedWhereUntouched, 0, 'where moved is 0 the height is bit-identical to the input');
  assert.ok(touched > 0 && untouched > 0, `the node changes part of the terrain: ${touched} texels moved, ${untouched} did not`);

  await writeGrey('worked-nodes/talus-513-grey', relaxed, 513);
  await writeHillshade('worked-nodes/talus-513-hillshade', relaxed, 513, SETTINGS.terrainSize, SETTINGS.heightRange);
  await writeGrey('worked-nodes/talus-513-moved', moved, 513, 'auto');
});

test('runs are bit-identical: recycled textures against new ones, a build against a preview, a document from a file', async () => {
  const ref = await reference();
  const engine = await engineOf();
  const doc = terrain({ talus: TALUS });
  const targets = ['fbm.out', 'talus.out', 'talus.moved'];
  const same = (out: GraphRender, what: string, names: readonly string[] = targets): void => {
    assert.equal(out.report.status, 'ok', `${what}: ${errorsOf(out)}`);
    assertIdentical(field(out, names[0]!, 513), ref.fbm, `fbm.out of ${what}`);
    assertIdentical(field(out, names[1]!, 513), ref.out, `talus.out of ${what}`);
    assertIdentical(field(out, names[2]!, 513), ref.moved, `talus.moved of ${what}`);
  };

  // A build neither reads nor writes the cache (runtime.md 2.8): both nodes run, and what it made is FREE afterwards.
  // The second build therefore works on recycled textures, which hold -1e30 (poisonRecycled), not zeros.
  for (const round of ['a build', 'a second build, on recycled textures']) {
    const build = await evaluate(doc, targets, { res: 513, mode: 'build' });
    assert.deepEqual([ending(build, 'fbm'), ending(build, 'talus'), build.report.nodesRun], ['run', 'run', 2], round);
    same(build, round);
  }

  // A preview fills the cache where it is not filled yet. The document written to text and read back has the
  // same keys: every node is a cache hit.
  same(await evaluate(doc, targets, { res: 513 }), 'a preview');
  const reread = parseDoc(serializeDoc(doc), engine.registry);
  assert.equal(reread.problems.length, 0, JSON.stringify(reread.problems.slice(0, 5)));
  // A document that was read from text is addressed by the ids it holds.
  const idOf = (type: string): string => Object.values(reread.doc.nodes).find((node) => node.type === type)!.id;
  const [fbmId, talusId] = [idOf('ref/fbm'), idOf('ref/talus')];
  const stored = [`${fbmId}.out`, `${talusId}.out`, `${talusId}.moved`];
  const cached = await evaluate(reread.doc, stored, { res: 513 });
  assert.deepEqual([ending(cached, fbmId), ending(cached, talusId), cached.report.nodesRun], ['cached', 'cached', 0]);
  same(cached, 'the cache', stored);

  // Nothing cached and nothing FREE: a preview on textures the device has just made.
  await engine.trim();
  const fresh = await evaluate(doc, targets, { res: 513 });
  assert.deepEqual([ending(fresh, 'fbm'), ending(fresh, 'talus'), fresh.report.nodesRun], ['run', 'run', 2]);
  same(fresh, 'a run on an emptied pool');
  await expectNoLeaks();
});

test('ref/talus: an output nobody wants is neither allocated nor computed, and wanting it later runs the node again', async () => {
  const ref = await reference();
  await (await engineOf()).trim();
  const doc = terrain({ talus: TALUS });

  // testing.md 10.2 graph 03 items 1 and 2: two fields without `moved`, three with it.
  const alone = await evaluate(doc, ['talus.out'], { res: 513, outputs: 'needed' });
  assert.equal(alone.report.status, 'ok', errorsOf(alone));
  assert.equal(alone.report.nodes.talus!.peakBytes, 2 * FIELD_BYTES(513), 'the node held its ping-pong pair and nothing else');
  assertIdentical(field(alone, 'talus.out', 513), ref.out, 'talus.out wanted alone');

  const both = await evaluate(doc, ['talus.out', 'talus.moved'], { res: 513, outputs: 'needed' });
  assert.deepEqual([ending(both, 'fbm'), ending(both, 'talus')], ['cached', 'run'], 'the entry lacked `moved`');
  assert.equal(both.report.nodes.talus!.peakBytes, 3 * FIELD_BYTES(513));
  assertIdentical(field(both, 'talus.out', 513), ref.out, 'talus.out with `moved` wanted');
  assertIdentical(field(both, 'talus.moved', 513), ref.moved, 'talus.moved');

  const again = await evaluate(doc, ['talus.out'], { res: 513, outputs: 'needed' });
  assert.equal(ending(again, 'talus'), 'cached', 'the entry holds both outputs now');
  await expectNoLeaks();
});

test('ref/talus is maskable: out is mix(in, relaxed, saturate(mask)), and `moved` is as computed', async () => {
  const raw = await evaluate(terrain({ talus: TALUS }), ['fbm.out', 'talus.out', 'talus.moved'], { res: 257 });
  const mix = await evaluate(terrain({ talus: TALUS, maskSeed: 7 }), ['talus.out', 'talus.moved', 'mask.out'], { res: 257 });
  assert.deepEqual([raw.report.status, mix.report.status], ['ok', 'ok'], errorsOf(raw) + errorsOf(mix));
  // The mask is in O, not in K (runtime.md 5.4): the node with a mask is the node without one, re-blended.
  assert.equal(ending(mix, 'talus'), 'cached');

  const input = field(raw, 'fbm.out', 257);
  const relaxed = field(raw, 'talus.out', 257);
  const mask = field(mix, 'mask.out', 257);
  const blended = field(mix, 'talus.out', 257);
  const saturate = (v: number): number => Math.min(Math.max(v, 0), 1);
  const { difference, index } = worst(blended, (i) => input[i]! + (relaxed[i]! - input[i]!) * saturate(mask[i]!));
  assert.ok(difference <= 1e-6, `max difference ${difference} at float ${index}; allowed 1e-6`);
  const blendedChange = worst(blended, (i) => relaxed[i]!).difference;
  assert.ok(blendedChange > 1e-4, `the mask changes the output (largest change ${blendedChange})`);
  assertIdentical(field(mix, 'talus.moved', 257), field(raw, 'talus.moved', 257), 'talus.moved with a mask');
  await expectNoLeaks();
});

// ---- failure paths of an iterative node ---------------------------------------------------------------------------

test('a budget that does not hold the working state: the node fails with kind "budget", a build fails before it starts', async () => {
  await (await engineOf()).trim();
  const doc = terrain({ talus: TALUS });
  // Room for two fields of 257 x 257 beside what the engine has reserved (testing.md 2.3, fieldBudgetBytes).
  const preview = await evaluate(doc, ['talus.out'], { res: 257, fieldBudgetBytes: 600_000 });
  assert.equal(preview.report.status, 'errors');
  assert.deepEqual([ending(preview, 'fbm'), ending(preview, 'talus')], ['run', 'error:budget']);
  const error = preview.report.nodes.talus!.error!;
  assert.deepEqual([error.nodeId, error.nodeType, error.kind], ['talus', 'ref/talus', 'budget']);
  assert.match(error.message, /^Needs \d+ KB more GPU memory at 257 × 257: budget \d+ (KB|MB), \d+ KB in use by this node, \d+ KB pinned$/);
  assert.equal(preview.fields['talus.out'], undefined, 'a failed target delivers no field');

  // runtime.md 5.3 step 6: fbm.out, talus.out and talus.moved are alive together, which is three fields.
  const build = await evaluate(doc, ['talus.out', 'talus.moved'], { res: 257, mode: 'build', fieldBudgetBytes: 600_000 });
  assert.equal(build.report.status, 'errors');
  assert.equal(build.report.events.filter((e) => e.type === 'node-start').length, 0, 'no node runs');
  assert.deepEqual(Object.values(build.report.nodes).flatMap((node) => (node.error ? [node.error.kind] : [])), ['budget']);

  const ok = await evaluate(doc, ['talus.out'], { res: 257 });
  assert.deepEqual([ok.report.status, ending(ok, 'fbm'), ending(ok, 'talus')], ['ok', 'cached', 'run'], 'the engine goes on');
  await expectNoLeaks();
});

// ---- slicing: the two engines with forced slice sizes, last (testing.md 2.1) --------------------------------------

test('slicing and cancellation: tiles one workgroup high, aborted in the loop, then bit-identical to one slice', async () => {
  const doc = terrain({ talus: TALUS });
  const targets = ['talus.out', 'talus.moved'];

  // Abort when the second slice of the node's loop has completed (testing.md 10.2 graph 03 item 5).
  const controller = new AbortController();
  let seen = 0;
  const aborted = await evaluate(doc, targets, {
    res: 257, slices: 'small', signal: controller.signal,
    onSlice: (slice) => {
      if (slice.nodeId === 'talus' && ++seen === 2) controller.abort();
    },
  });
  assert.equal(aborted.report.status, 'aborted');
  assert.deepEqual([ending(aborted, 'fbm'), ending(aborted, 'talus')], ['run', 'skipped:aborted']);
  assert.deepEqual(Object.keys(aborted.fields), [], 'an aborted evaluation delivers nothing');

  const tiled = await evaluate(doc, targets, { res: 257, slices: 'small' });
  assert.equal(tiled.report.status, 'ok', errorsOf(tiled));
  assert.deepEqual([ending(tiled, 'fbm'), ending(tiled, 'talus')], ['cached', 'run'], 'what had completed before the abort stayed cached');
  const smallSlices = tiled.report.nodes.talus!.slices;
  const fractions = tiled.report.nodes.talus!.progress;
  assert.ok(fractions.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fractions[i - 1]!)), 'progress is within 0..1 and does not decrease');
  const fbmTiled = await evaluate(doc, ['fbm.out'], { res: 257, slices: 'small' });

  const whole = await evaluate(doc, targets, { res: 257, slices: 'one' });
  assert.equal(whole.report.status, 'ok', errorsOf(whole));
  const oneSlices = whole.report.nodes.talus!.slices;
  // 13 iterations of 33 tiles each against a loop that fits one slice.
  assert.ok(smallSlices > 100 && oneSlices <= 3, `${smallSlices} slices with the small target, ${oneSlices} with one`);
  assertIdentical(field(tiled, 'talus.out', 257), field(whole, 'talus.out', 257), 'talus.out, small slices against one');
  assertIdentical(field(tiled, 'talus.moved', 257), field(whole, 'talus.moved', 257), 'talus.moved, small slices against one');
  const fbmWhole = await evaluate(doc, ['fbm.out'], { res: 257, slices: 'one' });
  assertIdentical(field(fbmTiled, 'fbm.out', 257), field(fbmWhole, 'fbm.out', 257), 'fbm.out, small slices against one');
  await expectNoLeaks();
});
