// The foundation used as a person uses it, from the first start to a dead engine (runtime.md section 8): the
// engine worker has the hardware adapter, the default project is computed and shown, the document is edited
// with the commands of 4.6 and the edits are undone and redone, the project is saved and opened by a second
// application, a node that fails is reported and leaves the application usable, and the terrain comes back when
// the GPU process and when the engine worker is gone. What every owner tested alone is here in one run.
//
// The captures are written for a person (testing.md 8.5 rule 1): journey-01 … journey-12.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { FieldStats } from '../../../src/core/api.ts';
import { nodes } from '../../../src/core/nodes/index.ts';
import {
  addNode, connect, createRegistry, parseDoc, removeNodes, serializeDoc, setParam,
  type DocDraft, type GraphDoc, type NodeError, type PortRef,
} from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { gpuProcesses } from '../platform/rig.ts';
import { appears, capture, docked, EVALUATION_BACKSTOP_MS, install, key, OUTPUT, PAGE_BACKSTOP_MS, press, quote, ready, run, settled, vanishes } from './rig.ts';

const REGISTRY = createRegistry(nodes);
const FOLDER = path.join(OUTPUT, 'journey');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

/** Statistics of one field on one adapter, computed twice: the same to the last digits a float prints. */
const SAME = 1e-6;

const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
const inspect = (app: AppDriver, ref: PortRef): Promise<FieldStats | null> => app.eval<FieldStats | null>(`orogenTest.ctx.engine.inspect(${quote(ref)})`);
const statusText = (app: AppDriver, item: string): Promise<string | null> => app.eval<string | null>(`document.querySelector('[data-status="${item}"]')?.textContent ?? null`);
const nodeState = (app: AppDriver, id: string): Promise<string> => app.eval<string>(`orogenTest.ctx.engineState.getState().nodes[${quote(id)}]?.state ?? 'none'`);

function close(a: FieldStats | null, b: FieldStats | null): boolean {
  return a !== null && b !== null && (['min', 'max', 'mean'] as const).every((name) => Math.abs(a[name] - b[name]) <= SAME);
}

/**
 * One command of runtime.md 4.6 as one transaction of the page's document. The command runs here, on a copy of
 * the page's document, and the transaction gives the page's draft what the command made: the page offers its
 * document to a test, not the functions that change it.
 */
async function transact(app: AppDriver, label: string, change: (draft: DocDraft) => void, opts: { mergeKey?: string; undoable?: boolean } = {}): Promise<GraphDoc> {
  const draft = structuredClone(await docOf(app)) as DocDraft;
  change(draft);
  await app.eval(`void orogenTest.ctx.doc.getState().transact(${quote(label)}, (draft) => {
    const made = ${quote(draft)};
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Only what the command changed is written: a transaction is told by its patches what it touched (8.5 rule 5).
    for (const member of ['nodes', 'edges', 'groups']) {
      for (const id of Object.keys(draft[member])) if (!Object.hasOwn(made[member], id)) delete draft[member][id];
      for (const id of Object.keys(made[member])) if (!same(draft[member][id], made[member][id])) draft[member][id] = made[member][id];
    }
    for (const member of ['settings', 'ui']) {
      for (const name of new Set([...Object.keys(draft[member]), ...Object.keys(made[member])])) {
        if (!Object.hasOwn(made[member], name)) delete draft[member][name];
        else if (!same(draft[member][name], made[member][name])) draft[member][name] = made[member][name];
      }
    }
  }, ${quote(opts)})`);
  return docOf(app);
}

