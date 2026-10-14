// The Examples tab of the library in the real application, in a window that is never shown (testing.md 8.5):
// the six projects with their pictures and descriptions, each opened as a new project without a file and
// computed at the preview resolution without an error, the question before unsaved changes are discarded, and
// the dialog of File > Open Example… while the Library tab is behind another.
//
// The captures are written for a person (rule 1): ui/library/examples-*.png.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry, parseDoc } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, capture, choose, closeMenu, docOf, EVALUATION_BACKSTOP_MS, exists, focus, install, key, openMenu, press, quote, run, setLibraryWidth, settled, showLibrary, sleep,
  vanishes, withApp,
} from './rig.ts';

const FOLDER = path.resolve(import.meta.dirname, '../../../examples');
/** Files these tests write: <OROGEN_TEST_OUTPUT>/library. */
const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.resolve(import.meta.dirname, '../../../test-output'), 'library');
fs.rmSync(OUTPUT, { recursive: true, force: true });
fs.mkdirSync(OUTPUT, { recursive: true });
const registry = createRegistry(nodes);
const INDEX = (JSON.parse(fs.readFileSync(path.join(FOLDER, 'index.json'), 'utf8')) as { examples: { file: string; image: string; title: string; description: string }[] }).examples;
const EXAMPLES = INDEX.map((entry) => ({ ...entry, id: entry.file.replace(/\.orogen$/, ''), doc: parseDoc(fs.readFileSync(path.join(FOLDER, entry.file), 'utf8'), registry).doc }));

const card = (id: string, place = 'panel'): string => `[data-library="examples"][data-place="${place}"] [data-example="${id}"]`;
interface Project { readonly nodes: string[]; readonly path: string | null; readonly unsaved: boolean; readonly past: number; readonly seed: number }
const project = (app: AppDriver): Promise<Project> => app.eval<Project>(`(() => {
  const state = orogenTest.ctx.doc.getState();
  return { nodes: Object.keys(state.doc.nodes).sort(), path: state.path, unsaved: state.unsaved, past: state.past.length, seed: state.doc.settings.seed };
})()`);
/** The nodes of the document that failed, with what they say. */
const failures = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`(() => {
  const held = orogenTest.ctx.doc.getState().doc.nodes;
  return Object.entries(orogenTest.ctx.engineState.getState().nodes)
    .filter(([id, node]) => Object.hasOwn(held, id) && node.state === 'error')
    .map(([id, node]) => id + ': ' + (node.error?.message ?? 'failed'));
})()`);
const selectedExample = (app: AppDriver, place = 'panel'): Promise<string | null> =>
  app.eval<string | null>(`document.querySelector('[data-library="examples"][data-place="${place}"] [aria-selected="true"]')?.getAttribute('data-example') ?? null`);

async function showExamples(app: AppDriver): Promise<void> {
  await showLibrary(app);
  await press(app, '[data-tab="examples"]');
  await appears(app, '[data-library="examples"][data-place="panel"]');
}

/** Holds the open project to an example: its nodes, no file, nothing to save, no history. */
async function expectOpened(app: AppDriver, example: (typeof EXAMPLES)[number]): Promise<void> {
  // An example is opened by the shell's project service, which may ask and save first: it is the project a moment after the answer.
  await app.waitFor(`JSON.stringify(Object.keys(orogenTest.ctx.doc.getState().doc.nodes).sort()) === ${quote(JSON.stringify(Object.keys(example.doc.nodes).sort()))}`, 15_000);
  const held = await project(app);
  assert.deepEqual(held.nodes, Object.keys(example.doc.nodes).sort(), `${example.title} is the project that is open`);
  assert.deepEqual([held.path, held.unsaved, held.past, held.seed], [null, false, 0, example.doc.settings.seed], 'a new project without a file, with nothing to save and nothing to undo');
  assert.deepEqual((await docOf(app)).ui.view, example.doc.ui.view, 'it shows what the example shows');
}

