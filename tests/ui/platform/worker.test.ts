// What the engine worker has beside the device (runtime.md 8.1, 8.3, 6.3): Node's file and compression modules,
// and a CPU worker of its own. Shown by what they do: a file is read from disk and decoded, a missing one is
// reported by the file system, and a build writes its files. And what a worker may not do: take the page, or
// the next worker, with it when it is killed (8.5, `EngineClient.connect`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { BuildResult, GraphDoc, NodeError, PortRef } from '../../../src/core/runtime.ts';
import { makeDoc } from '../../helpers/index.ts';
import { inspect, mountainDoc, OUTPUT, ready, ROOT, show, withApp } from './rig.ts';

const IMAGE = path.join(ROOT, 'tests/nodes/io/assets/terrain-193.png');
const ABSENT = path.join(OUTPUT, 'worker', 'no-such-image.png');

/** An imported height field, shown and exported; and an import whose file does not exist. */
function project(): { readonly doc: GraphDoc; readonly imported: PortRef; readonly absent: string } {
  const doc = makeDoc({
    // 337 is the smallest build resolution near the image's 193 that is both a ladder (engine.md 1.5) and an Unreal landscape size.
    settings: { buildResolution: 337, previewLevel: 1 },
    nodes: {
      imported: { type: 'io/import-field', params: { file: IMAGE } },
      absent: { type: 'io/import-field', params: { file: ABSENT } },
      landscape: { type: 'io/export-landscape', inputs: { in: 'imported.out' } },
      heights: { type: 'io/export-field', params: { name: 'Heights', format: 'png16' }, inputs: { in: 'imported.out' } },
    },
  });
  const ids = Object.keys(doc.nodes);
  const imported = { node: ids.find((id) => doc.nodes[id]!.params.file === IMAGE)!, port: 'out' };
  return { doc: { ...doc, ui: { ...doc.ui, view: { height: imported } } }, imported, absent: ids.find((id) => doc.nodes[id]!.params.file === ABSENT)! };
}

test('worker: an image is read with node:fs and decoded in the CPU worker', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    const { doc, imported } = project();
    await show(app, doc);
    const stats = await inspect(app, imported);
    assert.ok(stats !== null && stats.nonFinite === 0 && stats.max - stats.min > 0.2, `the imported field is the terrain of the file: ${JSON.stringify(stats)}`);
  });
});

test('worker: a build writes its files from the worker, and a missing file is the file system\'s word', async (t) => {
  const outDir = path.join(OUTPUT, 'worker', 'build');
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    const { doc, absent } = project();
    await show(app, doc);

    // Evaluated for its own sake: the node whose file is not there fails with what node:fs said.
    const lone: GraphDoc = { ...doc, ui: { ...doc.ui, view: { height: { node: absent, port: 'out' } } } };
    await app.eval(`orogenTest.ctx.doc.getState().load(${JSON.stringify(lone)}, null)`);
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      return state.evaluation === null && state.nodes[${JSON.stringify(absent)}] !== undefined && state.nodes[${JSON.stringify(absent)}].state === 'error';
    })()`, 60_000);
    const error = await app.eval<NodeError>(`orogenTest.ctx.engineState.getState().nodes[${JSON.stringify(absent)}].error`);
    assert.equal(error.kind, 'io');
    assert.ok(error.message.includes('File not found') && error.message.includes(ABSENT), error.message);

    const result = await app.eval<BuildResult>(`orogenTest.ctx.engine.build({ doc: ${JSON.stringify(doc)}, outDir: ${JSON.stringify(outDir)} })`);
    assert.equal(result.status, 'ok', `the build ended ${result.status}: ${JSON.stringify(result.problems)}`);
    assert.ok(result.files.length >= 3 && result.manifest !== null);
    for (const file of result.files) {
      assert.equal(fs.statSync(path.join(outDir, file.path)).size, file.bytes, `${file.path} is on disk at the size the build reports`);
    }
    // The PNG files went through node:zlib in the worker: each begins as a PNG does.
    const png = result.files.filter((file) => file.path.endsWith('.png'));
    assert.ok(png.length >= 2);
    for (const file of png) assert.equal(fs.readFileSync(path.join(outDir, file.path)).subarray(1, 4).toString('latin1'), 'PNG', file.path);
    assert.deepEqual(fs.readdirSync(path.dirname(outDir)).filter((name) => name.endsWith('.partial')), [], 'the staging folder is gone');
    t.diagnostic(`${result.files.length} files in ${outDir}`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && !orogenTest.ctx.engineState.getState().build.running`, 60_000);
  });
});

