// tests/nodes/filter/slope-blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/slope-blur.ts';
import { bilinearAt, mapField, mountain, range, smoothed, stepAt, stepBetween, stepLength } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;
/** A guide smoothing too small to smooth anything at 257: the guide steers as it is. Gullies need a smoothing. */
const AS_IS = { guideRadius: 0.0005 } as const;
const SMEAR = { mode: 'smear' } as const;

// ---- the node's passes on the CPU ---------------------------------------------------------------------------------

/** The step uphill at every texel of `guide`. */
function flowOf(guide: FieldData): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push(stepAt(guide, x, y));
  return out;
}

/** Rounding to the nearest whole number, a half to the even one, as WGSL rounds. */
function nearest(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

interface Pass { readonly stride: number; readonly way: 1 | -1; readonly substeps: number; readonly fade: number; readonly lowest: boolean }

/**
 * One pass: six points along the path from each texel, `stride` texels apart, each reached by `substeps` steps
 * along the flow of the texel the path is over. Point i counts 1 - i * fade. The weighted mean of the points and
 * the texel, or the lowest of them, each pulled towards the texel by what it does not count for.
 */
function pass(src: FieldData, flow: readonly (readonly [number, number])[], p: Pass): FieldData {
  const step = (p.way * p.stride) / p.substeps;
  return mapField(src, (x, y) => {
    const own = at(src, x, y);
    let px = x, py = y, sum = 0, drop = 0, weight = 1;
    for (let i = 1; i <= 6; i++) {
      for (let j = 0; j < p.substeps; j++) {
        const f = flow[nearest(py) * N + nearest(px)]!;
        px = Math.min(L, Math.max(0, px + step * f[0]));
        py = Math.min(L, Math.max(0, py + step * f[1]));
      }
      const w = Math.max(1 - i * p.fade, 0);
      const d = w * (bilinearAt(src, px, py) - own);
      sum += d;
      drop = Math.min(drop, d);
      weight += w;
    }
    return p.lowest ? own + drop : own + sum / weight;
  });
}

/**
 * The weighted mean over a whole path, followed in steps of a quarter of a texel over the slope between texels:
 * `points` points evenly spaced over `reach` texels. The weight of a point is what the nested passes give it: the
 * product, over the digits of its number to the base 7, of 1 - digit * (the stride of that digit) / reach.
 */
function smearedFine(src: FieldData, guide: FieldData, reach: number, points: number): FieldData {
  const spacing = reach / points;
  const weights = Array.from({ length: points }, (_, i) => {
    let w = 1;
    for (let rest = i, stride = spacing; rest > 0; rest = Math.floor(rest / 7), stride *= 7) w *= 1 - ((rest % 7) * stride) / reach;
    return w;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const fine = Math.max(1, Math.ceil(spacing / 0.25));
  return mapField(src, (x, y) => {
    let px = x, py = y, sum = 0;
    for (let i = 0; i < points; i++) {
      sum += weights[i]! * bilinearAt(src, px, py);
      for (let j = 0; j < fine; j++) {
        const f = stepBetween(guide, px, py);
        px = Math.min(L, Math.max(0, px + (spacing / fine) * f[0]));
        py = Math.min(L, Math.max(0, py + (spacing / fine) * f[1]));
      }
    }
    return sum / total;
  });
}

// ---- the mode "smear" ---------------------------------------------------------------------------------------------

test('filter/slope-blur: a smear gives each point the weighted mean of the picture along the path uphill from it', async () => {
  // A radius of 0.02 is 5.12 texels at 257: one pass, six points 0.73 texels apart, the farthest counting a seventh.
  const src = await fixtures.fbm(N);
  const guide = fixtures.terrain(N);
  const { out } = await renderNode(def, { inputs: { in: src, guide }, params: { radius: 0.02, ...SMEAR, ...AS_IS } });
  const expected = pass(src, flowOf(guide), { stride: 5.12 / 7, way: 1, substeps: 1, fade: 1 / 7, lowest: false });
  // The path is followed in float32. A point that lies within rounding of the middle between two texels takes the
  // flow of the other one and ends a hundredth of a texel away: 4 texels of the 66 049 differ by up to 7e-4.
  expectClose(out, expected, { max: 2e-3, rms: 2e-5 });
});

test('filter/slope-blur: a point is smeared downhill and nowhere else, thinning out, as far as the radius on steep ground', async () => {
  // The guide rises towards +X at 0.25 metres per metre, where a step is 0.857 of its length. An impulse at the
  // centre is drawn out towards -X over 0.857 of the radius: 0.1 is 25.6 texels, in two nested passes.
  const { out } = await renderNode(def, { inputs: { in: 'impulse', guide: 'rampX' }, params: { radius: 0.1, ...SMEAR, ...AS_IS } });
  const reach = 25.6 * stepLength(0.25);
  let sum = 0, row = 0, uphill = 0, farthest = 128;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = at(out, x, y);
      sum += v;
      if (y === 128) row += v;
      if (x > 128) uphill += Math.abs(v);
      if (v > 1e-6) farthest = Math.min(farthest, x);
    }
  }
  assert.ok(Math.abs(sum - 1) < 1e-4, `the smear sums to ${sum}`);
  assert.ok(Math.abs(row - sum) < 1e-6, 'it stays on the row of the impulse: the slope has no part across it');
  assert.equal(uphill, 0, 'nothing is smeared uphill');
  // The last of the 49 points lies a 49th short of the reach.
  assert.ok(Math.abs(farthest - (128 - reach)) < 2, `the smear ends at ${farthest}; the reach ends at ${128 - reach}`);
  // Over stretches of 4 texels, to even out where the points fall between texels: less the farther down.
  const stretch = (from: number): number => at(out, from, 128) + at(out, from - 1, 128) + at(out, from - 2, 128) + at(out, from - 3, 128);
  assert.ok(stretch(126) > 1.3 * stretch(118) && stretch(118) > 1.3 * stretch(110), `the smear holds ${stretch(126)}, ${stretch(118)}, ${stretch(110)} at 2, 10 and 18 texels: it thins out`);
});

test('filter/slope-blur: a long smear, made of nested passes, is the weighted mean over the whole path', async () => {
  // 0.1 is 25.6 texels: two passes, 49 points; 0.25 is 64 texels: three passes, 343 points.
  const src = await fixtures.fbm(N);
  const guide = fieldOf(N, (u, v) => 0.5 + 0.3 * Math.sin(5 * u + 1) * Math.cos(4 * v));
  for (const [radius, points] of [[0.1, 49], [0.25, 343]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src, guide }, params: { radius, ...SMEAR, ...AS_IS } });
    // A pass follows the path by the flow of the nearest texel, in steps of up to 2.3 texels in the third pass,
    // where the reference bends within a quarter of a texel: towards the far end of a path the places differ by
    // a texel or two, on a terrain that changes by up to 0.05 from one texel to the next.
    expectClose(out, smearedFine(src, guide, radius * L, points), { max: 0.08 * range(src), rms: 0.01 * range(src) });
  }
});