test('examples: the tab lists the six projects, each with its picture, its description and what it holds', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showExamples(app);
    await settled(app);
    assert.equal(EXAMPLES.length, 6);

    const cards = await app.eval<{ id: string; title: string; text: string; summary: string; picture: { src: string; complete: boolean; width: number; height: number } | null; open: boolean }[]>(
      `[...document.querySelectorAll('[data-library="examples"] [data-example]')].map((card) => {
        const picture = card.querySelector('img');
        return {
          id: card.getAttribute('data-example'),
          title: card.querySelector('h3').textContent,
          text: card.querySelector('p').textContent,
          summary: card.querySelector('[class*="exampleSummary"]').textContent,
          picture: picture ? { src: picture.getAttribute('src'), complete: picture.complete, width: picture.naturalWidth, height: picture.naturalHeight } : null,
          open: card.querySelector('[data-action="open"]') !== null && !card.querySelector('[data-action="open"]').disabled,
        };
      })`,
    );
    assert.deepEqual(cards.map((entry) => entry.id), EXAMPLES.map((example) => example.id), 'in the order of the index: the first project first');
    for (const [at, example] of EXAMPLES.entries()) {
      const shown = cards[at]!;
      assert.deepEqual([shown.title, shown.text, shown.open], [example.title, example.description, true]);
      // The picture is a file of the built application, loaded: 384 x 256, as the folder holds it.
      assert.ok(shown.picture && shown.picture.complete, `${example.title} has its picture`);
      assert.deepEqual([shown.picture.width, shown.picture.height], [384, 256], example.image);
      // Packed with the page by the build: a file of dist/assets named for the example.
      assert.match(shown.picture.src, new RegExp(`/assets/${example.id}-[\\w-]+\\.png$`));
      assert.match(shown.summary, new RegExp(`^${Object.keys(example.doc.nodes).length} nodes`));
    }
    assert.equal(cards[1]!.summary, '21 nodes · 5 layers');
    assert.equal(cards[0]!.summary, '3 nodes');
    assert.equal(await selectedExample(app), null);
    assert.equal(await app.eval<boolean>(`orogenTest.shell !== undefined && document.querySelector('[data-library="examples"]').scrollWidth <= document.querySelector('[data-library="examples"]').clientWidth`), true, 'the cards fit the width of the panel');
    t.diagnostic(`capture: ${await capture(app, 'examples-01-tab')}`);

    // A narrow panel, as the default layout of a small window gives it: the picture goes above the text, which
    // keeps the width of the card, and nothing is wider than the panel.
    await setLibraryWidth(app, 250);
    const narrow = await app.eval<{ overflow: number; stacked: number; text: number; card: number }>(`(() => {
      const list = document.querySelector('[data-library="examples"]');
      const cards = [...list.querySelectorAll('[data-example]')];
      return {
        overflow: list.scrollWidth - list.clientWidth,
        stacked: cards.filter((entry) => entry.querySelector('img').getBoundingClientRect().bottom <= entry.querySelector('h3').getBoundingClientRect().top).length,
        text: Math.min(...cards.map((entry) => entry.querySelector('p').getBoundingClientRect().width)),
        card: cards[0].getBoundingClientRect().width,
      };
    })()`);
    assert.deepEqual([narrow.overflow, narrow.stacked], [0, 6]);
    assert.ok(narrow.text >= narrow.card - 20, `the description has the width of its card: ${narrow.text} of ${narrow.card}`);
    t.diagnostic(`capture: ${await capture(app, 'examples-01b-narrow')}`);
    await setLibraryWidth(app, 367);

    // The keyboard: down and up select, and the selection is the project "Open Selected Example" opens.
    await focus(app, '[data-library="examples"]');
    assert.notEqual(await app.eval<string>(`getComputedStyle(document.querySelector('[data-library="examples"]')).boxShadow`), 'none', 'the focus is visible where no card is selected');
    await key(app, 'ArrowDown');
    assert.equal(await selectedExample(app), 'first-terrain');
    await key(app, 'ArrowDown');
    await key(app, 'ArrowDown');
    assert.equal(await selectedExample(app), 'temperate-hills');
    await key(app, 'End');
    assert.equal(await selectedExample(app), 'cratered-highland');
    await key(app, 'ArrowUp');
    assert.equal(await selectedExample(app), 'desert-canyons');
    t.diagnostic(`capture: ${await capture(app, 'examples-02-selected')}`);
  });
});

