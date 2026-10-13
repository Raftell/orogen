// The parts of the harness that need no device (testing.md 2.2, 2.5, 2.6): field data, the fixtures and what
// their table promises of them, statistics, comparisons and their messages, and the ladder functions.
//
// Sizes: fields of at most 513 x 513 floats; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  at, channelOf, colorOf, compareLadder, decimate, diff, expectClose, expectFinite, expectIdentical, expectLadder, expectMask,
  expectStats, fieldOf, fixtures, stats, type FieldData, type FixtureName,
} from '../../helpers/index.ts';

const AssertionError = assert.AssertionError;
const TAU = 2 * Math.PI;
/** The message an expectation fails with; fails itself when the expectation passes or throws anything else. */
function failure(expectation: () => unknown): string {
  try {
    expectation();
  } catch (thrown) {
    assert.ok(thrown instanceof AssertionError, `an AssertionError, not ${String(thrown)}`);
    assert.ok(thrown.message.length < 600, 'the message names a position and a count, never the data');
    assert.deepEqual([thrown.actual, thrown.expected], [undefined, undefined], 'an expectation carries no data');
    return thrown.message;
  }
  return assert.fail('the expectation passed');
}

/** Physical slope in degrees at every interior texel, by central differences with the test settings; the largest. */
function steepest(f: FieldData): number {
  const cell = 4096 / (f.width - 1);
  let worst = 0;
  for (let y = 1; y < f.height - 1; y++) {
    for (let x = 1; x < f.width - 1; x++) {
      const dx = ((at(f, x + 1, y) - at(f, x - 1, y)) * 1024) / (2 * cell), dy = ((at(f, x, y + 1) - at(f, x, y - 1)) * 1024) / (2 * cell);
      worst = Math.max(worst, (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI);
    }
  }
  return worst;
}

/** Interior texels lower than all eight neighbours. */
function minima(f: FieldData): number {
  let count = 0;
  for (let y = 1; y < f.height - 1; y++) {
    for (let x = 1; x < f.width - 1; x++) {
      let lowest = true;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if ((i !== 0 || j !== 0) && at(f, x + i, y + j) <= at(f, x, y)) lowest = false;
      if (lowest) count++;
    }
  }
  return count;
}

// ---- field data ----------------------------------------------------------------------------------------------------

test('fieldOf and colorOf call fn with uv = px / (res - 1) and store the float32 of the result', () => {
  const calls: [number, number][] = [];
  const f = fieldOf(5, (u, v) => { calls.push([u, v]); return u + 10 * v + 0.1; });
  assert.deepEqual([f.kind, f.width, f.height, f.channels, f.data.length], ['field', 5, 5, 1, 25]);
  assert.deepEqual(calls.slice(0, 6), [[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [1, 0], [0, 0.25]], 'row-major: x runs first');
  assert.equal(at(f, 3, 2), Math.fround(0.75 + 5 + 0.1));
  assert.equal(at(f, 4, 4), Math.fround(11.1));

  const c = colorOf(3, (u, v) => [u, v, u + v, 1]);
  assert.deepEqual([c.kind, c.width, c.height, c.channels, c.data.length], ['color', 3, 3, 4, 36]);
  assert.deepEqual([at(c, 2, 1), at(c, 2, 1, 1), at(c, 2, 1, 2), at(c, 2, 1, 3)], [1, 0.5, 1.5, 1]);
  assert.equal(at(c, 1, 2, 0), 0.5, 'the channel defaults to 0');

  const green = channelOf(c, 1);
  assert.deepEqual([green.kind, green.channels, green.width, green.data.length], ['field', 1, 3, 9]);
  assert.deepEqual([at(green, 0, 0), at(green, 1, 1), at(green, 2, 2)], [0, 0.5, 1]);

  assert.throws(() => at(f, 5, 0), RangeError);
  assert.throws(() => at(f, 0, -1), RangeError);
  assert.throws(() => at(f, 0, 0, 1), RangeError, 'a field has one channel');
  assert.throws(() => channelOf(f, 2), RangeError);
  assert.throws(() => fieldOf(0, () => 0), RangeError);
  assert.equal(at(fieldOf(1, (u, v) => u + v + 7), 0, 0), 7, 'a single texel is at uv (0, 0)');
});

// ---- fixtures ------------------------------------------------------------------------------------------------------

const COMPUTED: readonly Exclude<FixtureName, 'fbm'>[] = ['terrain', 'rampX', 'rampY', 'cone', 'basin', 'bowl', 'notch', 'mask', 'zero', 'one', 'impulse', 'color', 'color2', 'color3', 'color4'];

test('every fixture but fbm is a function of uv: a coarser level is the decimation of a finer one, bit for bit', async () => {
  for (const name of COMPUTED) {
    const fine = fixtures[name](513);
    expectIdentical(fixtures[name](257), decimate(fine));
    expectIdentical(fixtures[name](129), decimate(fine, 2));
    expectIdentical(await fixtures.byName(name, 257), fixtures[name](257));
    assert.equal(fine.kind, name.startsWith('color') ? 'color' : 'field');
  }
  await assert.rejects(fixtures.byName('granite' as FixtureName, 129), /not a fixture/);
});

test('the four colour fixtures are opaque, within 0..1, and no channel of one is the same channel of another', () => {
  const names = ['color', 'color2', 'color3', 'color4'] as const;
  const colors = names.map((name) => fixtures[name](129));
  for (const [i, color] of colors.entries()) {
    expectIdentical(channelOf(color, 3), fixtures.one(129));
    for (const channel of [0, 1, 2] as const) {
      const s = stats(color, channel);
      assert.ok(s.min >= 0 && s.max <= 1 && s.std > 0.05, `${names[i]}, channel ${channel}: ${s.min}..${s.max}, standard deviation ${s.std}`);
      for (let j = 0; j < i; j++) {
        const d = diff(channelOf(color, channel), channelOf(colors[j]!, channel));
        assert.ok(d.rms > 0.1, `channel ${channel} of ${names[i]} and of ${names[j]} differ by ${d.rms} rms`);
      }
    }
  }
});

test('terrain: the formula of the table, within 0.105..0.895, with 41 interior minima and slopes up to 55 degrees', () => {
  const expected = (u: number, v: number): number =>
    0.5 + 0.22 * Math.sin(TAU * (u + 0.5 * v) + 0.3) + 0.10 * Math.sin(TAU * (-2 * u + 3 * v) + 1.7)
    + 0.05 * Math.sin(TAU * (5 * u + 4 * v) + 4.1) + 0.025 * Math.sin(TAU * (9 * u - 7 * v) + 2.9);
  for (const res of [129, 257, 513]) {
    const terrain = fixtures.terrain(res);
    expectIdentical(terrain, fieldOf(res, expected));
    expectStats(terrain, { min: [0.105, 0.115], max: [0.885, 0.895] });
    assert.equal(minima(terrain), 41, `interior local minima at ${res}`);
  }
  const slope = steepest(fixtures.terrain(257));
  assert.ok(slope > 53 && slope < 56, `the steepest slope with the test settings is ${slope} degrees`);
});

test('the ramps, the cone and the notch have the slopes the table states', () => {
  for (const [name, x, y, value] of [['rampX', 64, 200, 0.25], ['rampY', 200, 64, 0.25]] as const) assert.equal(at(fixtures[name](257), x, y), value);
  // 0.25 m/m: one height range over four of them.
  assert.ok(Math.abs(steepest(fixtures.rampX(257)) - 14.036) < 1e-3 && Math.abs(steepest(fixtures.rampY(257)) - 14.036) < 1e-3);

  const cone = fixtures.cone(257);
  assert.deepEqual([at(cone, 128, 128), at(cone, 192, 128), at(cone, 0, 0)], [1, 0, 0], 'a single peak on a flat floor');
  assert.equal(at(cone, 160, 128), 0.5);
  assert.ok(Math.abs(steepest(cone) - 45) < 0.01, `the flank is at ${steepest(cone)} degrees`);

  const notch = fixtures.notch(257);
  assert.ok(steepest(notch) <= 10.1, `the notch is nowhere steeper than 10.1 degrees (${steepest(notch)})`);
  assert.equal(minima(notch), 0, 'no depression');
  assert.ok(at(notch, 128, 128) < at(notch, 128, 96), 'the channel runs along the centre line');
  assert.ok(at(notch, 250, 128) < at(notch, 10, 128), 'the plane falls towards +X');
});

test('basin and bowl: one closed depression below the test sea level, and a bowl without a sink', () => {
  const basin = fixtures.basin(257);
  expectStats(basin, { min: [0.146, 0.148] });
  assert.equal(minima(basin), 1, 'one closed depression');
  let below = 0, onBorder = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      if (at(basin, x, y) >= 0.25) continue;
      below++;
      if (x === 0 || y === 0 || x === 256 || y === 256) onBorder++;
    }
  }
  assert.ok(below / 257 ** 2 > 0.025 && below / 257 ** 2 < 0.04, `${(100 * below) / 257 ** 2} % of the field lies below the sea level of 0.25`);
  assert.equal(onBorder, 0, 'the part below the sea level does not touch the border');

  const bowl = fixtures.bowl(257);
  expectStats(bowl, { min: 0.3, max: 0.9 });
  assert.equal(at(bowl, 128, 128), Math.fround(0.3));
  for (const [x, y] of [[0, 77], [256, 190], [31, 0], [200, 256]] as const) assert.equal(at(bowl, x, y), Math.fround(0.9), 'the border ring is the highest part');
});