test('filter/slope-blur: without a guide a smear runs down the picture\'s own slopes, which raises a flank by what lies above it', async () => {
  // The cone falls by 4 per unit length at 45 degrees, where a step is 0.989 of its length. The six points of the
  // path count 6/7 .. 1/7 and the texel 1: their mean lies 2/7 of the way up the path of 0.02, 5.12 texels.
  const cone = fixtures.cone(N);
  const { out } = await renderNode(def, { inputs: { in: cone, guide: null }, params: { radius: 0.02, guideRadius: 0.004, ...SMEAR } });
  const weights = [1, 6 / 7, 5 / 7, 4 / 7, 3 / 7, 2 / 7, 1 / 7];
  const centre = weights.reduce((sum, w, i) => sum + w * i, 0) / weights.reduce((sum, w) => sum + w, 0) / 7;
  for (const [x, y] of [[160, 128], [128, 96], [105, 105], [150, 150]] as const) {
    const rise = at(out, x, y) - at(cone, x, y);
    assert.ok(Math.abs(rise - 4 * 0.02 * stepLength(1) * centre) < 2e-3, `at (${x}, ${y}) the flank rose by ${rise}`);
  }
  // Level ground has no downhill: the floor around the cone is untouched.
  assert.equal(at(out, 10, 10), 0);
  assert.equal(at(out, 128, 250), 0);
});

