// The toolbar of the viewport in the real application: what it says of the picture (which output, in which
// state, at which resolution), and what is left of it in a narrow panel. The state and the resolution are never
// cut; the controls give way one by one, the name of the output first; a long name is cut, never the panel.
//
// The captures are written for a person: test-output/ui/viewport/toolbar-01 … toolbar-08.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphDoc } from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { attr, capture, EVALUATION_BACKSTOP_MS, makeDoc, PAGE_BACKSTOP_MS, prepare, quote, resizeViewport, run, settled, show, toolbar, type ToolbarPart } from './rig.ts';

const HEIGHT = { node: 'range', port: 'out' };
const NODES = {
  range: { type: 'generate/mountain-range' },
  island: { type: 'generate/island' },
  steep: { type: 'select/slope', inputs: { in: 'range.out' } },
  missing: { type: 'io/import-field', params: { file: '/no/such/folder/heights.png' } },
};
const LONG = 'A very long name for a node that somebody typed without thinking about how wide a toolbar is';

const statusText = (app: AppDriver): Promise<string> => app.eval<string>(`viewportTest.statusText()`);
const subject = (app: AppDriver): Promise<{ text: string; cut: boolean; locked: boolean } | null> => app.eval(`(() => {
  const element = document.querySelector('[data-viewport="subject"]');
  if (!element) return null;
  const text = element.querySelector('span');
  return { text: element.textContent, cut: text.scrollWidth > text.clientWidth, locked: element.hasAttribute('data-locked') };
})()`);
const setView = (app: AppDriver, view: object): Promise<void> =>
  app.eval<void>(`void orogenTest.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = ${quote(view)}; }, { undoable: false })`);
/** The parts of the toolbar that are whole inside it. */
const whole = async (app: AppDriver): Promise<ToolbarPart[]> => {
  const layout = await toolbar(app);
  return (Object.keys(layout) as (ToolbarPart | 'width')[]).filter((part): part is ToolbarPart => part !== 'width' && typeof layout[part] === 'number');
};

