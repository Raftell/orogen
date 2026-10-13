// A build whose graphics device is lost while it runs (runtime.md 7.6 rule 8, 7.8; export-unreal.md 3.9): the GPU
// process of the application is ended in the middle of a build at 4033. The build ends with the status the
// pipeline gives a lost device, nothing is put in place, and the panel says so and what to do; when the device
// is back, the same build runs to its end. Linux only: the GPU process is found through /proc.
//
// Capture, for a person: ui/build/device-01-lost.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { gpuProcesses } from '../platform/rig.ts';
import {
  build, buildState, built, capture, chooseFolder, dismissNotices, longRidge, press, scratch, text, texts, withBuildPanel, writeProject, BUILD_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('device');
const OUT = path.join(FOLDER, 'out');
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'ridge', longRidge({ buildResolution: 4033, previewLevel: 3 }).doc);

test('the graphics device is lost during a build: nothing is put in place, the panel says so, and the next build succeeds', { skip: process.platform !== 'linux' && 'the GPU process is found through /proc' }, async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    await chooseFolder(app, OUT);
    const pids = gpuProcesses();
    assert.equal(pids.length, 1, `one application runs, with one GPU process: ${pids.join(', ')}`);

    const before = (await buildState(app)).requestId;
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    // A target is being converted: the pipeline is reading fields back from the device.
    await app.waitFor(`(() => {
      const state = orogenTest.ctx.engineState.getState().build;
      return state.requestId !== ${before} && (state.target !== null || !state.running && state.result !== null);
    })()`, BUILD_BACKSTOP_MS);
    assert.equal((await buildState(app)).running, true, 'the build is still running when its first target begins');
    process.kill(pids[0]!, 'SIGKILL');

    const lost = await built(app, before);
    assert.equal(lost.status, 'device-lost', JSON.stringify(lost.problems));
    assert.deepEqual(lost.problems.filter((problem) => problem.severity === 'error').map((problem) => problem.code), ['E_DEVICE_LOST']);
    assert.deepEqual([lost.files, lost.manifest], [[], null]);
    // Nothing was put in place: the folder was never made, and beside it lies at the most the report.
    assert.equal(fs.existsSync(OUT), false);
    assert.deepEqual(fs.existsSync(`${OUT}.partial`) ? fs.readdirSync(`${OUT}.partial`) : [], lost.report === null ? [] : [lost.report]);

    assert.equal(await text(app, '[data-build="status-line"]'), 'Build stopped: device lost');
    assert.equal(await text(app, '[data-build="outcome"]'), 'Build stopped: device lost');
    assert.equal(await text(app, '[data-build="written"]'), 'Nothing was written to the output folder.');
    assert.match((await text(app, '[data-build="kept"]'))!, /^None of the 15 planned files was put in place: the folder holds what it held before\. The build is not resumed: build again when the device is ready\./);
    const problem = (await texts(app, '[data-build-problem="E_DEVICE_LOST"]'))[0]!;
    assert.ok(problem.startsWith('The graphics device was lostE_DEVICE_LOST'), problem);
    assert.ok(problem.endsWith('A build is not resumed. Build again when the status bar says that the device is ready.'), problem);
    await dismissNotices(app);
    t.diagnostic(`capture: ${await capture(app, 'device-01-lost')}`);

    // The session recovers the device (7.8); then the same build runs to its end.
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready' && orogenTest.ctx.engineState.getState().evaluation === null`, BUILD_BACKSTOP_MS);
    const again = await build(app);
    assert.equal(again.status, 'ok', JSON.stringify(again.problems));
    assert.equal(again.outDir, OUT);
    assert.equal(fs.existsSync(`${OUT}.partial`), false, 'the next build removed what the lost one left');
    assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished');
  });
  // A build at 4033 is some 150 MB: it has served, and is not left on the disk.
  scratch('device');
});
