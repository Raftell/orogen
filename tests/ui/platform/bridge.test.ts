// The bridge to the main process (runtime.md 8.6) as the page uses it: project files as text, preferences,
// the stored form of a path, and what the test mode makes of dialogs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PREFERENCES, parseDoc, serializeDoc, type GraphDoc } from '../../../src/core/runtime.ts';
import { MANIFEST_SCHEMA_ID } from '../../../src/export/manifest.ts';
import type { PathStat, Preferences } from '../../../src/platform/electron/ipc.ts';
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
    // A write that fails is told in words that name the file, its folder and what helps, not the system's code and a temporary file (8.6).
    const refused = await failure(`writeTextFile(${quote(path.join(FOLDER, 'no-such-folder', 'a.orogen'))}, 'x')`);
    assert.ok(refused.endsWith(`a.orogen cannot be written: the folder ${path.join(FOLDER, 'no-such-folder')} does not exist. Save the project somewhere else with File > Save As.`), refused);
    assert.ok(!refused.includes('ENOENT') && !refused.includes('.tmp'), refused);
    assert.match(await failure(`writeTextFile('relative.orogen', 'x')`), /not an absolute file path/);

    // What is kept for recovery crosses the bridge and is read back; null removes it; what is no record is refused.
    assert.equal(await app.eval(`orogenTest.ctx.platform.readRecovery()`), null);
    await app.eval(`orogenTest.ctx.platform.writeRecovery({ path: null, text: '{"format":"orogen"}' })`);
    const kept = await app.eval<{ path: string | null; text: string; savedAt: number }>(`orogenTest.ctx.platform.readRecovery()`);
    assert.deepEqual([kept.path, kept.text, kept.savedAt > 1_600_000_000_000], [null, '{"format":"orogen"}', true]);
    assert.match(await failure(`writeRecovery({ path: 'relative', text: 'x' })`), /no project/);
    await app.eval(`orogenTest.ctx.platform.writeRecovery(null)`);
    assert.equal(await app.eval(`orogenTest.ctx.platform.readRecovery()`), null);
  });
});

test('bridge: preferences start at their defaults in the folder of the run and keep what is set', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const first = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(first, { gpu: DEFAULT_PREFERENCES, keymap: {}, layout: null, recent: [], viewport: null, panels: {} });
    await app.eval(`orogenTest.ctx.platform.setPreferences({ recent: ['/a.orogen'], keymap: { 'file.save': 'Mod+Alt+S' }, layout: { version: 1, panels: ['graph'] } })`);
    const second = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(second, {
      gpu: DEFAULT_PREFERENCES, keymap: { 'file.save': 'Mod+Alt+S' }, layout: { version: 1, panels: ['graph'] }, recent: ['/a.orogen'], viewport: null, panels: {},
    });

    // The viewport's member is opaque, as the layout is. Of `panels` a patch replaces the entries it names: two
    // panels that write in one moment keep each other's.
    const viewport = { version: 1, display: { sunAzimuth: 195, shading: 'clay' }, cameras: { orbit: { yaw: 30 } } };
    await app.eval(`Promise.all([
      orogenTest.ctx.platform.setPreferences({ viewport: ${quote(viewport)} }),
      orogenTest.ctx.platform.setPreferences({ panels: { library: { tab: 'examples', recent: ['filter/blur'] } } }),
      orogenTest.ctx.platform.setPreferences({ panels: { build: { folders: { '/work/alps.orogen': '/out/alps' } } } }),
    ])`);
    const third = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(third, {
      ...second, viewport, panels: { library: { tab: 'examples', recent: ['filter/blur'] }, build: { folders: { '/work/alps.orogen': '/out/alps' } } },
    });
  });
});

test('bridge: what a path names, and what the system\'s programs may be asked to open', async () => {
  // A folder that holds a build, by its manifest; and a folder that holds none.
  const built = path.join(FOLDER, 'built');
  const plain = path.join(FOLDER, 'plain');
  for (const dir of [built, plain]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(built, 'Alps.orogen.json'), JSON.stringify({ schema: MANIFEST_SCHEMA_ID, files: [] }));
  fs.writeFileSync(path.join(built, 'AlpsHeight.png'), 'png');
  fs.writeFileSync(path.join(built, 'tool.exe'), 'MZ');
  fs.writeFileSync(path.join(plain, 'Height.png'), 'png');
  fs.writeFileSync(path.join(plain, 'land.orogen'), '{}');

  await withApp({ profile: 'core' }, async (app) => {
    const stat = (file: string, project: string | null = null): Promise<PathStat> => app.eval<PathStat>(`orogenTest.ctx.platform.statPath(${quote(file)}, ${quote(project)})`);
    const png = await stat(path.join(plain, 'Height.png'));
    assert.deepEqual([png.exists, png.isFile, png.size, png.mtimeMs], [true, true, 3, fs.statSync(path.join(plain, 'Height.png')).mtimeMs]);
    assert.deepEqual(await stat('Height.png', path.join(plain, 'land.orogen')), png, 'a path as a document stores it, beside its project file');
    assert.deepEqual(await stat('Gone.png', path.join(plain, 'land.orogen')), { exists: false, isFile: false, size: 0, mtimeMs: 0 });
    assert.deepEqual(await stat('Height.png'), { exists: false, isFile: false, size: 0, mtimeMs: 0 }, 'without a project file a relative path names nothing');
    assert.deepEqual([(await stat(plain)).exists, (await stat(plain)).isFile], [true, false]);
    assert.deepEqual(await app.eval<PathStat>(`orogenTest.ctx.platform.statPath(${quote(path.join(plain, 'Height.png'))})`), png, 'the project path may be left out');

    // Test mode opens nothing (testing.md 2.9); each call answers as it would outside it.
    const asked = (call: string): Promise<boolean> => app.eval<boolean>(`orogenTest.ctx.platform.${call}`);
    assert.deepEqual([
      await asked(`openExternal('https://dev.epicgames.com/documentation/')`), await asked(`openExternal('file:///etc/passwd')`),
      await asked(`openExternal('javascript:alert(1)')`), await asked(`openExternal(${quote(path.join(built, 'AlpsHeight.png'))})`),
    ], [true, false, false, false], 'a web address and nothing else');
    assert.deepEqual([
      await asked(`openDocument('unreal-import.md')`), await asked(`openDocument('images/application.png')`),
      await asked(`openDocument('../../package.json')`), await asked(`openDocument('no-such-page.md')`), await asked(`openDocument(${quote(path.join(built, 'AlpsHeight.png'))})`),
    ], [true, true, false, false, false], 'a page of the documentation the application came with, by its name');
    assert.deepEqual([
      await asked(`openBuildFile(${quote(path.join(built, 'AlpsHeight.png'))})`), await asked(`openBuildFile(${quote(path.join(built, 'Alps.orogen.json'))})`),
      await asked(`openBuildFile(${quote(path.join(built, 'tool.exe'))})`), await asked(`openBuildFile(${quote(path.join(plain, 'Height.png'))})`),
      await asked(`openBuildFile(${quote(built)})`), await asked(`openBuildFile('AlpsHeight.png')`),
    ], [true, true, false, false, false, false], 'a file a build writes, in a folder that holds a build');
    assert.deepEqual(await app.errors(), [], 'a refusal is an answer, not an error');
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