test('journey: start, edit, undo, save, open in a second application, a failing node, a lost GPU process and a dead engine worker', async (t) => {
  const file = path.join(FOLDER, 'journey.orogen');
  const running: AppDriver[] = [];
  const launch = async (): Promise<AppDriver> => {
    const app = await launchApp({ profile: 'core' });
    running.push(app);
    await install(app);
    return app;
  };
  /** Closes an application; close() rejects for any error it reported (testing.md 8.5 rule 3). */
  const end = async (app: AppDriver): Promise<void> => {
    running.splice(running.indexOf(app), 1);
    await app.close();
  };

  try {
    // ---- 1. the first start ----
    const first = await launch();
    const caps = await ready(first);
    assert.equal(caps.software, false, `the engine worker has ${caps.adapter.vendor} ${caps.adapter.description}: a software adapter here means the launch switches were not applied`);
    assert.equal(caps.adapter.isFallbackAdapter, false);
    await docked(first);
    await settled(first);
    const adapter = await statusText(first, 'adapter');
    assert.ok(adapter !== null && adapter.trim() !== '' && !/software/i.test(adapter), `the status bar names a hardware adapter: ${adapter}`);
    t.diagnostic(`adapter: ${caps.adapter.vendor} ${caps.adapter.description}; the status bar says "${adapter}"`);

    // ---- 2. the default project is computed and shown ----
    const start = await docOf(first);
    const source = Object.keys(start.nodes)[0]!;
    assert.deepEqual([Object.keys(start.nodes).length, start.nodes[source]!.type, await nodeState(first, source)], [1, 'generate/mountain-range', 'done']);
    const range = await inspect(first, { node: source, port: 'out' });
    assert.ok(range !== null && range.nonFinite === 0 && range.max - range.min > 0.2, `the default project shows terrain: ${JSON.stringify(range)}`);
    assert.equal(await statusText(first, 'view'), '1009 × 1009');
    t.diagnostic(`capture: ${await capture(first, 'journey-01-default-project')}`);

    // ---- 3. edits, each one command of 4.6 in one transaction ----
    let terraces = '';
    await transact(first, 'Add Terraces', (draft) => { terraces = addNode(draft, REGISTRY, 'surface/terraces', { x: 280, y: 0 }); });
    await transact(first, 'Connect', (draft) => { connect(draft, REGISTRY, { node: source, port: 'out' }, { node: terraces, port: 'in' }); });
    const shown: PortRef = { node: terraces, port: 'out' };
    await transact(first, 'View', (draft) => { draft.ui.view = { height: shown }; }, { undoable: false });
    await settled(first);
    assert.equal(await nodeState(first, terraces), 'done');
    const eight = await inspect(first, shown);
    assert.ok(eight !== null && !close(eight, range), `the terraces are another terrain than the range: ${JSON.stringify(eight)}`);
    t.diagnostic(`capture: ${await capture(first, 'journey-02-node-added-and-connected')}`);

    await transact(first, 'Terraces: Levels', (draft) => setParam(draft, REGISTRY, terraces, 'levels', 3), { mergeKey: `param:${terraces}:levels` });
    await settled(first);
    const three = await inspect(first, shown);
    assert.ok(three !== null && !close(three, eight), `three levels are another terrain than eight: ${JSON.stringify(three)} against ${JSON.stringify(eight)}`);
    assert.deepEqual(await first.eval<string[]>(`orogenTest.ctx.doc.getState().past.map((entry) => entry.label)`), ['Add Terraces', 'Connect', 'Terraces: Levels']);
    t.diagnostic(`capture: ${await capture(first, 'journey-03-parameter-changed')}`);

    // ---- 4. undo and redo, by their keys ----
    await key(first, 'KeyZ', { ctrl: true });
    assert.equal((await docOf(first)).nodes[terraces]!.params.levels, 8);
    await settled(first);
    assert.ok(close(await inspect(first, shown), eight), 'undo shows the terrain of eight levels again');
    t.diagnostic(`capture: ${await capture(first, 'journey-04-undo')}`);
    await key(first, 'KeyZ', { ctrl: true, shift: true });
    assert.equal((await docOf(first)).nodes[terraces]!.params.levels, 3);
    await settled(first);
    assert.ok(close(await inspect(first, shown), three), 'redo shows the terrain of three levels again');
    t.diagnostic(`capture: ${await capture(first, 'journey-05-redo')}`);

    // ---- 5. save ----
    assert.equal(await first.eval<string>(`document.title`), 'Untitled* - Orogen');
    await first.eval(`void orogenTest.shell.answers.saveProjectDialog.push(${quote(file)})`);
    await key(first, 'KeyS', { ctrl: true });
    await first.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)} && orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(await first.eval<string>(`document.title`), 'journey - Orogen');
    const saved = await docOf(first);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text === serializeDoc(saved), 'the file holds the document as serializeDoc writes it');
    assert.deepEqual(parseDoc(text, REGISTRY).problems, []);
    t.diagnostic(`capture: ${await capture(first, 'journey-06-saved')}`);

    // ---- 6. a second application, beside the first, opens the file ----
    const second = await launch();
    const secondCaps = await ready(second);
    assert.equal(secondCaps.software, false);
    await docked(second);
    await settled(second);
    await second.eval(`void orogenTest.shell.answers.openProjectDialog.push(${quote(file)})`);
    await key(second, 'KeyO', { ctrl: true });
    await second.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    await settled(second);
    assert.ok(serializeDoc(await docOf(second)) === text, 'the second application holds the document the first saved');
    assert.equal(await second.eval<unknown>(`orogenTest.shell.state.getState().dialog`), null, 'the project opened without a problem');
    assert.ok(close(await inspect(second, shown), three), 'and computes the terrain the first one shows');
    assert.equal(await second.eval<string>(`document.title`), 'journey - Orogen');
    t.diagnostic(`capture: ${await capture(second, 'journey-07-second-application')}`);
    // The first has nothing more to show: it ends without an error of its own.
    await end(first);

    // ---- 7. a node that fails ----
    const absent = path.join(FOLDER, 'no-such-heights.png');
    let imported = '';
    await transact(second, 'Add Import Field', (draft) => {
      imported = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 220 });
      setParam(draft, REGISTRY, imported, 'file', absent);
    });
    await transact(second, 'View', (draft) => { draft.ui.view = { height: { node: imported, port: 'out' } }; }, { undoable: false });
    await second.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(imported)}]?.state === 'error'`, EVALUATION_BACKSTOP_MS);
    const error = await second.eval<NodeError>(`orogenTest.ctx.engineState.getState().nodes[${quote(imported)}].error`);
    assert.equal(error.kind, 'io');
    await appears(second, '[data-status="errors"]');
    assert.equal(await statusText(second, 'errors'), '1 node failed');
    assert.equal(await second.eval<string>(`document.querySelector('[data-status="device"]').getAttribute('data-state')`), 'ready');
    t.diagnostic(`capture: ${await capture(second, 'journey-08-node-failed')}`);
    await press(second, '[data-status="errors"]');
    await appears(second, `[data-error="node"][data-node="${imported}"]`);
    const said = await second.eval<string>(`document.querySelector('[data-error="node"][data-node="${imported}"]').textContent`);
    assert.ok(said.includes(error.message), `the list of errors says what the node said: ${said}`);
    t.diagnostic(`the node said: ${error.message}`);
    t.diagnostic(`capture: ${await capture(second, 'journey-09-error-list')}`);
    await press(second, '[data-ui="dialog"][data-dialog="errors"] [data-action="ok"]');
    await vanishes(second, '[data-ui="dialog"][data-dialog="errors"]');

    // The application is as usable as before: the view goes back to the terraces, and a parameter still changes them.
    await transact(second, 'View', (draft) => { draft.ui.view = { height: shown }; }, { undoable: false });
    await settled(second);
    assert.ok(close(await inspect(second, shown), three));
    await transact(second, 'Terraces: Levels', (draft) => setParam(draft, REGISTRY, terraces, 'levels', 5), { mergeKey: `param:${terraces}:levels` });
    await settled(second);
    const five = await inspect(second, shown);
    assert.ok(five !== null && !close(five, three));
    // The failing node is deleted: nothing is left to report.
    await transact(second, 'Delete', (draft) => removeNodes(draft, [imported]));
    await settled(second);
    await vanishes(second, '[data-status="errors"].og-status-error');
    t.diagnostic(`capture: ${await capture(second, 'journey-10-usable-again')}`);

    // ---- 8. the GPU process is gone (7.8) ----
    if (process.platform === 'linux') {
      const pids = gpuProcesses();
      assert.equal(pids.length, 1, `one application runs, with one GPU process: ${pids.join(', ')}`);
      const request = await second.eval<number>(`orogenTest.ctx.engineState.getState().nodes[${quote(terraces)}].requestId`);
      await second.eval(`void (window.journeyEvents = [], orogenTest.ctx.engine.subscribe((e) => {
        if (e.type === 'device-lost' || e.type === 'device-ready' || e.type === 'engine-error') window.journeyEvents.push(e.type);
      }))`);
      process.kill(pids[0]!, 'SIGKILL');
      await second.waitFor(`window.journeyEvents.includes('device-ready')`, EVALUATION_BACKSTOP_MS);
      await second.waitFor(`(() => {
        const state = orogenTest.ctx.engineState.getState();
        const node = state.nodes[${quote(terraces)}];
        return state.device.state === 'ready' && state.evaluation === null && state.view !== null && node.state === 'done' && node.requestId > ${request};
      })()`, EVALUATION_BACKSTOP_MS);
      assert.deepEqual(await second.eval<string[]>(`window.journeyEvents`), ['device-lost', 'device-ready']);
      assert.ok(close(await inspect(second, shown), five), 'the new device computes the terrain the lost one showed');
      t.diagnostic(`capture: ${await capture(second, 'journey-11-after-gpu-process-loss')}`);
    }

    // ---- 9. the engine worker is gone (8.5) ----
    // Nothing in a page ends its own worker; the test does, and tells nobody.
    await second.eval(`void (window.journeyCanvas = document.querySelector('[data-viewport="canvas"] canvas'), orogenTest.shell.engineWorker().terminate())`);
    await transact(second, 'Terraces: Levels', (draft) => setParam(draft, REGISTRY, terraces, 'levels', 4), { mergeKey: `param:${terraces}:levels` });
    const sent = await second.eval<number>(`orogenTest.ctx.doc.getState().engineRevision`);
    // A dead worker answers nothing, however long one waits: what is shown stays behind the document.
    await second.eval(`new Promise((resolve) => setTimeout(resolve, 500))`);
    assert.ok(await second.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`) < sent, 'nothing computes the change');
    // Engine → Restart Engine: another worker, told everything again, with a canvas of its own.
    await press(second, '.og-menubar-item[data-menu="Engine"]');
    await appears(second, '[data-ui="menu"][data-menu="Engine"] [data-item="engine.restart"]');
    await press(second, '[data-ui="menu"][data-menu="Engine"] [data-item="engine.restart"]');
    await second.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready'`, EVALUATION_BACKSTOP_MS);
    await settled(second);
    assert.equal(await second.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`), sent, 'the new engine shows the document as it is now');
    const four = await inspect(second, shown);
    assert.ok(four !== null && !close(four, five) && !close(four, three), `four levels are a terrain of their own: ${JSON.stringify(four)}`);
    assert.equal(await second.eval<boolean>(`(() => {
      const canvas = document.querySelector('[data-viewport="canvas"] canvas');
      return canvas !== null && canvas !== window.journeyCanvas && !window.journeyCanvas.isConnected;
    })()`), true, 'the viewport gave the new worker a canvas of its own');
    t.diagnostic(`capture: ${await capture(second, 'journey-12-after-engine-restart')}`);
    // And it is an engine like the first: an edit is computed, and undo brings back what it showed.
    await key(second, 'KeyZ', { ctrl: true });
    await settled(second);
    assert.ok(close(await inspect(second, shown), five), 'undo after the restart shows five levels again');

    await end(second);
  } finally {
    for (const app of running.splice(0)) await app.close().catch(() => {});
  }
});
