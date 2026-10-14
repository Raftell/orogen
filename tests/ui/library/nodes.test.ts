// The Nodes tab of the library in the real application, in a window that is never shown (testing.md 8.5): the
// catalogue by category, the search, the keyboard, the details of a node, and the two ways a node goes into the
// graph: a drag with the node type as its data, and the event that asks for a node now (runtime.md 8.7).
//
// The graph panel is another owner's. Where it is in the window (`[data-graph="root"]`), the tests hold it to
// the agreement: the node is in the document after the drop and after the event. Where it is not yet, they
// assert what the library sends, which is all the library does.
//
// The captures are written for a person (rule 1): ui/library/nodes-*.png.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import {
  added, appears, capture, closeMenu, docOf, focus, height, install, keeps, key, openMenu, press, pressTab, quote, rows, run, setLibraryWidth, settled, showLibrary, text, typeInto, vanishes, withApp,
} from './rig.ts';
import type { AppDriver } from '../../helpers/index.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PRODUCT = nodes.filter((def) => def.category !== 'ref');
const CATEGORIES = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io'];
const SEARCH = '[data-library="search"]';
const LIST = '[data-library="list"]';
const DETAILS = '[data-library="details"]';

const graphReady = (app: AppDriver): Promise<boolean> => app.eval<boolean>(`document.querySelector('[data-panel="graph"] [data-graph="root"]') !== null`);
const activeElement = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`document.activeElement?.getAttribute('data-library') ?? null`);
const selected = async (app: AppDriver): Promise<string | null> => {
  const row = (await rows(app)).find((candidate) => candidate.selected);
  return row ? row.node ?? `section:${row.section}` : null;
};
const detailsType = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`document.querySelector(${quote(DETAILS)}).getAttribute('data-type')`);
const nodesOfType = async (app: AppDriver, type: string): Promise<string[]> => Object.values((await docOf(app)).nodes).filter((node) => node.type === type).map((node) => node.id);
const rgb = (app: AppDriver, expression: string): Promise<string> => app.eval<string>(expression);

test('library: every product node is listed by category, in the color of its category, with its title and one line of description', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);

    const listed = await rows(app);
    assert.deepEqual(listed.filter((row) => row.section !== null).map((row) => row.section), CATEGORIES, 'the categories of engine.md 4.1, in its order; nothing was used yet');
    const types = listed.filter((row) => row.node !== null).map((row) => row.node!);
    assert.equal(types.length, PRODUCT.length);
    assert.deepEqual([...types].sort(), PRODUCT.map((def) => def.type).sort());
    assert.deepEqual(types.filter((type) => type.startsWith('ref/')), [], 'no reference node');
    assert.deepEqual(await app.eval(`[...document.querySelectorAll('[data-tab]')].map((tab) => tab.textContent)`), [`Nodes${PRODUCT.length}`, 'Examples6']);

    // A section and its nodes carry the color the theme gives the category (testing.md 6.7).
    for (const category of CATEGORIES) {
      const token = await rgb(app, `(() => {
        const probe = document.createElement('div');
        probe.style.color = 'var(--og-category-${category})';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      })()`);
      assert.match(token, /^rgb\(\d+, \d+, \d+\)$/);
      assert.equal(await rgb(app, `getComputedStyle(document.querySelector('[data-section="${category}"]')).backgroundColor`), token, `the header of ${category}`);
      const first = PRODUCT.filter((def) => def.category === category).map((def) => def.title).sort((a, b) => a.localeCompare(b, 'en'))[0]!;
      const row = `[data-row^="${category}:"]`;
      assert.equal(await text(app, `${row} [class*="nodeTitle"]`), first, `the nodes of ${category} are in the order of their titles`);
      assert.equal(await rgb(app, `getComputedStyle(document.querySelector('${row}')).borderLeftColor`), token, `the nodes of ${category}`);
    }

    // A row: the title and the description on one line each, cut where the panel ends.
    const blur = PRODUCT.find((def) => def.type === 'filter/blur')!;
    assert.equal(await text(app, '[data-node="filter/blur"] [class*="nodeTitle"]'), blur.title);
    assert.equal(await text(app, '[data-node="filter/blur"] [class*="nodeDescription"]'), blur.description);
    const line = await app.eval<{ wrap: string; overflow: string; rows: number; height: number }>(`(() => {
      const description = document.querySelector('[data-node="simulate/hydraulic-erosion"] [class*="nodeDescription"]');
      const style = getComputedStyle(description);
      return { wrap: style.whiteSpace, overflow: style.textOverflow, rows: description.getClientRects().length, height: description.closest('[data-node]').getBoundingClientRect().height };
    })()`);
    assert.deepEqual([line.wrap, line.overflow, line.rows], ['nowrap', 'ellipsis', 1]);
    assert.ok(line.height >= 30 && line.height <= 44, `a row is two lines high: ${line.height}`);
    // Nothing is selected, and the details say what to do.
    assert.equal(await selected(app), null);
    assert.equal(await detailsType(app), null);
    assert.match(await text(app, DETAILS), /Drag a node into the graph/);
    t.diagnostic(`capture: ${await capture(app, 'nodes-01-catalogue')}`);
  });
});