// ---- the mode "gullies" -------------------------------------------------------------------------------------------

test('filter/slope-blur: gullies lower each point by what the lowest detail on the path uphill cuts, within the room above the ground downhill', async () => {
  // A smoothing of 0.02 is a Gaussian of 5.12 texels, and a radius of 0.02 one pass of six points.
  const src = await fixtures.fbm(N);
  const { out } = await renderNode(def, { inputs: { in: src, guide: null }, params: { radius: 0.02, guideRadius: 0.02 } });
  const low = smoothed(src, 5.12);
  const flow = flowOf(low);
  const stride = 5.12 / 7;
  const base = pass(src, flow, { stride, way: -1, substeps: 1, fade: 0, lowest: true });
  const detail = mapField(src, (x, y) => at(src, x, y) - at(low, x, y));
  const part = pass(detail, flow, { stride, way: 1, substeps: 1, fade: 1 / 7, lowest: true });
  const expected = mapField(src, (x, y) => {
    const s = at(src, x, y);
    const cut = Math.min(at(part, x, y) - at(detail, x, y), 0);
    const room = Math.max(s - at(base, x, y), 0);
    return s - room * (1 - Math.exp(cut / Math.max(room, 1e-12)));
  });
  // As above, and the detail is the difference of two numbers near 0.5 in float32.
  expectClose(out, expected, { max: 2e-3, rms: 1e-4 });
  assert.ok(stats(mapField(src, (x, y) => at(out, x, y) - at(src, x, y))).min < -0.01 * range(src), 'something was cut');
});

test('filter/slope-blur: gullies never raise the ground, and leave level ground and the foot of a slope where they are', async () => {
  const src = await fixtures.fbm(N);
  const { out } = await renderNode(def, { inputs: { in: src, guide: null } });
  const change = stats(mapField(src, (x, y) => at(out, x, y) - at(src, x, y)));
  assert.ok(change.max <= 0, `the ground rose by ${change.max}`);
  assert.ok(change.min < -0.03 * range(src), `the deepest cut is ${change.min}`);
  assert.ok(stats(out).min >= stats(src).min, 'nothing was cut below the lowest ground there is');

  // A peak on a plain: smoothing rounds its foot, and what the plain lacks to the rounded foot counts as detail.
  // Nothing is cut from it: the plain has no ground below it.
  const peak = mountain(N);
  const { out: cut } = await renderNode(def, { inputs: { in: peak, guide: null } });
  let below = 0, moved = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (at(cut, x, y) < 0) below++;
      if (at(peak, x, y) === 0 && at(cut, x, y) !== 0) moved++;
    }
  }
  assert.equal(below, 0, 'no moat below the plain');
  assert.equal(moved, 0, 'the plain is untouched');
});

