// Previews that are paused are said as that, and alike (runtime.md 8.5, 8.7 rule 10): `paused` of engineStore is
// set by the engine client, and the graph, the inspector and the status bar read it there. What is not computed
// because of the pause is "Paused", in the colour of a warning, and not "Not computed" or "Out of date". The
// viewport's own word is its panel's (tests/ui/viewport). Afterwards: the inspector says at which resolution a
// node outside the view was measured.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppDriver } from '../../helpers/index.ts';
import { appears, capture, docked, EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, quote, ready, run, settled, withApp } from './rig.ts';

const status = (app: AppDriver, node: string): Promise<[string | null, string]> =>
  app.eval<[string | null, string]>(`(() => { const element = document.querySelector('[data-node=${quote(node)}]'); return [element.getAttribute('data-status'), element.querySelector('[data-role="status"]').textContent]; })()`);
const inspected = (app: AppDriver): Promise<string> => app.eval<string>(`document.querySelector('[data-panel="inspector"] [data-status-text]').textContent`);
const viewWord = (app: AppDriver): Promise<string> => app.eval<string>(`document.querySelector('[data-status="view"]')?.textContent ?? ''`);
const select = (app: AppDriver, ids: readonly string[]): Promise<void> => app.eval<void>(`void orogenTest.ctx.ui.setState({ selection: ${quote(ids)} })`);