test('library: a search ranks titles first, finds a node by the name another tool uses, and selects the best hit', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);

    await typeInto(app, SEARCH, 'blur');
    let found = await rows(app);
    assert.deepEqual(found.slice(0, 4).map((row) => row.title), ['Blur', 'Slope Blur', 'Smart Blur', 'Directional Blur']);
    assert.ok(found.every((row) => row.section === null), 'a search has no sections');
    assert.equal(await selected(app), 'filter/blur', 'the best hit is selected');
    assert.equal(await text(app, '[data-node="filter/slope-blur"] [class*="nodeTitle"] strong'), 'Blur', 'what matched is marked');
    t.diagnostic(`capture: ${await capture(app, 'nodes-02-search')}`);

    // The name of another tool: the row says whose name it is, and the details list the names.
    await typeInto(app, SEARCH, 'erosion2');
    found = await rows(app);
    assert.deepEqual([found.length, found[0]!.node, found[0]!.match, found[0]!.selected], [1, 'simulate/hydraulic-erosion', 'Erosion2 in Gaea', true]);
    const erosion = PRODUCT.find((def) => def.type === 'simulate/hydraulic-erosion')!;
    assert.equal(await detailsType(app), erosion.type);
    assert.equal(await text(app, `${DETAILS} [data-library="description"]`), erosion.description, 'the whole description');
    const ports = await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${DETAILS} [data-port]`)})].map((port) => port.textContent)`);
    assert.deepEqual(ports, ['Interrain', 'Maskmask, optional', 'Precipitationmask, optional', 'Outterrain', 'Weardata', 'Depositdata', 'Flowdata']);
    const details = await text(app, DETAILS);
    assert.equal(await text(app, `${DETAILS} [data-library="elsewhere"]`), 'In other tools Gaea: Erosion2, Erosion, EasyErosion, Wizard · World Machine: Erosion · Houdini: HeightField Erode, HeightField Erode Hydro');
    assert.match(details, /Also found by rain, water, gully/);
    assert.match(details, /Reads the project's sea level/);
    t.diagnostic(`capture: ${await capture(app, 'nodes-03-other-names')}`);

    await typeInto(app, SEARCH, 'voronoi');
    assert.deepEqual((await rows(app)).slice(0, 2).map((row) => [row.node, row.match]), [['generate/cellular-noise', 'Voronoi in Gaea'], ['surface/cracks', 'voronoi']]);

    // Nothing found: the list says so, nothing is selected, and Escape or the button brings the catalogue back.
    await typeInto(app, SEARCH, 'qqqq');
    assert.equal((await rows(app)).length, 0);
    assert.match(await text(app, '[data-library="none"]'), /No node matches “qqqq”/);
    assert.equal(await detailsType(app), null);
    // A text far longer than any name is cut, and what was searched is said back on two lines at the most.
    await typeInto(app, SEARCH, 'W'.repeat(400));
    assert.equal(await app.eval<number>(`document.querySelector(${quote(SEARCH)}).value.length`), 80);
    assert.ok(await height(app, '[data-library="none"] [class*="noneTitle"]') <= 34, 'two lines');
    assert.equal(await app.eval<boolean>(`document.querySelector(${quote(LIST)}).scrollWidth <= document.querySelector(${quote(LIST)}).clientWidth`), true);
    await press(app, '[data-library="nodes"] [data-action="clear"]');
    assert.equal(await app.eval<string>(`document.querySelector(${quote(SEARCH)}).value`), '');
    assert.equal((await rows(app)).filter((row) => row.section !== null).length, CATEGORIES.length);
    await typeInto(app, SEARCH, 'slope');
    assert.equal(await selected(app), 'select/slope');
    await focus(app, SEARCH);
    await key(app, 'Escape');
    assert.equal(await app.eval<string>(`document.querySelector(${quote(SEARCH)}).value`), '');
    assert.equal(await selected(app), null, 'the hit of a search that ended is no longer selected');
  });
});

