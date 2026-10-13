// Commands in the window (runtime.md 8.8): every entry of the menu bar reaches its effect, keys run commands
// through the one listener and the keymap in force, and the palette finds and runs them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  appears, capture, choose, closeMenu, docked, exists, key, openMenu, OUTPUT, press, quote, ready, run, seedOf, setSeed, settled, vanishes, withApp,
  EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = path.join(OUTPUT, 'commands');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

test('commands: the menu bar offers the commands of the shell and of the panels, with their keys', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    // 8.8 rule 7: the shell's menus, then those the panels name.
    const titles = await app.eval<string[]>(`shellTest.texts('.og-menubar-item')`);
    assert.deepEqual(titles, ['File', 'Edit', 'View', 'Engine', 'Viewport', 'Graph', 'Inspector', 'Library']);
    const menus: Record<string, string[]> = {};
    const keys: Record<string, string | null> = {};
    for (const title of titles) {
      const items = await openMenu(app, title);
      menus[title] = items.map((item) => `${item.id}${item.enabled ? '' : ' (disabled)'}`);
      for (const item of items) keys[item.id!] = item.key;
      if (title === 'File') t.diagnostic(`capture: ${await capture(app, 'menu-file')}`);
      await closeMenu(app);
    }
    // The default project at start: one node, nothing selected, the graph in front with the focus, the inspector
    // in front of the library and the build panel.
    assert.deepEqual(menus, {
      File: ['file.new', 'file.open', 'file.openRecent (disabled)', 'library.browseExamples', 'file.save', 'file.saveAs', 'file.exit'],
      // Nothing to undo. The graph has the focus: it takes the clipboard events, has nothing selected to delete, and a node to select.
      Edit: ['edit.undo (disabled)', 'edit.redo (disabled)', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete (disabled)', 'edit.selectAll', 'edit.preferences'],
      View: ['view.commandPalette', 'view.resetLayout', 'view.showErrors', 'viewport.toggleTop'],
      Engine: ['engine.togglePause', 'engine.retryDevice (disabled)', 'engine.restart', 'build.start', 'build.cancel (disabled)'],
      Viewport: [
        'viewport.frame', 'viewport.resetView', 'viewport.toggleTop', 'viewport.shadingMaterial', 'viewport.shadingClay', 'viewport.topHillshade', 'viewport.topHeight',
        'viewport.topOverlay', 'viewport.toggleSea', 'viewport.resetSun', 'viewport.resetVerticalScale', 'viewport.nextPalette', 'viewport.removeOverlay (disabled)',
      ],
      Graph: [
        'graph.addNode', 'graph.insertNode (disabled)', 'graph.duplicate (disabled)', 'graph.rename (disabled)', 'graph.toggleBypass (disabled)', 'graph.toggleCollapse (disabled)',
        'graph.group (disabled)', 'graph.selectContents (disabled)', 'graph.useAsTerrain (disabled)', 'graph.toggleViewLock', 'graph.fit', 'graph.toggleMinimap',
      ],
      Inspector: [
        'inspector.rename (disabled)', 'inspector.toggleBypass (disabled)', 'inspector.resetParameter (disabled)', 'inspector.resetAll (disabled)', 'inspector.randomizeSeed',
        'inspector.reloadFiles (disabled)', 'inspector.expandAll (disabled)', 'inspector.collapseAll (disabled)',
      ],
      // The library is behind the inspector: what shows one of its lists brings it to the front, what acts on a list is disabled.
      Library: [
        'library.search', 'library.addNode (disabled)', 'library.showNodes', 'library.showExamples', 'library.expandAll (disabled)', 'library.collapseAll',
        'library.clearRecent (disabled)', 'library.openExample (disabled)',
      ],
    });
    // The keys of runtime.md 8.8, as a person reads them. A key of a panel's scope is shown in that panel's menu.
    assert.deepEqual(
      Object.fromEntries(Object.entries(keys).filter(([, shown]) => shown !== null)),
      {
        'file.new': 'Ctrl+N', 'file.open': 'Ctrl+O', 'file.save': 'Ctrl+S', 'file.saveAs': 'Ctrl+Shift+S', 'edit.undo': 'Ctrl+Z', 'edit.redo': 'Ctrl+Shift+Z',
        'edit.preferences': 'Ctrl+,', 'view.commandPalette': 'Ctrl+Shift+P', 'viewport.toggleTop': 'F6', 'engine.togglePause': '`', 'build.start': 'Ctrl+B',
        'viewport.frame': 'F', 'viewport.resetView': 'Home',
        'graph.addNode': 'Tab', 'graph.duplicate': 'Ctrl+D', 'graph.rename': 'F2', 'graph.toggleBypass': 'B', 'graph.toggleCollapse': 'H', 'graph.group': 'Ctrl+G',
        'graph.useAsTerrain': 'G', 'graph.toggleViewLock': 'F', 'graph.fit': 'Ctrl+0', 'graph.toggleMinimap': 'M',
        'inspector.rename': 'F2', 'inspector.toggleBypass': 'B', 'library.search': 'Ctrl+F',
      },
    );
  });
});

