// The resolution ladder (engine.md 1.5) and the project settings (runtime.md 4.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBuildResolution, ladder, ladderLevel } from '../../src/core/graph/ladder.ts';
import { DEFAULT_SETTINGS, normalizeSettings, previewLevelNearest, previewResolution, withBuildResolution } from '../../src/core/graph/settings.ts';
import { newDoc, setSettings, type DocDraft } from '../../src/core/runtime.ts';

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
  assert.deepEqual(DEFAULT_SETTINGS, { terrainSize: 4032, heightRange: 1008, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0 });
  const result = normalizeSettings(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
  assert.equal(result.settings, DEFAULT_SETTINGS);
  assert.deepEqual(result.problems, []);
  assert.equal(previewResolution(DEFAULT_SETTINGS), 1009);
  assert.equal(previewResolution({ ...DEFAULT_SETTINGS, buildResolution: 513, previewLevel: 1 }), 257);
});

test('the default project is one metre per vertex at its build and as steep as the test settings', () => {
  // Unreal's 100 cm per quad, and the 4 : 1 of the 4096 by 1024 every node's defaults are judged on (testing.md 2.1).
  assert.equal(DEFAULT_SETTINGS.terrainSize / (DEFAULT_SETTINGS.buildResolution - 1), 1);
  assert.equal(DEFAULT_SETTINGS.terrainSize / DEFAULT_SETTINGS.heightRange, 4096 / 1024);
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
  assert.equal(result.problems[0], 'setting "terrainSize" is missing; the default 4032 is used');
});

test('an invalid setting takes its default or is clamped, one sentence each', () => {
  const stored = { terrainSize: 0, heightRange: 'tall', seed: -3.5, buildResolution: 4033, previewLevel: 2, seaLevel: null, note: 'kept' };
  const result = normalizeSettings(stored);
  assert.deepEqual(result.settings, { terrainSize: 1, heightRange: 1008, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0, note: 'kept' });
  assert.deepEqual(Object.keys(result.settings), Object.keys(stored));
  assert.deepEqual(result.problems, [
    'setting "terrainSize": 0 is not in 1..1000000; 1 is used',
    'setting "heightRange": "tall" is not a finite number; the default 1008 is used',
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

test('level 0 is a preview level of every build resolution: the preview at the build resolution itself', () => {
  for (const buildResolution of [1009, 2017, 4033, 8129, 129, 513, 2993]) {
    const { settings, problems } = normalizeSettings({ ...DEFAULT_SETTINGS, buildResolution, previewLevel: 0 });
    assert.deepEqual([settings.previewLevel, problems, previewResolution(settings)], [0, [], buildResolution], String(buildResolution));
    const draft = structuredClone(newDoc()) as DocDraft;
    setSettings(draft, { buildResolution, previewLevel: 0 });
    assert.deepEqual([draft.settings.buildResolution, draft.settings.previewLevel], [buildResolution, 0]);
  }
});

test('previewLevelNearest: the level whose resolution is nearest, and of two equally near the coarser', () => {
  // The ladders of 1009, 2017 and 4033 share their levels; that of 8129 lies beside them.
  assert.deepEqual([1009, 2017, 4033, 8129].map((build) => previewLevelNearest(build, 1009)), [0, 1, 2, 3]);
  assert.deepEqual([1009, 2017, 4033, 8129].map((build) => previewLevelNearest(build, 253)), [2, 3, 4, 5]);
  assert.deepEqual([previewLevelNearest(8129, 2033), previewLevelNearest(1009, 2033), previewLevelNearest(4033, 2033)], [2, 0, 1]);
  // Finer than the build itself, and coarser than its last level: the ends of the ladder.
  assert.equal(previewLevelNearest(1009, 8129), 0);
  assert.equal(previewLevelNearest(4033, 2), 6);
  assert.equal(previewLevelNearest(129, 64), 1, '65, of the ladder 129, 65, 33');
  // 513 has 257 and 129; 193 is as far from one as from the other: the coarser, which is the cheaper.
  assert.equal(previewLevelNearest(513, 193), 2);
  assert.equal(previewLevelNearest(513, 194), 1);
  // Every answer is a level the build resolution defines.
  for (const build of [1009, 2017, 4033, 8129, 129, 145, 2993]) {
    for (const resolution of [1, 64, 100, 253, 1009, 3000, 8192, 1e9]) {
      const level = previewLevelNearest(build, resolution);
      assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, buildResolution: build, previewLevel: level }).problems.length, 0, `level ${level} of ${build}`);
    }
  }
});

test('withBuildResolution: another build resolution with the preview resolution kept as near as its ladder allows', () => {
  const settings = (buildResolution: number, previewLevel: number) => ({ ...DEFAULT_SETTINGS, buildResolution, previewLevel });
  // The case of the default project: previews at 1009 stay at 1009, whichever build is chosen, and come back.
  assert.deepEqual(withBuildResolution(settings(4033, 2), 1009), { buildResolution: 1009, previewLevel: 0 });
  assert.deepEqual(withBuildResolution(settings(1009, 0), 4033), { buildResolution: 4033, previewLevel: 2 });
  assert.deepEqual(withBuildResolution(settings(4033, 2), 2017), { buildResolution: 2017, previewLevel: 1 });
  assert.deepEqual(withBuildResolution(settings(4033, 2), 8129), { buildResolution: 8129, previewLevel: 3 }, '1017 is the level of 8129 nearest to 1009');
  assert.deepEqual(withBuildResolution(settings(8129, 3), 4033), { buildResolution: 4033, previewLevel: 2 });
  assert.deepEqual(withBuildResolution(settings(4033, 2), 4033), { buildResolution: 4033, previewLevel: 2 }, 'the same build resolution changes nothing');
  // What setSettings alone does with the same change: the level stays and the previews follow the build.
  const alone = structuredClone(newDoc()) as DocDraft;
  setSettings(alone, { buildResolution: 1009 });
  assert.equal(previewResolution(alone.settings), 253);
  const kept = structuredClone(newDoc()) as DocDraft;
  setSettings(kept, withBuildResolution(kept.settings, 1009));
  assert.deepEqual([kept.settings.buildResolution, kept.settings.previewLevel, previewResolution(kept.settings)], [1009, 0, 1009]);
  // A value that is no build resolution is the one normalizeSettings makes of it, and the level is one of that.
  assert.deepEqual(withBuildResolution(settings(4033, 2), 1000), { buildResolution: 993, previewLevel: 0 });
  assert.deepEqual(withBuildResolution(settings(4033, 2), 3000), { buildResolution: 2993, previewLevel: 2 });
  assert.deepEqual(withBuildResolution(settings(4033, 2), Number.NaN), { buildResolution: 4033, previewLevel: 2 });
  for (const next of [129, 145, 993, 1009, 2993, 8129, 8177, 5, 1e6]) {
    const patch = withBuildResolution(settings(4033, 2), next);
    const draft = structuredClone(newDoc()) as DocDraft;
    setSettings(draft, patch);
    assert.deepEqual([draft.settings.buildResolution, draft.settings.previewLevel], [patch.buildResolution, patch.previewLevel], `setSettings stores the patch for ${next} as it is`);
  }
});