test('library: the keyboard moves through the list, folds a category, starts a search and adds a node', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);
    const ready = await graphReady(app);
    t.diagnostic(`the graph panel ${ready ? 'is in the window: it is held to the agreement' : 'is not built yet: the event alone is asserted'}`);

    // The keyboard is in the list before any row is selected: the list itself is ringed, and then the row is.
    const ring = (selector: string): Promise<string> => app.eval<string>(`getComputedStyle(document.querySelector(${quote(selector)})).boxShadow`);
    assert.equal(await ring(LIST), 'none');
    await focus(app, LIST);
    assert.notEqual(await ring(LIST), 'none', 'the focus is visible where nothing is selected');
    await key(app, 'ArrowDown');
    assert.equal(await selected(app), 'section:generate');
    assert.deepEqual([await ring(LIST), (await ring('[data-section="generate"]')) !== 'none'], ['none', true]);
    await key(app, 'ArrowDown');
    assert.equal(await selected(app), 'generate/canyon');
    assert.equal(await detailsType(app), 'generate/canyon', 'the selected node is described');
    assert.equal(await app.eval<string | null>(`document.querySelector(${quote(LIST)}).getAttribute('aria-activedescendant')`), 'library-row-generate-generate-canyon');
    await key(app, 'PageDown');
    assert.equal((await rows(app)).findIndex((row) => row.selected), 9);
    await key(app, 'End');
    assert.equal(await selected(app), 'io/export-landscape', 'the last node of the last category, by title');
    assert.ok(await app.eval<boolean>(`(() => {
      const list = document.querySelector(${quote(LIST)}).getBoundingClientRect();
      const row = document.querySelector('[data-node="io/export-landscape"]').getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom + 1;
    })()`), 'the selected row is scrolled into view');
    await key(app, 'Home');
    assert.equal(await selected(app), 'section:generate');

    // Left on a node goes to its category, left there folds it, right unfolds it; the fold is kept for the next start.
    await key(app, 'ArrowDown');
    await key(app, 'ArrowLeft');
    assert.equal(await selected(app), 'section:generate');
    const before = (await rows(app)).length;
    await key(app, 'ArrowLeft');
    let listed = await rows(app);
    assert.deepEqual([listed.length, listed[0]!.open, listed[1]!.section], [before - 16, 'false', 'adjust']);
    await keeps(app, 'collapsed', ['generate']);
    await key(app, 'Enter');
    assert.equal((await rows(app)).length, before, 'Enter on a category unfolds it');
    await key(app, 'Space');
    await key(app, 'ArrowRight');
    listed = await rows(app);
    assert.deepEqual([listed.length, listed[0]!.open], [before, 'true']);
    await key(app, 'ArrowRight');
    assert.equal(await selected(app), 'generate/canyon', 'right on an open category enters it');
    t.diagnostic(`capture: ${await capture(app, 'nodes-04-keyboard')}`);

    // A letter typed on the list is the start of a search, and the keyboard is then in the search field.
    await key(app, 'KeyT');
    assert.equal(await activeElement(app), 'search');
    assert.equal(await app.eval<string>(`document.querySelector(${quote(SEARCH)}).value`), 't');
    // Backspace on the list takes the last letter back, as a letter typed there adds one.
    await typeInto(app, SEARCH, 'erosionx');
    await focus(app, LIST);
    await key(app, 'Backspace');
    assert.deepEqual([await app.eval<string>(`document.querySelector(${quote(SEARCH)}).value`), await activeElement(app)], ['erosion', 'search']);
    assert.equal(await selected(app), 'simulate/fluvial-erosion', 'the best hit; of equal hits the first of the catalogue');
    // Down and up in the search field move the selection; the field keeps the keyboard.
    await key(app, 'ArrowDown');
    assert.equal(await selected(app), 'simulate/thermal-erosion');
    await key(app, 'ArrowUp');
    assert.equal(await selected(app), 'simulate/fluvial-erosion');
    await key(app, 'ArrowDown');
    assert.equal(await activeElement(app), 'search');

    // Enter adds the selected node: the library asks, the graph adds it and selects it (8.7 rule 8).
    const had = await nodesOfType(app, 'simulate/thermal-erosion');
    await key(app, 'Enter');
    assert.deepEqual(await added(app), [{ type: 'simulate/thermal-erosion' }]);
    if (ready) {
      const now = await nodesOfType(app, 'simulate/thermal-erosion');
      assert.equal(now.length, had.length + 1, 'the graph added the node');
      const id = now.find((candidate) => !had.includes(candidate))!;
      assert.deepEqual(await app.eval(`orogenTest.ctx.ui.getState().selection`), [id], 'and selected it');
      // The node that was added is the newest of the recently used, which the list shows when the search ends.
      await keeps(app, 'recent', ['simulate/thermal-erosion']);
    }

    // Mod+F in the panel: the search field has the keyboard and its text is selected to be typed over.
    await focus(app, LIST);
    await key(app, 'KeyF', { ctrl: true });
    assert.equal(await activeElement(app), 'search');
    assert.deepEqual(await app.eval(`[document.activeElement.selectionStart, document.activeElement.selectionEnd]`), [0, 7]);
  });
});

