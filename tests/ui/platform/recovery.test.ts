// Device recovery in the application (runtime.md 7.8). The device of the engine worker is taken away the way it
// goes in earnest: the GPU process of the application is killed. The session announces the loss, opens a new
// device, evaluates the document again, and the terrain is back on a canvas.
//
// The GPU process is found among this process's own descendants, through /proc: only the application this test
// launched can be hit, and only on Linux.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gpuProcesses, inspect, mountainDoc, ready, sentRevision, show, sleep, withApp } from './rig.ts';

test('recovery: the loss of the GPU process is survived, and the terrain is shown again', { skip: process.platform === 'linux' ? false : 'the GPU process is found through /proc' }, async (t) => {
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    const { doc, height } = mountainDoc();
    await show(app, doc);
    const before = await inspect(app, height);
    assert.ok(before !== null);
    const node = `orogenTest.ctx.engineState.getState().nodes[${JSON.stringify(height.node)}]`;
    const request = await app.eval<number>(`${node}.requestId`);
    await app.eval(`void (window.deviceEvents = [], orogenTest.ctx.engine.subscribe((e) => {
      if (e.type === 'device-lost' || e.type === 'device-ready') window.deviceEvents.push(e.type);
      if (e.type === 'engine-error') window.deviceEvents.push('engine-error: ' + e.message);
    }))`);

    const pids = gpuProcesses();
    assert.equal(pids.length, 1, `the application has one GPU process: ${pids.join(', ')}`);
    process.kill(pids[0]!, 'SIGKILL');

    // 7.8 rules 1 and 2: device-lost, a new device, device-ready, and a full evaluation of the latest document.
    await app.waitFor(`window.deviceEvents.includes('device-ready')`, 60_000);
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      return state.device.state === 'ready' && state.evaluation === null && ${node}.state === 'done' && ${node}.requestId > ${request};
    })()`, 60_000);
    assert.deepEqual(await app.eval<string[]>(`window.deviceEvents`), ['device-lost', 'device-ready']);
    assert.equal(await app.eval<number>(`orogenTest.ctx.engineState.getState().view.revision`), await sentRevision(app));

    // Nothing the user made was held only on the GPU: the new device computes the same terrain.
    const after = await inspect(app, height);
    assert.ok(after !== null, 'the shown result can be inspected on the new device');
    for (const name of ['min', 'max', 'mean'] as const) assert.ok(Math.abs(after[name] - before[name]) <= 1e-6, `${name}: ${before[name]} before the loss, ${after[name]} after`);

    // A GPU process that goes is no error of the application.
    assert.deepEqual(await app.errors(), []);
    await sleep(1200);
    t.diagnostic(`capture: ${await app.capture('platform/recovery')}`);
  });
});
