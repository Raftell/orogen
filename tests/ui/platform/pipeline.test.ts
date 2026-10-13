// The pipeline end to end, in a window that is never shown (runtime.md 8.1 to 8.3): the page has the bridge and
// no Node, the engine worker opens a hardware device, a document evaluates, and the worker draws its terrain
// to the canvas the page transferred. The capture is written for a person; no pixel is compared.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { inspect, mountainDoc, ready, show, sleep, withApp } from './rig.ts';

/** The members of PlatformApi (runtime.md 8.6), as the preload script exposes them. */
const BRIDGE = [
  'chooseFolder', 'confirmClose', 'getPreferences', 'gpuProfile', 'launchProject', 'onCloseRequested', 'onMenuCommand', 'openFileDialog',
  'openProjectDialog', 'readTextFile', 'saveProjectDialog', 'setBuildActive', 'setPreferences', 'showInFolder', 'testMode', 'toProjectPath',
  'writeTextFile',
];

test('pipeline: the page has the bridge and nothing of Node', async () => {
  await withApp({ profile: 'core' }, async (app) => {
    const page = await app.eval<{ require: string; process: string; bridge: string[]; test: boolean; profile: string; project: unknown }>(`({
      require: typeof require,
      process: typeof process,
      bridge: Object.keys(orogenPlatform).sort(),
      test: orogenPlatform.testMode,
      profile: orogenPlatform.gpuProfile,
      project: orogenPlatform.launchProject,
    })`);
    assert.deepEqual(page, { require: 'undefined', process: 'undefined', bridge: BRIDGE, test: true, profile: 'core', project: null });
    // 8.2 rule 3: neither a new window nor another page.
    assert.equal(await app.eval<boolean>(`window.open('about:blank') === null`), true);
    await app.eval(`void (location.href = 'engine-worker.js')`);
    await sleep(200);
    assert.ok((await app.eval<string>(`location.href`)).endsWith('/dist/index.html'), 'the page is still the page');
    await ready(app);
  });
});

test('pipeline: the engine worker opens a hardware device with the profile asked for', async () => {
  for (const profile of ['core', 'max'] as const) {
    await withApp({ profile }, async (app) => {
      const caps = await ready(app);
      assert.equal(caps.software, false, `the adapter is ${caps.adapter.vendor} ${caps.adapter.description}: on Linux, SwiftShader here means the launch switches were not applied`);
      assert.equal(caps.adapter.isFallbackAdapter, false);
      assert.equal(await app.eval<string>(`orogenTest.ctx.platform.gpuProfile`), profile);
      if (profile === 'core') {
        assert.equal(caps.compactFormats, false);
        assert.equal(caps.timestampQuery, false);
        assert.equal(caps.limits.maxTextureDimension2D, 8192, 'a core device has the default limits');
      } else {
        assert.equal(caps.compactFormats, caps.adapterFeatures.includes('texture-formats-tier1'));
        assert.equal(caps.timestampQuery, caps.adapterFeatures.includes('timestamp-query'));
      }
    });
  }
});

test('pipeline: a document evaluates in the worker and its terrain is on the canvas', async (t) => {
  await withApp({ profile: 'core' }, async (app) => {
    const caps = await ready(app);
    const { doc, height } = mountainDoc();
    const revision = await show(app, doc);
    const state = await app.eval<{ view: { revision: number; resolution: number; draft: boolean }; node: { state: string; error: unknown } }>(`(() => {
      const state = orogenTest.ctx.engineState.getState();
      return { view: state.view, node: { state: state.nodes[${JSON.stringify(height.node)}].state, error: state.nodes[${JSON.stringify(height.node)}].error } };
    })()`);
    assert.deepEqual(state, { view: { revision, resolution: 505, draft: false }, node: { state: 'done', error: null } });

    // The engine's own statistics of what is shown: a mountain range is not a plane.
    const stats = await inspect(app, height);
    assert.ok(stats !== null && stats.nonFinite === 0 && stats.min >= 0 && stats.max <= 1 && stats.max - stats.min > 0.2, `the shown field is terrain: ${JSON.stringify(stats)}`);

    // A never-shown window paints its page once a second (testing.md 8.5): the picture is taken after that.
    await sleep(1200);
    const file = await app.capture('platform/pipeline');
    assert.ok(fs.statSync(file).size > 10_000, 'the capture holds a picture');
    t.diagnostic(`capture: ${file} (${caps.adapter.vendor} ${caps.adapter.description})`);
  });
});

test('pipeline: OROGEN_ELECTRON_GPU=software starts on the software adapter, which evaluates as well', async (t) => {
  await withApp({ profile: 'core', gpu: 'software' }, async (app) => {
    const caps = await ready(app);
    assert.equal(caps.software, true, `the adapter is ${caps.adapter.vendor} ${caps.adapter.description}`);
    const { doc, height } = mountainDoc();
    await show(app, doc);
    const stats = await inspect(app, height);
    assert.ok(stats !== null && stats.max - stats.min > 0.2, `the shown field is terrain: ${JSON.stringify(stats)}`);
    await sleep(1200);
    t.diagnostic(`capture: ${await app.capture('platform/software')} (${caps.adapter.description})`);
  });
});
