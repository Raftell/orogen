// tests/nodes/simulate/hydraulic-erosion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectLadder, expectStats, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/hydraulic-erosion.ts';
import { combine, count, meanOf } from './_erosion-rig.ts';

conformance(def, {
  skip: {
    resolution: 'Wear, deposit and flow are gullies, fans and stream lines a few texels wide, which a finer level places elsewhere (simulation.md 2.8). At shared vertices 257 and 513 differ by 0.32, 0.19 and 0.38 standard deviations; out agrees within 0.005, which the test below asserts with the amounts moved.',
  },
});

const alone = { mask: null, precipitation: null } as const;
/** Without a sea: the lower parts of the fixtures are then no sinks. */
const DRY = { seaLevel: -1 } as const;

test('simulate/hydraulic-erosion: without rain and without slumping the terrain is returned bit for bit', async () => {
  const terrain = fixtures.terrain(257);
  const { out, wear, deposit, flow } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { rain: 0, talus: 90 } });
  expectIdentical(out, terrain);
  for (const f of [wear, deposit, flow]) expectStats(f, { min: [0, 0], max: [0, 0] });
});

test('simulate/hydraulic-erosion: a mask of 0 everywhere returns the input, and so does a run too short for one iteration', async () => {
  const terrain = fixtures.terrain(257);
  const masked = await renderNode(def, { inputs: { in: terrain, mask: 'zero', precipitation: null }, wants: ['out'] });
  expectIdentical(masked.out, terrain);
  // At 33 texels the smallest feature and the shortest duration come to less than half an iteration.
  const small = fixtures.terrain(33);
  const short = await renderNode(def, { res: 33, inputs: { in: small, ...alone }, params: { size: 0.005, duration: 0.05 }, wants: ['out'] });
  expectIdentical(short.out, small);
});

/** The mean of `of` over the texels of `weight`, weighted by it: where on the terrain a quantity lies. */
const weighted = (of: FieldData, weight: FieldData): number => {
  let sum = 0, total = 0;
  for (let i = 0; i < of.data.length; i++) { sum += weight.data[i]! * of.data[i]!; total += weight.data[i]!; }
  return sum / total;
};

test('simulate/hydraulic-erosion: wear and deposit are the two sides of the change, never both at one texel', async () => {
  for (const settings of [{}, DRY]) {
    const terrain = fixtures.terrain(257);
    const { out, wear, deposit } = await renderNode(def, { inputs: { in: terrain, ...alone }, settings });
    assert.ok(stats(wear).min >= 0 && stats(deposit).min >= 0, `least wear ${stats(wear).min}, least deposit ${stats(deposit).min}`);
    assert.equal(count(wear, (v, i) => v > 0 && deposit.data[i]! > 0), 0, 'texels with both wear and deposit');
    const rebuilt = combine(combine(terrain, wear, (h, w) => h - w), deposit, (h, d) => h + d);
    assert.ok(stats(combine(out, rebuilt, (a, b) => Math.abs(a - b))).max <= 1e-7, 'out is in - wear + deposit');
    assert.ok(stats(wear).max > 1e-3 && stats(deposit).max > 1e-3, `largest wear ${stats(wear).max}, largest deposit ${stats(deposit).max}`);
  }
});

