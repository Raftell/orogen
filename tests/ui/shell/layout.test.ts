// The dock in the window (runtime.md 8.7 rules 3 and 7): the default arrangement made from the panels'
// placements, with the inspector docked apart so that a selected node always shows its parameters; a panel that
// owns a canvas staying in the document while its tab is behind another; the least a divider makes a panel; and
// the layout saved to the preferences whenever it changes and restored from them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Preferences } from '../../../src/platform/electron/ipc.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { appears, capture, docked, exists, PAGE_BACKSTOP_MS, quote, ready, run, settled, vanishes, withApp } from './rig.ts';

interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Leaf { type: 'leaf'; data: { views: string[]; activeView: string; id: string }; size: number }
interface Branch { type: 'branch'; data: (Leaf | Branch)[]; size: number }
interface Layout { version: number; dock: { grid: { root: Branch; width: number; height: number; orientation: string }; panels: Record<string, { id: string; renderer?: string; title?: string }>; activeGroup?: string } }

const rect = (app: AppDriver, panel: string): Promise<Rect> => app.eval<Rect>(`shellTest.rect('[data-panel="${panel}"]')`);
const layout = (app: AppDriver): Promise<Layout> => app.eval<Layout>(`orogenTest.shell.layout()`);
const savedLayout = async (app: AppDriver): Promise<Layout | null> => (await app.eval<Preferences>(`orogenTest.ctx.platform.getPreferences()`)).layout as Layout | null;
/** The widths of the left column and the side column, as the layout holds them. */
const columns = (held: Layout): number[] => held.dock.grid.root.data.map((part) => part.size);
/** The group of a layout that holds a panel, wherever it is in the grid. */
function groupOf(part: Leaf | Branch, panel: string): Leaf | null {
  if (part.type === 'leaf') return part.data.views.includes(panel) ? part : null;
  for (const child of part.data) {
    const found = groupOf(child, panel);
    if (found) return found;
  }
  return null;
}
/** In the page: the tab in front of the group that holds `panel`, as the preferences file has it. */
const SAVED_FRONT = (panel: string): string => `orogenTest.ctx.platform.getPreferences().then((preferences) => {
  const find = (part) => (part.type === 'leaf' ? (part.data.views.includes(${quote(panel)}) ? part : null) : part.data.map(find).find((leaf) => leaf !== null) ?? null);
  return find(preferences.layout.dock.grid.root)?.data.activeView ?? null;
})`;
const tabs = (app: AppDriver): Promise<{ title: string; active: boolean; x: number; y: number }[]> => app.eval(`[...document.querySelectorAll('.dv-tab')].map((tab) => {
  const box = tab.getBoundingClientRect();
  return { title: tab.textContent, active: tab.classList.contains('dv-active-tab'), x: Math.round(box.x), y: Math.round(box.y) };
})`);
const pressTab = (app: AppDriver, title: string): Promise<void> =>
  app.eval<void>(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === ${quote(title)}))`);
/** Drags the sash between the left column and the side column. */
const dragSideSash = (app: AppDriver, dx: number): Promise<void> =>
  app.eval<void>(`void shellTest.drag([...document.querySelectorAll('.dv-sash')].find((sash) => sash.getBoundingClientRect().height > 500), ${dx})`);

test('layout: the default arrangement has the viewport above the graph, and at the right the inspector above the library and the build panel', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const [viewport, graph, inspector, library] = [await rect(app, 'viewport'), await rect(app, 'graph'), await rect(app, 'inspector'), await rect(app, 'library')];
    const window = await app.eval<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);

    // The left column: the viewport above, the graph below and at least as tall, both as wide as the column.
    assert.ok(Math.abs(viewport.x - graph.x) <= 1 && Math.abs(viewport.width - graph.width) <= 1, 'the viewport and the graph share a column');
    assert.ok(viewport.y < graph.y && graph.y >= viewport.y + viewport.height, 'the graph is below the viewport');
    assert.ok(graph.height >= viewport.height - 1 && graph.height > window.height * 0.4, `the graph is large: ${graph.height} of ${window.height}`);
    assert.ok(graph.width > window.width * 0.7, 'and wide');
    // The side column, at the right of both: the inspector above, the library below it, each as wide as the column.
    assert.ok(inspector.x >= viewport.x + viewport.width && inspector.x >= graph.x + graph.width, 'the inspector is right of both');
    assert.ok(Math.abs(inspector.x - library.x) <= 1 && Math.abs(inspector.width - library.width) <= 1, 'the inspector and the library share a column');
    assert.ok(library.y >= inspector.y + inspector.height, 'the library is below the inspector');
    assert.ok(inspector.height > library.height && library.height > window.height * 0.3, `the inspector keeps the larger part: ${inspector.height} over ${library.height}`);
    assert.ok(inspector.height + library.height >= viewport.height + graph.height - 40, 'together over the whole height');
    assert.ok(inspector.width >= 300 && inspector.width <= 440);
    assert.ok(Math.abs(inspector.x + inspector.width - window.width) <= 6, 'at the edge of the window');

    // The inspector has a group of its own; the library and the build panel are the two tabs below it, the library in front.
    const strip = await tabs(app);
    const side = strip.filter((tab) => tab.x >= inspector.x);
    assert.deepEqual(side.map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Inspector*', 'Library*', 'Build']);
    assert.ok(side[1]!.y === side[2]!.y && side[0]!.y < side[1]!.y, 'two strips of tabs, one above the other');
    assert.deepEqual(strip.filter((tab) => tab.x < inspector.x).map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Viewport*', 'Graph*']);
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'graph', 'the graph has the focus at start');
    const held = await layout(app);
    assert.deepEqual(groupOf(held.dock.grid.root, 'inspector')!.data.views, ['inspector'], 'no panel shares the inspector\'s group');
    assert.deepEqual(groupOf(held.dock.grid.root, 'library')!.data.views, ['library', 'build']);

    // A panel cannot be closed: no tab has a close button.
    assert.equal(await app.eval<number>(`[...document.querySelectorAll('.dv-tab .dv-default-tab-action')].filter((action) => action.getBoundingClientRect().width > 0).length`), 0);

    // The panel behind a tab is not in the document; chosen, it is, and the one in front before is not.
    assert.deepEqual([await exists(app, '[data-panel="library"] [data-library="root"]'), await exists(app, '[data-panel="build"]')], [true, false]);
    await pressTab(app, 'Build');
    await appears(app, '[data-panel="build"] [data-build="panel"]');
    await vanishes(app, '[data-panel="library"]');
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'build', 'choosing a tab gives its panel the focus');
    assert.equal(await exists(app, '[data-panel="inspector"]'), true, 'the inspector is in view whichever of the two is in front');
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-panel] .og-empty-title').length`), 0, 'no panel is a placeholder');

    // A node selected while the Build tab, and then the Library tab, is in front shows its parameters: no tab changes.
    const nodeId = await app.eval<string>(`Object.keys(orogenTest.ctx.doc.getState().doc.nodes)[0]`);
    assert.equal(await app.eval<string>(`shellTest.attr('[data-panel="inspector"] [data-inspector]', 'data-inspector')`), 'settings');
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [${quote(nodeId)}] })`);
    await appears(app, '[data-panel="inspector"] [data-inspector="nodes"] [data-inspector-header="generate/mountain-range"]');
    assert.equal(await exists(app, '[data-panel="build"] [data-build="panel"]'), true, 'the build panel stays where the user had it');
    await pressTab(app, 'Library');
    await appears(app, '[data-panel="library"] [data-library="root"]');
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [] })`);
    await appears(app, '[data-panel="inspector"] [data-inspector="settings"]');
    await app.eval(`void orogenTest.ctx.ui.setState({ selection: [${quote(nodeId)}] })`);
    await appears(app, '[data-panel="inspector"] [data-inspector-header="generate/mountain-range"]');
    assert.equal(await exists(app, '[data-panel="library"] [data-library="root"]'), true);
    assert.deepEqual((await tabs(app)).filter((tab) => tab.active).map((tab) => tab.title).sort(), ['Graph', 'Inspector', 'Library', 'Viewport']);
    t.diagnostic(`capture: ${await capture(app, 'layout-default-node-selected')}`);

    // The layout names the renderer of each panel: 'always' for the two that own a canvas.
    assert.equal(held.version, 1);
    assert.deepEqual(Object.keys(held.dock.panels).sort(), ['build', 'graph', 'inspector', 'library', 'viewport']);
    assert.deepEqual([held.dock.panels.viewport!.renderer, held.dock.panels.graph!.renderer], ['always', 'always']);
    for (const panel of ['inspector', 'library', 'build']) assert.notEqual(held.dock.panels[panel]!.renderer, 'always', panel);
  });
});

