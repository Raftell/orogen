// The life of a project in the window (runtime.md 4.5, 8.5, 8.6): saved through the bridge as an .orogen file
// and opened again as the same document, the window's title and its mark for unsaved changes, the question
// before they are discarded, the recent projects, and the problems of a file shown as the loader reports them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, serializeDoc, type GraphDoc } from '../../../src/core/runtime.ts';
import type { Preferences } from '../../../src/platform/electron/ipc.ts';
import { appears, capture, docked, exists, key, OUTPUT, PAGE_BACKSTOP_MS, press, quote, ready, run, seedOf, setSeed, settled, vanishes, withApp } from './rig.ts';

const REGISTRY = createRegistry(nodes);
const FOLDER = path.join(OUTPUT, 'project');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

const docOf = (app: Parameters<typeof seedOf>[0]): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
const pathIs = (file: string | null): string => `orogenTest.ctx.doc.getState().path === ${quote(file)}`;
const answerSave = (app: Parameters<typeof seedOf>[0], file: string): Promise<void> => app.eval<void>(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
const answerOpen = (app: Parameters<typeof seedOf>[0], file: string): Promise<void> => app.eval<void>(`void orogenTest.shell.answers.openProjectDialog.push(${quote(file)})`);
const titleBar = (app: Parameters<typeof seedOf>[0]): Promise<string> => app.eval<string>(`shellTest.text('[data-ui="project-title"]')`);

test('project: a project saved through the bridge and opened again is the same document', async (t) => {
  const file = path.join(FOLDER, 'roundtrip.orogen');
  let saved: GraphDoc | null = null;

  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    assert.deepEqual([await app.eval<string>(`document.title`), await titleBar(app)], ['Untitled - Orogen', 'Untitled']);

    // A project with more than the default: a second node, a connection, settings, a group, and what is only a view.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Build a graph', (draft) => {
      const source = Object.keys(draft.nodes)[0];
      draft.nodes.soften = { id: 'soften', type: 'filter/blur', version: 1, position: { x: 260, y: 20 }, params: { radius: 0.01 }, title: 'Soften' };
      draft.edges.wire = { id: 'wire', from: { node: source, port: 'out' }, to: { node: 'soften', port: 'in' } };
      draft.groups.land = { id: 'land', title: 'Land', color: '#335577', rect: { x: -40, y: -40, w: 520, h: 260 } };
      draft.settings.seed = 77;
      draft.settings.terrainSize = 5000;
    })`);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('View', (draft) => {
      draft.ui.view = { height: { node: 'soften', port: 'out' }, locked: true };
      draft.ui.graphViewport = { x: 12, y: -8, zoom: 0.75 };
    }, { undoable: false })`);
    assert.deepEqual([await app.eval<string>(`document.title`), await titleBar(app)], ['Untitled* - Orogen', 'Untitled (unsaved)']);

    // Save As, by its key.
    await answerSave(app, file);
    await key(app, 'KeyS', { ctrl: true, shift: true });
    await app.waitFor(pathIs(file), PAGE_BACKSTOP_MS);
    saved = await docOf(app);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, serializeDoc(saved), 'the file holds the document as serializeDoc writes it');
    const read = parseDoc(text, REGISTRY);
    assert.deepEqual(read.problems, []);
    assert.equal(serializeDoc(read.doc), text);
    assert.deepEqual([await app.eval<string>(`document.title`), await titleBar(app)], ['roundtrip - Orogen', 'roundtrip']);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), false);

    // A change marks the project; Save, by its key, writes the same file again.
    await setSeed(app, 78);
    assert.equal(await app.eval<string>(`document.title`), 'roundtrip* - Orogen');
    await key(app, 'KeyS', { ctrl: true });
    await app.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.seed, 78);
    saved = await docOf(app);
    // Undo to before the save: unsaved again; redo: saved again.
    await run(app, 'edit.undo');
    assert.equal(await app.eval<string>(`document.title`), 'roundtrip* - Orogen');
    await run(app, 'edit.redo');
    assert.equal(await app.eval<string>(`document.title`), 'roundtrip - Orogen');

    // New, then Open: the document that was saved, with nothing to undo and nothing to save.
    await key(app, 'KeyN', { ctrl: true });
    await app.waitFor(pathIs(null), PAGE_BACKSTOP_MS);
    assert.equal(Object.keys((await docOf(app)).nodes).length, 1);
    await answerOpen(app, file);
    await key(app, 'KeyO', { ctrl: true });
    await app.waitFor(pathIs(file), PAGE_BACKSTOP_MS);
    assert.equal(serializeDoc(await docOf(app)), serializeDoc(saved));
    assert.deepEqual(await app.eval<unknown[]>(`(() => { const s = orogenTest.ctx.doc.getState(); return [s.unsaved, s.past.length, s.future.length]; })()`), [false, 0, 0]);
    await settled(app);
    assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().nodes.soften.state`), 'done', 'the opened project is computed');

    // The recent projects are in the preferences file, newest first.
    const preferences = await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`);
    assert.deepEqual(preferences.recent, [file]);
    t.diagnostic(`capture: ${await capture(app, 'project-opened')}`);
  });

  // Another start of the application, with the file on the command line.
  await withApp({ open: file }, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    assert.equal(serializeDoc(await docOf(app)), serializeDoc(saved!));
    assert.deepEqual(await app.eval<unknown[]>(`(() => { const s = orogenTest.ctx.doc.getState(); return [s.path, s.unsaved, document.title]; })()`), [file, false, 'roundtrip - Orogen']);
    assert.equal(await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`), await app.eval<number>(`orogenTest.ctx.doc.getState().engineRevision`));
  });
});

test('project: unsaved changes are asked about before they are discarded', async (t) => {
  const file = path.join(FOLDER, 'kept.orogen');
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const prompt = '[data-dialog="unsaved"]';

    // Nothing unsaved: no question.
    await key(app, 'KeyN', { ctrl: true });
    assert.equal(await exists(app, prompt), false);

    // Cancel: the project and its changes stay.
    await setSeed(app, 5);
    await key(app, 'KeyN', { ctrl: true });
    await appears(app, prompt);
    assert.equal(await app.eval<string>(`shellTest.text('${prompt} .og-dialog-title')`), 'Save the changes to Untitled?');
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('${prompt} .og-dialog-actions button')`), ['Don’t Save', 'Cancel', 'Save']);
    t.diagnostic(`capture: ${await capture(app, 'unsaved-prompt')}`);
    await press(app, `${prompt} [data-action="cancel"]`);
    await vanishes(app, prompt);
    assert.deepEqual([await seedOf(app), await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`)], [5, true]);

    // Escape and the close button are Cancel. Opening asks before its own dialog.
    await key(app, 'KeyO', { ctrl: true });
    await appears(app, prompt);
    await key(app, 'Escape', {}, prompt);
    await vanishes(app, prompt);
    await key(app, 'KeyO', { ctrl: true });
    await appears(app, prompt);
    await press(app, `${prompt} [aria-label="Close"]`);
    await vanishes(app, prompt);
    assert.equal(await seedOf(app), 5);

    // Save, with the save dialog cancelled: nothing is discarded.
    await key(app, 'KeyN', { ctrl: true });
    await appears(app, prompt);
    await press(app, `${prompt} [data-action="save"]`);
    await vanishes(app, prompt);
    assert.deepEqual([await seedOf(app), await app.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), fs.existsSync(file)], [5, true, false]);

    // Save: the changes are in the file, and then the new project is made.
    await answerSave(app, file);
    await key(app, 'KeyN', { ctrl: true });
    await appears(app, prompt);
    await press(app, `${prompt} [data-action="save"]`);
    await app.waitFor(`${pathIs(null)} && orogenTest.ctx.doc.getState().doc.settings.seed === 0`, PAGE_BACKSTOP_MS);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.seed, 5);

    // Don't Save: the changes go.
    await setSeed(app, 6);
    await answerOpen(app, file);
    await key(app, 'KeyO', { ctrl: true });
    await appears(app, prompt);
    await press(app, `${prompt} [data-action="discard"]`);
    await app.waitFor(pathIs(file), PAGE_BACKSTOP_MS);
    assert.equal(await seedOf(app), 5);

    // What is only a view does not make a project unsaved; the build resolution does.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Pan', (draft) => { draft.ui.graphViewport = { x: 5, y: 5, zoom: 1 }; }, { undoable: false })`);
    await key(app, 'KeyN', { ctrl: true });
    await app.waitFor(pathIs(null), PAGE_BACKSTOP_MS);
    assert.equal(await exists(app, prompt), false);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Resolution', (draft) => { draft.settings.buildResolution = 2017; }, { undoable: false })`);
    await key(app, 'KeyN', { ctrl: true });
    await appears(app, prompt);
    await press(app, `${prompt} [data-action="discard"]`);
    await vanishes(app, prompt);
  });
});