test('simulate/hydraulic-erosion: in a closed bowl what the water takes from the flanks it lays down lower, and without removal nothing is lost', async () => {
  // The bowl fixture: its border ring is the highest ground, so no water and no sediment leaves; its lowest point is above the sea.
  const bowl = fixtures.bowl(257);
  const { out, wear, deposit } = await renderNode(def, { inputs: { in: bowl, ...alone }, params: { removal: 0 } });
  const drift = Math.abs(meanOf(out) - meanOf(bowl));
  const allowed = 2e-6 + 1e-4 * meanOf(wear);
  assert.ok(meanOf(wear) > 1e-4, `the mean wear is ${meanOf(wear)}`);
  assert.ok(drift <= allowed, `|mean(out) - mean(in)| is ${drift}; allowed ${allowed}`);
  // The mean height of the ground that wore, and of the ground that was laid on.
  const from = weighted(bowl, wear), onto = weighted(bowl, deposit);
  assert.ok(onto < from - 0.02, `material left ground at ${from} on average and came to rest at ${onto}`);

  // With full removal nothing is suspended: no texel rises, and the bowl loses what wore.
  const gone = await renderNode(def, { inputs: { in: bowl, ...alone }, params: { removal: 1 } });
  assert.equal(count(gone.out, (v, i) => v > bowl.data[i]!), 0, 'texels that rose although everything eroded was removed');
  assert.ok(stats(gone.deposit).max === 0, `the largest deposit is ${stats(gone.deposit).max}`);
  assert.ok(Math.abs((meanOf(bowl) - meanOf(gone.out)) - meanOf(gone.wear)) < 1e-6 && meanOf(gone.wear) > 1e-4, `the bowl lost ${meanOf(bowl) - meanOf(gone.out)}; the mean wear is ${meanOf(gone.wear)}`);
  // The default removes a part: less is laid down than without removal.
  const part = await renderNode(def, { inputs: { in: bowl, ...alone }, wants: ['deposit'] });
  assert.ok(meanOf(part.deposit) < 0.8 * meanOf(deposit) && meanOf(part.deposit) > 0, `the mean deposit is ${meanOf(part.deposit)} at the default removal and ${meanOf(deposit)} without`);
});

test('simulate/hydraulic-erosion: water gathers in a channel and cuts only where enough of it has gathered', async () => {
  // The notch fixture: a plane falling towards +x with a V-shaped channel along its centre line, row 128.
  const { flow, wear } = await renderNode(def, { inputs: { in: 'notch', ...alone }, settings: DRY, wants: ['flow', 'wear'] });
  assert.ok(stats(flow).min >= 0, `the least flow is ${stats(flow).min}`);
  const channel = at(flow, 180, 128), plane = at(flow, 180, 40);
  assert.ok(channel > 2 * plane && plane > 0, `flow is ${channel} in the channel and ${plane} on the plane`);
  assert.ok(at(flow, 180, 40) > 3 * at(flow, 20, 40), `on the plane the flow grows down the slope: ${at(flow, 20, 40)} near the top, ${at(flow, 180, 40)} below`);
  // At the top of the plane, less than a channel head from the divide, the film of water carves nothing.
  assert.ok(at(wear, 180, 40) > 1e-3, `far down the plane the wear is ${at(wear, 180, 40)}`);
  assert.ok(at(wear, 6, 40) < 0.05 * at(wear, 180, 40), `near the divide the wear is ${at(wear, 6, 40)}`);
});

test('simulate/hydraulic-erosion: the gullies lie where the water runs, and the deposits lower and on gentler ground', async () => {
  const terrain = fixtures.terrain(257);
  const { wear, deposit, flow } = await renderNode(def, { inputs: { in: terrain, ...alone }, settings: DRY });
  assert.ok(weighted(flow, wear) > 2 * meanOf(flow), `the flow over the worn ground is ${weighted(flow, wear)}; the mean flow is ${meanOf(flow)}`);
  assert.ok(weighted(terrain, deposit) < weighted(terrain, wear) - 0.02, `material left ground at ${weighted(terrain, wear)} on average and came to rest at ${weighted(terrain, deposit)}`);
  // A gully is a line: most of the terrain is not worn at all, and the deepest cut is many times the mean.
  assert.ok(stats(wear).p50 < 0.1 * stats(wear).max, `the median wear is ${stats(wear).p50}, the largest ${stats(wear).max}`);
});

