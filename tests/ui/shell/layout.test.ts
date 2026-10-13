// The dock in the window (runtime.md 8.7 rules 3 and 7): the default arrangement made from the panels'
// placements, a panel that owns a canvas staying in the document while its tab is behind another, and the
// layout saved to the preferences whenever it changes and restored from them.

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
const tabs = (app: AppDriver): Promise<{ title: string; active: boolean; x: number; y: number }[]> => app.eval(`[...document.querySelectorAll('.dv-tab')].map((tab) => {
  const box = tab.getBoundingClientRect();
  return { title: tab.textContent, active: tab.classList.contains('dv-active-tab'), x: Math.round(box.x), y: Math.round(box.y) };
})`);
const pressTab = (app: AppDriver, title: string): Promise<void> =>
  app.eval<void>(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === ${quote(title)}))`);
/** Drags the sash between the left column and the side column. */
const dragSideSash = (app: AppDriver, dx: number): Promise<void> =>
  app.eval<void>(`void shellTest.drag([...document.querySelectorAll('.dv-sash')].find((sash) => sash.getBoundingClientRect().height > 500), ${dx})`);

test('layout: the default arrangement has the viewport above the graph, the inspector at the right, and the library and the build as tabs', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const [viewport, graph, inspector] = [await rect(app, 'viewport'), await rect(app, 'graph'), await rect(app, 'inspector')];
    const window = await app.eval<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);

    // The left column: the viewport above, the graph below and at least as tall, both as wide as the column.
    assert.ok(Math.abs(viewport.x - graph.x) <= 1 && Math.abs(viewport.width - graph.width) <= 1, 'the viewport and the graph share a column');
    assert.ok(viewport.y < graph.y && graph.y >= viewport.y + viewport.height, 'the graph is below the viewport');
    assert.ok(graph.height >= viewport.height - 1 && graph.height > window.height * 0.4, `the graph is large: ${graph.height} of ${window.height}`);
    assert.ok(graph.width > window.width * 0.7, 'and wide');
    // The side column: the inspector over the whole height, at the right of both.
    assert.ok(inspector.x >= viewport.x + viewport.width && inspector.x >= graph.x + graph.width, 'the inspector is right of both');
    assert.ok(inspector.height >= viewport.height + graph.height, 'over the whole height');
    assert.ok(inspector.width >= 300 && inspector.width <= 440);
    assert.ok(Math.abs(inspector.x + inspector.width - window.width) <= 6, 'at the edge of the window');

    // Inspector, Library and Build are tabs of one group, the inspector in front.
    const strip = await tabs(app);
    const side = strip.filter((tab) => tab.x >= inspector.x);
    assert.deepEqual(side.map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Inspector*', 'Library', 'Build']);
    assert.ok(side.every((tab) => tab.y === side[0]!.y));
    assert.deepEqual(strip.filter((tab) => tab.x < inspector.x).map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Viewport*', 'Graph*']);
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'graph', 'the graph has the focus at start');

    // A panel cannot be closed: no tab has a close button.
    assert.equal(await app.eval<number>(`[...document.querySelectorAll('.dv-tab .dv-default-tab-action')].filter((action) => action.getBoundingClientRect().width > 0).length`), 0);

    // The panels behind a tab are not in the document; chosen, they are, and the one in front before is not.
    assert.deepEqual([await exists(app, '[data-panel="library"]'), await exists(app, '[data-panel="build"]')], [false, false]);
    await pressTab(app, 'Library');
    await appears(app, '[data-panel="library"]');
    await vanishes(app, '[data-panel="inspector"]');
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'library', 'choosing a tab gives its panel the focus');
    assert.equal(await app.eval<string>(`shellTest.text('[data-panel="library"] .og-empty-title')`), 'Library');
    await pressTab(app, 'Build');
    await appears(app, '[data-panel="build"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-panel="build"] .og-empty-title')`), 'Build');
    t.diagnostic(`capture: ${await capture(app, 'layout-default-build-tab')}`);

    // The layout names the renderer of each panel: 'always' for the two that own a canvas.
    const held = await layout(app);
    assert.equal(held.version, 1);
    assert.deepEqual(Object.keys(held.dock.panels).sort(), ['build', 'graph', 'inspector', 'library', 'viewport']);
    assert.deepEqual([held.dock.panels.viewport!.renderer, held.dock.panels.graph!.renderer], ['always', 'always']);
    for (const panel of ['inspector', 'library', 'build']) assert.notEqual(held.dock.panels[panel]!.renderer, 'always', panel);
  });
});

