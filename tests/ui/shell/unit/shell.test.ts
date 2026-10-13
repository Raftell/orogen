// The shell without a window (runtime.md 8.5, 8.6, 8.8): the life of a project through the bridge, the question
// before unsaved changes are discarded, the recent projects, undo and redo, where the edit commands go, the
// preferences, and what the shell does when the engine or the main process speaks.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addNode, parseDoc, serializeDoc, setParam, setSettings, type DocDraft, type GraphDoc } from '../../../../src/core/runtime.ts';
import { editRoute, SHELL_KEYS, SHELL_MENU, shellCommands } from '../../../../src/app/shell/app-commands.ts';
import { RegistrationError } from '../../../../src/app/shell/commands.ts';
import { defaultDoc, DEFAULT_NODE, recentWith, RECENT_MAX, relocatedFiles } from '../../../../src/app/shell/project.ts';
import { LOG_KEPT, NOTICES_SHOWN } from '../../../../src/app/shell/shell.ts';
import { CAPS, createRig, fakePanels, REGISTRY, run, turn, type Rig } from './_shell.ts';

const edit = (rig: Rig, seed: number): void => rig.doc.getState().transact('Seed', (draft) => setSettings(draft, { seed }));
const seedOf = (rig: Rig): number => rig.doc.getState().doc.settings.seed;
const dialog = (rig: Rig) => rig.shell.state.getState().dialog;

function projectText(change?: (draft: DocDraft) => void): string {
  const draft = structuredClone(defaultDoc(REGISTRY)) as DocDraft;
  change?.(draft);
  return serializeDoc(draft as GraphDoc);
}

// ---- start-up ----

test('the shell starts with the default project: one terrain, shown, saved nowhere and with nothing to save', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  const state = rig.doc.getState();
  const nodes = Object.values(state.doc.nodes);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.type, DEFAULT_NODE);
  assert.deepEqual(state.doc.ui.view, { height: { node: nodes[0]!.id, port: REGISTRY.get(DEFAULT_NODE)!.outputs[0]!.name } });
  assert.deepEqual([state.path, state.unsaved, state.past.length], [null, false, 0]);
  assert.equal(dialog(rig), null);
});

test('the project given at launch is opened, and one that cannot be read leaves the default project and says why', async () => {
  const opened = createRig({ launchProject: '/work/alps.orogen' });
  opened.platform.files.set('/work/alps.orogen', projectText((draft) => setSettings(draft, { seed: 41 })));
  await opened.shell.project.start();
  assert.deepEqual([opened.doc.getState().path, seedOf(opened), opened.doc.getState().unsaved], ['/work/alps.orogen', 41, false]);
  assert.deepEqual(opened.shell.state.getState().preferences.recent, ['/work/alps.orogen']);

  const missing = createRig({ launchProject: '/work/gone.orogen' });
  await missing.shell.project.start();
  assert.equal(missing.doc.getState().path, null);
  assert.equal(Object.keys(missing.doc.getState().doc.nodes).length, 1, 'the default project is there instead');
  assert.deepEqual(dialog(missing), { kind: 'failure', title: 'gone.orogen could not be opened', message: "ENOENT: no such file or directory, open '/work/gone.orogen'" });
});

test('the registry of the shell holds the default keys of the contract, and every key and menu entry names a command', () => {
  const rig = createRig();
  const key = (binding: { key: string; command: string }): string => `${binding.key} ${binding.command}`;
  // runtime.md 8.8, the rows of scope global.
  for (const row of [
    'Mod+N file.new', 'Mod+O file.open', 'Mod+S file.save', 'Mod+Shift+S file.saveAs', 'Mod+Z edit.undo', 'Mod+Shift+Z edit.redo', 'Mod+Y edit.redo',
    'Mod+Shift+P view.commandPalette', 'F1 view.commandPalette', 'Backquote engine.togglePause', 'Mod+B build.start', 'F6 viewport.toggleTop',
  ]) assert.ok(SHELL_KEYS.map(key).includes(row), row);
  assert.ok(SHELL_KEYS.every((binding) => binding.scope === 'global'));
  const ids = rig.shell.commands.commands.map((command) => command.def.id);
  for (const id of [
    'file.new', 'file.open', 'file.openRecent', 'file.save', 'file.saveAs', 'edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete',
    'edit.selectAll', 'edit.preferences', 'view.commandPalette', 'view.resetLayout', 'engine.togglePause', 'build.start',
  ]) assert.ok(ids.includes(id), id);
  assert.ok(SHELL_MENU.every((entry) => ids.includes(entry.command)));
  assert.deepEqual(rig.shell.menus().map((menu) => menu.title), ['File', 'Edit', 'View', 'Engine']);
  assert.equal(ids.includes('view.controlGallery'), false, 'the gallery of controls is no command of the product');
  assert.equal(createRig({ testMode: true }).shell.commands.get('view.controlGallery')?.owner, 'shell');
});

