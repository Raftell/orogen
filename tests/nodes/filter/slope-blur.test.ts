// tests/nodes/filter/slope-blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/slope-blur.ts';
import { bilinearAt, mapField, mountain, range, stepAt, stepBetween, stepLength } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;
/** A guide smoothing too small to smooth anything at 257: the guide steers as it is. */
const AS_IS = { guideRadius: 0.0005 } as const;

/**
 * The smear on the CPU: the mean of the picture at `points` places of the path that leads uphill from each texel
 * over the slope of `guide`, evenly spaced over `reach` texels: the midpoints of that many equal steps.
 */
function smeared(src: FieldData, guide: FieldData, reach: number, points: number): FieldData {
  const step = reach / points;
  const move = (p: readonly [number, number], flow: readonly [number, number], by: number): [number, number] =>
    [Math.min(L, Math.max(0, p[0] + by * flow[0])), Math.min(L, Math.max(0, p[1] + by * flow[1]))];
  return mapField(src, (x, y) => {
    // The path starts on the texel, by the slope at the texel; from there on it goes by the slope between texels.
    let p = move([x, y], stepAt(guide, x, y), step / 2);
    let sum = 0;
    for (let i = 0; i < points; i++) {
      sum += bilinearAt(src, p[0], p[1]);
      if (i + 1 < points) p = move(p, stepBetween(guide, p[0], p[1]), step);
    }
    return sum / points;
  });
}

test('filter/slope-blur: each point becomes the mean of the picture along the path uphill from it', async () => {
  // A radius of 0.02 is 5.12 texels at 257: one pass, 7 points of the path. The guide is another terrain.
  const src = await fixtures.fbm(N);
  const guide = fixtures.terrain(N);
  const { out } = await renderNode(def, { inputs: { in: src, guide }, params: { radius: 0.02, ...AS_IS } });
  // The path is followed in float32, over a picture with slopes of up to 0.05 a texel.
  expectClose(out, smeared(src, guide, 5.12, 7), { max: 5e-4 });
});

test('filter/slope-blur: a point is smeared downhill and nowhere else, as far as the radius on steep ground', async () => {
  // The guide rises towards +X at 0.25 metres per metre, where a step is 0.857 of its length. An impulse at the
  // centre is drawn out towards -X over 0.857 of the radius: 0.1 is 25.6 texels, in two nested passes.
  const { out } = await renderNode(def, { inputs: { in: 'impulse', guide: 'rampX' }, params: { radius: 0.1, ...AS_IS } });
  const reach = 25.6 * stepLength(0.25);
  let sum = 0, row = 0, uphill = 0, centre = 0, farthest = 128;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = at(out, x, y);
      sum += v;
      if (y === 128) row += v;
      if (x > 128) uphill += Math.abs(v);
      centre += v * x;
      if (v > 1e-6) farthest = Math.min(farthest, x);
    }
  }
  assert.ok(Math.abs(sum - 1) < 1e-4, `the smear sums to ${sum}`);
  assert.ok(Math.abs(row - sum) < 1e-6, 'it stays on the row of the impulse: the slope has no part across it');
  assert.equal(uphill, 0, 'nothing is smeared uphill');
  // The 49 points of the two passes are evenly spaced over the path: its middle is the middle of the smear.
  assert.ok(Math.abs(centre / sum - (128 - reach / 2)) < 0.3, `the middle of the smear is at ${centre / sum}; half the reach downhill is ${128 - reach / 2}`);
  assert.ok(Math.abs(farthest - (128 - reach)) < 1.5, `the smear ends at ${farthest}; the reach ends at ${128 - reach}`);
});

test('filter/slope-blur: a long smear, made of nested passes, is the mean over the whole path', async () => {
  // 0.1 is 25.6 texels: two passes, 49 points; 0.25 is 64 texels: three passes, 343 points.
  const src = await fixtures.fbm(N);
  const guide = fieldOf(N, (u, v) => 0.5 + 0.3 * Math.sin(5 * u + 1) * Math.cos(4 * v));
  for (const [radius, points] of [[0.1, 49], [0.25, 343]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src, guide }, params: { radius, ...AS_IS } });
    // A pass takes each of its steps whole, a seventh of its reach, where the path of the reference bends within
    // it: at the far end of a path the places differ by a texel or two, on a terrain that changes by up to 0.05
    // from one texel to the next. Measured: 0.15 % and 0.7 % of the range in the root mean square.
    expectClose(out, smeared(src, guide, radius * L, points), { max: 0.08 * range(src), rms: 0.01 * range(src) });
  }
});

test('filter/slope-blur: without a guide the picture is smeared down its own slopes, which raises a flank by what lies above it', async () => {
  // The cone falls by 4 per unit length at 45 degrees, where a step is 0.989 of its length: the mean over a path
  // of 0.02 uphill is higher than the point by 4 * 0.989 * 0.02 / 2.
  const cone = fixtures.cone(N);
  const { out } = await renderNode(def, { inputs: { in: cone, guide: null }, params: { radius: 0.02, guideRadius: 0.004 } });
  for (const [x, y] of [[160, 128], [128, 96], [105, 105], [150, 150]] as const) {
    assert.ok(Math.abs(at(out, x, y) - at(cone, x, y) - 2 * 0.02 * stepLength(1)) < 2e-3, `at (${x}, ${y}) the flank rose by ${at(out, x, y) - at(cone, x, y)}`);
  }
  // Level ground has no downhill: the floor around the cone is untouched.
  assert.equal(at(out, 10, 10), 0);
  assert.equal(at(out, 128, 250), 0);
});

