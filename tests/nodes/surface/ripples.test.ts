// tests/nodes/surface/ripples.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def, { RIPPLES } from '../../../src/core/nodes/surface/ripples.ts';
import { correlation, mapField, share } from './_probe.ts';

conformance(def);

const N = 257;
const L = N - 1;
/** What the node adds to a terrain. */
const added = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));
/** The profile of a ripple at the phase `turns`, in turns: -1 .. 1. */
const profile = (turns: number): number => (Math.sin(2 * Math.PI * turns) * (1 - RIPPLES.skew * Math.cos(2 * Math.PI * turns))) / (1 + RIPPLES.skewGain * RIPPLES.skew);

test('surface/ripples: without irregularity the ripples are one even wave train across the wind, a ripple length apart', async () => {
  const flat = fieldOf(N, () => 0.5);
  for (const [size, angle, height] of [[0.1, 0, 0.02], [0.0625, 90, 0.01], [0.2, 30, 0.05], [0.08, 215, 0.02]] as const) {
    const { out } = await renderNode(def, { inputs: { in: flat }, params: { size, angle, height, irregularity: 0 } });
    const turn = (angle * Math.PI) / 180;
    // The phase is carried through nine patches in float32, over up to sixteen turns.
    expectClose(added(out, flat), fieldOf(N, (u, v) => 0.5 * height * profile((u * Math.cos(turn) + v * Math.sin(turn)) / size)), { max: 2e-4 * (height / 0.02) + 1e-5 });
  }
});

test('surface/ripples: the wind climbs the long side of a ripple and drops over the short one', async () => {
  const flat = fieldOf(N, () => 0.5);
  const rising = async (angle: number): Promise<number> => {
    const { out } = await renderNode(def, { inputs: { in: flat }, params: { size: 0.125, angle, height: 0.02, irregularity: 0 } });
    return share(out, (v, x, y) => x + 1 < N && at(out, x + 1, y) > v);
  };
  // Towards +X the ground rises over two thirds of every ripple; with the wind turned round, over one third.
  const along = await rising(0), against = await rising(180);
  assert.ok(Math.abs(along - 2 / 3) < 0.03, `with the wind towards +X ${along} of the ground rises towards +X`);
  assert.ok(Math.abs(against - 1 / 3) < 0.03, `with the wind towards -X ${against} of it does`);
});

test('surface/ripples: a crest stands the height above the trough beside it, and no ripple is taller', async () => {
  const src = fixtures.rampY(N);
  for (const irregularity of [0, 0.5, 1]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { size: 0.1, height: 0.03, irregularity } });
    const s = stats(added(out, src));
    assert.ok(s.max <= 0.015 + 1e-6 && s.min >= -0.015 - 1e-6, `at an irregularity of ${irregularity} the ground is moved by ${s.min} to ${s.max}`);
    assert.ok(s.max > 0.014 && s.min < -0.014, `crests of ${s.max} and troughs of ${s.min}`);
  }
});