test('a panel whose commands contradict the shell stops start-up with both owners named', () => {
  assert.throws(
    () => createRig({ panels: fakePanels({ graph: [{ id: 'graph.fit', title: 'Fit' }, { id: 'graph.fit', title: 'Fit Again' }].map((c) => ({ ...c, run: () => undefined })) }) }),
    (thrown: unknown) => thrown instanceof RegistrationError && /"graph\.fit" is declared twice: by graph and by graph/.test(thrown.message),
  );
  const noBuild = fakePanels().map((panel) => (panel.id === 'build' ? { ...panel, commands: [], menu: [] } : panel));
  assert.throws(() => createRig({ panels: noBuild }), /shell binds Mod\+B to "build\.start", which nobody declares/);
});

// ---- save, open, new ----

test('save asks where when the project has no file, writes the .orogen text, and the project is saved', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 7);
  assert.equal(rig.doc.getState().unsaved, true);

  await run(rig, 'file.save');
  assert.deepEqual(rig.platform.asked, ['save:'], 'a cancelled dialog saves nothing');
  assert.deepEqual([rig.doc.getState().path, rig.doc.getState().unsaved, rig.platform.files.size], [null, true, 0]);

  rig.platform.answers.save.push('/work/alps.orogen');
  await run(rig, 'file.save');
  assert.deepEqual([rig.doc.getState().path, rig.doc.getState().unsaved], ['/work/alps.orogen', false]);
  const written = rig.platform.files.get('/work/alps.orogen')!;
  assert.equal(written, serializeDoc(rig.doc.getState().doc));
  assert.equal(parseDoc(written, REGISTRY).doc.settings.seed, 7);
  assert.deepEqual(rig.shell.state.getState().preferences.recent, ['/work/alps.orogen']);
  assert.deepEqual(rig.platform.preferences.recent, ['/work/alps.orogen'], 'and the recent projects are in the preferences file');

  edit(rig, 8);
  rig.platform.asked.length = 0;
  await run(rig, 'file.save');
  assert.deepEqual(rig.platform.asked, [], 'a project that has a file is saved to it without a question');
  assert.equal(parseDoc(rig.platform.files.get('/work/alps.orogen')!, REGISTRY).doc.settings.seed, 8);
  assert.equal(rig.doc.getState().unsaved, false);
});

test('save as suggests the current file and moves the project to the new one', async () => {
  const rig = createRig({ launchProject: '/work/alps.orogen' });
  rig.platform.files.set('/work/alps.orogen', projectText());
  await rig.shell.project.start();
  rig.platform.answers.save.push('/work/andes.orogen');
  await run(rig, 'file.saveAs');
  assert.deepEqual(rig.platform.asked, ['save:/work/alps.orogen']);
  assert.equal(rig.doc.getState().path, '/work/andes.orogen');
  assert.ok(rig.platform.files.has('/work/andes.orogen'));
  assert.deepEqual(rig.shell.state.getState().preferences.recent, ['/work/andes.orogen', '/work/alps.orogen']);
});