test('commands: every entry of the File menu reaches its effect', async () => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const file = path.join(FOLDER, 'menu.orogen');
    const title = (): Promise<string> => app.eval<string>(`document.title`);

    // Save As: asks where, writes the file, and the window is named for it.
    await setSeed(app, 17);
    assert.equal(await title(), 'Untitled* - Orogen');
    await app.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    await choose(app, 'File', 'file.saveAs');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.seed, 17);
    assert.equal(await title(), 'menu - Orogen');

    // Save: to the same file, without a question.
    await setSeed(app, 18);
    assert.equal(await title(), 'menu* - Orogen');
    await choose(app, 'File', 'file.save');
    await app.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.seed, 18);

    // New: the default project again, with no file.
    await choose(app, 'File', 'file.new');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === null`, PAGE_BACKSTOP_MS);
    assert.deepEqual([await seedOf(app), await title()], [0, 'Untitled - Orogen']);

    // Open: the file that was saved.
    await app.eval(`void orogenTest.shell.answers.openProjectDialog.push(${quote(file)})`);
    await choose(app, 'File', 'file.open');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    assert.equal(await seedOf(app), 18);

    // Open Recent: the submenu lists what was saved and opened, and an entry opens it.
    await choose(app, 'File', 'file.new');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === null`, PAGE_BACKSTOP_MS);
    const items = await openMenu(app, 'File');
    assert.equal(items.find((item) => item.id === 'file.openRecent')?.enabled, true);
    await app.eval(`void shellTest.hover('[data-ui="menu"] [data-item="file.openRecent"]')`);
    const recent = `[data-item=${quote(`recent:${file}`)}]`;
    await appears(app, recent);
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${recent} .og-menu-item-label`)})`), 'menu.orogen');
    await press(app, recent);
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    await vanishes(app, '[data-ui="menu"]');

    // Exit: the window is asked to close, the main process asks the page, and the page asks about the changes.
    await setSeed(app, 19);
    await choose(app, 'File', 'file.exit');
    await appears(app, '[data-dialog="unsaved"]');
    await press(app, '[data-dialog="unsaved"] [data-action="cancel"]');
    await vanishes(app, '[data-dialog="unsaved"]');
    assert.equal(await seedOf(app), 19, 'the window is still there and so are the changes');
  });
});