test('surface/ripples: the irregularity lets crests wander, end and fork, and the ripples still run across the wind', async () => {
  const flat = fieldOf(N, () => 0.5);
  const render = async (irregularity: number, seed = 0): Promise<FieldData> =>
    added((await renderNode(def, { inputs: { in: flat }, params: { size: 0.08, height: 0.02, irregularity, seed } })).out, flat);
  const even = await render(0), odd = await render(1);
  // Along a crest of the even train nothing changes: the wind blows towards +X and the crests lie along the columns.
  const alongCrest = (f: FieldData): number => {
    let sum = 0;
    for (let y = 1; y < N; y++) for (let x = 0; x < N; x++) sum += Math.abs(at(f, x, y) - at(f, x, y - 1));
    return sum / (N * (N - 1));
  };
  const acrossCrest = (f: FieldData): number => {
    let sum = 0;
    for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) sum += Math.abs(at(f, x, y) - at(f, x - 1, y));
    return sum / (N * (N - 1));
  };
  assert.ok(alongCrest(even) < 1e-6, `along its crests the even train changes by ${alongCrest(even)} a texel`);
  assert.ok(alongCrest(odd) > 0.1 * acrossCrest(odd), `irregular crests change by ${alongCrest(odd)} a texel along the columns`);
  assert.ok(acrossCrest(odd) > 2 * alongCrest(odd), `and by ${acrossCrest(odd)} across them: they still lie across the wind`);
  // Where a crest ends or forks, the rows on either side of the place cross a different number of crests.
  const crests = (f: FieldData): { least: number; most: number } => {
    let least = Infinity, most = -Infinity;
    for (let y = 0; y < N; y++) {
      let count = 0;
      for (let x = 1; x < N; x++) if (at(f, x - 1, y) <= 0 && at(f, x, y) > 0) count++;
      least = Math.min(least, count);
      most = Math.max(most, count);
    }
    return { least, most };
  };
  const straight = crests(even), forked = crests(odd);
  // The terrain is 12.5 ripple lengths across.
  assert.ok(straight.most - straight.least <= 1 && straight.least >= 12 && straight.most <= 13, `a row of the even train crosses ${straight.least} to ${straight.most} crests`);
  assert.ok(forked.most - forked.least >= 2 && forked.least >= 8 && forked.most <= 18, `a row of the irregular one crosses ${forked.least} to ${forked.most}`);
  // Another seed moves the ends and forks.
  const other = await render(1, 1);
  assert.ok(correlation(odd, other) < 0.6, `two seeds correlate by ${correlation(odd, other)}`);
});

test('surface/ripples: ripples lie on ground no steeper than the upper slope', async () => {
  // The cone: a flank of 45 degrees on a level floor.
  const cone = fixtures.cone(N);
  const { out } = await renderNode(def, { inputs: { in: cone }, params: { size: 0.03, slopeMax: 35 } });
  const moved = added(out, cone);
  let flank = 0, floor = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 16 && r < 52) flank = Math.max(flank, Math.abs(at(moved, x, y)));
      else if (r > 76) floor = Math.max(floor, Math.abs(at(moved, x, y)));
    }
  }
  assert.equal(flank, 0, 'the flank of 45 degrees');
  assert.ok(floor > 0.005, `the floor has ripples of ${floor}`);
  const everywhere = await renderNode(def, { inputs: { in: cone }, params: { size: 0.03, slopeMax: 90 } });
  assert.ok(Math.abs(at(everywhere.out, 160, 128) - at(cone, 160, 128)) > 0 || Math.abs(at(everywhere.out, 161, 128) - at(cone, 161, 128)) > 0, 'with an upper slope of 90 degrees the flank has them too');
});

test('surface/ripples: ripples the grid cannot hold are left out, and no height gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  // A ripple length of 0.009 is 2.3 texels at 257.
  for (const params of [{ size: 0.009 }, { height: 0 }, { height: -1 }] as Record<string, number>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out!, src);
    assert.equal(report.nodes.node!.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
  // Between 2.5 and 5 texels they fade in: at 3.75 texels a ripple has half its height.
  const flat = fieldOf(N, () => 0.5);
  const faint = added((await renderNode(def, { inputs: { in: flat }, params: { size: 3.75 / L, height: 0.02, irregularity: 0 } })).out, flat);
  assert.ok(stats(faint).max < 0.5 * 0.01 * 1.05 && stats(faint).max > 0.5 * 0.01 * 0.5, `ripples of 3.75 texels stand ${stats(faint).max} high`);
});

test('surface/ripples: the ripples are the same at two levels of the ladder wherever both can hold them', async () => {
  // Ripples of 0.1 are 26 texels at 257: whole at both levels, lee side and all.
  const levels = await renderLadder(def, { inputs: { in: 'notch' }, params: { size: 0.1, height: 0.02 } });
  expectLadder(levels[257]!.out, levels[513]!.out, { max: 2e-5 });
});