test('a project that changes while its file is written is written again, and stays unsaved when it never stands still', async () => {
  /** A bridge whose writes are each overtaken by an edit, the first `overtaken` of them: a drag that goes on. */
  const overtaking = async (overtaken: number): Promise<{ rig: Rig; writes: number[] }> => {
    const rig = createRig();
    await rig.shell.project.start();
    edit(rig, 10);
    const writes: number[] = [];
    const write = rig.platform.writeTextFile;
    rig.platform.writeTextFile = async (file, text) => {
      await write(file, text);
      writes.push(parseDoc(text, REGISTRY).doc.settings.seed);
      if (writes.length <= overtaken) edit(rig, 10 + writes.length);
    };
    rig.platform.answers.save.push('/work/alps.orogen');
    return { rig, writes };
  };

  // One edit during the first write: the second write holds it, and the project is saved.
  const once = await overtaking(1);
  assert.equal(await once.rig.shell.project.save(), true);
  assert.deepEqual(once.writes, [10, 11]);
  assert.deepEqual([once.rig.doc.getState().unsaved, once.rig.doc.getState().path, seedOf(once.rig)], [false, '/work/alps.orogen', 11]);
  assert.equal(parseDoc(once.rig.platform.files.get('/work/alps.orogen')!, REGISTRY).doc.settings.seed, 11);
  assert.deepEqual(once.rig.shell.state.getState().notices, []);

  // An edit during every write: the file is behind, the project says that it is not saved, and the save says so.
  const always = await overtaking(Infinity);
  assert.equal(await always.rig.shell.project.save(), false, 'what was to follow the save does not happen');
  assert.deepEqual(always.writes, [10, 11, 12], 'the file is written again, three times at the most');
  assert.deepEqual([always.rig.doc.getState().unsaved, always.rig.doc.getState().path, seedOf(always.rig)], [true, '/work/alps.orogen', 13]);
  assert.deepEqual(always.rig.shell.state.getState().notices.map((notice) => [notice.level, notice.message]), [
    ['warning', 'alps.orogen was written while the project changed and lacks the last changes: save again'],
  ]);
  // The window is not closed over it: "Save" in the question about unsaved changes saves, and that save is not whole either.
  always.rig.platform.requestClose();
  await turn();
  assert.deepEqual(dialog(always.rig), { kind: 'unsaved', project: 'alps' });
  always.rig.shell.answerUnsaved('save');
  await turn();
  assert.deepEqual([always.rig.platform.confirmed, always.rig.doc.getState().unsaved], [0, true]);
  // The project stands still: the next save is whole.
  always.rig.platform.writeTextFile = async (file, text) => void always.rig.platform.files.set(file, text);
  assert.equal(await always.rig.shell.project.save(), true);
  assert.deepEqual([always.rig.doc.getState().unsaved, parseDoc(always.rig.platform.files.get('/work/alps.orogen')!, REGISTRY).doc.settings.seed], [false, seedOf(always.rig)]);
});

test('a file that cannot be written leaves the project unsaved and says why', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 3);
  rig.platform.answers.save.push('/readonly/alps.orogen');
  rig.platform.failNext = 'EACCES: permission denied';
  await run(rig, 'file.save');
  assert.deepEqual([rig.doc.getState().path, rig.doc.getState().unsaved], [null, true]);
  assert.deepEqual(dialog(rig), { kind: 'failure', title: 'alps.orogen could not be saved', message: 'EACCES: permission denied' });
  assert.deepEqual(rig.shell.state.getState().preferences.recent, []);
});

test('open reads a project through the bridge, and a project that is saved and opened again is the same document', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  rig.doc.getState().transact('Add', (draft) => {
    const id = addNode(draft, REGISTRY, 'filter/blur', { x: 240, y: 40 });
    setParam(draft, REGISTRY, id, 'radius', 0.02);
    setSettings(draft, { seed: 99, terrainSize: 5000 });
  });
  const before = rig.doc.getState().doc;
  rig.platform.answers.save.push('/work/roundtrip.orogen');
  await run(rig, 'file.save');

  await run(rig, 'file.new');
  assert.equal(Object.keys(rig.doc.getState().doc.nodes).length, 1);
  rig.platform.answers.open.push('/work/roundtrip.orogen');
  await run(rig, 'file.open');
  const after = rig.doc.getState();
  assert.equal(serializeDoc(after.doc), serializeDoc(before));
  assert.deepEqual([after.path, after.unsaved, after.past.length, dialog(rig)], ['/work/roundtrip.orogen', false, 0, null]);
});

test('a project that opens with problems is open, and its problems are shown as the loader reports them', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  const text = projectText((draft) => {
    (draft.nodes as Record<string, unknown>).ghost = { id: 'ghost', type: 'generate/no-such-node', version: 1, position: { x: 0, y: 0 }, params: {} };
    (draft.settings as { terrainSize: unknown }).terrainSize = 'wide';
  });
  rig.platform.files.set('/work/odd.orogen', text);
  rig.platform.answers.open.push('/work/odd.orogen');
  await run(rig, 'file.open');
  assert.equal(rig.doc.getState().path, '/work/odd.orogen');
  const shown = dialog(rig);
  assert.ok(shown?.kind === 'problems' && shown.file === '/work/odd.orogen');
  assert.deepEqual(shown.problems, parseDoc(text, REGISTRY).problems);
  assert.ok(shown.problems.length >= 2 && shown.problems.some((problem) => problem.nodeId === 'ghost'));
});