test('paused: the graph, the inspector and the status bar say "Paused" of what the pause keeps from being computed, and nothing else changes its word', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const range = await app.eval<string>(`Object.keys(orogenTest.ctx.doc.getState().doc.nodes)[0]`);
    assert.equal(await app.eval<boolean>(`orogenTest.ctx.engineState.getState().paused`), false);
    await app.waitFor(`['done', 'cached'].includes(document.querySelector('[data-node=${quote(range)}]').getAttribute('data-status'))`, EVALUATION_BACKSTOP_MS);

    // ---- the pause, by its command: the store of the engine has it, where a panel may read it ----
    await run(app, 'engine.togglePause');
    await app.waitFor(`orogenTest.ctx.engineState.getState().paused === true`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`shellTest.text('[data-status="device"]')`), 'Previews paused');
    // What is computed says what it said: the pause is no news of a node that has its result.
    assert.ok(['done', 'cached'].includes((await status(app, range))[0]!));
    assert.doesNotMatch(await viewWord(app), /Paused|Out of date/, 'the picture is of the project as it is');

    // ---- a node added while paused has no result, and says why in the graph and in the inspector ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Add Blur', (draft) => {
      draft.nodes.soft = { id: 'soft', type: 'filter/blur', version: 1, position: { x: 320, y: 0 }, params: {} };
      draft.edges.wire = { id: 'wire', from: { node: ${quote(range)}, port: 'out' }, to: { node: 'soft', port: 'in' } };
      draft.nodes.landscape = { id: 'landscape', type: 'io/export-landscape', version: 1, position: { x: 640, y: 0 }, params: {} };
      draft.edges.out = { id: 'out', from: { node: 'soft', port: 'out' }, to: { node: 'landscape', port: 'in' } };
      draft.nodes.loose = { id: 'loose', type: 'filter/blur', version: 1, position: { x: 320, y: 260 }, params: {} };
      draft.nodes.flat = { id: 'flat', type: 'generate/constant', version: 1, position: { x: 0, y: 260 }, params: {} };
      draft.nodes.softer = { id: 'softer', type: 'filter/blur', version: 1, position: { x: 640, y: 260 }, params: {} };
      draft.edges.second = { id: 'second', from: { node: ${quote(range)}, port: 'out' }, to: { node: 'softer', port: 'in' } };
    })`);
    await appears(app, '[data-node="soft"]');
    await app.waitFor(`document.querySelector('[data-node="soft"]').getAttribute('data-status') === 'paused'`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await status(app, 'soft'), ['paused', 'Paused']);
    assert.equal(await app.eval<string>(`getComputedStyle(document.querySelector('[data-node="soft"] [data-role="status"]')).color`),
      await app.eval<string>(`(() => { const probe = document.createElement('span'); probe.style.color = 'var(--og-warning)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`),
      'in the colour of a warning, not of an error');
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-node="soft"]').getAttribute('data-failed')`), null);
    // A node that waits for a wire says that, paused or not; an export node runs in no preview and is never paused.
    assert.deepEqual(await status(app, 'loose'), ['missing', 'Missing input: In']);
    assert.deepEqual(await status(app, 'landscape'), ['idle', '']);

    await select(app, ['soft']);
    await appears(app, '[data-panel="inspector"] [data-inspector-header="filter/blur"]');
    assert.equal(await inspected(app), 'Paused');
    await select(app, ['landscape']);
    await app.waitFor(`document.querySelector('[data-panel="inspector"] [data-status-text]')?.textContent === 'Runs when the project is built'`, PAGE_BACKSTOP_MS);
    await select(app, ['soft', 'softer']);
    await app.waitFor(`/paused/.test(document.querySelector('[data-panel="inspector"] [data-status-text]')?.textContent ?? '')`, PAGE_BACKSTOP_MS);
    assert.equal(await inspected(app), '2 paused');

    // ---- the picture is behind the project because of the pause: the status bar says so, as what it is ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = 31; })`);
    await app.waitFor(`document.querySelector('[data-status="view"]')?.hasAttribute('data-behind') === true`, PAGE_BACKSTOP_MS);
    assert.match(await viewWord(app), /Paused$/);
    assert.doesNotMatch(await viewWord(app), /Out of date|Updating/);
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-status="view"]').getAttribute('data-paused')`), '');
    t.diagnostic(`capture: ${await capture(app, 'paused')}`);

    // ---- resumed: everything is computed, and "Paused" is gone from all three ----
    await select(app, ['soft']);
    await run(app, 'engine.togglePause');
    await app.waitFor(`orogenTest.ctx.engineState.getState().paused === false`, PAGE_BACKSTOP_MS);
    await settled(app);
    assert.doesNotMatch(await viewWord(app), /Paused|Out of date/);
    await app.waitFor(`document.querySelector('[data-node="soft"]').getAttribute('data-status') !== 'paused'`, PAGE_BACKSTOP_MS);
    await app.waitFor(`!/Paused/.test(document.querySelector('[data-panel="inspector"] [data-status-text]')?.textContent ?? 'Paused')`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<string>(`shellTest.text('[data-status="device"]')`), 'Ready');

    // ---- a node outside the view is computed for its thumbnail, on another grid: the inspector says at which ----
    // The view shows the range. The flat terrain beside it is no part of that: the graph asks for its thumbnail, and
    // an idle evaluation makes it at the thumbnail resolution (runtime.md 7.3 rule 9).
    await app.waitFor(`(() => {
      const record = orogenTest.ctx.engineState.getState().nodes.flat;
      return record?.state === 'done' && record.wallMs !== null && record.resolution !== null;
    })()`, EVALUATION_BACKSTOP_MS);
    const [measured, shown] = await app.eval<[number, number]>(`[orogenTest.ctx.engineState.getState().nodes.flat.resolution, orogenTest.ctx.engineState.getState().view.resolution]`);
    assert.notEqual(measured, shown, `the thumbnail run was at ${measured}, the view shows ${shown}`);
    // The view is pinned to what it shows (7.4 rule 4), so that selecting the flat terrain does not show it: a node
    // that is selected and shown is computed for the view, at the view's resolution.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Lock view', (draft) => { draft.ui.view = { ...draft.ui.view, locked: true }; }, { undoable: false })`);
    await select(app, ['flat']);
    await app.waitFor(`document.querySelector('[data-panel="inspector"] [data-status-text]')?.textContent.includes(${quote(`at ${measured} × ${measured}`)})`, PAGE_BACKSTOP_MS);
    assert.match(await inspected(app), new RegExp(`^Computed · .+ · at ${measured} × ${measured}`));
    assert.equal(await app.eval<number>(`orogenTest.ctx.engineState.getState().nodes.flat.resolution`), measured, 'it is still the record of its thumbnail');
    // A node the view shows was measured at what the status bar names: its line names no resolution.
    await select(app, [range]);
    await app.waitFor(`/^Computed/.test(document.querySelector('[data-panel="inspector"] [data-status-text]')?.textContent ?? '')`, PAGE_BACKSTOP_MS);
    assert.doesNotMatch(await inspected(app), / at \d+ × \d+/);
    t.diagnostic(`capture: ${await capture(app, 'measured-at-another-resolution')}`);
  });
});