test('simulate/hydraulic-erosion: the terrain agrees between two levels of the ladder, and wear, deposit and flow in their amounts', async () => {
  // The conformance check is not run for this node: wear, deposit and flow are lines a few texels wide. What a
  // preview must share with the build is the terrain and how much was moved.
  const levels = await renderLadder(def, { settings: DRY });
  expectLadder(levels[257]!.out!, levels[513]!.out!, { rel: 0.02 });
  for (const name of ['wear', 'deposit', 'flow'] as const) {
    const ratio = meanOf(levels[513]![name]!) / meanOf(levels[257]![name]!);
    assert.ok(ratio > 0.5 && ratio < 2, `mean(${name}) at 513 is ${ratio} of that at 257`);
  }
});

test('simulate/hydraulic-erosion: more rain, capacity, downcutting and time cut more; no rain where the precipitation is 0', async () => {
  const terrain = fixtures.terrain(257);
  const worn = async (params: Record<string, number>, precipitation: 'zero' | null = null) =>
    meanOf((await renderNode(def, { inputs: { in: terrain, mask: null, precipitation }, params: { talus: 90, ...params }, settings: DRY, wants: ['wear'] })).wear);
  const base = await worn({});
  assert.ok(base > 0, 'the defaults wear the terrain');
  assert.ok(await worn({ rain: 0.8 }) > 1.2 * base, 'more rain wears more');
  assert.ok(await worn({ capacity: 3 }) > 1.2 * base, 'more capacity wears more');
  assert.ok(await worn({ capacity: 0.3 }) < 0.7 * base, 'less capacity wears less');
  assert.ok(await worn({ downcutting: 2 }) > 1.2 * base, 'more downcutting wears more');
  assert.ok(await worn({ duration: 0.5 }) < 0.7 * base, 'a shorter run wears less');
  assert.equal(await worn({}, 'zero'), 0, 'without precipitation nothing wears');
});

test('simulate/hydraulic-erosion: a low deposition carries the sediment further before it settles', async () => {
  // In the bowl what travels further comes to rest lower.
  const bowl = fixtures.bowl(257);
  const restsAt = async (deposition: number) => weighted(bowl, (await renderNode(def, { inputs: { in: bowl, ...alone }, params: { deposition, removal: 0 }, wants: ['deposit'] })).deposit);
  const slow = await restsAt(0.1), quick = await restsAt(3);
  assert.ok(slow < quick - 0.001, `sediment came to rest at ${slow} with a low deposition and at ${quick} with a high one`);
});

test('simulate/hydraulic-erosion: ground at or below the sea level takes no part in the flow and is never cut', async () => {
  // A single level. What the water lays down beside the sea may slide into it; nothing below the sea level wears.
  const terrain = fixtures.terrain(257);
  const { out, flow } = await renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus: 90, size: 0.02 }, wants: ['out', 'flow'] });
  assert.equal(count(out, (v, i) => terrain.data[i]! <= 0.25 && v < terrain.data[i]!), 0, 'texels at or below the sea level that were lowered');
  assert.equal(count(flow, (v, i) => terrain.data[i]! <= 0.25 && v !== 0), 0, 'texels at or below the sea level with a flow');
  assert.ok(count(out, (v, i) => v !== terrain.data[i]) > 1000, 'the land changed');
});

test('simulate/hydraulic-erosion: banks the water cut steeper than the talus angle slump, and the slump is part of the wear', async () => {
  const terrain = fixtures.terrain(257);
  const run = async (talus: number) => renderNode(def, { inputs: { in: terrain, ...alone }, params: { talus, capacity: 3 }, settings: DRY, wants: ['out', 'wear'] });
  const standing = await run(90), slumped = await run(20);
  assert.ok(meanOf(slumped.wear) > meanOf(standing.wear), `mean wear ${meanOf(slumped.wear)} with slumping, ${meanOf(standing.wear)} without`);
  assert.ok(count(slumped.out, (v, i) => v !== standing.out.data[i]) > 1000, 'the slumping changed the terrain');
});