test('examples: each opens as a new project without a file and is computed at the preview resolution without an error', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showExamples(app);
    await settled(app);

    // The four ways to open one: the button, a double-click, Enter on the selection, and the command.
    const ways: Record<string, (id: string) => Promise<void>> = {
      button: (id) => press(app, `${card(id)} [data-action="open"]`),
      doubleClick: (id) => app.eval<void>(`void libraryTest.doubleClick(${quote(card(id))})`),
      async enter(id) {
        await press(app, card(id));
        await focus(app, '[data-library="examples"]');
        await key(app, 'Enter');
      },
      async command(id) {
        await press(app, card(id));
        await run(app, 'library.openExample');
      },
    };
    const how = ['button', 'doubleClick', 'enter', 'command', 'button', 'doubleClick'];

    for (const [at, example] of EXAMPLES.entries()) {
      const started = Date.now();
      await ways[how[at]!]!(example.id);
      await expectOpened(app, example);
      assert.equal(await exists(app, '[data-dialog="unsaved"]'), false, 'a project without changes is replaced without a question');
      assert.equal(await app.eval<string>(`document.title`), 'Untitled - Orogen');
      assert.equal(await selectedExample(app), example.id);

      // The engine computes it: the view of this revision is shown at 1009, and no node of the project failed.
      await settled(app);
      const seconds = (Date.now() - started) / 1000;
      const view = await app.eval<{ resolution: number; draft: boolean } | null>(`orogenTest.ctx.engineState.getState().view`);
      assert.deepEqual([view?.resolution, view?.draft], [1009, false]);
      assert.deepEqual(await failures(app), [], `${example.title}: nodes that failed`);
      const shown = example.doc.ui.view!.height!;
      const state = await app.eval<string>(`orogenTest.ctx.engineState.getState().nodes[${quote(shown.node)}]?.state ?? 'none'`);
      assert.equal(state, 'done', `the terrain ${shown.node} of ${example.title} was computed`);
      // The thumbnails of the nodes follow when the engine is idle: wait for them before the picture.
      await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
      t.diagnostic(`${example.title}: opened by ${how[at]} and shown after ${seconds.toFixed(1)} s (not asserted); capture: ${await capture(app, `examples-open-${example.id}`)}`);
    }
    // Opened and never edited: the last one is still a project with nothing to save.
    assert.equal((await project(app)).unsaved, false);
  });
});