test('filter/slope-blur: the smear draws streaks down the slope: detail along the fall line goes, detail across it stays', async () => {
  // Ridges that run down an even slope towards -X, 20 texels apart, with bumps along them every 13 texels.
  const bumps = fieldOf(N, (u, v) => 0.5 * u + 0.02 * Math.sin(80 * v) * (1 + 0.5 * Math.sin(125 * u)));
  const { out } = await renderNode(def, { inputs: { in: bumps, guide: 'rampX' }, params: { radius: 0.08, ...AS_IS } });
  const bend = (f: FieldData, dx: number, dy: number): number => {
    let sum = 0;
    for (let y = 40; y < 216; y++) for (let x = 40; x < 216; x++) sum += (at(f, x - dx, y - dy) - 2 * at(f, x, y) + at(f, x + dx, y + dy)) ** 2;
    return Math.sqrt(sum);
  };
  // The smear reaches 17.5 texels: of bumps 13 texels apart a fifth is left.
  assert.ok(bend(out, 1, 0) < 0.3 * bend(bumps, 1, 0), `along the fall line the surface bends ${bend(out, 1, 0)}; it bent ${bend(bumps, 1, 0)}`);
  assert.ok(bend(out, 0, 1) > 0.8 * bend(bumps, 0, 1), `across the fall line it bends ${bend(out, 0, 1)}; it bent ${bend(bumps, 0, 1)}`);

  // On a mountain, smeared down its own slopes, the spurs swell and the hollows between them narrow to creases:
  // the surface bends more sharply in its hollows than it did, although it is smoother everywhere else.
  const peak = mountain(N);
  const { out: gullied } = await renderNode(def, { inputs: { in: peak, guide: null }, params: { radius: 0.06, guideRadius: 0.01 } });
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
  assert.ok(sharpest(gullied) > 2 * sharpest(peak), `the sharpest hollow bends ${sharpest(gullied)}; before the smear ${sharpest(peak)}`);
});

test('filter/slope-blur: the strength mixes the smear into the picture', async () => {
  const src = await fixtures.fbm(N);
  const full = await renderNode(def, { inputs: { in: src, guide: 'terrain' }, params: { radius: 0.05 } });
  const half = await renderNode(def, { inputs: { in: src, guide: 'terrain' }, params: { radius: 0.05, strength: 0.5 } });
  expectClose(half.out, mapField(src, (x, y) => 0.5 * at(src, x, y) + 0.5 * at(full.out, x, y)), { max: 1e-6 });
});

test('filter/slope-blur: no strength, or a radius within a quarter of a texel, gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const params of [{ strength: 0 }, { radius: 0.0009 }, { radius: 0 }, { radius: -1 }] as Readonly<Record<string, number>>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
  const flat = fieldOf(N, () => 0.3);
  expectIdentical((await renderNode(def, { inputs: { in: flat, guide: 'terrain' }, params: { radius: 0.1 } })).out, flat);
});

test('filter/slope-blur: a color is smeared channel by channel and stays opaque; without a guide, down the slopes of its brightness', async () => {
  const color = fixtures.color(N);
  const guided = await renderNode(def, { inputs: { in: color, guide: 'cone' }, params: { radius: 0.05 } });
  assert.equal(guided.out.kind, 'color');
  const blue = await renderNode(def, { inputs: { in: channelOf(color, 2), guide: 'cone' }, params: { radius: 0.05 } });
  expectClose(channelOf(guided.out, 2), blue.out, { max: 2e-3 });
  expectIdentical(channelOf(guided.out, 3), fixtures.one(N));

  // The brightness of the color fixture, 0.2126 u + 0.7152 v + 0.0722 terrain, as the guide of its own smear.
  const own = await renderNode(def, { inputs: { in: color, guide: null }, params: { radius: 0.05 } });
  const brightness = mapField(fixtures.terrain(N), (x, y) => 0.2126 * at(color, x, y, 0) + 0.7152 * at(color, x, y, 1) + 0.0722 * at(color, x, y, 2));
  const same = await renderNode(def, { inputs: { in: color, guide: brightness }, params: { radius: 0.05 } });
  expectClose(own.out, same.out, { max: 2e-3 });
  expectIdentical(channelOf(own.out, 3), fixtures.one(N));
});

test('filter/slope-blur: the smear is the same at two levels of the ladder, in one pass and in several', async () => {
  for (const radius of [0.02, 0.1]) {
    const guided = await renderLadder(def, { inputs: { in: 'terrain', guide: 'basin' }, params: { radius } });
    expectLadder(guided[257].out, guided[513].out, { rel: 0.01 });
    const own = await renderLadder(def, { inputs: { in: 'terrain', guide: null }, params: { radius } });
    expectLadder(own[257].out, own[513].out, { rel: 0.02 });
  }
});
