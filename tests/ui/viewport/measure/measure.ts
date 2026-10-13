// Frame pace and memory of the viewport in the application, in a window that is never shown, for fields of
// 1009, 4033 and 8129. Not a test of a suite (its name ends in no .test.ts): it evaluates a field of 8129 on the
// machine's card, and what it finds is read by a person.
//
//   npm run build
//   tools/guard --lock --mem=4G --timeout=1800 node --test --test-timeout=900000 tests/ui/viewport/measure/measure.ts
//
// A round is one change of the camera and the answer to a pick, which the worker gives when the frame of that
// camera is drawn and the GPU has done it (src/viewport/renderer.ts). Frames are drawn from the worker's
// animation frame, so a round cannot be shorter than the display's refresh: 16.7 ms a round is 60 frames a
// second held, and a longer median is a frame that took longer than a refresh.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MemoryReport } from '../../../../src/core/runtime.ts';
import { launchApp } from '../../../helpers/index.ts';
import { canvasSize, capture, makeDoc, prepare, quote, show } from '../rig.ts';

const MIB = 2 ** 20;
const ROUNDS = 150;
const EVALUATION_MS = 600_000;

test('measure: the pace of the viewport and the memory of the engine for 1009, 4033 and 8129', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    const canvas = await canvasSize(app);
    t.diagnostic(`canvas ${canvas.width} × ${canvas.height} CSS pixels, device pixel ratio ${await app.eval<number>('window.devicePixelRatio')}`);
    const base = await app.eval<MemoryReport | null>(`orogenTest.ctx.engineState.getState().memory`);
    for (const resolution of [1009, 4033, 8129]) {
      const size = resolution - 1;
      const doc = makeDoc({ range: { type: 'generate/mountain-range' } }, { height: { node: 'range', port: 'out' } },
        { buildResolution: resolution, previewLevel: 0, terrainSize: size, heightRange: size / 4 });
      const started = Date.now();
      await show(app, doc, EVALUATION_MS);
      const shownMs = Date.now() - started;
      const state = await app.eval<string>(`orogenTest.ctx.engineState.getState().nodes.range?.state ?? 'none'`);
      assert.equal(state, 'done', `the field of ${resolution} was computed`);
      const memory = await app.eval<MemoryReport>(`orogenTest.ctx.engineState.getState().memory`);
      t.diagnostic(`${resolution} × ${resolution}: shown ${shownMs} ms after it was loaded; engine: ${Math.round(memory.pinnedBytes / MIB)} MB pinned (the field on screen), `
        + `${Math.round(memory.cacheBytes / MIB)} MB cached, ${Math.round(memory.reservedBytes / MIB)} MB reserved (the renderer's textures among them; ${Math.round((base?.reservedBytes ?? 0) / MIB)} MB before any terrain), `
        + `budget ${Math.round(memory.budgetBytes / MIB)} MB`);
      const views: Readonly<Record<string, string>> = {
        'whole terrain': `({ kind: 'orbit', target: [${size / 2}, ${size / 2}, ${size * 0.06}], yaw: 300 + i * 2, pitch: 30, distance: ${2 * size}, fovY: 35 })`,
        'half the terrain': `({ kind: 'orbit', target: [${size / 2}, ${size / 2}, ${size * 0.08}], yaw: 300 + i * 2, pitch: 25, distance: ${0.7 * size}, fovY: 35 })`,
        'near the ground': `({ kind: 'orbit', target: [${size / 2}, ${size / 2}, ${size * 0.1}], yaw: 300 + i * 2, pitch: 12, distance: ${0.12 * size}, fovY: 35 })`,
        'top view': `({ kind: 'top', center: [0.5 + 0.001 * i, 0.5], span: 1.7 })`,
      };
      for (const [name, camera] of Object.entries(views)) {
        const times = await app.eval<number[]>(`(async () => {
          const { viewport } = orogenTest.ctx.engine;
          const times = [];
          for (let i = 0; i < ${ROUNDS}; i++) {
            const t0 = performance.now();
            viewport.setCamera(${camera});
            await viewport.pick(${canvas.width / 2}, ${canvas.height / 2});
            times.push(performance.now() - t0);
          }
          return times;
        })()`);
        const sorted = [...times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!, high = sorted[Math.floor(sorted.length * 0.95)]!;
        t.diagnostic(`  ${name.padEnd(18)} a round takes ${median.toFixed(1)} ms in the median, ${high.toFixed(1)} ms at the 95th percentile, ${sorted.at(-1)!.toFixed(1)} ms at most: ${(1000 / median).toFixed(0)} frames a second`);
      }
      await app.eval(`void orogenTest.ctx.engine.viewport.setCamera(${quote({ kind: 'orbit', target: [size / 2, size / 2, size * 0.07], yaw: 300, pitch: 28, distance: 1.55 * size, fovY: 35 })})`);
      t.diagnostic(`capture: ${await capture(app, `measure-${resolution}`)}`);
    }
    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