test('layout: a panel that owns a canvas stays in the document while its tab is behind another', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);

    // A layout in which the viewport is a tab of the side column, behind the inspector: the left column is the graph alone.
    const held = await layout(app);
    const [left, side] = held.dock.grid.root.data as [Branch, Leaf];
    const graph = left.data.find((part): part is Leaf => part.type === 'leaf' && part.data.views.includes('graph'))!;
    const moved: Layout = structuredClone(held);
    moved.dock.grid.root.data = [{ ...graph, size: left.size }, { ...side, data: { ...side.data, views: [...side.data.views, 'viewport'], activeView: 'inspector' } }];
    await app.eval(`orogenTest.ctx.platform.setPreferences({ layout: ${JSON.stringify(moved)} })`);
    assert.equal(await app.eval<string>(`orogenTest.shell.restoreLayout()`), 'restored');
    await app.waitFor(`document.querySelectorAll('.dv-tab').length === 5`, PAGE_BACKSTOP_MS);
    const side2 = (await tabs(app)).filter((tab) => tab.title !== 'Graph');
    assert.deepEqual(side2.map((tab) => `${tab.title}${tab.active ? '*' : ''}`), ['Inspector*', 'Library', 'Build', 'Viewport']);

    // Behind its tab the viewport is still in the document, with its canvas; the library, which owns none, is not.
    await appears(app, '[data-panel="viewport"] canvas');
    assert.equal(await exists(app, '[data-panel="library"]'), false);
    await app.eval(`void (window.keptCanvas = document.querySelector('[data-panel="viewport"] canvas'))`);
    assert.equal(await app.eval<boolean>(`window.keptCanvas.isConnected`), true);
    const hidden = await rect(app, 'viewport');
    assert.ok(hidden.width === 0 || (await app.eval<string>(`getComputedStyle(shellTest.el('[data-panel="viewport"]').closest('.dv-render-overlay') ?? shellTest.el('[data-panel="viewport"]')).display`)) === 'none'
      || (await app.eval<boolean>(`!shellTest.el('[data-panel="viewport"]').checkVisibility({ visibilityProperty: true })`)), 'and it is not shown');

    // Brought to the front and sent back, it is the same canvas element: its control was transferred once.
    await pressTab(app, 'Viewport');
    await app.waitFor(`shellTest.rect('[data-panel="viewport"]').width > 100`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-panel="viewport"] canvas') === window.keptCanvas`), true);
    await vanishes(app, '[data-panel="inspector"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-viewport-as-tab')}`);
    await pressTab(app, 'Inspector');
    await appears(app, '[data-panel="inspector"]');
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
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.layout.dock.grid.root.data[1].data.activeView === 'build')`, PAGE_BACKSTOP_MS);
    const changed = (await savedLayout(app))!;
    t.diagnostic(`capture: ${await capture(app, 'layout-changed')}`);

    // Reset Layout: the default arrangement again, in the window and in the preferences.
    await run(app, 'view.resetLayout');
    await app.waitFor(`shellTest.exists('[data-panel="inspector"]') && shellTest.rect('[data-panel="inspector"]').width === ${before.width}`, PAGE_BACKSTOP_MS);
    await app.waitFor(`orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.layout.dock.grid.root.data[1].size === ${columns(initial)[1]})`, PAGE_BACKSTOP_MS);
    assert.deepEqual(columns((await savedLayout(app))!), columns(initial));
    assert.equal((await tabs(app)).find((tab) => tab.title === 'Inspector')?.active, true);

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
