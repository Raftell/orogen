// src/app/platform.ts (runtime.md 8.6): typed access to the object the preload script exposes. Here the bridge
// is an object of the test's own under the name the preload script uses (src/platform/electron/ipc.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLATFORM_GLOBAL, type PlatformApi, type Preferences } from '../../../../src/platform/electron/ipc.ts';
import { hasPlatform, platform } from '../../../../src/app/platform.ts';

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
    onMenuCommand: (listener) => { menu.add(listener); return () => void menu.delete(listener); },
    onCloseRequested: () => () => undefined,
    confirmClose: () => said('confirmClose'),
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
  const preferences: Preferences = { gpu: { vramBytes: null, budgetFraction: 0.5 }, keymap: { 'graph.fit': 'Home' }, layout: null, recent: ['/projects/a.orogen'] };
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