test('layout: no divider makes a panel narrower than 220 pixels, by a drag or by the dock\'s own call, and a layout saved without the minimum gets it', async () => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const before = await rect(app, 'inspector');
    const total = (await rect(app, 'graph')).width + before.width;

    // The sash between the columns, dragged as far to the right as the window goes: the side column stops at its least.
    await dragSideSash(app, 2000);
    await app.waitFor(`shellTest.rect('[data-panel="inspector"]').width < ${before.width}`, PAGE_BACKSTOP_MS);
    assert.equal(Math.round((await rect(app, 'inspector')).width), 220);
    assert.equal(Math.round((await rect(app, 'library')).width), 220, 'the tabs below it are in the same column');
    // And as far to the left: the graph and the viewport keep theirs.
    await dragSideSash(app, -4000);
    await app.waitFor(`shellTest.rect('[data-panel="graph"]').width < 400`, PAGE_BACKSTOP_MS);
    assert.equal(Math.round((await rect(app, 'graph')).width), 220);
    assert.ok(Math.abs((await rect(app, 'inspector')).width - (total - 220)) <= 8);

    // What a test sets a panel's size with (testing.md 8.5) holds to the same least.
    await app.eval(`void orogenTest.shell.dock.setSize('inspector', { width: 90 })`);
    await app.waitFor(`Math.round(shellTest.rect('[data-panel="inspector"]').width) === 220`, PAGE_BACKSTOP_MS);
    await app.eval(`void orogenTest.shell.dock.setSize('inspector', { width: 400, height: 300 })`);
    await app.waitFor(`Math.round(shellTest.rect('[data-panel="inspector"]').width) === 400`, PAGE_BACKSTOP_MS);
    const sized = await app.eval<{ width: number; height: number }>(`orogenTest.shell.dock.size('inspector')`);
    assert.ok(Math.abs(sized.width - 400) <= 1 && Math.abs(sized.height - 300) <= 1, JSON.stringify(sized));
    assert.equal(await app.eval<null>(`orogenTest.shell.dock.size('no-such-panel')`), null);

    // A layout of a build that knew no minimum, with a side column of 120: restored, the column has its least.
    const narrow: Layout = structuredClone(await layout(app));
    for (const panel of Object.values(narrow.dock.panels) as Record<string, unknown>[]) {
      delete panel.minimumWidth;
      delete panel.minimumHeight;
    }
    const [left, side] = narrow.dock.grid.root.data as [Branch, Branch];
    left.size += side.size - 120;
    side.size = 120;
    await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(narrow)} })`);
    assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'restored');
    await app.waitFor(`document.querySelectorAll('.dv-tab').length === 5 && shellTest.exists('[data-panel="inspector"]')`, PAGE_BACKSTOP_MS);
    await app.waitFor(`Math.round(shellTest.rect('[data-panel="inspector"]').width) >= 220`, PAGE_BACKSTOP_MS);
    const restored = await layout(app);
    assert.deepEqual(Object.values(restored.dock.panels).map((panel) => (panel as { minimumWidth?: number }).minimumWidth), [220, 220, 220, 220, 220]);
  });
});

test('layout: a panel that owns a canvas stays in the document while its tab is behind another', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);

    // A layout in which the viewport is a tab of the side column, behind the library: the left column is the graph alone.
    const held = await layout(app);
    const moved: Layout = structuredClone(held);
    const [left, side] = moved.dock.grid.root.data as [Branch, Branch];
    const graph = left.data.find((part): part is Leaf => part.type === 'leaf' && part.data.views.includes('graph'))!;
    const below = groupOf(side, 'library')!;
    below.data.views = [...below.data.views, 'viewport'];
    below.data.activeView = 'library';
    moved.dock.grid.root.data = [{ ...graph, size: left.size }, side];
    await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(moved)} })`);
    assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'restored');
    await app.waitFor(`document.querySelectorAll('.dv-tab').length === 5`, PAGE_BACKSTOP_MS);
    const side2 = (await tabs(app)).filter((tab) => tab.title !== 'Graph');
    assert.deepEqual(side2.map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Inspector*', 'Library*', 'Build', 'Viewport']);

    // Behind its tab the viewport is still in the document, with its canvas; the build panel, which owns none, is not.
    await appears(app, '[data-panel="viewport"] canvas');
    assert.equal(await exists(app, '[data-panel="build"]'), false);
    await app.eval(`void (window.keptCanvas = document.querySelector('[data-panel="viewport"] canvas'))`);
    assert.equal(await app.eval<boolean>(`window.keptCanvas.isConnected`), true);
    const hidden = await rect(app, 'viewport');
    assert.ok(hidden.width === 0 || (await app.eval<string>(`getComputedStyle(shellTest.el('[data-panel="viewport"]').closest('.dv-render-overlay') ?? shellTest.el('[data-panel="viewport"]')).display`)) === 'none'
      || (await app.eval<boolean>(`!shellTest.el('[data-panel="viewport"]').checkVisibility({ visibilityProperty: true })`)), 'and it is not shown');

    // Brought to the front and sent back, it is the same canvas element: its control was transferred once.
    await pressTab(app, 'Viewport');
    await app.waitFor(`shellTest.rect('[data-panel="viewport"]').width > 100`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-panel="viewport"] canvas') === window.keptCanvas`), true);
    await vanishes(app, '[data-panel="library"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-viewport-as-tab')}`);
    await pressTab(app, 'Library');
    await appears(app, '[data-panel="library"]');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-panel="viewport"] canvas') === window.keptCanvas && window.keptCanvas.isConnected`), true);

    // The engine goes on computing for a viewport nobody sees.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = 12; })`);
    await settled(app);
  });
});