test('examples: a project with unsaved changes is replaced only after the question File > Open asks, which is the shell\'s own: save, do not save, or cancel', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showExamples(app);
    await settled(app);
    const alpine = EXAMPLES.find((example) => example.id === 'alpine-range')!;
    const first = EXAMPLES.find((example) => example.id === 'first-terrain')!;
    // The dialog File > Open shows (src/app/shell/Dialogs.tsx): an example is opened by the shell's project service.
    const QUESTION = '[data-dialog="unsaved"]';
    const edit = (seed: number): Promise<void> => app.eval<void>(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = ${seed}; })`);
    /** The file dialog of "Save" answers with this next; null is a dialog that was cancelled. */
    const answerSave = (file: string | null): Promise<void> => app.eval<void>(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    const saveAsked = (): Promise<void> => app.waitFor(`orogenTest.shell.answers.saveProjectDialog.length === 0`);

    await edit(4242);
    const edited = await project(app);
    assert.deepEqual([edited.unsaved, edited.seed], [true, 4242]);

    await press(app, `${card('alpine-range')} [data-action="open"]`);
    await appears(app, QUESTION);
    assert.deepEqual(await project(app), edited, 'nothing is replaced while the question is open');
    assert.match(await app.eval<string>(`document.querySelector(${quote(QUESTION)}).textContent`), /Save the changes to Untitled\?.*The changes are lost if they are not saved\./);
    assert.equal(await exists(app, '[data-dialog="library-unsaved"]'), false, 'the library has no question of its own');
    // The three answers, in the shell's order.
    assert.deepEqual(
      await app.eval(`[...document.querySelectorAll(${quote(`${QUESTION} [data-action]`)})].map((button) => [button.getAttribute('data-action'), button.textContent])`),
      [['discard', 'Don’t Save'], ['cancel', 'Cancel'], ['save', 'Save']],
    );
    assert.equal(await selectedExample(app), 'alpine-range', 'the card that was asked for is the selected one');
    t.diagnostic(`capture: ${await capture(app, 'examples-03-unsaved-question')}`);

    // Cancel, and Escape: the project stays as it is, changes and all.
    await press(app, `${QUESTION} [data-action="cancel"]`);
    await vanishes(app, QUESTION);
    assert.deepEqual(await project(app), edited);
    await app.eval(`void libraryTest.doubleClick(${quote(card('alpine-range'))})`);
    await appears(app, QUESTION);
    await app.eval(`void shellTest.key('Escape', {}, ${quote(QUESTION)})`);
    await vanishes(app, QUESTION);
    assert.deepEqual(await project(app), edited);

    // Save, and the file dialog is cancelled: nothing was saved, so nothing is replaced. The question is over, as it is after File > Open.
    await press(app, card('alpine-range'));
    await run(app, 'library.openExample');
    await appears(app, QUESTION);
    await answerSave(null);
    await press(app, `${QUESTION} [data-action="save"]`);
    await saveAsked();
    await vanishes(app, QUESTION);
    assert.deepEqual(await project(app), edited);

    // Save, with a file: the project is written with its changes, and then the example is the project.
    const file = path.join(OUTPUT, 'saved-before-example.orogen');
    await run(app, 'library.openExample');
    await appears(app, QUESTION);
    await answerSave(file);
    await press(app, `${QUESTION} [data-action="save"]`);
    await vanishes(app, QUESTION);
    await expectOpened(app, alpine);
    const written = parseDoc(fs.readFileSync(file, 'utf8'), registry).doc;
    assert.deepEqual([written.settings.seed, Object.keys(written.nodes).sort()], [4242, edited.nodes], 'the file holds the project that was open, with its changes');
    await settled(app);
    assert.deepEqual(await failures(app), []);

    // Don't Save: the changes are gone and the example is open.
    await edit(77);
    await press(app, `${card('first-terrain')} [data-action="open"]`);
    await appears(app, QUESTION);
    await press(app, `${QUESTION} [data-action="discard"]`);
    await vanishes(app, QUESTION);
    await expectOpened(app, first);

    // An answer "Save" that came to nothing is over with the question: a later save of the project opens no example.
    await edit(78);
    await press(app, `${card('alpine-range')} [data-action="open"]`);
    await appears(app, QUESTION);
    await answerSave(null);
    await press(app, `${QUESTION} [data-action="save"]`);
    await saveAsked();
    await vanishes(app, QUESTION);
    const later = path.join(OUTPUT, 'saved-later.orogen');
    await answerSave(later);
    await run(app, 'file.save');
    await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(later)} && !orogenTest.ctx.doc.getState().unsaved`);
    // Longer than a timer of a window that is not shown takes: an example that waited would be open by now.
    await sleep(1500);
    const kept = await project(app);
    assert.deepEqual([kept.nodes, kept.seed, kept.path], [Object.keys(first.doc.nodes).sort(), 78, later], 'the project that was saved is still the project');
    // The question names a project that has a file by the name of the file.
    await edit(79);
    await press(app, `${card('alpine-range')} [data-action="open"]`);
    await appears(app, QUESTION);
    assert.match(await app.eval<string>(`document.querySelector(${quote(QUESTION)}).textContent`), /Save the changes to saved-later\?/);
    // Save, where the project has a file: no dialog, the file is written, and the example opens.
    await press(app, `${QUESTION} [data-action="save"]`);
    await vanishes(app, QUESTION);
    await expectOpened(app, alpine);
    assert.equal(parseDoc(fs.readFileSync(later, 'utf8'), registry).doc.settings.seed, 79);
    // An example is no file: it is in no list of recent projects, and the project it replaced is.
    assert.deepEqual(await app.eval<string[]>(`orogenTest.shell.state.getState().preferences.recent`), [later, file]);
    await settled(app);
  });
});