test('library: the node under the pointer is described while the pointer moves over the list; the selected one otherwise, and it is what the button adds', async () => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);
    const addShown = (): Promise<boolean> => app.eval<boolean>(`getComputedStyle(document.querySelector(${quote(`${DETAILS} [data-action="add"]`)})).visibility === 'visible'`);
    const describes = (type: string): Promise<void> => app.waitFor(`document.querySelector(${quote(DETAILS)}).getAttribute('data-type') === ${quote(type)}`);

    await press(app, '[data-node="generate/dunes"]');
    assert.equal(await selected(app), 'generate/dunes', 'a press selects');
    assert.equal(await detailsType(app), 'generate/dunes');
    assert.equal(await addShown(), true);

    const rested = await app.eval<{ clientX: number; clientY: number }>(`libraryTest.moveOn('[data-node="generate/island"]')`);
    await describes('generate/island');
    assert.equal(await selected(app), 'generate/dunes', 'looking at a node does not select it');
    const island = nodes.find((def) => def.type === 'generate/island')!;
    assert.equal(await text(app, `${DETAILS} [data-library="description"]`), island.description);
    assert.deepEqual(await app.eval(`[...document.querySelectorAll(${quote(`${DETAILS} [data-port]`)})].map((port) => port.textContent)`), ['Outterrain', 'Watermask']);
    assert.match(await text(app, DETAILS), /None: it starts a graph/);
    assert.equal(await addShown(), false, 'the button adds the selected node: a node that is only looked at has none');

    // The list scrolls under a pointer that rests: another row is at its place, and nothing else is described.
    await app.eval(`void libraryTest.moveAt('[data-node="generate/mountain"]', ${JSON.stringify(rested)})`);
    await app.eval(`void libraryTest.moveAt('[data-node="generate/volcano"]', ${JSON.stringify(rested)})`);
    assert.equal(await detailsType(app), 'generate/island');

    // A key ends the look: the keyboard works on the selected node, and that is the node described.
    await focus(app, LIST);
    await key(app, 'ArrowDown');
    assert.equal(await selected(app), 'generate/eroded-noise');
    await describes('generate/eroded-noise');
    await app.eval(`void libraryTest.moveAt('[data-node="generate/volcano"]', ${JSON.stringify(rested)})`);
    assert.equal(await detailsType(app), 'generate/eroded-noise', 'and the resting pointer does not take it back');

    // The pointer moves again, over another node, and then down to the button of the details: on its way it has
    // left the list, the selected node is described again, and that is the node the button adds.
    await app.eval(`void libraryTest.moveOn('[data-node="generate/volcano"]')`);
    await describes('generate/volcano');
    await app.eval(`void libraryTest.leave('[data-node="generate/volcano"]', ${quote(`${DETAILS} [data-action="add"]`)})`);
    await describes('generate/eroded-noise');
    assert.equal(await addShown(), true);
    await press(app, `${DETAILS} [data-action="add"]`);
    assert.deepEqual(await added(app), [{ type: 'generate/eroded-noise' }]);

    // Nothing selected: the details describe the node under the pointer, and say what to do when it has left.
    await typeInto(app, SEARCH, 'zzzz');
    await typeInto(app, SEARCH, '');
    assert.equal(await selected(app), null);
    await app.eval(`void libraryTest.moveOn('[data-node="generate/canyon"]')`);
    await describes('generate/canyon');
    await app.eval(`void libraryTest.leave('[data-node="generate/canyon"]', ${quote(DETAILS)})`);
    await app.waitFor(`document.querySelector(${quote(DETAILS)}).getAttribute('data-type') === null`);
    assert.match(await text(app, DETAILS), /Drag a node into the graph/);
    assert.deepEqual(await added(app), [{ type: 'generate/eroded-noise' }], 'nothing more was added');
  });
});

