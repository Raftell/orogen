// The resolution ladder (engine.md 1.5) and the project settings (runtime.md 4.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBuildResolution, ladder, ladderLevel } from '../../src/core/graph/ladder.ts';
import { DEFAULT_SETTINGS, normalizeSettings, previewResolution } from '../../src/core/graph/settings.ts';

test('the ladders of the four Unreal sizes are the table of engine.md 1.5', () => {
  assert.deepEqual(ladder(8129), [8129, 4065, 2033, 1017, 509, 255, 128]);
  assert.deepEqual(ladder(4033), [4033, 2017, 1009, 505, 253, 127, 64]);
  assert.deepEqual(ladder(2017), [2017, 1009, 505, 253, 127, 64]);
  assert.deepEqual(ladder(1009), [1009, 505, 253, 127, 64]);
});

test('ctx.ladder: from res downwards, a single element without a coarser level', () => {
  assert.deepEqual(ladder(509), [509, 255, 128]);
  assert.deepEqual(ladder(513), [513, 257, 129, 65, 33]);
  for (const res of [128, 64, 33]) assert.deepEqual(ladder(res), [res]);
});

test('a level is defined while (B - 1) is divisible by 2^k and the level is at least 33', () => {
  assert.equal(ladderLevel(4033, 0), 4033);
  assert.equal(ladderLevel(4033, 6), 64);
  assert.equal(ladderLevel(4033, 7), null);      // 63 is odd
  assert.equal(ladderLevel(129, 2), 33);
  assert.equal(ladderLevel(129, 3), null);       // 17 is below 33
  assert.equal(ladderLevel(4033, -1), null);
  assert.equal(ladderLevel(4033, 1.5), null);
  assert.equal(ladderLevel(4033.5, 0), null);
  assert.equal(ladderLevel(4033, 1e9), null);
});

test('build resolutions: the Unreal sizes, or 129..8192 with (B - 1) divisible by 16', () => {
  for (const b of [1009, 2017, 4033, 8129, 129, 513, 8177]) assert.equal(isBuildResolution(b), true, String(b));
  for (const b of [113, 128, 130, 1000, 8193, 8209, 513.5, NaN, Infinity]) assert.equal(isBuildResolution(b), false, String(b));
});

test('the defaults are those of runtime.md 4.2 and valid', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { terrainSize: 5000, heightRange: 2500, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0 });
  const result = normalizeSettings(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
  assert.equal(result.settings, DEFAULT_SETTINGS);
  assert.deepEqual(result.problems, []);
  assert.equal(previewResolution(DEFAULT_SETTINGS), 1009);
  assert.equal(previewResolution({ ...DEFAULT_SETTINGS, buildResolution: 513, previewLevel: 1 }), 257);
});

test('valid settings come back as the same object, with their order and extra members', () => {
  const stored = { seaLevel: -1, seed: 4294967295, note: 'kept', terrainSize: 1, heightRange: 100000, buildResolution: 129, previewLevel: 0 };
  const result = normalizeSettings(stored);
  assert.equal(result.settings, stored);
  assert.deepEqual(result.problems, []);
});

test('a missing setting takes its default and is reported', () => {
  const result = normalizeSettings({});
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.equal(result.problems.length, 6);
  assert.equal(result.problems[0], 'setting "terrainSize" is missing; the default 5000 is used');
});

test('an invalid setting takes its default or is clamped, one sentence each', () => {
  const stored = { terrainSize: 0, heightRange: 'tall', seed: -3.5, buildResolution: 4033, previewLevel: 2, seaLevel: null, note: 'kept' };
  const result = normalizeSettings(stored);
  assert.deepEqual(result.settings, { terrainSize: 1, heightRange: 2500, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0, note: 'kept' });
  assert.deepEqual(Object.keys(result.settings), Object.keys(stored));
  assert.deepEqual(result.problems, [
    'setting "terrainSize": 0 is not in 1..1000000; 1 is used',
    'setting "heightRange": "tall" is not a finite number; the default 2500 is used',
    'setting "seed": -3.5 is not an integer in 0..4294967295; 0 is used',
    'setting "seaLevel": null is not a finite number; the default 0 is used',
  ]);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, terrainSize: 2e6 }).settings.terrainSize, 1_000_000);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, heightRange: 1e9 }).settings.heightRange, 100_000);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, seed: 2 ** 40 }).settings.seed, 2 ** 32 - 1);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, seed: 7.9 }).settings.seed, 7);
});

test('a build resolution that is none becomes the nearest one', () => {
  const near = (v: unknown): number => normalizeSettings({ ...DEFAULT_SETTINGS, previewLevel: 0, buildResolution: v }).settings.buildResolution;
  assert.equal(near(1000), 993);
  assert.equal(near(1002), 1009);
  assert.equal(near(5), 129);
  assert.equal(near(100000), 8177);
  assert.equal(near('big'), 4033);
  assert.deepEqual(normalizeSettings({ ...DEFAULT_SETTINGS, buildResolution: 1000 }).problems, [
    'setting "buildResolution": 1000 is not a build resolution; 993 is used',
  ]);
});

test('previewLevel is lowered to the largest level the build resolution defines', () => {
  const level = (buildResolution: number, previewLevel: unknown) => normalizeSettings({ ...DEFAULT_SETTINGS, buildResolution, previewLevel });
  assert.equal(level(4033, 6).settings.previewLevel, 6);
  assert.deepEqual(level(4033, 6).problems, []);
  assert.equal(level(4033, 7).settings.previewLevel, 6);
  assert.deepEqual(level(4033, 7).problems, ['setting "previewLevel": level 7 is not defined for build resolution 4033; lowered to 6']);
  assert.equal(level(129, 5).settings.previewLevel, 2);
  assert.equal(level(8129, 1e300).settings.previewLevel, 6);
  assert.equal(level(4033, -1).settings.previewLevel, 0);
  assert.equal(level(4033, 1.7).settings.previewLevel, 1);
  assert.deepEqual(level(4033, 1.7).problems, ['setting "previewLevel": 1.7 is not a ladder level; 1 is used']);
  assert.equal(level(4033, 'two').settings.previewLevel, 2);
});
