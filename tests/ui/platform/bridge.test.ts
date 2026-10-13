// The bridge to the main process (runtime.md 8.6) as the page uses it: project files as text, preferences,
// the stored form of a path, and what the test mode makes of dialogs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PREFERENCES, parseDoc, serializeDoc, type GraphDoc } from '../../../src/core/runtime.ts';
import type { Preferences } from '../../../src/platform/electron/ipc.ts';
import { mountainDoc, OUTPUT, ready, REGISTRY, sentRevision, show, shown, withApp } from './rig.ts';

const FOLDER = path.join(OUTPUT, 'bridge');
fs.mkdirSync(FOLDER, { recursive: true });
const quote = (value: unknown): string => JSON.stringify(value);

test('bridge: a document saved through the bridge reads back equal, and opens as the project of the next launch', async () => {
  const file = path.join(FOLDER, 'saved.orogen');
  fs.rmSync(file, { force: true });
  let text = '';
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    await show(app, mountainDoc().doc);
    // The graph panel fits a project that brings no viewport and keeps the fit in the document's interface state
    // (runtime.md 8.7): the document is whole, and is what a user would save, once that is there.
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.ui.graphViewport !== undefined`);
    text = serializeDoc(await app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`));
    await app.eval(`orogenTest.ctx.platform.writeTextFile(${quote(file)}, ${quote(text)})`);
    const back = await app.eval<string>(`orogenTest.ctx.platform.readTextFile(${quote(file)})`);
    assert.ok(back === text, 'the text read through the bridge is the text written');
    assert.ok(fs.readFileSync(file, 'utf8') === text, 'and it is what the file holds');
    assert.deepEqual(fs.readdirSync(FOLDER).filter((name) => name.includes('.tmp')), [], 'no temporary file is left');
    const parsed = parseDoc(back, REGISTRY);
    assert.deepEqual(parsed.problems, []);
    assert.ok(serializeDoc(parsed.doc) === text, 'the document parsed from it serializes to the same text');
  });

  // The first argument of the application is a project file (testing.md 2.9).
  await withApp({ profile: 'core', open: file }, async (app) => {
    await ready(app);
    await app.waitFor(`orogenTest.ctx.doc.getState().path !== null`);
    assert.equal(await app.eval<string>(`orogenTest.ctx.doc.getState().path`), file);
    assert.equal(await app.eval<string>(`orogenTest.ctx.platform.launchProject`), file);
    assert.ok(serializeDoc(await app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`)) === text, 'the opened document is the saved one');
    await shown(app, await sentRevision(app));
    // And it stays the saved one: the graph shows the viewport the file brought and fits nothing over it.
    await app.eval(`new Promise((resolve) => setTimeout(resolve, 1500))`);
    assert.ok(serializeDoc(await app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`)) === text, 'the opened document is still the saved one when the panels have settled');
  });
});

test('bridge: a failed read or write rejects in the page', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const failure = (call: string): Promise<string> => app.eval<string>(`orogenTest.ctx.platform.${call}.then(() => 'resolved', (e) => String(e.message))`);
    assert.match(await failure(`readTextFile(${quote(path.join(FOLDER, 'none.orogen'))})`), /ENOENT/);
    assert.match(await failure(`readTextFile('relative.orogen')`), /not an absolute file path/);
    assert.match(await failure(`writeTextFile(${quote(path.join(FOLDER, 'no-such-folder', 'a.orogen'))}, 'x')`), /ENOENT/);
  });
});

test('bridge: preferences start at their defaults in the folder of the run and keep what is set', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const first = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(first, { gpu: DEFAULT_PREFERENCES, keymap: {}, layout: null, recent: [] });
    await app.eval(`orogenTest.ctx.platform.setPreferences({ recent: ['/a.orogen'], keymap: { 'file.save': 'Mod+Alt+S' }, layout: { version: 1, panels: ['graph'] } })`);
    const second = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(second, { gpu: DEFAULT_PREFERENCES, keymap: { 'file.save': 'Mod+Alt+S' }, layout: { version: 1, panels: ['graph'] }, recent: ['/a.orogen'] });
  });
});

test('bridge: a path under the project folder is stored relative, any other absolute', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const project = path.join(FOLDER, 'land.orogen');
    const stored = (projectPath: string | null, file: string): Promise<string> =>
      app.eval<string>(`orogenTest.ctx.platform.toProjectPath(${quote(projectPath)}, ${quote(file)})`);
    assert.equal(await stored(project, path.join(FOLDER, 'maps', 'height.png')), 'maps/height.png');
    assert.equal(await stored(project, path.join(OUTPUT, 'height.png')), path.join(OUTPUT, 'height.png'));
    assert.equal(await stored(null, path.join(FOLDER, 'height.png')), path.join(FOLDER, 'height.png'));
  });
});

test('bridge: test mode opens no dialog, and what cannot be seen is not done', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const answers = await app.eval<unknown[]>(`Promise.all([
      orogenTest.ctx.platform.openProjectDialog(),
      orogenTest.ctx.platform.saveProjectDialog(${quote(path.join(FOLDER, 'suggested.orogen'))}),
      orogenTest.ctx.platform.openFileDialog(['png', 'tif']),
      orogenTest.ctx.platform.chooseFolder(),
    ])`);
    assert.deepEqual(answers, [null, null, null, null]);
    // No file manager opens, no power-save blocker is left behind, and a listener can be taken away again.
    await app.eval(`(() => {
      const platform = orogenTest.ctx.platform;
      platform.showInFolder(${quote(FOLDER)});
      platform.setBuildActive(true);
      platform.setBuildActive(false);
      platform.onMenuCommand(() => {})();
      platform.onCloseRequested(() => {})();
    })()`);
  });
});