test('library: the details keep their height whatever they show, the bar above them sets it, and a narrow or low panel still shows the list', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);
    const SPLITTER = '[data-library="splitter"]';
    /** The height the preferences file holds, once it holds `height`: the entry is written a moment after it changes. */
    const kept = async (height: number | null): Promise<number | null> => {
      await keeps(app, 'detailsHeight', height);
      return height;
    };

    // Before the details have described a node they are the one line of their hint, and the list has the room:
    // at first start the panel showed four nodes above an empty box.
    const rest = await height(app, DETAILS);
    const listAtRest = await height(app, LIST);
    assert.ok(rest >= 20 && rest <= 48, `the hint alone: ${rest}`);
    assert.ok(listAtRest >= 6 * 38, `the list has the room at first start: ${listAtRest}`);
    t.diagnostic(`capture: ${await capture(app, 'nodes-07-first-start')}`);
    // From the first node on: the same height for a small node, the node with the most to say and the hint, so
    // that the list does not move as the pointer does.
    await press(app, '[data-node="generate/constant"]');
    const empty = await height(app, DETAILS);
    assert.ok(empty >= 150 && empty <= 264, `the details of the default window: ${empty}`);
    assert.equal(await height(app, LIST), listAtRest - (empty - rest), 'the details took their room from the list');
    await press(app, '[data-node="simulate/hydraulic-erosion"]');
    assert.equal(await height(app, DETAILS), empty);
    const list = await height(app, LIST);

    // A drag of the bar upward makes the details higher by as much and the list lower; the height is kept.
    await app.eval(`void libraryTest.dragY(${quote(SPLITTER)}, -90)`);
    await app.waitFor(`shellTest.rect(${quote(DETAILS)}).height === ${empty + 90}`);
    assert.equal(await height(app, LIST), list - 90);
    assert.equal(await kept(empty + 90), empty + 90);
    // With the room, the node with the most to say is shown whole.
    assert.equal(await app.eval<boolean>(`(() => { const details = document.querySelector(${quote(DETAILS)}); return details.scrollHeight <= details.clientHeight; })()`), true, 'nothing of Hydraulic Erosion is below the fold');
    t.diagnostic(`capture: ${await capture(app, 'nodes-08-details-resized')}`);

    // The arrow keys on the bar, a step each; a press without a move changes nothing.
    await focus(app, SPLITTER);
    await key(app, 'ArrowDown');
    assert.deepEqual([await height(app, DETAILS), await kept(empty + 74)], [empty + 74, empty + 74]);
    await key(app, 'ArrowUp');
    await press(app, SPLITTER);
    assert.equal(await kept(empty + 90), empty + 90);

    // Dragged as far as it goes either way: four rows of the list stay, and the details stay high enough to read.
    await app.eval(`void libraryTest.dragY(${quote(SPLITTER)}, -3000)`);
    const row = await height(app, '[data-node="simulate/hydraulic-erosion"]');
    await app.waitFor(`shellTest.rect(${quote(LIST)}).height < ${list - 90}`);
    const least = await height(app, LIST);
    assert.ok(Math.abs(least - 4 * row) <= 2, `the list keeps four rows: ${least} of rows of ${row}`);
    await app.eval(`void libraryTest.dragY(${quote(SPLITTER)}, 3000)`);
    await app.waitFor(`shellTest.rect(${quote(DETAILS)}).height < ${empty}`);
    assert.ok(await height(app, DETAILS) >= 72);

    // A double-click, or Home, gives the height back to the panel.
    await app.eval(`void libraryTest.doubleClick(${quote(SPLITTER)})`);
    await app.waitFor(`shellTest.rect(${quote(DETAILS)}).height === ${empty}`);
    assert.equal(await kept(null), null);
    await app.eval(`void libraryTest.dragY(${quote(SPLITTER)}, -40)`);
    await focus(app, SPLITTER);
    await key(app, 'Home');
    assert.deepEqual([await height(app, DETAILS), await kept(null)], [empty, null]);

    // A narrow panel: the title of the node is whole, the ports are one below the other, nothing is wider than the panel.
    const width = await setLibraryWidth(app, 230);
    await press(app, '[data-node="simulate/hydraulic-erosion"]');
    const narrow = await app.eval<{ title: string; titleFits: boolean; overflow: number; portColumns: number; addRight: number; right: number }>(`(() => {
      const details = document.querySelector(${quote(DETAILS)});
      const title = details.querySelector('h3');
      const ports = [...details.querySelectorAll('[data-port]')];
      return {
        title: title.textContent,
        titleFits: title.scrollWidth <= title.clientWidth,
        overflow: Math.max(details.scrollWidth - details.clientWidth, document.querySelector(${quote(LIST)}).scrollWidth - document.querySelector(${quote(LIST)}).clientWidth),
        portColumns: new Set(ports.map((port) => Math.round(port.getBoundingClientRect().left))).size,
        addRight: details.querySelector('[data-action="add"]').getBoundingClientRect().right,
        right: details.getBoundingClientRect().right,
      };
    })()`);
    assert.deepEqual([narrow.title, narrow.titleFits, narrow.overflow, narrow.portColumns], ['Hydraulic Erosion', true, 0, 1], `at a width of ${width}`);
    assert.ok(narrow.addRight <= narrow.right, 'the button is inside the panel');
    t.diagnostic(`capture: ${await capture(app, 'nodes-09-narrow')}`);
  });
});