test('a file that is no project is not opened: the project that was open stays, and the dialog says what the loader said', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 5);
  rig.doc.getState().markSaved('/work/kept.orogen');
  for (const [file, text, pattern] of [
    ['/work/notes.orogen', 'not json at all', /./],
    ['/work/newer.orogen', JSON.stringify({ format: 'orogen', version: 99 }), /newer version of Orogen/],
    ['/work/other.orogen', JSON.stringify({ format: 'gaea' }), /./],
  ] as const) {
    rig.platform.files.set(file, text);
    rig.platform.answers.open.push(file);
    await run(rig, 'file.open');
    const shown = dialog(rig);
    assert.ok(shown?.kind === 'failure', file);
    assert.equal(shown.title, `${file.slice('/work/'.length)} could not be opened`);
    assert.match(shown.message, pattern);
    assert.deepEqual([rig.doc.getState().path, seedOf(rig)], ['/work/kept.orogen', 5]);
    rig.shell.closeDialog();
  }
  assert.equal(rig.shell.state.getState().preferences.recent.length, 0, 'what did not open is no recent project');
});

// ---- unsaved changes ----

test('new, open and closing the window ask before unsaved changes are discarded', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 11);

  // Cancel: nothing happens.
  await run(rig, 'file.new');
  assert.deepEqual(dialog(rig), { kind: 'unsaved', project: 'Untitled' });
  rig.shell.answerUnsaved('cancel');
  await turn();
  assert.deepEqual([dialog(rig), seedOf(rig), rig.doc.getState().unsaved], [null, 11, true]);

  // Closing the dialog is cancelling.
  await run(rig, 'file.open');
  assert.equal(dialog(rig)?.kind, 'unsaved');
  rig.shell.closeDialog();
  await turn();
  assert.deepEqual([seedOf(rig), rig.platform.asked], [11, []], 'the open dialog was never reached');

  // Discard: the changes go.
  await run(rig, 'file.new');
  rig.shell.answerUnsaved('discard');
  await turn();
  assert.deepEqual([seedOf(rig), rig.doc.getState().unsaved, rig.doc.getState().past.length], [0, false, 0]);

  // The window: it closes only when the question is answered with something other than cancel.
  edit(rig, 12);
  rig.platform.requestClose();
  await turn();
  assert.equal(dialog(rig)?.kind, 'unsaved');
  assert.equal(rig.platform.confirmed, 0);
  rig.shell.answerUnsaved('cancel');
  await turn();
  assert.equal(rig.platform.confirmed, 0);
  rig.platform.requestClose();
  await turn();
  rig.shell.answerUnsaved('discard');
  await turn();
  assert.equal(rig.platform.confirmed, 1);
});

test('answering "save" saves first, and what follows happens only when the save did', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 21);

  // The save is cancelled in its own dialog: the new project is not made.
  await run(rig, 'file.new');
  rig.shell.answerUnsaved('save');
  await turn();
  assert.deepEqual([seedOf(rig), rig.doc.getState().unsaved, rig.platform.asked], [21, true, ['save:']]);

  rig.platform.answers.save.push('/work/kept.orogen');
  await run(rig, 'file.new');
  rig.shell.answerUnsaved('save');
  await turn();
  assert.equal(parseDoc(rig.platform.files.get('/work/kept.orogen')!, REGISTRY).doc.settings.seed, 21);
  assert.deepEqual([seedOf(rig), rig.doc.getState().path, rig.doc.getState().unsaved], [0, null, false]);
});

test('a window whose project has nothing unsaved closes without a question', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  rig.platform.requestClose();
  await turn();
  assert.deepEqual([dialog(rig), rig.platform.confirmed], [null, 1]);
  await run(rig, 'file.exit');
  assert.equal(rig.closed, 1, 'Exit asks the window to close, which asks the page');
});

test('file commands run one after another, in the order given', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  edit(rig, 31);
  rig.platform.answers.save.push('/work/first.orogen');
  rig.platform.answers.open.push('/work/first.orogen');
  rig.shell.runner.run('file.save');
  rig.shell.runner.run('file.open');
  rig.shell.runner.run('file.saveAs');
  await turn();
  assert.deepEqual(rig.platform.asked, ['save:', 'open', 'save:/work/first.orogen']);
  assert.deepEqual([rig.doc.getState().path, seedOf(rig), dialog(rig)], ['/work/first.orogen', 31, null]);
});

// ---- recent projects ----

test('recent projects are kept newest first, each once, and the list has an end', () => {
  assert.deepEqual(recentWith(['/a', '/b', '/c'], '/b'), ['/b', '/a', '/c']);
  assert.deepEqual(recentWith([], '/a'), ['/a']);
  const many = Array.from({ length: 40 }, (_, index) => `/p${index}`);
  const kept = recentWith(many, '/new');
  assert.equal(kept.length, RECENT_MAX);
  assert.equal(kept[0], '/new');
});

