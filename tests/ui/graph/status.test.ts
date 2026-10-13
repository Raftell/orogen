// What a node says of itself in the window (runtime.md 8.7): acceptance graph 06 holds a node that fails, one
// that waits behind it, a type this build lacks, a missing input and a cycle; then a simulation is added to a
// terrain and watched while it runs. The engine is the real one, in the application's worker.
//
// The captures are written for a person (testing.md 8.5 rule 1): graph/status-01 … status-04.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppDriver } from '../../helpers/index.ts';
import {
  added, appears, attr, capture, click, docked, docOf, drag, EVALUATION_BACKSTOP_MS, focusGraph, graphSettled, key, nodeBox, nodeSelector, PAGE_BACKSTOP_MS,
  port, quote, ready, selection, settled, text, titleOf, vanishes, withApp,
} from './rig.ts';

const status = (app: AppDriver, id: string): Promise<string | null> => attr(app, nodeSelector(id), 'data-status');
const line = (app: AppDriver, id: string): Promise<string | null> => text(app, `${nodeSelector(id)} [data-role="status"]`);
const waitStatus = (app: AppDriver, id: string, state: string): Promise<void> =>
  app.waitFor(`document.querySelector(${quote(nodeSelector(id))})?.getAttribute('data-status') === ${quote(state)}`, EVALUATION_BACKSTOP_MS);