test('filter/slope-blur: gullies draw a pit down the slope as a channel that shallows; uphill of it and beside it nothing happens', async () => {
  // A slope that rises towards +X at 0.25 metres per metre, with one pit 4 texels wide at (154, 128).
  const pit = fieldOf(N, (u, v) => u - 0.03 * Math.exp(-((u - 0.6) ** 2 + (v - 0.5) ** 2) / (2 * 0.015 ** 2)));
  const { out } = await renderNode(def, { inputs: { in: pit, guide: null }, params: { radius: 0.1, guideRadius: 0.03 } });
  const change = (x: number, y: number): number => at(out, x, y) - at(pit, x, y);
  // The path reaches 0.857 * 25.6 = 22 texels uphill. The smoothing leaves a fifth of the pit, spread wide: the
  // detail is the pit less that, 0.024 deep.
  assert.ok(change(148, 128) < -0.008, `6 texels below the pit the ground changed by ${change(148, 128)}`);
  assert.ok(change(138, 128) < -0.002 && change(138, 128) > change(148, 128), `16 texels below it by ${change(138, 128)}: shallower`);
  assert.ok(Math.abs(change(114, 128)) < 5e-4, `40 texels below it, beyond the reach of its rim, by ${change(114, 128)}`);
  // Around the pit the detail is the little the smoothing spread there, 0.003 at most.
  assert.ok(Math.abs(change(168, 128)) < 3e-3, `14 texels above the pit the ground changed by ${change(168, 128)}`);
  assert.ok(Math.abs(change(144, 143)) < 3e-3 && Math.abs(change(144, 113)) < 3e-3, `15 texels beside the channel by ${change(144, 143)} and ${change(144, 113)}`);
});

// ---- both modes ---------------------------------------------------------------------------------------------------

test('filter/slope-blur: both modes draw streaks down the slope: detail along the fall line goes, detail across it stays', async () => {
  // Ridges that run down an even slope towards -X, 20 texels apart, with bumps along them every 13 texels.
  const bumps = fieldOf(N, (u, v) => 0.5 * u + 0.02 * Math.sin(80 * v) * (1 + 0.5 * Math.sin(125 * u)));
  const bend = (f: FieldData, dx: number, dy: number): number => {
    let sum = 0;
    for (let y = 40; y < 216; y++) for (let x = 40; x < 216; x++) sum += (at(f, x - dx, y - dy) - 2 * at(f, x, y) + at(f, x + dx, y + dy)) ** 2;
    return Math.sqrt(sum);
  };
  // The path reaches 0.64 * 0.12 * 256 = 20 texels on this slope, over more than one bump.
  const smear = await renderNode(def, { inputs: { in: bumps, guide: 'rampX' }, params: { radius: 0.12, ...SMEAR, ...AS_IS } });
  assert.ok(bend(smear.out, 1, 0) < 0.4 * bend(bumps, 1, 0), `smear: along the fall line the surface bends ${bend(smear.out, 1, 0)}; it bent ${bend(bumps, 1, 0)}`);
  assert.ok(bend(smear.out, 0, 1) > 0.8 * bend(bumps, 0, 1), `smear: across the fall line it bends ${bend(smear.out, 0, 1)}; it bent ${bend(bumps, 0, 1)}`);
  // Gullies: the smoothing of 0.03, 7.7 texels, takes the ridges and the bumps for detail and leaves the slope.
  const gullies = await renderNode(def, { inputs: { in: bumps, guide: 'rampX' }, params: { radius: 0.12, guideRadius: 0.03 } });
  assert.ok(bend(gullies.out, 1, 0) < 0.6 * bend(bumps, 1, 0), `gullies: along the fall line the surface bends ${bend(gullies.out, 1, 0)}; it bent ${bend(bumps, 1, 0)}`);
  assert.ok(bend(gullies.out, 0, 1) > 0.8 * bend(bumps, 0, 1), `gullies: across the fall line it bends ${bend(gullies.out, 0, 1)}; it bent ${bend(bumps, 0, 1)}`);

  // On a mountain, smeared down its own slopes, the spurs swell and the hollows between them narrow to creases:
  // the surface bends more sharply in its hollows than it did, although it is smoother everywhere else.
  const peak = mountain(N);
  const { out: smeared } = await renderNode(def, { inputs: { in: peak, guide: null }, params: { radius: 0.06, guideRadius: 0.01, ...SMEAR } });
  const sharpest = (f: FieldData): number => {
    let worst = 0;
    for (let y = 40; y < 216; y++) {
      for (let x = 40; x < 216; x++) {
        if (Math.hypot(x - 128, y - 128) < 30) continue;      // the summit, where every path ends
        worst = Math.max(worst, at(f, x - 1, y) + at(f, x + 1, y) + at(f, x, y - 1) + at(f, x, y + 1) - 4 * at(f, x, y));
      }
    }
    return worst;
  };
  assert.ok(sharpest(smeared) > 1.5 * sharpest(peak), `the sharpest hollow bends ${sharpest(smeared)}; before the smear ${sharpest(peak)}`);
});