test('layout: the layout is saved to the preferences when it changes, restored from them, and reset by its command', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const initial = await layout(app);
    const before = await rect(app, 'inspector');

    // A change of the layout: the side column is made wider by dragging its sash.
    await dragSideSash(app, -140);
    await app.waitFor(`shellTest.rect('[data-panel="inspector"]').width > ${before.width + 120}`, PAGE_BACKSTOP_MS);
    const widened = await rect(app, 'inspector');
    // It is written to the preferences file, with its schema version, without anything else being done.
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.layout?.dock?.grid?.root?.data?.[1]?.size === ${widened.width})`, PAGE_BACKSTOP_MS);
    const saved = (await savedLayout(app))!;
    assert.equal(saved.version, 1);
    assert.deepEqual(columns(saved), columns(await layout(app)));
    assert.notDeepEqual(columns(saved), columns(initial));
    // Another tab in front is a change of the layout too.
    await pressTab(app, 'Build');
    await app.waitFor(`${SAVED_FRONT('library')}.then((front) => front === 'build')`, PAGE_BACKSTOP_MS);
    const changed = (await savedLayout(app))!;
    t.diagnostic(`capture: ${await capture(app, 'layout-changed')}`);

    // Reset Layout: the default arrangement again, in the window and in the preferences.
    await run(app, 'view.resetLayout');
    await app.waitFor(`shellTest.exists('[data-panel="inspector"]') && shellTest.rect('[data-panel="inspector"]').width === ${before.width}`, PAGE_BACKSTOP_MS);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.layout.dock.grid.root.data[1].size === ${columns(initial)[1]})`, PAGE_BACKSTOP_MS);
    assert.deepEqual(columns((await savedLayout(app))!), columns(initial));
    assert.equal((await tabs(app)).find((tab) => tab.title === 'Library')?.active, true, 'the library is in front of the build panel again');

    // What start-up does with the preferences: the saved layout comes back as it was saved.
    await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(changed)} })`);
    assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'restored');
    await app.waitFor(`shellTest.exists('[data-panel="build"]') && shellTest.rect('[data-panel="build"]').width === ${widened.width}`, PAGE_BACKSTOP_MS);
    assert.deepEqual(columns(await layout(app)), columns(changed));
    assert.equal((await tabs(app)).find((tab) => tab.title === 'Build')?.active, true);
    assert.deepEqual([(await layout(app)).dock.panels.viewport!.renderer, (await layout(app)).dock.panels.graph!.renderer], ['always', 'always']);

    // A layout this build cannot restore is replaced by the default: another schema version, a panel missing, or nonsense.
    const missing: Layout = structuredClone(changed);
    delete missing.dock.panels.library;
    const broken = { version: 1, dock: { grid: { root: { type: 'branch', data: 'nonsense' }, width: 10, height: 10, orientation: 'HORIZONTAL' }, panels: changed.dock.panels } };
    for (const [what, value] of [['another version', { ...changed, version: 2 }], ['a panel missing', missing], ['a grid dockview refuses', broken], ['no layout', null], ['text', 'layout']] as const) {
      await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(changed)} })`);
      assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'restored');
      await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(value)} })`);
      assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'default', what);
      await app.waitFor(`shellTest.exists('[data-panel="inspector"]') && shellTest.rect('[data-panel="inspector"]').width === ${before.width}`, PAGE_BACKSTOP_MS);
      assert.equal(await app.eval<number>(`document.querySelectorAll('.dv-tab').length`), 5, what);
    }
    t.diagnostic(`capture: ${await capture(app, 'layout-reset')}`);
  });
});
