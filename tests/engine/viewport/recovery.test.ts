// The renderer and a lost device (runtime.md 7.5 rule 9, 7.8): after a loss it draws on the device recovery
// opens, to the canvas attached then; and a renderer whose device is lost with the first frame it drew, before
// that frame was confirmed, draws nothing for the rest of its life. This file makes its own contexts, one after
// another: there is one device per process.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { GpuContext, GpuProfile } from '../../../src/core/runtime.ts';
import { createNodeGpu } from '../../../src/platform/node/gpu.ts';
import { createViewportRenderer } from '../../../src/viewport/index.ts';
import { createCanvas, rangeDoc, region, SIZE, startView, within, writePicture } from './rig.ts';

const profile: GpuProfile = (process.env.OROGEN_GPU_PROFILE as GpuProfile | undefined) || 'core';
const contexts: GpuContext[] = [];
async function nextGpu(): Promise<GpuContext> {
  contexts.at(-1)?.destroy();
  const gpu = await createNodeGpu({ profile });
  contexts.push(gpu);
  return gpu;
}
after(() => {
  for (const gpu of contexts) gpu.destroy();
});

test('a lost device: the renderer draws nothing of it, and the terrain again on the device recovery opens', async () => {
  const first = await nextGpu();
  const rig = await startView({ gpu: first, reopenGpu: nextGpu });
  try {
    await rig.show(rangeDoc(1009));
    const before = await rig.picture();
    assert.ok(region(before, 0.2, 0.2, 0.8, 0.8).spread > 60);
    const hit = await rig.session.viewport.pick(800, 560);
    assert.ok(hit !== null);

    // A driver reset, without telling anyone.
    const from = rig.events.length;
    first.device.destroy();
    await rig.until(() => rig.events.slice(from).some((e) => e.type === 'device-lost'), 'the loss');
    assert.equal(await within(rig.session.viewport.pick(800, 560), 'a pick on a lost device'), null);
    await rig.until(() => rig.events.slice(from).some((e) => e.type === 'device-ready'), 'the new device');
    const second = contexts.at(-1)!;
    assert.ok(second !== first && !second.lost);
    // The panel attaches a new canvas at the device-ready that follows a loss (7.8 rule 6).
    rig.attach(second);
    await rig.until(() => rig.events.slice(from).some((e) => e.type === 'view-updated' && e.height), 'the view on the new device');
    const picture = await rig.picture();
    await writePicture('recovery-after-loss', picture);
    assert.ok(region(picture, 0.2, 0.2, 0.8, 0.8).spread > 60, 'the terrain is drawn on the new device');
    assert.equal(rig.renderer.state.blocked, false);
    const again = await rig.session.viewport.pick(800, 560);
    assert.ok(again !== null && Math.abs(again.height - hit.height) < 1e-4 && Math.abs(again.uv[0] - hit.uv[0]) < 1e-4, 'and the same point is under the same pixel');
    assert.ok(rig.engine.memory().reservedBytes >= rig.renderer.state.reservedBytes, 'what the renderer made on the new device is in its ledger');
  } finally {
    await rig.dispose();
  }
});

test('a device that is lost with the first frame, before it was confirmed: the renderer draws nothing more, on any device, and says so once', async () => {
  const gpu = await nextGpu();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]): void => { warned.push(args.map(String).join(' ')); };
  const renderer = createViewportRenderer({ canvasFormat: 'rgba8unorm' });
  try {
    const ledger = { reserve: () => ({ release() {} }) };
    renderer.init(gpu, ledger);
    // A window that cannot present: the frame's own texture costs the device (measured under a virtual display, 7.5 rule 9).
    const canvas = createCanvas(gpu);
    const element = canvas.element as unknown as { getContext(kind: string): { getCurrentTexture(): GPUTexture } };
    const context = element.getContext('webgpu');
    const lost = new Promise<void>((resolve) => gpu.onLost(() => resolve()));
    const patched = { ...context, getCurrentTexture: () => { queueMicrotask(() => gpu.device.destroy()); return context.getCurrentTexture(); } };
    renderer.attach({ width: 1, height: 1, getContext: () => patched } as unknown as OffscreenCanvas, SIZE);
    await within(lost, 'the loss of the device with the first frame');
    assert.equal(renderer.state.frames, 1);
    assert.equal(renderer.state.blocked, false);

    // Recovery opens another device: the renderer takes that for the same window, and draws nothing to it.
    const second = await nextGpu();
    renderer.init(second, ledger);
    assert.equal(renderer.state.blocked, true);
    renderer.attach(createCanvas(second).element, SIZE);
    renderer.setCamera({ kind: 'top', center: [0.5, 0.5], span: 1 });
    await within(renderer.whenIdle(), 'a renderer that draws nothing is idle');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(renderer.state.frames, 1, 'no frame on the second device');
    assert.equal(second.lost, false, 'which is therefore alive');
    renderer.init(second, ledger);
    assert.equal(warned.filter((line) => line.includes('the viewport stays empty')).length, 1, 'said once');
    assert.equal(await renderer.pick(10, 10), null);
  } finally {
    console.warn = warn;
    renderer.dispose();
  }
});