test('a recent project is opened by its path, and the list can be cleared', async () => {
  const rig = createRig({ preferences: { recent: ['/work/a.orogen', '/work/b.orogen'] } });
  await rig.shell.project.start();
  rig.platform.files.set('/work/b.orogen', projectText((draft) => setSettings(draft, { seed: 2 })));
  assert.equal(rig.shell.runner.enabled('file.openRecent'), true);
  await run(rig, 'file.openRecent');
  assert.equal(rig.shell.state.getState().palette, 'recent');
  rig.shell.closePalette();
  assert.equal(await rig.shell.project.openPath('/work/b.orogen'), true);
  assert.deepEqual([rig.doc.getState().path, seedOf(rig)], ['/work/b.orogen', 2]);
  assert.deepEqual(rig.shell.state.getState().preferences.recent, ['/work/b.orogen', '/work/a.orogen']);

  await run(rig, 'file.clearRecent');
  assert.deepEqual(rig.platform.preferences.recent, []);
  assert.equal(rig.shell.runner.enabled('file.openRecent'), false);
  assert.equal(rig.shell.runner.enabled('file.clearRecent'), false);
});

// ---- files beside the project ----

test('saving a project under another folder keeps its files: a path is stored relative to the project file where it lies under its folder', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  let inside = '';
  let outside = '';
  rig.doc.getState().transact('Import', (draft) => {
    inside = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 200 });
    outside = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 400 });
    setParam(draft, REGISTRY, inside, 'file', '/work/alps/maps/height.png');
    setParam(draft, REGISTRY, outside, 'file', '/shared/base.png');
  });
  const fileOf = (id: string): unknown => rig.doc.getState().doc.nodes[id]!.params.file;

  rig.platform.answers.save.push('/work/alps/alps.orogen');
  await run(rig, 'file.save');
  assert.deepEqual([fileOf(inside), fileOf(outside)], ['maps/height.png', '/shared/base.png']);
  assert.equal(rig.doc.getState().unsaved, false, 'the paths changed with the save, and the project is saved');
  const saved = parseDoc(rig.platform.files.get('/work/alps/alps.orogen')!, REGISTRY).doc;
  assert.deepEqual([saved.nodes[inside]!.params.file, saved.nodes[outside]!.params.file], ['maps/height.png', '/shared/base.png'], 'the file holds the paths as they are stored');

  rig.platform.answers.save.push('/work/andes/andes.orogen');
  await run(rig, 'file.saveAs');
  assert.deepEqual([fileOf(inside), fileOf(outside)], ['/work/alps/maps/height.png', '/shared/base.png'], 'no longer under the project folder: absolute');
  rig.platform.answers.save.push('/work/top.orogen');
  await run(rig, 'file.saveAs');
  assert.deepEqual([fileOf(inside), fileOf(outside)], ['alps/maps/height.png', '/shared/base.png']);
  assert.equal(rig.doc.getState().unsaved, false);

  assert.deepEqual(relocatedFiles(rig.doc.getState().doc, REGISTRY, '/work/top.orogen', '/work/top.orogen', rig.platform.toProjectPath), [], 'the same place moves nothing');
});

// ---- undo, redo, pause ----

test('undo and redo are commands that are enabled while there is something to undo or redo', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  assert.deepEqual([rig.shell.runner.enabled('edit.undo'), rig.shell.runner.enabled('edit.redo')], [false, false]);
  edit(rig, 1);
  rig.doc.getState().transact('Size', (draft) => setSettings(draft, { terrainSize: 5000 }));
  await run(rig, 'edit.undo');
  assert.deepEqual([seedOf(rig), rig.doc.getState().doc.settings.terrainSize], [1, 4032]);
  assert.deepEqual([rig.shell.runner.enabled('edit.undo'), rig.shell.runner.enabled('edit.redo')], [true, true]);
  await run(rig, 'edit.undo');
  assert.deepEqual([seedOf(rig), rig.doc.getState().unsaved], [0, false], 'back at what was loaded, nothing is unsaved');
  await run(rig, 'edit.undo');
  await run(rig, 'edit.redo');
  await run(rig, 'edit.redo');
  assert.deepEqual([seedOf(rig), rig.doc.getState().doc.settings.terrainSize, rig.shell.runner.enabled('edit.redo')], [1, 5000, false]);
});

test('pause is a state of the shell that the engine is told', async () => {
  const rig = createRig();
  await run(rig, 'engine.togglePause');
  assert.equal(rig.shell.state.getState().paused, true);
  await run(rig, 'engine.togglePause');
  rig.shell.setPaused(false);
  assert.deepEqual(rig.engine.calls.filter(([name]) => name === 'setPaused'), [['setPaused', true], ['setPaused', false]]);
});

