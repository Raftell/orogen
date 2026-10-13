// The preferences file of runtime.md 8.6, in a temporary folder.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_PREFERENCES } from '../../../../src/core/runtime.ts';
import { createPreferenceStore, DEFAULTS, PREFERENCES_FILE, RECENT_MAX, sanitize } from '../../../../src/platform/electron/main/preferences.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-platform-preferences-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let folders = 0;
const folder = (): string => path.join(ROOT, `run-${++folders}`);

test('preferences: the GPU defaults are the engine\'s own', () => {
  assert.deepEqual(DEFAULTS.gpu, DEFAULT_PREFERENCES);
});

test('preferences: without a file the defaults are returned, and nothing is written', async () => {
  const dir = folder();
  assert.deepEqual(await createPreferenceStore(dir).get(), DEFAULTS);
  assert.equal(fs.existsSync(dir), false);
});

test('preferences: a patch replaces the members it names and is on disk for the next run', async () => {
  const dir = folder();
  const store = createPreferenceStore(dir);
  await store.set({ recent: ['/a.orogen', '/b.orogen'], keymap: { 'file.save': 'Mod+Alt+S' } });
  await store.set({ gpu: { vramBytes: 8 * 2 ** 30, budgetFraction: 0.5 } });
  const expected = { ...DEFAULTS, recent: ['/a.orogen', '/b.orogen'], keymap: { 'file.save': 'Mod+Alt+S' }, gpu: { vramBytes: 8 * 2 ** 30, budgetFraction: 0.5 } };
  assert.deepEqual(await store.get(), expected);
  assert.deepEqual(await createPreferenceStore(dir).get(), expected);
  assert.deepEqual(fs.readdirSync(dir), [PREFERENCES_FILE], 'no temporary file is left beside it');
});

test('preferences: patches made at once are applied in the order made', async () => {
  const store = createPreferenceStore(folder());
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.set({ layout: { version: n } })));
  assert.deepEqual((await store.get()).layout, { version: 5 });
});

test('preferences: a file that is not JSON gives the defaults and is replaced by the next write', async () => {
  const dir = folder();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PREFERENCES_FILE), '{ "recent": [');
  const store = createPreferenceStore(dir);
  assert.deepEqual(await store.get(), DEFAULTS);
  await store.set({ recent: ['/c.orogen'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, PREFERENCES_FILE), 'utf8')), { ...DEFAULTS, recent: ['/c.orogen'] });
});

test('preferences: a member that is not of its type takes its default', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize({ gpu: { vramBytes: '8 GB', budgetFraction: Number.NaN }, keymap: ['x'], recent: 'a.orogen' }), DEFAULTS);
  assert.deepEqual(sanitize({ gpu: { vramBytes: -1, budgetFraction: 0.4 } }).gpu, { vramBytes: null, budgetFraction: 0.4 });
  assert.deepEqual(sanitize({ keymap: { 'file.save': 'Mod+S', 'edit.undo': 7 } }).keymap, { 'file.save': 'Mod+S' });
  assert.deepEqual(sanitize({ layout: { panels: [1, 2] } }).layout, { panels: [1, 2] });
});

test('preferences: the recent list holds each path once and has an end', () => {
  const many = Array.from({ length: RECENT_MAX + 10 }, (_, i) => `/p${i}.orogen`);
  const kept = sanitize({ recent: ['/p0.orogen', ...many, 3, ''] }).recent;
  assert.equal(kept.length, RECENT_MAX);
  assert.equal(kept[0], '/p0.orogen');
  assert.equal(kept[1], '/p1.orogen');
});

test('preferences: a member the patch does not name, and one that is no preference, changes nothing', async () => {
  const store = createPreferenceStore(folder());
  await store.set({ recent: ['/a.orogen'] });
  await store.set({ unknown: 1 } as never);
  assert.deepEqual(await store.get(), { ...DEFAULTS, recent: ['/a.orogen'] });
});