test('mask, zero, one, impulse and color', () => {
  const mask = fixtures.mask(257);
  expectMask(mask);
  // Exactly 1 inside radius 0.2, exactly 0 outside 0.35.
  let wrong = 0;
  for (let y = 0; y < 257; y++) {
    for (let x = 0; x < 257; x++) {
      const r = Math.hypot(x / 256 - 0.5, y / 256 - 0.5);
      if ((r <= 0.2 && at(mask, x, y) !== 1) || (r >= 0.35 && at(mask, x, y) !== 0) || (r > 0.2 && r < 0.35 && !(at(mask, x, y) > 0 && at(mask, x, y) < 1))) wrong++;
    }
  }
  assert.equal(wrong, 0, 'texels of the mask off its definition');

  expectStats(fixtures.zero(129), { min: 0, max: 0 });
  expectStats(fixtures.one(129), { min: 1, max: 1 });
  const impulse = fixtures.impulse(129);
  assert.equal(at(impulse, 64, 64), 1);
  assert.equal(stats(impulse).mean * 129 ** 2, 1, 'one texel is 1, every other 0');
  assert.equal(at(fixtures.impulse(128), 63, 63), 1, 'a grid without a centre vertex takes the texel before it');

  const color = fixtures.color(129);
  assert.deepEqual([at(color, 32, 96, 0), at(color, 32, 96, 1), at(color, 32, 96, 3)], [0.25, 0.75, 1]);
  expectIdentical(channelOf(color, 2), fixtures.terrain(129));
});