test('examples: File > Open Example… shows the projects while the Library tab is behind another, and opens one', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready' && document.querySelectorAll('.dv-tab').length === 5`, 60_000);
    await settled(app);
    // The Build tab in front of the Library's: the panel is not in the document, and its component is mounted all the same.
    const showBuild = async (): Promise<void> => {
      await app.eval(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === 'Build'))`);
      await vanishes(app, '[data-panel="library"]');
    };
    await showBuild();

    await choose(app, 'File', 'library.browseExamples');
    await appears(app, '[data-dialog="library-examples"] [data-example]');
    const shown = await app.eval<{ ids: string[]; columns: number; pictures: number }>(`(() => {
      const cards = [...document.querySelectorAll('[data-dialog="library-examples"] [data-example]')];
      return {
        ids: cards.map((entry) => entry.getAttribute('data-example')),
        columns: new Set(cards.map((entry) => Math.round(entry.getBoundingClientRect().left))).size,
        pictures: cards.filter((entry) => entry.querySelector('img')?.complete && entry.querySelector('img').naturalWidth === 384).length,
      };
    })()`);
    assert.deepEqual(shown.ids, EXAMPLES.map((example) => example.id));
    assert.deepEqual([shown.columns, shown.pictures], [3, 6], 'three cards a row in the dialog, each with its picture');
    t.diagnostic(`capture: ${await capture(app, 'examples-04-dialog')}`);

    // The arrow keys move through the cards as they lie: down and up by a row of three, left and right by a card.
    const DIALOG_LIST = '[data-library="examples"][data-place="dialog"]';
    await focus(app, DIALOG_LIST);
    const walk: string[] = [];
    for (const code of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'End', 'ArrowUp', 'Home']) {
      await key(app, code);
      walk.push((await selectedExample(app, 'dialog'))!);
    }
    const ids = EXAMPLES.map((example) => example.id);
    assert.deepEqual(walk, [ids[0], ids[3], ids[3], ids[4], ids[1], ids[1], ids[0], ids[5], ids[2], ids[0]]);
    // "Open Selected Example" opens the card selected in the dialog, whatever tab the panel has behind it.
    assert.equal(await exists(app, '[data-library="examples"][data-place="panel"]'), false);
    await press(app, card('desert-canyons', 'dialog'));
    await run(app, 'library.openExample');
    await vanishes(app, '[data-dialog="library-examples"]');
    await expectOpened(app, EXAMPLES.find((example) => example.id === 'desert-canyons')!);
    await run(app, 'library.browseExamples');
    await appears(app, '[data-dialog="library-examples"] [data-example]');

    const island = EXAMPLES.find((example) => example.id === 'volcanic-island')!;
    await press(app, `${card('volcanic-island', 'dialog')} [data-action="open"]`);
    await vanishes(app, '[data-dialog="library-examples"]');
    await expectOpened(app, island);
    await settled(app);
    assert.deepEqual(await failures(app), []);

    // The dialog closes without opening anything, by its button and by Escape.
    await run(app, 'library.browseExamples');
    await appears(app, '[data-dialog="library-examples"]');
    await app.eval(`void shellTest.key('Escape', {}, '[data-dialog="library-examples"]')`);
    await vanishes(app, '[data-dialog="library-examples"]');
    await expectOpened(app, island);

    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'examples-05-opened-from-dialog')}`);

    // Behind another tab the panel is not in the document. What acts on a list nobody sees is disabled in the
    // menu; what shows a list brings the panel's tab to the front first (AppServices.showPanel).
    assert.equal(await exists(app, '[data-panel="library"]'), false);
    const menu = await openMenu(app, 'Library');
    assert.deepEqual(menu.filter((entry) => !entry.enabled).map((entry) => entry.id), ['library.addNode', 'library.expandAll', 'library.clearRecent', 'library.openExample']);
    await closeMenu(app);
    await choose(app, 'Library', 'library.showExamples');
    await appears(app, '[data-panel="library"] [data-library="examples"][data-place="panel"] [data-example]');
    assert.equal(await exists(app, '[data-dialog="library-examples"]'), false, 'in the panel, not in the dialog');
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'library', 'the panel that was brought to the front has the focus');
    // "Find Node…" from behind the Build tab: the Library comes to the front with the keyboard in its search field.
    await showBuild();
    await choose(app, 'Library', 'library.search');
    await appears(app, '[data-panel="library"] [data-library="search"]');
    await app.waitFor(`document.activeElement === document.querySelector('[data-library="search"]')`, 15_000);
    assert.equal(await exists(app, '[data-panel="build"]'), false, 'the build panel went behind it');
    await showBuild();
    await run(app, 'library.showNodes');
    await appears(app, '[data-panel="library"] [data-library="nodes"]');
    t.diagnostic(`capture: ${await capture(app, 'examples-06-brought-to-the-front')}`);
  });
});
