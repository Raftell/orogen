// The preferences file of runtime.md 8.6, in a temporary folder.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_PREFERENCES } from '../../../../src/core/runtime.ts';
import { BAD_SUFFIX, createPreferenceStore, DEFAULTS, PREFERENCES_FILE, RECENT_MAX, sanitize } from '../../../../src/platform/electron/main/preferences.ts';

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
  // What the damaged file held is kept beside it: key bindings typed by hand are not lost with one stray comma.
  assert.equal(fs.readFileSync(path.join(dir, `${PREFERENCES_FILE}${BAD_SUFFIX}`), 'utf8'), '{ "recent": [');
  // A second damage does not replace the copy of the first.
  fs.writeFileSync(path.join(dir, PREFERENCES_FILE), 'again not json');
  await store.set({ recent: ['/d.orogen'] });
  assert.equal(fs.readFileSync(path.join(dir, `${PREFERENCES_FILE}${BAD_SUFFIX}`), 'utf8'), '{ "recent": [');
  assert.deepEqual((await createPreferenceStore(dir).get()).recent, ['/d.orogen']);
});

test('preferences: a patch is applied to the file as it is now: what another application wrote of other members stays', async () => {
  const dir = folder();
  const first = createPreferenceStore(dir);
  await first.set({ keymap: { 'file.save': 'Mod+Alt+S' }, recent: ['/a.orogen'], panels: { build: { folders: { '/a.orogen': '/out' } } } });
  // A second application on the same file (test mode has no lock): it has read the file, and writes its own member.
  const second = createPreferenceStore(dir);
  await second.get();
  await first.set({ layout: { version: 2 } });
  await second.set({ recent: ['/b.orogen'], panels: { library: { recent: ['filter/blur'] } } });
  const held = JSON.parse(fs.readFileSync(path.join(dir, PREFERENCES_FILE), 'utf8')) as typeof DEFAULTS;
  assert.deepEqual(held.keymap, { 'file.save': 'Mod+Alt+S' }, 'the first application\'s key bindings are still there');
  assert.deepEqual(held.layout, { version: 2 }, 'and what it wrote after the second had read the file');
  assert.deepEqual(held.recent, ['/b.orogen']);
  assert.deepEqual(held.panels, { build: { folders: { '/a.orogen': '/out' } }, library: { recent: ['filter/blur'] } });
  // A file that was removed meanwhile leaves what the process holds.
  fs.rmSync(path.join(dir, PREFERENCES_FILE));
  await first.set({ recent: ['/c.orogen'] });
  assert.deepEqual((await first.get()).keymap, { 'file.save': 'Mod+Alt+S' });
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

test('preferences: the viewport\'s member is kept as it is given, as the layout is', async () => {
  const dir = folder();
  const store = createPreferenceStore(dir);
  const viewport = { version: 1, display: { sunAzimuth: 195, shading: 'clay' }, cameras: { orbit: { yaw: 30, target: [0, 0, 100] }, top: null } };
  await store.set({ viewport });
  assert.deepEqual((await store.get()).viewport, viewport);
  assert.deepEqual((await createPreferenceStore(dir).get()).viewport, viewport, 'and is on disk for the next run');
  await store.set({ viewport: null });
  assert.equal((await store.get()).viewport, null);
  assert.deepEqual([sanitize({}).viewport, sanitize({ viewport: 'anything' }).viewport, sanitize({ viewport: [1, 2] }).viewport], [null, 'anything', [1, 2]]);
});

test('preferences: each panel\'s entry is replaced alone; a patch of one panel keeps the others', async () => {
  const dir = folder();
  const store = createPreferenceStore(dir);
  // Two panels write in the same moment, each knowing its own entry only.
  await Promise.all([
    store.set({ panels: { library: { recent: ['filter/blur'], tab: 'nodes' } } }),
    store.set({ panels: { build: { folders: { '/work/alps.orogen': '/out/alps' } } } }),
  ]);
  assert.deepEqual((await store.get()).panels, { library: { recent: ['filter/blur'], tab: 'nodes' }, build: { folders: { '/work/alps.orogen': '/out/alps' } } });
  // An entry is replaced whole, not merged: its value is the panel's and opaque here.
  await store.set({ panels: { library: { tab: 'examples' } } });
  await store.set({ recent: ['/a.orogen'] });
  const expected = { library: { tab: 'examples' }, build: { folders: { '/work/alps.orogen': '/out/alps' } } };
  assert.deepEqual((await store.get()).panels, expected);
  assert.deepEqual((await createPreferenceStore(dir).get()).panels, expected, 'and is on disk for the next run');
  await store.set({ panels: { library: null, inspector: 'narrow' } });
  assert.deepEqual((await store.get()).panels, { ...expected, library: null, inspector: 'narrow' }, 'null is a value like any other');
});

test('preferences: what is no record of panels takes the default, and a key that is no panel\'s is dropped', async () => {
  assert.deepEqual([sanitize({ panels: ['a'] }).panels, sanitize({ panels: 'library' }).panels, sanitize({ panels: null }).panels], [{}, {}, {}]);
  const kept = sanitize({ panels: JSON.parse(`{ "graph": 1, "": 2, "__proto__": { "polluted": true }, "${'x'.repeat(65)}": 3 }`) }).panels;
  assert.deepEqual(Object.keys(kept), ['graph']);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  const store = createPreferenceStore(folder());
  await store.set({ panels: { graph: { minimap: false } } });
  await store.set({ panels: 'not a record' } as never);
  assert.deepEqual((await store.get()).panels, { graph: { minimap: false } }, 'a patch that is no record changes no entry');
});