// ---- statistics ----------------------------------------------------------------------------------------------------

test('stats covers the finite values of one channel, in float64', () => {
  const ramp = fieldOf(101, (u) => u);
  const s = stats(ramp);
  assert.deepEqual([s.count, s.nonFinite, s.min, s.max], [101 * 101, 0, 0, 1]);
  assert.ok(Math.abs(s.mean - 0.5) < 1e-7 && Math.abs(s.p50 - 0.5) < 1e-7);
  assert.ok(Math.abs(s.p01 - 0.01) < 1e-6 && Math.abs(s.p99 - 0.99) < 1e-6, `p01 ${s.p01}, p99 ${s.p99}`);
  // The population deviation of a uniform lattice of 101 values in 0..1: sqrt((n^2 - 1) / 12) / (n - 1).
  assert.ok(Math.abs(s.std - Math.sqrt((101 ** 2 - 1) / 12) / 100) < 1e-7, `std ${s.std}`);

  const holed = fieldOf(4, (u, v) => (u === 0 ? NaN : v === 0 ? Infinity : 2));
  assert.deepEqual(stats(holed), { count: 9, nonFinite: 7, min: 2, max: 2, mean: 2, std: 0, p01: 2, p50: 2, p99: 2 });
  assert.deepEqual(stats(fieldOf(2, () => NaN)), { count: 0, nonFinite: 4, min: 0, max: 0, mean: 0, std: 0, p01: 0, p50: 0, p99: 0 });

  const color = colorOf(3, (u, v) => [u, 5, v, 1]);
  assert.deepEqual([stats(color).max, stats(color, 1).min, stats(color, 1).max, stats(color, 3).mean], [1, 5, 5, 1], 'the channel asked for; 0 by default');
  assert.throws(() => stats(color, 4), RangeError);
  assert.throws(() => stats(fieldOf(2, () => 0), 1), RangeError);
});