test('the toolbar says what is shown: the output\'s name, the pin, the state in a word and the resolution; an overlay that fails and previews that are paused are said as what they are', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc(NODES, { height: HEIGHT }));

    // ---- the output's name ----
    assert.deepEqual(await subject(app), { text: 'Mountain Range', cut: false, locked: false });
    assert.equal(await statusText(app), '1009 × 1009', 'a picture that is current needs no word');
    // An output that is not the node's first is named with the node.
    await setView(app, { height: { node: 'island', port: 'water' } });
    await settled(app);
    assert.equal((await subject(app))!.text, 'Island · Water');
    // The user's own title, and the pin (7.4 rule 4).
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Rename', (draft) => { draft.nodes.range.title = 'North ridge'; })`);
    await setView(app, { height: HEIGHT, locked: true });
    await settled(app);
    assert.deepEqual(await subject(app), { text: 'North ridge', cut: false, locked: true });
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="subject"] [data-icon="lock"]') !== null`), true);

    // ---- an overlay: its button says that there is one, and the popover which output it is ----
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'steep', port: 'out' }, as: 'mask', opacity: 0.7 } });
    await settled(app);
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="overlay"]').hasAttribute('data-active')`), true);
    await app.eval(`void shellTest.press('[data-viewport="overlay"]')`);
    await app.waitFor(`document.querySelector('[data-ui="popover"] [data-viewport="overlay-source"]') !== null`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`document.querySelector('[data-ui="popover"] [data-viewport="overlay-source"]').textContent`), 'Slope');
    assert.match(await app.eval<string>(`document.querySelector('[data-ui="popover"]').textContent`), /AsMask/);
    t.diagnostic(`capture: ${await capture(app, 'toolbar-01-overlay-popover')}`);
    await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="popover"]'))`);
    await app.waitFor(`document.querySelector('[data-ui="popover"]') === null`, PAGE_BACKSTOP_MS);

    // ---- the overlay's node fails, the terrain's is well: nothing new can be shown (7.3 rule 6), and that is what is said ----
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'missing', port: 'out' }, as: 'mask', opacity: 1 } });
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes.missing?.state === 'error'`, EVALUATION_BACKSTOP_MS);
    await app.waitFor(`viewportTest.attr('data-status') === 'overlayError'`, PAGE_BACKSTOP_MS);
    assert.equal(await statusText(app), 'Overlay failed1009 × 1009');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="cover"]') === null`), true, 'the terrain that was shown stays');
    t.diagnostic(`capture: ${await capture(app, 'toolbar-02-overlay-failed')}`);
    await run(app, 'viewport.removeOverlay');
    await settled(app);
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="overlay"]').hasAttribute('data-active')`), false);

    // ---- previews are paused and the document changes: the picture is of an earlier state, and nothing is "updating" ----
    await run(app, 'engine.togglePause');
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Mountain Range: Height', (draft) => { draft.nodes.range.params.height = 0.6; })`);
    await app.waitFor(`viewportTest.attr('data-status') === 'stale'`, PAGE_BACKSTOP_MS);
    assert.equal(await statusText(app), 'Out of date1009 × 1009');
    t.diagnostic(`capture: ${await capture(app, 'toolbar-03-paused-out-of-date')}`);
    await run(app, 'engine.togglePause');
    await settled(app);
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await statusText(app), '1009 × 1009');

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('a narrow panel: the state and the resolution stay whole, the controls give way one by one, and a long name is cut and never the toolbar', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    const doc = makeDoc(NODES, { height: HEIGHT });
    const long: GraphDoc = { ...doc, nodes: { ...doc.nodes, range: { ...doc.nodes.range!, title: LONG } } };
    await show(app, long);

    // The default layout: everything is there, and the long name is cut to what is left between the controls and the state.
    const wide = await toolbar(app);
    assert.deepEqual(await whole(app), ['view', 'shading', 'overlay', 'sun', 'scale', 'sea', 'frame', 'subject', 'resolution']);
    assert.deepEqual(await subject(app), { text: LONG, cut: true, locked: false });
    assert.ok((wide.subject as number) < (wide.resolution as number) && (wide.resolution as number) <= wide.width, JSON.stringify(wide));
    t.diagnostic(`capture: ${await capture(app, 'toolbar-04-long-name')}`);

    // Narrower and narrower. What has gone from the toolbar is in the Viewport menu; the state is in every width.
    const steps: readonly (readonly [number, readonly ToolbarPart[]])[] = [
      [900, ['view', 'shading', 'overlay', 'sun', 'scale', 'sea', 'frame', 'subject', 'resolution']],
      [740, ['view', 'shading', 'overlay', 'sun', 'scale', 'sea', 'frame', 'resolution']],
      [650, ['view', 'shading', 'overlay', 'sun', 'scale', 'resolution']],
      [540, ['view', 'overlay', 'sun', 'scale', 'resolution']],
      [430, ['view', 'overlay', 'sun', 'resolution']],
      [330, ['view', 'overlay', 'sun']],
      [250, ['view', 'overlay']],
    ];
    for (const [width, parts] of steps) {
      await resizeViewport(app, width, 360);
      const layout = await toolbar(app);
      assert.deepEqual(await whole(app), parts, `at a width of ${layout.width}: ${JSON.stringify(layout)}`);
      // Nothing that is shown is cut or lies over its neighbour: each part ends before the next begins, inside the toolbar.
      const ends = parts.map((part) => layout[part] as number);
      assert.ok(ends.every((end, i) => end <= layout.width && (i === 0 || end > ends[i - 1]!)), `${width}: ${JSON.stringify(layout)}`);
      if ([740, 540, 330].includes(width)) t.diagnostic(`capture: ${await capture(app, `toolbar-05-width-${width}`)}`);
    }

    // The state in the narrowest panels: a draft during a gesture, with its resolution where there is room for it.
    await resizeViewport(app, 430, 360);
    await app.eval(`void (orogenTest.ctx.doc.getState().beginGesture('param:range:height'),
      orogenTest.ctx.doc.getState().transact('Mountain Range: Height', (draft) => { draft.nodes.range.params.height = 0.4; }, { mergeKey: 'param:range:height' }))`);
    await app.waitFor(`viewportTest.attr('data-status') === 'draft' && orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    assert.deepEqual(await whole(app), ['view', 'overlay', 'sun', 'state', 'resolution']);
    assert.match(await app.eval<string>(`viewportTest.statusText()`), /^Draft(253|505) × \1$/);
    t.diagnostic(`capture: ${await capture(app, 'toolbar-06-draft-narrow')}`);
    await resizeViewport(app, 250, 360);
    assert.deepEqual(await whole(app), ['view', 'overlay', 'state'], 'the word stays when the resolution has no room');
    await app.eval(`void orogenTest.ctx.doc.getState().endGesture()`);
    await settled(app);

    // The commands that have left the toolbar still run from the menu the panel brings.
    assert.equal(await attr(app, 'data-sea'), '');
    await app.eval(`void shellTest.press('.og-menubar-item[data-menu="Viewport"]')`);
    await app.waitFor(`document.querySelector('[data-ui="menu"][data-menu="Viewport"] [data-item="viewport.toggleSea"]') !== null`, PAGE_BACKSTOP_MS);
    await app.eval(`void shellTest.press('[data-ui="menu"][data-menu="Viewport"] [data-item="viewport.toggleSea"]')`);
    await app.waitFor(`viewportTest.attr('data-sea') === null`, PAGE_BACKSTOP_MS);
    await run(app, 'viewport.toggleSea');

    // And back: a wide panel has everything again, and the picture follows the panel's shape.
    await resizeViewport(app, 1300, 700);
    assert.deepEqual(await whole(app), ['view', 'shading', 'overlay', 'sun', 'scale', 'sea', 'frame', 'subject', 'resolution']);
    await run(app, 'viewport.frame');
    t.diagnostic(`capture: ${await capture(app, 'toolbar-07-wide-panel')}`);

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