/**
 * Engine workers of the test's own, made by the page from the built script and spoken to in the messages of
 * runtime.md 7.2. `spare.start(doc)` creates one and tells it what a client tells a session first; its events
 * are kept by type, without those that come many times a second.
 */
const SPARE = `window.spare = (() => {
  const made = [];
  const quiet = ['thumbnail', 'node-progress', 'eval-progress', 'node-preview', 'memory', 'keys'];
  return {
    start(doc) {
      const worker = new Worker('./engine-worker.js');
      const record = { worker, events: [], sent: 0 };
      worker.onmessage = (e) => {
        const event = e.data && e.data.event;
        if (!event || quiet.includes(event.type)) return;
        record.events.push(event.type === 'engine-error' ? 'engine-error: ' + event.message : event.type === 'view-updated' ? 'view-updated ' + event.revision : event.type);
      };
      record.tell = (method, ...args) => worker.postMessage({ id: ++record.sent, method, args });
      record.tell('setPreferences', { vramBytes: null, budgetFraction: 0.6 });
      record.tell('setProject', { path: null });
      record.tell('setDocument', doc, 1);
      return made.push(record) - 1;
    },
    events: (index) => made[index].events,
    tell: (index, method, ...args) => made[index].tell(method, ...args),
    kill: (index) => made[index].worker.terminate(),
  };
})(), undefined`;

test('worker: an engine worker that is killed takes nothing with it, and one started in its place evaluates', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    const first = mountainDoc();
    await show(app, first.doc);
    await app.eval(SPARE);

    // A second engine beside the application's own: its device, its session, its evaluation.
    const second = await app.eval<number>(`spare.start(${JSON.stringify(first.doc)})`);
    await app.waitFor(`spare.events(${second}).includes('view-updated 1')`, 60_000);
    const events = await app.eval<string[]>(`spare.events(${second})`);
    assert.equal(events[0], 'device-ready');
    assert.deepEqual(events.filter((type) => type.startsWith('engine-error') || type === 'device-lost'), []);

    // Killed with a document on its way to it: no message of the session says goodbye.
    const next = mountainDoc();
    await app.eval(`void (spare.tell(${second}, 'setDocument', ${JSON.stringify(next.doc)}, 2), spare.kill(${second}))`);

    // The page is there, and the application's own engine evaluates and answers as before.
    await show(app, next.doc);
    const stats = await inspect(app, next.height);
    assert.ok(stats !== null && stats.max - stats.min > 0.2, `the application's engine still shows terrain: ${JSON.stringify(stats)}`);
    assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().device.state`), 'ready');

    // A worker in the place of the killed one starts from nothing and is told everything again.
    const third = await app.eval<number>(`spare.start(${JSON.stringify(next.doc)})`);
    await app.waitFor(`spare.events(${third}).includes('view-updated 1')`, 60_000);
    assert.equal((await app.eval<string[]>(`spare.events(${third})`))[0], 'device-ready');
    assert.deepEqual(await app.eval<string[]>(`spare.events(${second}).filter((type) => type === 'view-updated 2')`), [], 'the killed worker reported nothing more');
    await app.eval(`void spare.tell(${third}, 'dispose')`);
    assert.deepEqual(await app.errors(), []);
  });
});