test('expectStats, expectFinite and expectMask name the statistic or the position, the value and the bound', () => {
  const ramp = fieldOf(101, (u) => u);
  expectStats(ramp, { min: 0, max: 1, mean: [0.49, 0.51], std: [0.28, 0.3], p50: 0.5 });
  assert.match(failure(() => expectStats(ramp, { mean: [0.6, 0.75] })), /^mean 0\.5\d* is outside \[0\.6, 0\.75\]$/);
  assert.match(failure(() => expectStats(ramp, { max: 0.9 })), /^max 1 is outside \[0\.89999, 0\.90001\]$/, 'a number n means [n - 1e-5, n + 1e-5]');
  expectStats(ramp, { max: 1.000009 });
  assert.match(failure(() => expectStats(fieldOf(3, (u) => (u === 1 ? NaN : 0.5)), { mean: 0.5 })), /^nonFinite 3 is not 0/, 'always asserted as well');
  assert.throws(() => expectStats(ramp, { median: 0.5 } as never), TypeError);

  expectFinite(ramp);
  expectFinite(fixtures.color(33));
  const broken = colorOf(5, (u, v) => [u, v === 0.5 && u === 0.75 ? -Infinity : 0, 0, 1]);
  assert.equal(failure(() => expectFinite(broken)), '1 of 100 values are not finite; the first is -Infinity at (3, 2) channel 1');

  expectMask(fieldOf(9, (u) => u));
  assert.equal(failure(() => expectMask(fieldOf(5, (u, v) => (v === 1 ? 1.25 * u : u)))), '1 of 25 values are outside [0, 1]; the first is 1.25 at (4, 4)');
  assert.match(failure(() => expectMask(fieldOf(3, (u) => (u === 0.5 ? NaN : 0)))), /^3 of 9 values are outside \[0, 1\]; the first is NaN at \(1, 0\)$/);
  assert.match(failure(() => expectMask(fieldOf(3, () => -1e-9))), /^9 of 9 values are outside/, 'exactly 0..1: no tolerance');
});

test('diff measures two fields of one shape; expectClose and expectIdentical report the worst value', () => {
  const a = fieldOf(33, (u, v) => u * v);
  const b = fieldOf(33, (u, v) => u * v + (u === 0.5 && v === 0.25 ? 0.003 : u === 1 ? 1e-7 : 0));
  const d = diff(a, b);
  assert.ok(Math.abs(d.max - 0.003) < 1e-7);
  assert.deepEqual([d.worst.x, d.worst.y, d.worst.channel], [16, 8, 0]);
  assert.deepEqual([d.worst.a, d.worst.b], [at(a, 16, 8), at(b, 16, 8)]);
  assert.ok(d.differing >= 1 && d.differing <= 34, `${d.differing} values are not bit-identical`);
  assert.ok(Math.abs(d.rms - Math.sqrt(0.003 ** 2 / 33 ** 2)) < 1e-6);
  assert.deepEqual(diff(a, a), { max: 0, rms: 0, differing: 0, worst: { x: 0, y: 0, channel: 0, a: 0, b: 0 } });

  assert.equal(expectClose(a, b, { max: 0.0031 }).differing, d.differing, 'the Diff is returned');
  expectClose(a, b, { rms: 1e-4 });
  assert.match(failure(() => expectClose(a, b, { max: 1e-6 })), /^max difference 0\.003\d* at \(16, 8\): 0\.125 vs 0\.128; allowed 1e-6$/);
  assert.match(failure(() => expectClose(a, b, { max: 1, rms: 1e-6 })), /^rms difference 9\.09\d*e-5 \(max difference .* at \(16, 8\).*\); allowed 1e-6$/);
  assert.throws(() => expectClose(a, b, {}), TypeError, 'at least one of max and rms');
  assert.throws(() => expectClose(a, b, { max: -1 }), RangeError);

  expectIdentical(a, fieldOf(33, (u, v) => u * v));
  assert.match(failure(() => expectIdentical(a, b)), /^\d+ of 1089 values are not bit-identical; the first is at \(32, 0\): 0 vs 1e-7$/);
  // The same 32 bits, not the same number: 0 and -0 differ, a NaN equals itself.
  assert.match(failure(() => expectIdentical(fieldOf(2, () => 0), fieldOf(2, () => -0))), /^4 of 4 values/);
  expectIdentical(fieldOf(2, () => NaN), fieldOf(2, () => NaN));
  assert.equal(diff(fieldOf(2, () => 0), fieldOf(2, () => -0)).max, 0);
  assert.equal(diff(fieldOf(2, () => 1), fieldOf(2, (u) => (u === 0 ? NaN : 1))).max, Infinity, 'a value that is not finite is never close');

  // A colour is compared in all four channels.
  const c1 = colorOf(9, (u, v) => [u, v, 0.5, 1]);
  const c2 = colorOf(9, (u, v) => [u, v, 0.5, u === 1 && v === 1 ? 0.75 : 1]);
  assert.deepEqual(diff(c1, c2).worst, { x: 8, y: 8, channel: 3, a: 1, b: 0.75 });
  assert.match(failure(() => expectClose(c1, c2, { max: 1e-6 })), /at \(8, 8\) channel 3: 1 vs 0\.75; allowed 1e-6$/);

  assert.throws(() => diff(a, fieldOf(17, () => 0)), RangeError, 'another size');
  assert.throws(() => diff(c1, fieldOf(9, () => 0)), RangeError, 'another kind');
  assert.throws(() => expectIdentical(a, { ...a, data: new Float32Array(5) }), RangeError, 'data that does not fit its size');
});