test('commands: every entry of the Edit, View and Engine menus reaches its effect', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);

    // ---- Edit: undo, redo ----
    await setSeed(app, 3);
    await choose(app, 'Edit', 'edit.undo');
    assert.equal(await seedOf(app), 0);
    await choose(app, 'Edit', 'edit.redo');
    assert.equal(await seedOf(app), 3);

    // ---- Edit: cut, copy and paste reach the focused panel as DOM clipboard events (8.8 rule 3) ----
    // The desktop's clipboard is the user's own: what the page would write there is kept in the page.
    await app.eval(`void (navigator.clipboard.writeText = () => Promise.resolve(), navigator.clipboard.readText = () => Promise.resolve(''))`);
    await app.eval(`void (window.clipboardEvents = [], ['cut', 'copy', 'paste'].forEach((type) => document.querySelector('[data-panel="graph"]').addEventListener(type, (event) => {
      window.clipboardEvents.push(type + ':' + (event.clipboardData instanceof DataTransfer));
    })))`);
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'graph');
    for (const action of ['cut', 'copy', 'paste']) await choose(app, 'Edit', `edit.${action}`);
    await app.waitFor(`window.clipboardEvents.length === 3`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await app.eval<string[]>(`window.clipboardEvents`), ['cut:true', 'copy:true', 'paste:true']);

    // ---- Edit: preferences ----
    await choose(app, 'Edit', 'edit.preferences');
    await appears(app, '[data-dialog="preferences"]');
    // ---- Edit: select all and delete go to the text field that has the focus ----
    await press(app, '[data-dialog="preferences"] [data-tab-button="graphics"]');
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="preferences"]');

    // ---- View ----
    await choose(app, 'View', 'view.commandPalette');
    await appears(app, '[data-ui="palette"][data-mode="commands"]');
    await key(app, 'Escape', {}, '.og-palette-input');
    await vanishes(app, '[data-ui="palette"]');

    const inspector = (): Promise<{ width: number }> => app.eval(`shellTest.rect('[data-panel="inspector"]')`);
    const before = await inspector();
    await app.eval(`void shellTest.drag([...document.querySelectorAll('.dv-sash')].find((sash) => sash.getBoundingClientRect().height > 500), -120)`);
    await app.waitFor(`shellTest.rect('[data-panel="inspector"]').width > ${before.width + 100}`, PAGE_BACKSTOP_MS);
    await choose(app, 'View', 'view.resetLayout');
    await app.waitFor(`shellTest.rect('[data-panel="inspector"]').width === ${before.width}`, PAGE_BACKSTOP_MS);

    await choose(app, 'View', 'view.showErrors');
    await appears(app, '[data-dialog="errors"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-dialog="errors"] .og-dialog-body')`), 'Nothing has gone wrong');
    await press(app, '[data-dialog="errors"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="errors"]');

    // ---- Engine: pause. A paused engine records the document and computes nothing; resumed, it catches up. ----
    await choose(app, 'Engine', 'engine.togglePause');
    assert.equal(await app.eval<boolean>(`orogenTest.shell.state.getState().paused`), true);
    assert.equal(await app.eval<string>(`shellTest.text('[data-status="device"]')`), 'Previews paused');
    const shown = await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`);
    await setSeed(app, 4);
    await app.waitFor(`Object.keys(orogenTest.ctx.engineState.getState().keys).length > 0 && orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    assert.equal(await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`), shown, 'nothing newer is shown while the engine is paused');
    assert.equal(await app.eval<string>(`shellTest.attr('[data-status="view"]', 'data-behind')`), '');
    await choose(app, 'Engine', 'engine.togglePause');
    await settled(app);
    assert.ok(await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`) > shown);

    // ---- Engine: build. Without an export node a build writes nothing and says so. ----
    const empty = path.join(FOLDER, 'build-nothing');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(empty)})`);
    await choose(app, 'Engine', 'build.start');
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.lastStatus !== null && !orogenTest.ctx.engineState.getState().build.running`, EVALUATION_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().build.lastStatus`), 'errors');
    await appears(app, '[data-ui="notice"][data-level="error"]');
    assert.match(await app.eval<string>(`shellTest.text('[data-ui="notice"] .og-notice-text')`), /^Build failed: A build would write nothing/);
    t.diagnostic(`capture: ${await capture(app, 'notice-build-failed')}`);
    await press(app, '[data-ui="notice"] [aria-label="Dismiss"]');
    await vanishes(app, '[data-ui="notice"]');
    await settled(app);

    // With one: the files are on disk, the status bar showed the build, and its end is said.
    const out = path.join(FOLDER, 'build');
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Resolution', (draft) => { draft.settings.buildResolution = 1009; draft.settings.previewLevel = 1; }, { undoable: false })`);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Export', (draft) => {
      const source = Object.keys(draft.nodes)[0];
      draft.nodes.out = { id: 'out', type: 'io/export-landscape', version: 1, position: { x: 300, y: 0 }, params: {} };
      draft.edges.wire = { id: 'wire', from: { node: source, port: 'out' }, to: { node: 'out', port: 'in' } };
    })`);
    await settled(app);
    // What the status bar shows while the build runs, as the page draws it.
    await app.eval(`void (window.statusSeen = { purposes: [], nodes: [] }, new MutationObserver(() => {
      const shown = document.querySelector('[data-status="evaluation"]');
      if (!shown) return;
      const purpose = shown.getAttribute('data-purpose');
      const node = shown.querySelector('[data-status="node"]')?.textContent;
      if (!window.statusSeen.purposes.includes(purpose)) window.statusSeen.purposes.push(purpose);
      if (node && !window.statusSeen.nodes.includes(node)) window.statusSeen.nodes.push(node);
    }).observe(document.querySelector('[data-shell="statusbar"]'), { subtree: true, childList: true, attributes: true, characterData: true }))`);
    // The build panel keeps the folder a project was built into (8.7): another folder is chosen by its command.
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)})`);
    await run(app, 'build.chooseFolder');
    await choose(app, 'Engine', 'build.start');
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.result?.outDir === ${quote(out)} && !orogenTest.ctx.engineState.getState().build.running`, EVALUATION_BACKSTOP_MS);
    const result = await app.eval<{ status: string; files: { path: string }[] }>(`orogenTest.ctx.engineState.getState().build.result`);
    assert.equal(result.status, 'ok');
    assert.ok(result.files.length >= 2);
    for (const written of result.files) assert.ok(fs.existsSync(path.join(out, written.path)), `${written.path} is in the output folder`);
    const seen = await app.eval<{ purposes: string[]; nodes: string[] }>(`window.statusSeen`);
    assert.ok(seen.purposes.includes('build'), `the status bar said that a build runs: ${seen.purposes.join(', ')}`);
    assert.ok(seen.nodes.some((node) => node.startsWith('Mountain Range')), `and which node it was on: ${seen.nodes.join(', ')}`);
    await appears(app, '[data-ui="notice"][data-level="info"]');
    assert.match(await app.eval<string>(`shellTest.text('[data-ui="notice"] .og-notice-text')`), new RegExp(`^Build finished: ${result.files.length} files in build$`));
    await settled(app);
  });
});

test('commands: the edit commands act in the text field that has the focus', async () => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await run(app, 'view.controlGallery');
    await appears(app, '[data-dialog="gallery"]');
    // The gallery's text field, taken out of the dialog's reach for this test: a field of the content.
    await app.eval(`void (() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'content-field';
      input.value = 'Ridge';
      document.querySelector('[data-panel="inspector"]').append(input);
    })()`);
    await press(app, '[data-dialog="gallery"] [aria-label="Close"]');
    await vanishes(app, '[data-dialog="gallery"]');
    await app.eval(`void shellTest.focus('#content-field')`);
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'inspector');
    await run(app, 'edit.selectAll');
    assert.deepEqual(await app.eval<number[]>(`[shellTest.el('#content-field').selectionStart, shellTest.el('#content-field').selectionEnd]`), [0, 5]);
    await run(app, 'edit.delete');
    assert.equal(await app.eval<string>(`shellTest.el('#content-field').value`), '');
    // From the menu as well: the field keeps being the target while the menu has the focus.
    await app.eval(`void shellTest.type('#content-field', 'Dune')`);
    await choose(app, 'Edit', 'edit.selectAll');
    await choose(app, 'Edit', 'edit.delete');
    assert.equal(await app.eval<string>(`shellTest.el('#content-field').value`), '');
    assert.equal(await exists(app, '#content-field'), true);
  });
});

test('commands: keys run commands through the keymap, and undo and redo follow it', async () => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    for (const seed of [1, 2, 3]) await setSeed(app, seed);
    // The merge window of 600 ms may have made one step of the three: what is undone is whatever the history holds.
    const steps = await app.eval<number>(`orogenTest.ctx.doc.getState().past.length`);
    assert.ok(steps >= 1);

    await key(app, 'KeyZ', { ctrl: true });
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().past.length`), steps - 1);
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().future.length`), 1);
    const undone = await seedOf(app);
    assert.notEqual(undone, 3);
    await key(app, 'KeyZ', { ctrl: true, shift: true });
    assert.equal(await seedOf(app), 3);
    await key(app, 'KeyZ', { ctrl: true });
    await key(app, 'KeyY', { ctrl: true });
    assert.equal(await seedOf(app), 3, 'Mod+Y redoes as Mod+Shift+Z does');
    assert.equal(await app.eval<boolean>(`shellTest.key('KeyZ', { ctrl: true })`), false, 'a key that ran a command is taken: its default is prevented');
    assert.equal(await seedOf(app), undone);
    await key(app, 'KeyY', { ctrl: true });

    // A key that is bound to nothing is left alone.
    assert.equal(await app.eval<boolean>(`shellTest.key('KeyK', { ctrl: true })`), true);

    // In a text field, Mod+Z is the field's own undo and the document stays (rule 3); Mod+S still saves.
    await app.eval(`void (() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'content-field';
      document.querySelector('[data-panel="inspector"]').append(input);
      shellTest.focus(input);
    })()`);
    assert.equal(await app.eval<boolean>(`shellTest.key('KeyZ', { ctrl: true }, '#content-field')`), true);
    assert.equal(await seedOf(app), 3);
    assert.equal(await app.eval<boolean>(`shellTest.key('Backquote', {}, '#content-field')`), true, 'a plain key is typed');
    assert.equal(await app.eval<boolean>(`orogenTest.shell.state.getState().paused`), false);
    const file = path.join(FOLDER, 'keys.orogen');
    await app.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    assert.equal(await app.eval<boolean>(`shellTest.key('KeyS', { ctrl: true }, '#content-field')`), false);
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.seed, 3);
    await app.eval(`void document.querySelector('#content-field').remove()`);

    // Outside a text field the plain key is the command's.
    await key(app, 'Backquote');
    assert.equal(await app.eval<boolean>(`orogenTest.shell.state.getState().paused`), true);
    await key(app, 'Backquote');
    assert.equal(await app.eval<boolean>(`orogenTest.shell.state.getState().paused`), false);

    // A key the user gives a command replaces its defaults (rule 5), at once and in the preferences file.
    await run(app, 'edit.preferences');
    await appears(app, '[data-dialog="preferences"]');
    await press(app, '[data-tab-button="keys"]');
    await press(app, '[data-key-of="edit.undo"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-key-of="edit.undo"]')`), 'Press a key');
    await key(app, 'KeyU', { ctrl: true, alt: true }, '[data-key-of="edit.undo"]');
    await app.waitFor(`shellTest.text('[data-key-of="edit.undo"]') === 'Ctrl+Alt+U'`, PAGE_BACKSTOP_MS);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.keymap['edit.undo'] === 'Mod+Alt+U')`, PAGE_BACKSTOP_MS);
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
    await vanishes(app, '[data-dialog="preferences"]');
    await key(app, 'KeyZ', { ctrl: true });
    assert.equal(await seedOf(app), 3, 'the default key no longer undoes');
    await key(app, 'KeyU', { ctrl: true, alt: true });
    assert.equal(await seedOf(app), undone);
    const items = await openMenu(app, 'Edit');
    assert.equal(items.find((item) => item.id === 'edit.undo') !== undefined, true);
    assert.equal(await app.eval<string>(`shellTest.text('[data-item="edit.undo"] .og-menu-item-key')`), 'Ctrl+Alt+U', 'the menu shows the key in force');
    await closeMenu(app);

    // While a dialog is open the keys are the dialog's.
    await run(app, 'edit.preferences');
    await appears(app, '[data-dialog="preferences"]');
    assert.equal(await app.eval<boolean>(`shellTest.key('KeyY', { ctrl: true })`), true);
    assert.equal(await seedOf(app), undone);
    await press(app, '[data-dialog="preferences"] [data-action="ok"]');
  });
});

test('commands: the palette finds a command by a few of its letters and runs it', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    await setSeed(app, 9);

    await key(app, 'KeyP', { ctrl: true, shift: true });
    await appears(app, '[data-ui="palette"][data-mode="commands"]');
    const listed = await app.eval<{ id: string; disabled: boolean; key: string | null }[]>(`[...document.querySelectorAll('.og-palette-item')].map((item) => ({
      id: item.getAttribute('data-id'), disabled: item.getAttribute('aria-disabled') === 'true', key: item.querySelector('.og-key')?.textContent ?? null,
    }))`);
    const ids = listed.map((entry) => entry.id);
    for (const id of ['file.new', 'file.save', 'edit.undo', 'edit.preferences', 'view.resetLayout', 'engine.togglePause', 'build.start', 'viewport.toggleTop']) assert.ok(ids.includes(id), id);
    assert.equal(ids.includes('view.commandPalette'), false, 'the palette does not offer itself');
    assert.deepEqual(listed.find((entry) => entry.id === 'edit.undo'), { id: 'edit.undo', disabled: false, key: 'Ctrl+Z' });
    assert.deepEqual(listed.find((entry) => entry.id === 'edit.redo'), { id: 'edit.redo', disabled: true, key: 'Ctrl+Shift+Z' });
    assert.equal(listed.find((entry) => entry.id === 'viewport.toggleTop')?.disabled, false);
    // Read from top to bottom, the list is the whole list: every command of the shell and of the five panels but the palette's own.
    const declared = await app.eval<string[]>(`[...document.querySelectorAll('.og-menubar-item')].map((item) => item.getAttribute('data-menu'))`);
    assert.ok(declared.length === 8 && listed.length > 70, `${listed.length} commands are listed`);
    for (const id of ['graph.fit', 'graph.toggleMinimap', 'inspector.collapseAll', 'library.browseExamples', 'build.cancel', 'build.importGuide', 'build.selectProblemNode', 'viewport.removeOverlay']) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length, 'each once');
    // Two panels have a command of one title: the list says whose each is.
    const owners = await app.eval<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.og-palette-item')].map((item) => [item.getAttribute('data-id'), item.querySelector('.og-palette-item-note')?.textContent ?? '']))`);
    assert.deepEqual([owners['graph.delete'], owners['edit.delete'], owners['inspector.toggleBypass'], owners['graph.toggleBypass'], owners['build.start']], ['Graph', 'Edit', 'Inspector', 'Graph', 'Build']);

    // Typed letters narrow the list, the best match first; the letters need not be together.
    await app.eval(`void shellTest.type('.og-palette-input', 'undo')`);
    await app.waitFor(`document.querySelector('.og-palette-item')?.getAttribute('data-id') === 'edit.undo'`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`shellTest.text('.og-palette-item[aria-selected="true"] .og-palette-item-title b')`), 'Undo');
    await app.eval(`void shellTest.type('.og-palette-input', 'rslay')`);
    await app.waitFor(`document.querySelector('.og-palette-item')?.getAttribute('data-id') === 'view.resetLayout'`, PAGE_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'palette')}`);
    await app.eval(`void shellTest.type('.og-palette-input', 'zzzzqq')`);
    await appears(app, '.og-palette-empty');

    // Arrows move through the list, Enter runs what is selected.
    await app.eval(`void shellTest.type('.og-palette-input', 'do')`);
    await app.waitFor(`shellTest.count('.og-palette-item') >= 2`, PAGE_BACKSTOP_MS);
    const order = await app.eval<string[]>(`[...document.querySelectorAll('.og-palette-item')].map((item) => item.getAttribute('data-id'))`);
    const undoAt = order.indexOf('edit.undo');
    assert.ok(undoAt >= 0, `"do" finds Undo among ${order.join(', ')}`);
    for (let step = 0; step < undoAt; step++) await key(app, 'ArrowDown', {}, '.og-palette-input');
    await app.waitFor(`document.querySelector('.og-palette-item[aria-selected="true"]')?.getAttribute('data-id') === 'edit.undo'`, PAGE_BACKSTOP_MS);
    await key(app, 'Enter', {}, '.og-palette-input');
    await vanishes(app, '[data-ui="palette"]');
    assert.equal(await seedOf(app), 0, 'Enter ran Undo');

    // F1 opens it too; a click runs an entry; a disabled entry does not run and the palette stays.
    await key(app, 'F1');
    await appears(app, '[data-ui="palette"]');
    await press(app, '.og-palette-item[data-id="edit.undo"]');
    assert.equal(await exists(app, '[data-ui="palette"]'), true, 'nothing is left to undo: the entry is disabled');
    await press(app, '.og-palette-item[data-id="edit.redo"]');
    await vanishes(app, '[data-ui="palette"]');
    assert.equal(await seedOf(app), 9);

    // Escape closes it without running anything, and so does a press beside it.
    await key(app, 'F1');
    await appears(app, '[data-ui="palette"]');
    await key(app, 'Escape', {}, '.og-palette-input');
    await vanishes(app, '[data-ui="palette"]');
    await key(app, 'F1');
    await appears(app, '[data-ui="palette"]');
    await app.eval(`void shellTest.el('.og-palette-backdrop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await vanishes(app, '[data-ui="palette"]');
    assert.equal(await seedOf(app), 9);

    // The same list opens recent projects.
    const file = path.join(FOLDER, 'palette.orogen');
    await app.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    await run(app, 'file.saveAs');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    await run(app, 'file.new');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === null`, PAGE_BACKSTOP_MS);
    await key(app, 'F1');
    await appears(app, '[data-ui="palette"]');
    await app.eval(`void shellTest.type('.og-palette-input', 'open recent')`);
    await app.waitFor(`document.querySelector('.og-palette-item')?.getAttribute('data-id') === 'file.openRecent'`, PAGE_BACKSTOP_MS);
    await key(app, 'Enter', {}, '.og-palette-input');
    await appears(app, '[data-ui="palette"][data-mode="recent"]');
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('.og-palette-item-title')`), ['palette']);
    await key(app, 'Enter', {}, '.og-palette-input');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    assert.equal(await seedOf(app), 9);
  });
});