// ---- the edit commands ----

test('an edit command goes to the text field that has the focus, else to the focused panel', () => {
  const has = (...ids: string[]) => (id: string): boolean => ids.includes(id);
  assert.deepEqual(editRoute('copy', { textField: true, focusedPanel: 'graph', has: has('graph.copy') }), { to: 'text-field' });
  assert.deepEqual(editRoute('delete', { textField: false, focusedPanel: 'graph', has: has('graph.delete') }), { to: 'command', id: 'graph.delete' });
  assert.deepEqual(editRoute('selectAll', { textField: false, focusedPanel: 'graph', has: has('graph.selectAll') }), { to: 'command', id: 'graph.selectAll' });
  // Without a command of the panel, cut, copy and paste are the DOM clipboard events (8.8 rule 3).
  assert.deepEqual(editRoute('copy', { textField: false, focusedPanel: 'graph', has: has() }), { to: 'clipboard-event', panel: 'graph' });
  assert.deepEqual(editRoute('paste', { textField: false, focusedPanel: 'viewport', has: has() }), { to: 'clipboard-event', panel: 'viewport' });
  assert.equal(editRoute('delete', { textField: false, focusedPanel: 'viewport', has: has('graph.delete') }), null);
  assert.equal(editRoute('selectAll', { textField: false, focusedPanel: 'inspector', has: has() }), null);
  assert.equal(editRoute('copy', { textField: false, focusedPanel: null, has: has('graph.copy') }), null);
});

test('the edit commands of the shell do what the route says', async () => {
  const deleted: string[] = [];
  const rig = createRig({ panels: fakePanels({ graph: [{ id: 'graph.delete', title: 'Delete Nodes', run: () => { deleted.push('graph'); } }] }) });
  assert.equal(rig.shell.runner.enabled('edit.delete'), false, 'no panel has the focus');
  rig.ui.setState({ focusedPanel: 'graph' });
  assert.equal(rig.shell.runner.enabled('edit.delete'), true);
  await run(rig, 'edit.delete');
  await run(rig, 'edit.copy');
  await run(rig, 'edit.selectAll');
  assert.deepEqual([deleted, rig.edits], [['graph'], ['event:copy:graph']]);

  rig.ui.setState({ focusedPanel: 'viewport' });
  assert.equal(rig.shell.runner.enabled('edit.delete'), false);
  await run(rig, 'edit.paste');
  rig.textField = true;
  for (const action of ['cut', 'copy', 'paste', 'delete', 'selectAll']) await run(rig, `edit.${action}`);
  assert.deepEqual(rig.edits, ['event:copy:graph', 'event:paste:viewport', 'field:cut', 'field:copy', 'field:paste', 'field:delete', 'field:selectAll']);
  assert.deepEqual(deleted, ['graph']);
});

// ---- preferences and keys ----

test('a preference is in force, in the engine and in the file at once', async () => {
  const rig = createRig();
  rig.shell.setPreferences({ gpu: { vramBytes: 8 * 2 ** 30, budgetFraction: 0.7 } });
  await turn();
  assert.deepEqual(rig.shell.state.getState().preferences.gpu, { vramBytes: 8 * 2 ** 30, budgetFraction: 0.7 });
  assert.deepEqual(rig.platform.preferences.gpu, { vramBytes: 8 * 2 ** 30, budgetFraction: 0.7 });
  assert.deepEqual(rig.engine.calls.at(-1), ['setPreferences', { vramBytes: 8 * 2 ** 30, budgetFraction: 0.7 }]);
  const calls = rig.engine.calls.length;
  rig.shell.setPreferences({ layout: { version: 1, dock: {} } });
  assert.equal(rig.engine.calls.length, calls, 'the engine hears of its own preferences only');
  assert.deepEqual(rig.platform.preferences.layout, { version: 1, dock: {} });
});