test('project: a file with problems opens and they are shown; a file that is no project does not', async (t) => {
  const odd = path.join(FOLDER, 'odd.orogen');
  const foreign = path.join(FOLDER, 'foreign.orogen');
  const text = JSON.stringify({
    format: 'orogen',
    version: 1,
    settings: { terrainSize: 'wide', heightRange: 1008, seed: 3, buildResolution: 1009, previewLevel: 1, seaLevel: 0 },
    nodes: {
      range: { id: 'range', type: 'generate/mountain-range', version: 1, position: { x: 0, y: 0 }, params: {} },
      ghost: { id: 'ghost', type: 'generate/no-such-node', version: 1, position: { x: 240, y: 0 }, params: {} },
    },
    edges: { loose: { id: 'loose', from: { node: 'nobody', port: 'out' }, to: { node: 'ghost', port: 'in' } } },
    groups: {},
    ui: { view: { height: { node: 'ghost', port: 'out' } } },
  }, null, 2);
  fs.writeFileSync(odd, text);
  fs.writeFileSync(foreign, '{ "format": "something else" }');
  const expected = parseDoc(text, REGISTRY).problems;
  assert.ok(expected.length >= 3, 'the file has a bad setting, an unknown node type and a broken edge');

  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);

    await answerOpen(app, odd);
    await run(app, 'file.open');
    await appears(app, '[data-dialog="problems"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-dialog="problems"] .og-dialog-title')`), `odd.orogen was opened with ${expected.length} problems`);
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('[data-dialog="problems"] .og-list-title')`), expected.map((problem) => problem.message));
    assert.deepEqual(
      await app.eval<string[]>(`shellTest.texts('[data-dialog="problems"] .og-list-note')`),
      expected.flatMap((problem) => (problem.nodeId ? [`Node ${problem.nodeId}`] : problem.edgeId ? [`Connection ${problem.edgeId}`] : [])),
    );
    t.diagnostic(`capture: ${await capture(app, 'load-problems')}`);
    // The project is open: the file was read, nothing was deleted from it, and it is not marked unsaved.
    assert.deepEqual(await app.eval<unknown[]>(`(() => { const s = orogenTest.ctx.doc.getState(); return [s.path, s.unsaved, Object.keys(s.doc.nodes), s.doc.settings.terrainSize]; })()`), [odd, false, ['range', 'ghost'], 4032]);
    await press(app, '[data-dialog="problems"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="problems"]');

    // The node of the unknown type fails; the status bar says so and leads to the details.
    await app.waitFor(`orogenTest.ctx.engineState.getState().nodes.ghost?.state === 'error' && orogenTest.ctx.engineState.getState().evaluation === null`, 60_000);
    await appears(app, '[data-status="errors"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-status="errors"]')`), '1 node failed');
    await press(app, '[data-status="errors"]');
    await appears(app, '[data-dialog="errors"]');
    const error = await app.eval<{ title: string; note: string }>(`({
      title: shellTest.text('[data-dialog="errors"] [data-error="node"] .og-list-title'), note: shellTest.text('[data-dialog="errors"] [data-error="node"] .og-list-note'),
    })`);
    assert.match(error.title, /^generate\/no-such-node: /);
    assert.equal(error.note, 'generate/no-such-node, unknown-type');
    t.diagnostic(`capture: ${await capture(app, 'errors')}`);
    await press(app, '[data-dialog="errors"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="errors"]');

    // A file that is no project: the one that is open stays, and the dialog says what the loader said.
    await answerOpen(app, foreign);
    await run(app, 'file.open');
    await appears(app, '[data-dialog="failure"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-dialog="failure"] .og-dialog-title')`), 'foreign.orogen could not be opened');
    assert.ok((await app.eval<string>(`shellTest.text('[data-dialog="failure"] .og-dialog-description')`)).length > 0);
    await press(app, '[data-dialog="failure"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="failure"]');
    assert.equal(await app.eval<string>(`orogenTest.ctx.doc.getState().path`), odd);

    // And one that is not there.
    await answerOpen(app, path.join(FOLDER, 'missing.orogen'));
    await run(app, 'file.open');
    await appears(app, '[data-dialog="failure"]');
    assert.match(await app.eval<string>(`shellTest.text('[data-dialog="failure"] .og-dialog-description')`), /ENOENT|no such file/i);
    await press(app, '[data-dialog="failure"] [data-action="ok"]');
    assert.deepEqual((await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`)).recent, [odd], 'what did not open is no recent project');
  });
});
