// Device recovery in the application (runtime.md 7.8). The device of the engine worker is taken away the way it
// goes in earnest: the GPU process of the application is killed. The session announces the loss, opens a new
// device, evaluates the document again, and the terrain is back on a canvas.
//
// The GPU process is found among this process's own descendants, through /proc: only the application this test
// launched can be hit, and only on Linux.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { launchApp } from '../../helpers/index.ts';
import { gpuProcesses, inspect, mountainDoc, ready, sentRevision, show, shown, sleep, withApp } from './rig.ts';

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

const ADAPTER = `(() => {
  const device = orogenTest.ctx.engineState.getState().device;
  return { state: device.state, message: device.message, software: device.caps ? device.caps.software : null };
})()`;

test('recovery: a second loss of the GPU process ten seconds after the first is recovered as the first was, on the same adapter', { skip: process.platform === 'linux' ? false : 'the GPU process is found through /proc', timeout: 240_000 }, async (t) => {
  // Without the two switches of 1.6 Chromium refuses the page every adapter for about two minutes after a second
  // end of its GPU process: the three attempts, Retry and a restarted engine all failed (7.8 rule 3).
  await withApp({ profile: 'core' }, async (app) => {
    await ready(app);
    const { doc, height } = mountainDoc();
    await show(app, doc);
    const before = await app.eval<{ state: string; software: boolean | null }>(ADAPTER);
    await app.eval(`void (window.deviceEvents = [], orogenTest.ctx.engine.subscribe((e) => {
      if (e.type === 'device-lost' || e.type === 'device-ready') window.deviceEvents.push(e.type);
      if (e.type === 'engine-error') window.deviceEvents.push('engine-error: ' + e.message);
    }))`);
    for (let loss = 1; loss <= 2; loss++) {
      const pids = gpuProcesses();
      assert.equal(pids.length, 1, `loss ${loss}: the application has one GPU process: ${pids.join(', ')}`);
      process.kill(pids[0]!, 'SIGKILL');
      await app.waitFor(`window.deviceEvents.filter((e) => e === 'device-lost').length >= ${loss}`, 30_000);
      // By itself: nobody presses Retry. The session's attempts are over after six seconds at the latest.
      await app.waitFor(`['ready', 'failed'].includes(orogenTest.ctx.engineState.getState().device.state)`, 40_000);
      const after = await app.eval<{ state: string; message: string | null; software: boolean | null }>(ADAPTER);
      assert.equal(after.state, 'ready', `loss ${loss}: the device is back by itself: ${after.message}`);
      assert.equal(after.software, before.software, `loss ${loss}: on the adapter it had, not on a software adapter in its place`);
      await shown(app, await sentRevision(app));
      assert.ok(await inspect(app, height) !== null, `loss ${loss}: the terrain is computed again`);
      // As far apart as the review's probe had them, and well inside Chromium's two minutes.
      if (loss === 1) await sleep(10_000);
    }
    assert.deepEqual(await app.eval<string[]>(`window.deviceEvents`), ['device-lost', 'device-ready', 'device-lost', 'device-ready']);
    assert.deepEqual(await app.errors(), []);
    t.diagnostic(`both losses were recovered on ${before.software ? 'the software adapter' : 'the hardware adapter'}`);
  });
});

test('recovery: a GPU process that ends while the engine starts does not leave the application without a device', { skip: process.platform === 'linux' ? false : 'the GPU process is found through /proc', timeout: 180_000 }, async (t) => {
  // launchApp returns when the window has loaded: the engine worker is then opening its first device (8.3 step 1).
  const app = await launchApp({ profile: 'core' });
  try {
    const at = await app.eval<string>(`orogenTest.ctx.engineState.getState().device.state`);
    const pids = gpuProcesses();
    assert.equal(pids.length, 1, `the application has one GPU process: ${pids.join(', ')}`);
    process.kill(pids[0]!, 'SIGKILL');
    t.diagnostic(`the GPU process was killed while the device was '${at}'`);
    // Nobody presses Retry: the first device is asked for again on the schedule of recovery, or, where it was
    // there already, the session recovers it.
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      return state.device.state === 'ready' && state.view !== null && state.evaluation === null;
    })()`, 90_000);
    const device = await app.eval<{ state: string; message: string | null }>(ADAPTER);
    assert.equal(device.state, 'ready', `the engine has a device: ${device.message}`);
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-status="device"]')?.textContent ?? null`), 'Ready');
    assert.deepEqual((await app.errors()).filter((line) => line.includes('The engine did not start')), [], 'no call was answered with "The engine did not start"');
  } finally {
    await app.close().catch(() => {});
  }
});
