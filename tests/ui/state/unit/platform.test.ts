// src/app/platform.ts (runtime.md 8.6): typed access to the object the preload script exposes. Here the bridge
// is an object of the test's own under the name the preload script uses (src/platform/electron/ipc.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLATFORM_GLOBAL, type PlatformApi, type Preferences } from '../../../../src/platform/electron/ipc.ts';
import { hasPlatform, panelKeep, platform } from '../../../../src/app/platform.ts';

const root = globalThis as { [PLATFORM_GLOBAL]?: PlatformApi };

interface Call { readonly method: string; readonly args: readonly unknown[] }

/** A bridge that records what it is asked. */
function fakeBridge(calls: Call[], preferences: Preferences): PlatformApi {
  const menu = new Set<(commandId: string) => void>();
  const said = (method: string, ...args: unknown[]): void => { calls.push({ method, args }); };
  return {
    gpuProfile: 'core',
    testMode: true,
    launchProject: '/projects/open-me.orogen',
    softwareRendering: false,
    openProjectDialog: async () => { said('openProjectDialog'); return '/projects/a.orogen'; },
    saveProjectDialog: async (suggestedPath) => { said('saveProjectDialog', suggestedPath); return null; },
    openFileDialog: async (extensions) => { said('openFileDialog', extensions); return '/images/height.png'; },
    chooseFolder: async () => { said('chooseFolder'); return '/out'; },
    readTextFile: async (path) => { said('readTextFile', path); return '{"format":"orogen"}'; },
    writeTextFile: async (path, text) => { said('writeTextFile', path, text); },
    toProjectPath: (projectPath, filePath) => { said('toProjectPath', projectPath, filePath); return 'height.png'; },
    getPreferences: async () => { said('getPreferences'); return preferences; },
    setPreferences: async (patch) => { said('setPreferences', patch); },
    setBuildActive: (active) => said('setBuildActive', active),
    showInFolder: (path) => said('showInFolder', path),
    statPath: async (path, projectPath) => { said('statPath', path, projectPath); return { exists: true, isFile: true, size: 12, mtimeMs: 1 }; },
    openExternal: async (url) => { said('openExternal', url); return true; },
    openDocument: async (name) => { said('openDocument', name); return name === 'unreal-import.md'; },
    openBuildFile: async (path) => { said('openBuildFile', path); return false; },
    readRecovery: async () => { said('readRecovery'); return null; },
    writeRecovery: async (record) => { said('writeRecovery', record); },
    onOpenRequested: () => () => undefined,
    onMenuCommand: (listener) => { menu.add(listener); return () => void menu.delete(listener); },
    onCloseRequested: () => () => undefined,
    confirmClose: () => said('confirmClose'),
    restartWithSoftwareRendering: async (project) => { said('restartWithSoftwareRendering', project); return true; },
    // What the main process does when a menu entry is chosen. No member of PlatformApi: reached by the test alone.
    ...{ choose: (commandId: string) => { for (const listener of [...menu]) listener(commandId); } },
  };
}

test('without a preload script the module loads, says so, and a member that is used throws with the reason', () => {
  assert.equal(PLATFORM_GLOBAL, 'orogenPlatform');
  assert.equal(root[PLATFORM_GLOBAL], undefined);
  assert.equal(hasPlatform(), false);
  assert.throws(() => platform.gpuProfile, /platform\.gpuProfile: the preload bridge is missing \(window\.orogenPlatform\)/);
  assert.throws(() => platform.openProjectDialog(), /platform\.openProjectDialog: the preload bridge is missing/);
  assert.equal('readTextFile' in platform, false);
});

test('an async function may return the bridge: it is no promise, with or without a preload script', async () => {
  assert.equal(await (async () => platform)(), platform);
});