test('library: a node is dragged out with its type as the data of the drag, and a double-click asks the graph for it', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);
    const ready = await graphReady(app);
    t.diagnostic(`the graph panel ${ready ? 'is in the window: the drop is held to the agreement' : 'is not built yet: the data of the drag alone is asserted'}`);

    assert.equal(await app.eval<boolean>(`document.querySelector('[data-node="filter/blur"]').draggable`), true);
    const drag = await app.eval<{ started: boolean; types: string[]; node: string; text: string; effectAllowed: string }>(`libraryTest.dragStart('[data-node="filter/blur"]')`);
    // runtime.md 8.7: type "application/x-orogen-node", the node type id as text, effectAllowed "copy".
    assert.equal(drag.started, true, 'the drag is not prevented');
    assert.ok(drag.types.includes('application/x-orogen-node'));
    assert.deepEqual([drag.node, drag.effectAllowed, drag.text], ['filter/blur', 'copy', 'filter/blur']);
    assert.equal(await selected(app), 'filter/blur', 'the dragged node is the selected one');

    const had = await nodesOfType(app, 'filter/blur');
    const drop = await app.eval<{ accepted: boolean; over: string | null }>(`libraryTest.dropOn('[data-panel="graph"]', 0.25, 0.3)`);
    assert.equal(drop.over, 'graph');
    if (ready) {
      assert.equal(drop.accepted, true, 'the graph takes a drag of this type');
      const now = await nodesOfType(app, 'filter/blur');
      assert.equal(now.length, had.length + 1, 'the graph added the node where it was dropped');
      assert.deepEqual(await app.eval(`orogenTest.ctx.doc.getState().past.length`), 1, 'in one step that can be undone');
      await appears(app, '[data-section="recent"]');
      assert.deepEqual((await rows(app)).slice(0, 2).map((row) => row.section ?? row.node), ['recent', 'filter/blur']);
    } else {
      assert.equal(drop.accepted, false, 'nothing takes the drag yet');
      assert.equal((await nodesOfType(app, 'filter/blur')).length, had.length);
    }
    // A drop anywhere else is nobody's: the viewport does not take a node.
    await app.eval(`libraryTest.dragStart('[data-node="filter/sharpen"]')`);
    const elsewhere = await app.eval<{ accepted: boolean }>(`libraryTest.dropOn('[data-shell="statusbar"], .og-statusbar')`);
    assert.equal(elsewhere.accepted, false);
    assert.deepEqual(await nodesOfType(app, 'filter/sharpen'), []);

    // A double-click asks for the node now.
    await app.eval(`void libraryTest.doubleClick('[data-row="filter:filter/median"]')`);
    assert.deepEqual(await added(app), [{ type: 'filter/median' }]);
    if (ready) {
      assert.equal((await nodesOfType(app, 'filter/median')).length, 1);
      assert.deepEqual((await rows(app)).slice(0, 3).map((row) => row.section ?? row.node), ['recent', 'filter/median', 'filter/blur'], 'newest first');
      // Undo takes the node out of the graph; what was used stays in the list.
      await app.eval(`void orogenTest.ctx.run('edit.undo')`);
      assert.deepEqual(await nodesOfType(app, 'filter/median'), []);
      await keeps(app, 'recent', ['filter/median', 'filter/blur']);
    }
    t.diagnostic(`capture: ${await capture(app, 'nodes-05-after-adding')}`);
  });
});

