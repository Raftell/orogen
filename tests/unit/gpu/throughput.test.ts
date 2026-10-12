// Learned throughput and tile sizes: the arithmetic of runtime.md 3.3 and 3.4.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextRate, rowsPerTile } from '../../../src/core/gpu/throughput.ts';
import { HARD_CEILING_MS, RATE_CAP_FACTOR, RATE_FLOOR_FACTOR, RATE_INITIAL, SLICE_TARGET_BUILD_MS, SLICE_TARGET_PREVIEW_MS } from '../../../src/core/gpu/tuning.ts';

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));

test('the constants the contract prints', () => {
  assert.equal(RATE_INITIAL, 1e-7);
  assert.equal(RATE_CAP_FACTOR, 100);
  assert.equal(SLICE_TARGET_PREVIEW_MS, 8);
  assert.equal(SLICE_TARGET_BUILD_MS, 75);
  assert.equal(HARD_CEILING_MS, 500);
});

test('rule 2: the rate is multiplied by clamp(dt / est, 0.5, 2)', () => {
  const rate = 4e-7;
  for (const [dt, est, factor] of [[8, 8, 1], [12, 8, 1.5], [16, 8, 2], [100, 8, 2], [6, 8, 0.75], [4, 8, 0.5], [0.1, 8, 0.5], [0, 8, 0.5]] as const) {
    assert.ok(close(nextRate(rate, est, dt, true), rate * factor), `dt ${dt}, est ${est}`);
  }
});

test('rule 3: a slice above the hard ceiling corrects the rate at once', () => {
  assert.ok(close(nextRate(1e-7, 10, 501, true), 1e-7 * 50.1), 'no upper bound on the factor');
  assert.ok(close(nextRate(1e-7, 10, 500, true), 2e-7), 'at the ceiling the clamp still applies');
  // The cap of rule 6 does not apply either.
  assert.ok(close(nextRate(5e-6, 1, 2000, true), 5e-6 * 2000));
  assert.ok(nextRate(5e-6, 1, 2000, true) > RATE_INITIAL * RATE_CAP_FACTOR);
  // An owner whose ceiling is halved (5.9 rule 6) is corrected from 250 ms.
  assert.ok(close(nextRate(1e-7, 10, 300, true, 250), 1e-7 * 30));
  assert.ok(close(nextRate(1e-7, 10, 300, true), 2e-7));
});

test('rule 6: a rate never exceeds 100 x RATE_INITIAL except through rule 3', () => {
  const cap = RATE_INITIAL * RATE_CAP_FACTOR;
  let rate = RATE_INITIAL;
  for (let i = 0; i < 40; i++) {
    rate = nextRate(rate, 1, 400, true);
    assert.ok(rate <= cap);
  }
  assert.equal(rate, cap, 'forty doublings stop at the cap');
  // A rate that rule 3 took past the cap is not pulled back by a slow slice, and falls with a fast one.
  const high = cap * 8;
  assert.equal(nextRate(high, 1, 400, true), high);
  assert.ok(close(nextRate(high, 10, 5, true), high * 0.5));
});

test('rule 7: a rate never falls below the floor', () => {
  const floor = RATE_INITIAL * RATE_FLOOR_FACTOR;
  let rate = RATE_INITIAL;
  for (let i = 0; i < 40; i++) {
    rate = nextRate(rate, 8, 0, true);
    assert.ok(rate >= floor);
  }
  assert.equal(rate, floor, 'forty halvings stop at the floor');
  assert.ok(RATE_FLOOR_FACTOR > 0 && RATE_FLOOR_FACTOR < 1);
});

test('3.5 rule 2: a wall time too close to the completion latency never raises a rate', () => {
  assert.equal(nextRate(3e-7, 8, 80, false), 3e-7);
  assert.equal(nextRate(3e-7, 8, 9000, false), 3e-7, 'not even above the hard ceiling');
  assert.ok(close(nextRate(3e-7, 8, 6, false), 3e-7 * 0.75), 'it may lower one');
});

test('a slice without an estimate, or without a measurement, teaches nothing', () => {
  assert.equal(nextRate(3e-7, 0, 5, true), 3e-7);
  assert.equal(nextRate(3e-7, 8, NaN, true), 3e-7);
  assert.equal(nextRate(3e-7, NaN, 5, true), 3e-7);
});

test('rowsPerTile = clamp(floor(target / (width x cost x rate) / wgY) x wgY, wgY, height)', () => {
  // 2049 wide at cost 8 and the initial rate: a row is 1.6392e-3 ms, so 8 ms hold 4880 rows.
  assert.equal(rowsPerTile(8, 2049, 2049, 8, RATE_INITIAL, 8), 2049, 'the whole grid fits one tile');
  // 8129 wide at cost 64: a row is 0.052 ms, 8 ms hold 153 rows, 152 in whole workgroups.
  assert.equal(rowsPerTile(8, 8129, 8129, 64, RATE_INITIAL, 8), 152);
  assert.equal(rowsPerTile(75, 8129, 8129, 64, RATE_INITIAL, 8), 1440);
  assert.equal(rowsPerTile(8, 8129, 8129, 64, RATE_INITIAL, 16), 144);
  assert.equal(rowsPerTile(8, 8129, 8129, 64, RATE_INITIAL, 1), 153);
  // A tile is at least one workgroup high, whatever the estimate.
  assert.equal(rowsPerTile(1e-6, 513, 513, 8, RATE_INITIAL, 8), 8);
  assert.equal(rowsPerTile(8, 8192, 8192, 1e9, RATE_INITIAL, 4), 4);
  // And never higher than the grid.
  assert.equal(rowsPerTile(1e9, 513, 513, 8, RATE_INITIAL, 8), 513);
  assert.equal(rowsPerTile(8, 1, 1, 8, RATE_INITIAL, 8), 1);
  assert.equal(rowsPerTile(1e-6, 5, 5, 8, RATE_INITIAL, 8), 5);
});

test('a learned rate changes the tiles', () => {
  const slow = rowsPerTile(8, 2049, 2049, 8, RATE_INITIAL * 100, 8);
  assert.equal(slow, 48);
  assert.ok(rowsPerTile(8, 2049, 2049, 8, RATE_INITIAL * 50, 8) > slow);
});

test('maxTileRows: no tile has more rows, in whole workgroups', () => {
  assert.equal(rowsPerTile(1e9, 513, 513, 8, RATE_INITIAL, 8, 16), 16);
  assert.equal(rowsPerTile(1e9, 513, 513, 8, RATE_INITIAL, 8, 20), 16);
  assert.equal(rowsPerTile(1e9, 513, 513, 8, RATE_INITIAL, 8, 1), 8, 'one workgroup is the least');
  assert.equal(rowsPerTile(1e-6, 513, 513, 8, RATE_INITIAL, 8, 64), 8, 'the hook only lowers');
  assert.equal(rowsPerTile(1e9, 513, 513, 8, RATE_INITIAL, 4, 6), 4);
});

test('every tile count is finite: the tile loop cannot run away', () => {
  for (const target of [0, 1e-300, 8, Infinity, NaN]) {
    for (const rate of [0, 1e-300, RATE_INITIAL, Infinity, NaN]) {
      for (const cost of [0, 8, Infinity, NaN]) {
        const rows = rowsPerTile(target, 257, 257, cost, rate, 8);
        assert.ok(Number.isInteger(rows) && rows >= 1 && rows <= 257, `target ${target}, rate ${rate}, cost ${cost}: ${rows}`);
      }
    }
  }
});