test('the keymap follows Preferences.keymap, and so do the keys the menus and tooltips show', () => {
  const rig = createRig();
  const first = rig.shell.keymap();
  assert.equal(rig.shell.keymap(), first, 'the same keymap until a key changes');
  assert.equal(rig.shell.services.keyLabel('file.save'), 'Ctrl+S');
  assert.equal(rig.shell.services.keyLabel('edit.redo'), 'Ctrl+Shift+Z');
  assert.equal(rig.shell.services.keyLabel('file.exit'), null);
  assert.equal(rig.shell.services.commandTitle('file.saveAs'), 'Save As…');
  assert.equal(rig.shell.services.commandTitle('nobody.knows'), null);

  rig.shell.setPreferences({ keymap: { 'file.save': 'Mod+Alt+S', 'engine.togglePause': 'F9' } });
  assert.notEqual(rig.shell.keymap(), first);
  assert.equal(rig.shell.services.keyLabel('file.save'), 'Ctrl+Alt+S');
  assert.equal(rig.shell.keymap().resolve('Mod+S', { focusedPanel: null, textField: false }), null);
  assert.equal(rig.shell.keymap().resolve('F9', { focusedPanel: 'graph', textField: true }), 'engine.togglePause');
  const save = rig.shell.menus().find((menu) => menu.title === 'File')!.items.find((item) => item.kind === 'command' && item.command === 'file.save');
  assert.deepEqual(save, { kind: 'command', command: 'file.save', title: 'Save', key: 'Mod+Alt+S' });
});

test('preferences that cannot be written are said in the notification area', async () => {
  const rig = createRig();
  rig.platform.setPreferences = async () => { throw new Error('disk full'); };
  rig.shell.setPreferences({ recent: ['/a.orogen'] });
  await turn();
  const notices = rig.shell.state.getState().notices;
  assert.deepEqual(notices.map((notice) => [notice.level, notice.message, notice.detail]), [['error', 'The preferences could not be saved', 'disk full']]);
});

// ---- the palette and the dialogs ----

test('the palette and the dialogs are states of the shell that commands open', async () => {
  const rig = createRig({ testMode: true });
  await run(rig, 'view.commandPalette');
  assert.equal(rig.shell.state.getState().palette, 'commands');
  await run(rig, 'edit.preferences');
  assert.deepEqual([dialog(rig), rig.shell.state.getState().palette], [{ kind: 'preferences' }, null], 'a dialog closes the palette');
  await run(rig, 'view.showErrors');
  assert.deepEqual(dialog(rig), { kind: 'errors' });
  await run(rig, 'view.controlGallery');
  assert.deepEqual(dialog(rig), { kind: 'gallery' });
  rig.shell.closeDialog();
  assert.equal(dialog(rig), null);
  const resets = rig.shell.state.getState().layoutResets;
  await run(rig, 'view.resetLayout');
  assert.equal(rig.shell.state.getState().layoutResets, resets + 1);
});

// ---- the engine and the main process ----

test('what the engine reports beside its state reaches the notification area and the log', () => {
  const rig = createRig();
  rig.engine.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 2 ** 30 });
  assert.deepEqual(rig.shell.state.getState().notices, []);
  rig.engine.emit({ type: 'engine-error', message: 'A slice ran for 2100 ms', fatal: false });
  rig.engine.emit({ type: 'engine-error', message: 'A slice ran for 2100 ms', fatal: false });
  rig.engine.emit({ type: 'device-lost', reason: 'unknown', message: 'Device was destroyed.' });
  rig.engine.emit({ type: 'engine-error', message: 'No adapter', fatal: true });
  const state = rig.shell.state.getState();
  assert.deepEqual(state.notices.map((notice) => [notice.level, notice.message, notice.count]), [
    ['warning', 'A slice ran for 2100 ms', 2],
    ['warning', 'The graphics device was lost and is being recovered', 1],
    ['error', 'The engine stopped: No adapter', 1],
  ]);
  assert.equal(state.log.length, 4, 'the log holds every one');
  assert.equal(state.log[0]!.time, 1000);
  assert.equal(rig.engineState.getState().device.state, 'failed');
  assert.equal(rig.shell.runner.enabled('engine.retryDevice'), true);
  rig.shell.runner.run('engine.retryDevice');
  assert.deepEqual([rig.engine.calls.at(-1), rig.restarts], [['retryDevice'], 0], 'an engine that had a device recovers in place');

  rig.shell.dismissNotice(state.notices[0]!.id);
  assert.equal(rig.shell.state.getState().notices.length, 2);
  for (let index = 0; index < LOG_KEPT + 20; index++) rig.shell.notify({ level: 'info', message: `Message ${index}` });
  assert.equal(rig.shell.state.getState().notices.length, NOTICES_SHOWN);
  assert.equal(rig.shell.state.getState().log.length, LOG_KEPT);
});