test('library: the recent nodes follow the document while another tab is in front, whoever adds the node', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready' && document.querySelectorAll('.dv-tab').length === 5`, 60_000);
    await settled(app);
    // The Build tab is in front of the Library's: the dock holds the library's component all the same.
    await pressTab(app, 'Build');
    await vanishes(app, '[data-panel="library"]');
    // A node added as the graph's own palette adds one: a transaction of the document, with a command of 4.6.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Add Terraces', (draft) => {
      draft.nodes.added = { id: 'added', type: 'surface/terraces', version: 1, position: { x: 400, y: 0 }, params: {} };
    })`);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Add a Reference Node', (draft) => {
      draft.nodes.reference = { id: 'reference', type: 'ref/blur', version: 1, position: { x: 400, y: 300 }, params: {} };
    })`);
    // A reference node is none of the library.
    await keeps(app, 'recent', ['surface/terraces']);

    await showLibrary(app);
    const listed = await rows(app);
    assert.deepEqual(listed.slice(0, 3).map((row) => row.section ?? row.node), ['recent', 'surface/terraces', 'generate']);
    assert.deepEqual([listed[0]!.title, listed[0]!.open], ['Recently Used', 'true']);
    // The node is listed twice, in the color of its category both times, and each row is selected by itself.
    await press(app, '[data-row="recent:surface/terraces"]');
    assert.deepEqual((await rows(app)).filter((row) => row.selected).length, 1);
    assert.equal(
      await app.eval<string>(`getComputedStyle(document.querySelector('[data-row="recent:surface/terraces"]')).borderLeftColor`),
      await app.eval<string>(`getComputedStyle(document.querySelector('[data-row="surface:surface/terraces"]')).borderLeftColor`),
    );
    t.diagnostic(`capture: ${await capture(app, 'nodes-06-recently-used')}`);

    await run(app, 'library.clearRecent');
    await vanishes(app, '[data-section="recent"]');
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.run('library.clearRecent') === undefined`), true, 'the command with nothing to clear does nothing');
    await keeps(app, 'recent', []);
    // What the panel keeps is its entry of the preferences file, whole, beside the entries of the other panels
    // (runtime.md 8.6); nothing of it is in the page's own storage.
    const entry = await app.eval<Record<string, unknown>>(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.panels.library)`);
    assert.deepEqual(Object.keys(entry).sort(), ['collapsed', 'detailsHeight', 'recent', 'tab']);
    assert.deepEqual(await app.eval<string[]>(`Object.keys(localStorage).filter((key) => key.startsWith('orogen'))`), []);
  });
});