test('with the bridge every member is the preload script\'s: values, calls with their arguments and results, subscriptions', async () => {
  const calls: Call[] = [];
  const preferences: Preferences = {
    gpu: { vramBytes: null, budgetFraction: 0.5 }, keymap: { 'graph.fit': 'Home' }, layout: null, recent: ['/projects/a.orogen'], viewport: null, panels: { library: { recent: ['generate/perlin'] } },
  };
  const bridge = fakeBridge(calls, preferences);
  root[PLATFORM_GLOBAL] = bridge;
  try {
    assert.equal(hasPlatform(), true);
    assert.equal('readTextFile' in platform, true);
    assert.deepEqual([platform.gpuProfile, platform.testMode, platform.launchProject], ['core', true, '/projects/open-me.orogen']);

    assert.equal(await platform.openProjectDialog(), '/projects/a.orogen');
    assert.equal(await platform.saveProjectDialog('/projects/b.orogen'), null);
    assert.equal(await platform.openFileDialog(['png', 'r16']), '/images/height.png');
    assert.equal(await platform.chooseFolder(), '/out');
    assert.equal(await platform.readTextFile('/projects/a.orogen'), '{"format":"orogen"}');
    await platform.writeTextFile('/projects/a.orogen', '{}');
    assert.equal(platform.toProjectPath('/projects/a.orogen', '/projects/height.png'), 'height.png');
    assert.equal(await platform.getPreferences(), preferences);
    await platform.setPreferences({ recent: [] });
    platform.setBuildActive(true);
    platform.showInFolder('/out');
    assert.deepEqual(await platform.statPath('heights.png', '/projects/a.orogen'), { exists: true, isFile: true, size: 12, mtimeMs: 1 });
    assert.equal(await platform.openExternal('https://example.com/'), true);
    assert.deepEqual([await platform.openDocument('unreal-import.md'), await platform.openDocument('no-such-page.md')], [true, false]);
    assert.equal(await platform.openBuildFile('/out/Land.report.json'), false);
    platform.confirmClose();
    assert.deepEqual(calls, [
      { method: 'openProjectDialog', args: [] },
      { method: 'saveProjectDialog', args: ['/projects/b.orogen'] },
      { method: 'openFileDialog', args: [['png', 'r16']] },
      { method: 'chooseFolder', args: [] },
      { method: 'readTextFile', args: ['/projects/a.orogen'] },
      { method: 'writeTextFile', args: ['/projects/a.orogen', '{}'] },
      { method: 'toProjectPath', args: ['/projects/a.orogen', '/projects/height.png'] },
      { method: 'getPreferences', args: [] },
      { method: 'setPreferences', args: [{ recent: [] }] },
      { method: 'setBuildActive', args: [true] },
      { method: 'showInFolder', args: ['/out'] },
      { method: 'statPath', args: ['heights.png', '/projects/a.orogen'] },
      { method: 'openExternal', args: ['https://example.com/'] },
      { method: 'openDocument', args: ['unreal-import.md'] },
      { method: 'openDocument', args: ['no-such-page.md'] },
      { method: 'openBuildFile', args: ['/out/Land.report.json'] },
      { method: 'confirmClose', args: [] },
    ]);

    const heard: string[] = [];
    const off = platform.onMenuCommand((commandId) => heard.push(commandId));
    const choose = (bridge as unknown as { choose(commandId: string): void }).choose;
    choose('file.save');
    off();
    choose('file.open');
    assert.deepEqual(heard, ['file.save'], 'the function a subscription returns ends it');
    assert.equal(typeof platform.onCloseRequested(() => undefined), 'function');

    // A member is read when it is used: a function taken off the bridge works without it, as the page's own would.
    const { setBuildActive } = platform;
    setBuildActive(false);
    assert.deepEqual(calls.at(-1), { method: 'setBuildActive', args: [false] });
    assert.throws(() => { (platform as { gpuProfile: string }).gpuProfile = 'max'; }, /read-only/);
  } finally {
    delete root[PLATFORM_GLOBAL];
  }
  assert.equal(hasPlatform(), false);
});

// ---- what a panel keeps (8.6) ----

/** A stand-in for the two calls a panel's entry goes through, with the main process's rule for `panels`: a patch replaces the entries it names. */
function preferenceFile(panels: Record<string, unknown> = {}): { panels: Record<string, unknown>; writes: unknown[]; fail: boolean; api: Pick<PlatformApi, 'getPreferences' | 'setPreferences'> } {
  const file = {
    panels, writes: [] as unknown[], fail: false,
    api: {
      getPreferences: async () => {
        if (file.fail) throw new Error('the file cannot be read');
        return { panels: file.panels } as unknown as Preferences;
      },
      setPreferences: async (patch: Partial<Preferences>) => {
        file.writes.push(patch);
        if (file.fail) throw new Error('the disk is full');
        file.panels = { ...file.panels, ...patch.panels };
      },
    },
  };
  return file;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('panelKeep reads the entry of its panel and writes that entry alone, so two panels never drop each other\'s', async () => {
  const file = preferenceFile({ library: { recent: ['generate/perlin'] }, build: { folders: { '/p/a.orogen': '/out' } } });
  const library = panelKeep('library', file.api, 0);
  const build = panelKeep('build', file.api, 0);
  assert.deepEqual(await library.read(), { recent: ['generate/perlin'] });
  assert.deepEqual(await build.read(), { folders: { '/p/a.orogen': '/out' } });
  assert.equal(await panelKeep('graph', file.api, 0).read(), null, 'a panel that kept nothing reads null');

  library.write({ recent: ['filter/blur', 'generate/perlin'] });
  build.write({ folders: {} });
  await tick();
  assert.deepEqual(file.writes, [{ panels: { library: { recent: ['filter/blur', 'generate/perlin'] } } }, { panels: { build: { folders: {} } } }]);
  assert.deepEqual(file.panels, { library: { recent: ['filter/blur', 'generate/perlin'] }, build: { folders: {} } });
});

test('panelKeep writes once for a burst of changes, with the last value', async () => {
  const file = preferenceFile();
  const keep = panelKeep('library', file.api, 20);
  for (let height = 100; height <= 160; height += 20) keep.write({ detailsHeight: height });
  assert.deepEqual(file.writes, [], 'nothing is written while the value still changes');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(file.writes, [{ panels: { library: { detailsHeight: 160 } } }]);
});

test('a preferences file that cannot be read or written costs a panel its memory and nothing else', async () => {
  const file = preferenceFile({ library: { recent: ['generate/perlin'] } });
  file.fail = true;
  const keep = panelKeep('library', file.api, 0);
  assert.equal(await keep.read(), null);
  const original = console.warn;
  const said: unknown[] = [];
  console.warn = (...args: unknown[]) => { said.push(args[0]); };
  try {
    keep.write({ recent: [] });
    await tick();
    await tick();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(said, ['[orogen] what the library panel keeps could not be saved']);
  // An entry that is no object, and a file of another build without the member, read as nothing kept.
  assert.equal(await panelKeep('library', { getPreferences: async () => ({}) as unknown as Preferences, setPreferences: async () => undefined }, 0).read(), null);
});