test('an engine that never started is retried with another worker, and the engine can be restarted at any time', async () => {
  const rig = createRig();
  // The worker stopped before it had a device (8.3): there is no session that could retry.
  rig.engine.emit({ type: 'engine-error', message: 'No GPU adapter was found', fatal: true });
  assert.deepEqual([rig.engineState.getState().device.state, rig.engineState.getState().device.caps], ['failed', null]);
  await run(rig, 'engine.retryDevice');
  assert.equal(rig.restarts, 1);
  assert.equal(rig.engine.calls.some(([name]) => name === 'retryDevice'), false, 'a worker that refuses every call is not asked');

  // By its command, whatever the engine's state: a worker that hangs says nothing of itself.
  rig.engine.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 2 ** 30 });
  assert.equal(rig.shell.runner.enabled('engine.restart'), true);
  await run(rig, 'engine.restart');
  assert.equal(rig.restarts, 2);
  const said = rig.shell.state.getState().notices.at(-1)!;
  assert.deepEqual([said.level, said.message, said.count], ['info', 'The engine was restarted', 2], 'each restart is said');
  assert.ok(rig.shell.menus().find((menu) => menu.title === 'Engine')!.items.some((item) => item.kind === 'command' && item.command === 'engine.restart'), 'the Engine menu offers it');
});

test('the main process keeps the machine awake while a build runs, and the end of a build is said', async () => {
  const rig = createRig();
  await rig.shell.project.start();
  rig.platform.answers.folder.push('/work/out');
  await run(rig, 'build.start');
  assert.deepEqual(rig.engine.calls.at(-1), ['build', '/work/out']);
  rig.engine.emit({ type: 'request-start', requestId: 5, revision: 1, purpose: 'build' });
  rig.engine.emit({ type: 'build-start', requestId: 5, resolution: 4033, outDir: '/work/out' });
  assert.deepEqual(rig.platform.buildActive, [true]);
  const result = { requestId: 5, status: 'ok' as const, problems: [], files: [{ path: 'a.png', bytes: 1 }, { path: 'a.orogen.json', bytes: 2 }], manifest: 'a.orogen.json', report: null, outDir: '/work/out' };
  rig.engine.emit({ type: 'build-result', requestId: 5, result });
  rig.engine.emit({ type: 'build-end', requestId: 5, status: 'ok' });
  assert.deepEqual(rig.platform.buildActive, [true, false]);
  assert.deepEqual(rig.shell.state.getState().notices.map((notice) => [notice.level, notice.message]), [['info', 'Build finished: 2 files in out']]);

  rig.engine.emit({ type: 'build-result', requestId: 6, result: { ...result, status: 'errors', files: [], problems: [{ severity: 'error', code: 'E_OUT_DIR', message: 'The folder holds files that are not a build' }] } });
  assert.deepEqual(rig.shell.state.getState().notices.at(-1)?.message, 'Build failed: The folder holds files that are not a build');
});

test('a command of the native menu runs, and one this page does not have is passed over without an error', async () => {
  const rig = createRig();
  rig.platform.menu('engine.togglePause');
  assert.equal(rig.shell.state.getState().paused, true);
  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args[0]); };
  try {
    rig.platform.menu('graph.nothing');
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.deepEqual(rig.shell.state.getState().notices, []);
});

test('a command that fails is said in the notification area, and the shell goes on', async () => {
  const rig = createRig({ panels: fakePanels({ graph: [{ id: 'graph.broken', title: 'Break…', run: () => { throw new Error('It broke'); } }] }) });
  const logged: unknown[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args[0]); };
  try {
    await run(rig, 'graph.broken');
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(rig.shell.state.getState().notices.map((notice) => [notice.level, notice.message]), [['error', 'Break failed: It broke']]);
  assert.throws(() => rig.shell.ctx.run('graph.nothing'), /There is no command "graph\.nothing"/);
  await run(rig, 'engine.togglePause');
  assert.equal(rig.shell.state.getState().paused, true);
});

test('after stop the shell hears neither the engine nor the main process', () => {
  const rig = createRig();
  rig.stop();
  rig.engine.emit({ type: 'engine-error', message: 'Late', fatal: false });
  rig.platform.menu('engine.togglePause');
  rig.platform.requestClose();
  assert.deepEqual([rig.shell.state.getState().notices.length, rig.shell.state.getState().paused, rig.platform.confirmed], [0, false, 0]);
});

test('shellCommands makes a list that the registry takes: every id begins with file, edit, view or engine', () => {
  const rig = createRig();
  const host = {
    project: rig.shell.project, edit: { textField: () => false, inTextField: () => undefined, clipboardEvent: () => undefined }, testMode: true,
    hasCommand: () => false, recent: () => [], paused: () => false, setPaused: () => undefined, openPalette: () => undefined, showDialog: () => undefined,
    resetLayout: () => undefined, closeWindow: () => undefined, restartEngine: () => undefined,
  };
  for (const command of shellCommands(host)) assert.match(command.id, /^(file|edit|view|engine)\.[a-zA-Z]+$/);
});