// ---- the ladder ----------------------------------------------------------------------------------------------------

test('decimate keeps every 2^levels-th row and column', () => {
  const fine = fieldOf(17, (u, v) => 100 * v + u);
  const half = decimate(fine);
  assert.deepEqual([half.width, half.height, half.kind], [9, 9, 'field']);
  expectIdentical(half, fieldOf(9, (u, v) => 100 * v + u));
  expectIdentical(decimate(fine, 3), fieldOf(3, (u, v) => 100 * v + u));
  expectIdentical(decimate(fine, 0), fine);
  expectIdentical(decimate(fixtures.color(65), 2), fixtures.color(17));
  assert.throws(() => decimate(fieldOf(16, () => 0)), RangeError, '(width - 1) must be divisible by 2');
  assert.throws(() => decimate(fine, 5), RangeError, '16 is not divisible by 32');
  assert.throws(() => decimate(fine, -1), RangeError);
});

test('compareLadder and expectLadder compare a level with the decimation of a finer one', () => {
  const coarse = fixtures.terrain(129);
  const exact = compareLadder(coarse, fixtures.terrain(513));
  assert.deepEqual([exact.max, exact.rms, exact.rel], [0, 0, 0]);
  assert.ok(Math.abs(exact.std - stats(coarse).std) < 1e-9, 'std is that of the coarse field');

  // A fine field that is off by a known amount everywhere.
  const fine = fixtures.terrain(257);
  const shifted = fieldOf(257, (u, v) => at(fine, Math.round(u * 256), Math.round(v * 256)) + 0.01);
  const d = compareLadder(coarse, shifted);
  assert.ok(Math.abs(d.max - 0.01) < 1e-6 && Math.abs(d.rms - 0.01) < 1e-6 && Math.abs(d.rel - 0.01 / exact.std) < 1e-4, JSON.stringify(d));
  assert.deepEqual(expectLadder(coarse, shifted, { max: 0.011, rms: 0.011, rel: 0.1 }), d);
  assert.match(failure(() => expectLadder(coarse, shifted, { max: 1e-6 })), /^129 against 257: max difference 0\.01\d* at \(\d+, \d+\): .* vs .*; allowed 1e-6$/);
  assert.match(failure(() => expectLadder(coarse, shifted, { rms: 1e-3 })), /^129 against 257: rms difference 0\.0(1|09)\d* \(max difference .*\); allowed 0\.001$/);
  assert.match(failure(() => expectLadder(coarse, shifted, { rel: 0.01 })), /rms difference 0\.0(1|09)\d* is 0\.0[56]\d* of the standard deviation 0\.1\d* .*; allowed 0\.01$/);
  assert.throws(() => expectLadder(coarse, shifted, {}), TypeError);

  // For a colour the deviation is that of the three colour channels as one population; alpha does not count.
  const color = compareLadder(fixtures.color(65), fixtures.color(129));
  const rgb = [0, 1, 2].flatMap((channel) => [...channelOf(fixtures.color(65), channel as 0 | 1 | 2).data]);
  const mean = rgb.reduce((sum, v) => sum + v, 0) / rgb.length;
  const std = Math.sqrt(rgb.reduce((sum, v) => sum + (v - mean) ** 2, 0) / rgb.length);
  assert.ok(Math.abs(color.std - std) < 1e-9, `${color.std} against ${std}`);

  assert.throws(() => compareLadder(coarse, fixtures.terrain(385)), RangeError, '384 / 128 is no power of two');
  assert.throws(() => compareLadder(fixtures.terrain(257), coarse), RangeError, 'the finer field comes second');
  assert.throws(() => compareLadder(coarse, fixtures.color(257)), RangeError, 'a field against a colour');
});