test('status: a failing node, the node behind it, an unknown type, a missing input and a cycle each say what is wrong', async (t) => {
  await withApp({ open: 'tests/graphs/06-broken.orogen' }, async (app) => {
    await ready(app);
    await docked(app);
    // The shell says what it found in the file; the graph is behind that dialog.
    await appears(app, '[data-ui="dialog"] [data-action="ok"]');
    await app.eval(`void shellTest.press('[data-ui="dialog"] [data-action="ok"]')`);
    await vanishes(app, '[data-ui="dialog"]');
    await graphSettled(app);
    await focusGraph(app);
    assert.equal(await app.eval<number>(`document.querySelectorAll('[data-node]').length`), 10, 'every node of the file is drawn, also those nothing can be done with');

    // ---- what the document alone says, before any evaluation names the node ----
    assert.deepEqual([await status(app, 'ghost'), await line(app, 'ghost')], ['error', 'Unknown node type "legacy/unknown"']);
    assert.equal(await text(app, `${nodeSelector('ghost')} [data-role="title"]`), 'legacy/unknown');
    assert.equal(await app.eval<number>(`document.querySelectorAll('.react-flow__edge').length`), 9, 'the wires to and from the unknown node are drawn');
    assert.deepEqual([await status(app, 'open'), await line(app, 'open')], ['missing', 'Missing input: In']);
    assert.equal(await attr(app, `${nodeSelector('open')} .react-flow__handle[data-port="in"]`, 'data-missing'), '');
    // The node after the unknown one has a wire into its input that the evaluator ignores (4.3 rule 5).
    assert.deepEqual([await status(app, 'after'), await line(app, 'after')], ['missing', 'Missing input: In']);
    // A cycle is in the wires: both of its nodes say so, in the engine's words, though the file names no view
    // and no evaluation can have named them.
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.engineState.getState().nodes.loopa?.error ?? null`), null);
    assert.deepEqual([await status(app, 'loopa'), await line(app, 'loopa'), await status(app, 'loopb'), await line(app, 'loopb')], ['error', 'Part of a cycle', 'error', 'Part of a cycle']);
    assert.equal(await attr(app, nodeSelector('loopa'), 'data-failed'), '');

    // ---- the failing node: the engine's message in the status line, and in a badge that shows it on the pointer ----
    // The file names no view, so the thumbnails the graph asks for are what evaluates these nodes.
    await waitStatus(app, 'bad', 'error');
    assert.equal(await line(app, 'bad'), 'Reference failure');
    assert.equal(await attr(app, nodeSelector('bad'), 'data-failed'), '');
    const badge = `${nodeSelector('bad')} [data-badge="error"]`;
    await appears(app, badge);
    await app.eval(`void shellTest.hover(${quote(badge)})`);
    await appears(app, '[data-ui="tooltip"]');
    assert.equal(await text(app, '[data-ui="tooltip"]'), 'Reference failure', 'the one sentence of the error, not its stack');
    // The node behind it did not run, and says which node stopped it.
    await waitStatus(app, 'down', 'skipped');
    assert.equal(await line(app, 'down'), 'Skipped: Fail (Reference) failed');
    // The good branch is computed and has its pictures.
    await waitStatus(app, 'good', 'done');
    await app.waitFor(`document.querySelector(${quote(`${nodeSelector('good')} [data-thumbnail="drawn"]`)}) !== null`, PAGE_BACKSTOP_MS);
    assert.match(await line(app, 'good') ?? '', /^(< 1|\d+) ms$|^\d+\.\d+ s$/);
    t.diagnostic(`capture: ${await capture(app, 'status-01-broken-graph')}`);

    // ---- the engine reports the cycle as well, once a node of it is asked for, and the node says the same ----
    // Selecting such a node does not show it: what a "same as" output carries cannot be told around a cycle
    // (7.4), so the view stays. G names the node as the terrain all the same, and the engine then says why not.
    await click(app, await titleOf(app, 'loopa'));
    assert.deepEqual(await selection(app), ['loopa']);
    assert.equal((await docOf(app)).ui.view, undefined);
    await key(app, 'KeyG');
    assert.deepEqual((await docOf(app)).ui.view, { height: { node: 'loopa', port: 'out' } });
    await waitStatus(app, 'loopa', 'error');
    assert.equal(await line(app, 'loopa'), 'Part of a cycle');
    await waitStatus(app, 'loopb', 'error');
    // The failing node selected: the viewport is given it, the engine reports it again, and the graph still says the same.
    await click(app, await titleOf(app, 'bad'));
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    assert.deepEqual([await status(app, 'bad'), await line(app, 'bad'), await attr(app, nodeSelector('bad'), 'data-shown')], ['error', 'Reference failure', 'terrain']);
    t.diagnostic(`capture: ${await capture(app, 'status-02-failing-node-selected')}`);

    // ---- repaired in the graph: the input that was missing is connected, and the node computes ----
    await drag(app, await port(app, 'fbm', 'out', 'out'), await port(app, 'open', 'in', 'in'));
    assert.equal((await docOf(app)).edges[Object.keys((await docOf(app)).edges).at(-1)!]!.to.node, 'open');
    await app.waitFor(`document.querySelector(${quote(nodeSelector('open'))}).getAttribute('data-status') !== 'missing'`, PAGE_BACKSTOP_MS);
    await click(app, await titleOf(app, 'open'));
    await waitStatus(app, 'open', 'done');
    assert.equal(await attr(app, `${nodeSelector('open')} .react-flow__handle[data-port="in"]`, 'data-missing'), null);
  });
});

test('status: a simulation shows that it runs and how far it is, then what it took', async (t) => {
  await withApp({}, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    await graphSettled(app);
    await focusGraph(app);
    const start = await docOf(app);
    const range = Object.keys(start.nodes)[0]!;

    // ---- the simulation, from the palette ----
    const box = await nodeBox(app, range);
    await app.eval(`void graphTest.hover(${box.x + box.width + 220}, ${box.y + 70})`);
    await key(app, 'Tab');
    await appears(app, '[data-graph="palette"]');
    await app.eval(`void shellTest.type('[data-graph="palette"] input', 'hydraulic')`);
    await app.waitFor(`document.querySelector('[data-graph="palette"] [aria-selected="true"][data-type]')?.getAttribute('data-type') === 'simulate/hydraulic-erosion'`, PAGE_BACKSTOP_MS);
    await key(app, 'Enter', {}, '[data-graph="palette"] input');
    await vanishes(app, '[data-graph="palette"]');
    const [erosion] = await added(app, start);
    assert.ok(erosion);
    assert.equal(await status(app, erosion), 'missing');

    // What the node shows from now on, as often as it changes: a poll could miss a state that lasts a moment.
    await app.eval(`void (() => {
      const node = document.querySelector(${quote(nodeSelector(erosion))});
      const seen = window.graphStatusSeen = [];
      const note = () => {
        const progress = node.querySelector('[data-role="progress"]');
        const entry = node.getAttribute('data-status') + '|' + (node.querySelector('[data-role="status"]')?.textContent ?? '') + '|' + (progress ? progress.style.transform : '');
        if (seen.at(-1) !== entry && seen.length < 2000) seen.push(entry);
      };
      new MutationObserver(note).observe(node, { attributes: true, childList: true, subtree: true, characterData: true });
      note();
    })()`);

    // ---- connected, it is the terrain shown (it is selected), so the engine runs it at the preview resolution ----
    await drag(app, await port(app, range, 'out', 'out'), await port(app, erosion, 'in', 'in'));
    await app.waitFor(`orogenTest.ctx.engineState.getState().nodes[${quote(erosion)}]?.state === 'running'`, EVALUATION_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'status-03-simulation-running')}`);
    await waitStatus(app, erosion, 'done');
    await settled(app);

    const seen = await app.eval<string[]>(`window.graphStatusSeen`);
    const states = seen.map((entry) => entry.split('|')[0]!);
    assert.equal(states[0], 'missing');
    assert.ok(states.includes('running'), `the node said that it runs: ${[...new Set(states)].join(', ')}`);
    assert.equal(states.at(-1), 'done');
    const running = seen.filter((entry) => entry.startsWith('running|')).map((entry) => entry.split('|'));
    // While it runs: a line that says how far it is, and a bar of that length along its header.
    assert.ok(running.every(([, said]) => /^[A-Z][^|]* \d+%(, .* left)?$/.test(said!)), `the status line while running: ${running.slice(0, 3).map(([, said]) => said).join(' / ')}`);
    const fractions = running.map(([, , transform]) => Number(/scaleX\(([0-9.e-]+)\)/.exec(transform!)?.[1] ?? Number.NaN));
    assert.ok(fractions.length > 0 && fractions.every((fraction) => fraction >= 0 && fraction <= 1), 'the bar is a share of the header');
    assert.ok(fractions.every((fraction, i) => i === 0 || fraction >= fractions[i - 1]!), 'and it never goes back');
    assert.ok(new Set(fractions).size > 2, `it moved: ${new Set(fractions).size} lengths`);
    t.diagnostic(`while running the node showed ${running.length} states, from "${running[0]![1]}" to "${running.at(-1)![1]}"`);
    // Done: no bar, the time it took, its picture, and it is what the viewport shows.
    assert.equal(await app.eval<boolean>(`document.querySelector(${quote(`${nodeSelector(erosion)} [data-role="progress"]`)}) === null`), true);
    assert.match(await line(app, erosion) ?? '', /^\d+ ms$|^\d+\.\d+ s$/);
    assert.equal(await attr(app, nodeSelector(erosion), 'data-shown'), 'terrain');
    await app.waitFor(`document.querySelector(${quote(`${nodeSelector(erosion)} [data-thumbnail="drawn"]`)}) !== null`, PAGE_BACKSTOP_MS);
    t.diagnostic(`the simulation took "${await line(app, erosion)}" at ${await app.eval<number>(`orogenTest.ctx.engineState.getState().view.resolution`)} × the same`);
    t.diagnostic(`capture: ${await capture(app, 'status-04-simulation-done')}`);

    // Selecting the source and the simulation again finds it in the cache: the node says so.
    await click(app, await titleOf(app, range));
    await settled(app);
    await click(app, await titleOf(app, erosion));
    await waitStatus(app, erosion, 'cached');
    assert.equal(await line(app, erosion), 'Cached');
  });
});