test('library: the commands of the panel run from its key, its menus and the palette of commands', async (t) => {
  await withApp({}, async (app) => {
    await install(app);
    await showLibrary(app);
    await settled(app);

    // The menu bar: the panel's own menu, and Open Example… with the other ways to open a project.
    const file = await openMenu(app, 'File');
    assert.deepEqual(file.slice(0, 4).map((item) => item.id), ['file.new', 'file.open', 'file.openRecent', 'library.browseExamples']);
    assert.equal(file[3]!.label, 'Open Example…');
    await closeMenu(app);
    const menu = await openMenu(app, 'Library');
    assert.deepEqual(menu.map((item) => item.id), [
      'library.search', 'library.addNode', 'library.showNodes', 'library.showExamples', 'library.expandAll', 'library.collapseAll', 'library.clearRecent', 'library.openExample',
    ]);
    const item = (id: string) => menu.find((entry) => entry.id === id)!;
    assert.deepEqual([item('library.search').label, item('library.search').key, item('library.search').enabled], ['Find Node…', 'Ctrl+F', true]);
    // What has nothing to act on is disabled: no node and no example is selected, nothing is folded or used.
    assert.deepEqual(menu.filter((entry) => !entry.enabled).map((entry) => entry.id), ['library.addNode', 'library.expandAll', 'library.clearRecent', 'library.openExample']);
    t.diagnostic(`capture: ${await capture(app, 'nodes-07-library-menu')}`);
    await closeMenu(app);

    // The panel's own menu holds the same commands.
    await press(app, '[data-library="root"] [data-action="menu"]');
    await appears(app, '[data-ui="menu"] [data-item="library.collapseAll"]');
    await press(app, '[data-ui="menu"] [data-item="library.collapseAll"]');
    await vanishes(app, '[data-ui="menu"]');
    assert.deepEqual((await rows(app)).map((row) => [row.section, row.open]), CATEGORIES.map((category) => [category, 'false']));
    await run(app, 'library.expandAll');
    assert.equal((await rows(app)).length, CATEGORIES.length + PRODUCT.length);

    // The two tabs of the panel: by their commands, and by the arrow keys on the tab that has the keyboard.
    await focus(app, '[data-tab="nodes"]');
    await key(app, 'ArrowRight');
    await appears(app, '[data-library="examples"][data-place="panel"]');
    assert.deepEqual(await app.eval(`[document.activeElement.getAttribute('data-tab'), document.activeElement.getAttribute('aria-selected')]`), ['examples', 'true']);
    await keeps(app, 'tab', 'examples');
    await key(app, 'ArrowLeft');
    await appears(app, LIST);
    await run(app, 'library.showExamples');
    await appears(app, '[data-library="examples"][data-place="panel"]');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-library="nodes"]') === null`), true);
    await run(app, 'library.search');
    await appears(app, SEARCH);
    assert.equal(await activeElement(app), 'search', 'Find Node… shows the nodes and puts the keyboard into the search field');
    // The request is answered once: the node list that comes back after a look at the examples leaves the keyboard where it is.
    await focus(app, '[data-tab="nodes"]');
    await press(app, '[data-tab="examples"]');
    await appears(app, '[data-library="examples"][data-place="panel"]');
    await press(app, '[data-tab="nodes"]');
    await appears(app, SEARCH);
    assert.equal(await activeElement(app), null);
    await run(app, 'library.showNodes');

    await press(app, '[data-node="adjust/levels"]');
    await run(app, 'library.addNode');
    assert.deepEqual(await added(app), [{ type: 'adjust/levels' }]);

    // testing.md 5.6 rule 3: every command the panel declares runs in a hidden-window test of this folder.
    const declared = [...fs.readFileSync(path.join(ROOT, 'src/app/panels/library/index.ts'), 'utf8').matchAll(/\bid: '(library\.\w+)'/g)].map((found) => found[1]!);
    assert.equal(declared.length, 9);
    const tests = ['nodes.test.ts', 'examples.test.ts'].map((file) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')).join('\n');
    const never = declared.filter((id) => !tests.includes(`run(app, '${id}')`) && !tests.includes(`[data-item="${id}"]`) && !tests.includes(`'${id}')`));
    assert.deepEqual(never, [], 'commands no test runs');
  });
});