test('filter/slope-blur: the strength mixes the result into the picture', async () => {
  const src = await fixtures.fbm(N);
  for (const mode of ['gullies', 'smear'] as const) {
    const full = await renderNode(def, { inputs: { in: src, guide: 'terrain' }, params: { radius: 0.05, mode } });
    const half = await renderNode(def, { inputs: { in: src, guide: 'terrain' }, params: { radius: 0.05, mode, strength: 0.5 } });
    expectClose(half.out, mapField(src, (x, y) => 0.5 * at(src, x, y) + 0.5 * at(full.out, x, y)), { max: 1e-6 });
    assert.ok(stats(mapField(src, (x, y) => Math.abs(at(full.out, x, y) - at(src, x, y)))).max > 0.02 * range(src), `${mode}: the result differs from the picture`);
  }
});

test('filter/slope-blur: no strength, a radius within a quarter of a texel, or gullies without a smoothing give the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const params of [{ strength: 0 }, { radius: 0.0009 }, { radius: 0 }, { radius: -1 }, { ...AS_IS }, { guideRadius: 0 }, { radius: 0.0009, ...SMEAR }] as Readonly<Record<string, number | string>>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
  const flat = fieldOf(N, () => 0.3);
  for (const mode of ['gullies', 'smear'] as const) {
    expectIdentical((await renderNode(def, { inputs: { in: flat, guide: 'terrain' }, params: { mode } })).out, flat);
  }
});

test('filter/slope-blur: a color is treated channel by channel and stays opaque; without a guide, down the slopes of its brightness', async () => {
  const color = fixtures.color(N);
  const brightness = mapField(fixtures.terrain(N), (x, y) => 0.2126 * at(color, x, y, 0) + 0.7152 * at(color, x, y, 1) + 0.0722 * at(color, x, y, 2));
  for (const mode of ['gullies', 'smear'] as const) {
    const guided = await renderNode(def, { inputs: { in: color, guide: 'cone' }, params: { radius: 0.05, mode } });
    assert.equal(guided.out.kind, 'color');
    const blue = await renderNode(def, { inputs: { in: channelOf(color, 2), guide: 'cone' }, params: { radius: 0.05, mode } });
    expectClose(channelOf(guided.out, 2), blue.out, { max: 2e-3 });
    expectIdentical(channelOf(guided.out, 3), fixtures.one(N));

    // The brightness of the color fixture, 0.2126 u + 0.7152 v + 0.0722 terrain, as the guide of its own smear.
    const own = await renderNode(def, { inputs: { in: color, guide: null }, params: { radius: 0.05, mode } });
    const same = await renderNode(def, { inputs: { in: color, guide: brightness }, params: { radius: 0.05, mode } });
    expectClose(own.out, same.out, { max: 2e-3 });
    expectIdentical(channelOf(own.out, 3), fixtures.one(N));
  }
});

test('filter/slope-blur: the result is the same at two levels of the ladder, in one pass and in several', async () => {
  for (const mode of ['gullies', 'smear'] as const) {
    for (const radius of [0.02, 0.1]) {
      const guided = await renderLadder(def, { inputs: { in: 'terrain', guide: 'basin' }, params: { radius, mode } });
      expectLadder(guided[257].out, guided[513].out, { rel: 0.01 });
      const own = await renderLadder(def, { inputs: { in: 'terrain', guide: null }, params: { radius, mode } });
      expectLadder(own[257].out, own[513].out, { rel: 0.02 });
    }
  }
});
