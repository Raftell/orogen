// The view and the viewport host (runtime.md 7.4, 7.5 rule 2, 5.11), inspect (7.1), the memory report and the
// preferences (2.4, 7.7), and what dispose leaves behind (testing.md 2.8). The renderer is the rig's recording one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BYTES_PER_TEXEL } from '../../../src/core/gpu/pool.ts';
import type { ViewportContent } from '../../../src/core/runtime.ts';
import { budgetBytes, DEFAULT_PREFERENCES } from '../../../src/core/session/budget.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, MIB, PREVIEW, RENDERER_BYTES, resetSlow, slow, startSession } from './rig.ts';

const gpu = await testGpu();

const bytes = (kind: 'field' | 'color', resolution = PREVIEW): number =>
  resolution * resolution * BYTES_PER_TEXEL[gpu.caps.formats[kind] as keyof typeof BYTES_PER_TEXEL];
/** level → walk (slow) → out, with `far` (slow) and `paint` (a colour) beside the chain. */
const graph = (p: { value?: number; gain?: number; iterations?: number; lend?: boolean } = {}, view: object = { height: { node: 'out', port: 'out' } }, settings = {}) => doc({
  level: { type: 'ref/constant', params: { value: p.value ?? 0.25 } },
  walk: { type: 'ref/slow', params: { iterations: p.iterations ?? 24, lend: p.lend ?? false }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: p.gain ?? 2 }, inputs: { in: 'walk.out' } },
  far: { type: 'ref/slow', params: { iterations: 8 }, inputs: { in: 'level.out' } },
  paint: { type: 'ref/tint', params: { tint: [0.25, 0.5, 0.75] } },
}, view, settings);
const port = (node: string, name = 'out') => ({ node, port: name });
const contents = (calls: readonly { call: string }[], from: number): (ViewportContent | null)[] =>
  calls.slice(from).flatMap((c) => (c.call === 'setContent' ? [(c as unknown as { content: ViewportContent | null }).content] : []));

test('the session starts by announcing its device, and hands the renderer the device and the ledger', async () => {
  const t = await startSession({ budgetBytes: 300 * MIB });
  try {
    await t.idle();
    assert.deepEqual(t.events.map((e) => e.type), ['device-ready']);
    const ready = t.of('device-ready')[0]!;
    assert.deepEqual([ready.epoch, ready.budgetBytes, ready.caps], [1, 300 * MIB, gpu.caps]);
    assert.deepEqual(t.renderer.calls.map((c) => c.call), ['init']);
    assert.equal((t.renderer.calls[0] as { gpu: unknown }).gpu, gpu);
    const reserved = t.memory().reservedBytes;
    assert.ok(reserved >= RENDERER_BYTES, 'what the renderer registers is in the engine\'s ledger');
  } finally {
    await t.dispose();
  }
});

test('height and overlay come from one evaluation, and the viewport switches to both in one call', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph({}, { height: port('out'), overlay: { ref: port('paint'), as: 'color', opacity: 0.5 } }), 1);
    const shown = await t.next('view-updated');
    assert.deepEqual([shown.height, shown.overlay, shown.resolution], [true, true, PREVIEW]);
    assert.equal(t.renderer.switches, 1, 'one call for both parts');
    const content = t.renderer.content!;
    assert.deepEqual(
      [content.height?.kind, content.height?.width, content.height?.height, content.overlay?.texture.kind, content.overlay?.texture.width, content.overlay?.as, content.overlay?.opacity],
      ['field', PREVIEW, PREVIEW, 'color', PREVIEW, 'color', 0.5],
    );
    assert.deepEqual([content.terrainSize, content.heightRange, content.seaLevel], [4096, 1024, 0.25], 'the frame is the document\'s');
    await t.idle();
    assert.equal(t.memory().pinnedBytes, bytes('field') + bytes('color'), 'both parts are held by their handles');

    // A mask overlay of a colour port is that port converted to a field (7.4 rule 1); the height is unchanged content.
    const heightView = content.height!.view;
    t.session.setDocument(graph({}, { height: port('out'), overlay: { ref: port('paint'), as: 'mask', opacity: 1 } }), 2);
    await t.next('view-updated');
    const masked = t.renderer.content!;
    assert.deepEqual([masked.overlay?.texture.kind, masked.overlay?.as, masked.overlay?.opacity], ['field', 'mask', 1]);
    assert.equal(masked.height?.view, heightView, 'the same published texture, under a new handle');
    await t.idle();
    assert.equal(t.memory().pinnedBytes, 2 * bytes('field'), 'the handles of the result before were released');

    // An overlay alone is drawn on a flat plane: no height (7.4 rule 5).
    t.session.setDocument(graph({}, { overlay: { ref: port('walk', 'steps'), as: 'heat', opacity: 0.25 } }), 3);
    const flat = await t.next('view-updated');
    assert.deepEqual([flat.height, flat.overlay], [false, true]);
    assert.deepEqual([t.renderer.content?.height, t.renderer.content?.overlay?.as, t.renderer.content?.overlay?.texture.kind], [null, 'heat', 'field']);
    assert.equal(t.renderer.switches, 3);
  } finally {
    await t.dispose();
  }
});

test('what is on screen is pinned: emptying the cache does not take it', async () => {
  resetSlow();
  const t = await startSession({ budgetBytes: 8 * MIB });
  try {
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    await t.idle();
    await t.engine.trim();
    const memory = t.memory();
    assert.deepEqual([memory.cacheBytes, memory.freeBytes, memory.pinnedBytes], [0, 0, bytes('field')]);
    assert.deepEqual(await t.session.inspect(port('out')), { min: 2 * 24.25, max: 2 * 24.25, mean: 2 * 24.25, nonFinite: 0 }, 'the content behind the handle is intact');
  } finally {
    await t.dispose();
  }
});

test('inspect: the shown port, another port of the shown result, and null for what is not there', async () => {
  resetSlow();
  const t = await startSession();
  try {
    assert.equal(await t.session.inspect(port('out')), null, 'nothing is shown yet');
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    await t.idle();
    const runs = new Map(slow.runs);
    const requests = t.of('request-start').length;

    assert.deepEqual(await t.session.inspect(port('out')), { min: 48.5, max: 48.5, mean: 48.5, nonFinite: 0 });
    // Ports the view does not name, found in the cache at the shown resolution.
    assert.deepEqual(await t.session.inspect(port('walk')), { min: 24.25, max: 24.25, mean: 24.25, nonFinite: 0 });
    assert.deepEqual(await t.session.inspect(port('walk', 'steps')), { min: 24, max: 24, mean: 24, nonFinite: 0 });
    assert.deepEqual(await t.session.inspect(port('level')), { min: 0.25, max: 0.25, mean: 0.25, nonFinite: 0 });
    // Not a field; not cached at that resolution; not in the document.
    assert.equal(await t.session.inspect(port('paint')), null);
    assert.equal(await t.session.inspect(port('far')), null);
    assert.equal(await t.session.inspect(port('gone')), null);
    assert.equal(await t.session.inspect(port('walk', 'nope')), null);
    assert.deepEqual(slow.runs, runs, 'inspect never runs a node');
    assert.equal(t.of('request-start').length, requests, 'and is no request of the event stream');
    assert.equal(t.of('eval-start').length, requests);

    // Asked while an evaluation runs, it is answered between evaluations: from the result shown by then.
    let asked: Promise<unknown> | null = null;
    slow.at = (i, ctx) => { if (ctx.res === PREVIEW && i === 12) asked ??= t.session.inspect(port('level')); };
    t.session.setDocument(graph({ value: 0.75 }), 2);
    await t.next('view-updated');
    assert.deepEqual(await asked, { min: 0.75, max: 0.75, mean: 0.75, nonFinite: 0 });
    slow.at = undefined;

    // While paused the shown result can still be inspected.
    t.session.setPaused(true);
    assert.equal((await t.session.inspect(port('walk')))?.mean, 24.75);
  } finally {
    await t.dispose();
  }
});

test('inspecting a draft neither keeps its transient entries nor drops them', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    t.session.beginGesture();
    t.session.setDocument(graph({ value: 0.5 }), 2);
    const draft = await t.next('view-updated');
    assert.equal(draft.draft, true);
    // Not dropped: looking at one port leaves the entries of the others, which the next tick of the drag will want.
    assert.deepEqual(await t.session.inspect(port('level')), { min: 0.5, max: 0.5, mean: 0.5, nonFinite: 0 });
    assert.deepEqual(await t.session.inspect(port('walk', 'steps')), { min: 24, max: 24, mean: 24, nonFinite: 0 });
    assert.equal((await t.session.inspect(port('walk')))?.mean, 24.5);
    assert.equal((await t.session.inspect(port('out')))?.mean, 49);
    assert.equal(await t.session.inspect(port('far')), null, 'what the draft did not evaluate is not cached at its resolution');

    // Not kept: after an edit above them they are gone with the tick that replaced them.
    t.session.setDocument(graph({ value: 0.625 }), 3);
    const last = await t.next('view-updated');
    await t.idle();
    const memory = t.memory();
    const draftBytes = 4 * last.resolution * last.resolution * 4;
    assert.equal(memory.cacheBytes + memory.pinnedBytes, 4 * bytes('field') + draftBytes, JSON.stringify(memory));
  } finally {
    await t.dispose();
  }
});

test('a loan of the viewed port is drawn while its node runs, and withdrawn before the node settles', async () => {
  resetSlow();
  // Every iteration is a batch boundary, so the node lends at each one. Preview at 65.
  const t = await startSession({ hooks: { sliceTargetMs: 1e-6 } });
  const small = { buildResolution: 129, previewLevel: 1 };
  const lending = (value: number, view: object) => graph({ value, iterations: 6, lend: true }, view, small);
  try {
    // 1. Nothing is shown yet: the loans, then nothing again when they are withdrawn, then the result.
    t.session.setDocument(lending(0.25, { height: port('walk') }), 1);
    await t.next('view-updated');
    const first = contents(t.renderer.calls, 0);
    const result = first.at(-1)!;
    assert.ok(first.length >= 4, `${first.length} contents: at least two loans, their withdrawal and the result`);
    assert.equal(first.at(-2), null, 'the loans are withdrawn before the node settles');
    for (const lent of first.slice(0, -2)) {
      assert.deepEqual([lent?.height?.kind, lent?.height?.width, lent?.overlay, lent?.terrainSize], ['field', 65, null, 4096]);
    }
    // The node's state alternates between two fields; whichever holds the latest is the one lent.
    assert.equal(new Set(first.slice(0, -2).map((lent) => lent?.height?.view)).size, 2);
    assert.equal(t.of('node-preview').length > 0, true, 'the engine reported the previews');

    // 2. With a result on screen: the loans stand in for it, and it comes back when they are withdrawn.
    let from = t.renderer.calls.length;
    t.session.setDocument(lending(0.5, { height: port('walk') }), 2);
    await t.next('view-updated');
    const second = contents(t.renderer.calls, from);
    assert.ok(second.length >= 4);
    assert.equal(second.at(-2)?.height?.view, result.height?.view, 'after the loans, what was shown before');
    assert.notEqual(second.at(-1)?.height?.view, result.height?.view);
    for (const lent of second.slice(0, -2)) assert.notEqual(lent?.height?.view, result.height?.view);

    // 3. The view names another node: its loans are not drawn. One switch, to the result.
    from = t.renderer.calls.length;
    t.session.setDocument(lending(0.75, { height: port('out') }), 3);
    await t.next('view-updated');
    assert.equal(contents(t.renderer.calls, from).length, 1, 'the loans of a node the view does not name are not shown');

    // 4. The view asks for a colour of that port: a field loan is not the kind it asks for.
    from = t.renderer.calls.length;
    t.session.setDocument(lending(0.125, { height: port('out'), overlay: { ref: port('walk'), as: 'color', opacity: 1 } }), 4);
    await t.next('view-updated');
    assert.equal(contents(t.renderer.calls, from).length, 1);

    // 5. As a heat overlay the loan is the kind asked for: it is drawn over the height that is on screen.
    const shownHeight = t.renderer.content?.height?.view;
    from = t.renderer.calls.length;
    t.session.setDocument(lending(0.375, { height: port('out'), overlay: { ref: port('walk'), as: 'heat', opacity: 0.5 } }), 5);
    await t.next('view-updated');
    const fifth = contents(t.renderer.calls, from);
    assert.ok(fifth.length >= 4);
    for (const lent of fifth.slice(0, -2)) {
      assert.deepEqual([lent?.overlay?.as, lent?.overlay?.opacity, lent?.overlay?.texture.kind], ['heat', 0.5, 'field']);
      assert.equal(lent?.height?.view, shownHeight, 'the other part stays what it was');
    }

    // 6. An abort in the middle: the viewport shows what it showed before.
    const before = t.renderer.content;
    from = t.renderer.calls.length;
    slow.at = (i) => { if (i === 3) t.session.setPaused(true); };
    t.session.setDocument(lending(0.875, { height: port('out'), overlay: { ref: port('walk'), as: 'heat', opacity: 0.5 } }), 6);
    assert.equal((await t.next('eval-end')).status, 'aborted');
    await t.idle();
    const sixth = contents(t.renderer.calls, from);
    assert.ok(sixth.length >= 2, 'loans were shown before the abort');
    assert.deepEqual(sixth.at(-1), before);
    assert.equal(t.renderer.content?.overlay?.texture.view, before?.overlay?.texture.view);
  } finally {
    await t.dispose();
  }
});

test('setPreferences recomputes the budget and applies it; memory reports the ledger', async () => {
  const t = await startSession();
  try {
    await t.idle();
    const from = t.mark();
    t.session.setPreferences({ vramBytes: 1024 * MIB, budgetFraction: 0.5 });
    const memory = t.of('memory', from)[0]!;
    assert.deepEqual(Object.keys(memory).sort(), ['budgetBytes', 'cacheBytes', 'drainingBytes', 'freeBytes', 'pinnedBytes', 'reservedBytes', 'type', 'workingBytes']);
    assert.equal(memory.budgetBytes, 512 * MIB);
    assert.equal(t.memory().budgetBytes, 512 * MIB);
    // Headless the amount of video memory is unknown: 4 GiB stands in for it (2.4).
    t.session.setPreferences({ vramBytes: null, budgetFraction: 0.5 });
    assert.equal(t.memory().budgetBytes, budgetBytes(gpu.caps, { vramBytes: null, budgetFraction: 0.5 }));

    const caps = (vramBytes: number | null) => ({ ...gpu.caps, vramBytes });
    assert.equal(budgetBytes(caps(null), DEFAULT_PREFERENCES), Math.floor(4 * 2 ** 30 * 0.6));
    assert.equal(budgetBytes(caps(10 * 2 ** 30), DEFAULT_PREFERENCES), Math.floor(10 * 2 ** 30 * 0.6));
    assert.equal(budgetBytes(caps(10 * 2 ** 30), { vramBytes: 6 * 2 ** 30, budgetFraction: 0.5 }), 3 * 2 ** 30, 'the preference wins over what the adapter reports');
    assert.equal(budgetBytes(caps(null), { vramBytes: 1000, budgetFraction: 0.99 }), 850, 'the fraction is limited to 0.85');
    assert.equal(budgetBytes(caps(null), { vramBytes: 1000, budgetFraction: 0.1 }), 300, 'and to 0.3');
    assert.equal(budgetBytes(caps(null), { vramBytes: 1001, budgetFraction: 0.5 }), 500, 'floor');
  } finally {
    await t.dispose();
  }
});

test('the viewport host forwards to the renderer; without a renderer calls are ignored and the session still shows results', async () => {
  resetSlow();
  const t = await startSession();
  try {
    const canvas = {} as OffscreenCanvas;
    const size = { width: 640, height: 480, dpr: 2 };
    const camera = { kind: 'top', center: [0.5, 0.5], span: 1 } as const;
    const display = { verticalScale: 1, showSea: true, sunAzimuth: 315, sunElevation: 45 };
    t.session.viewport.attach(canvas, size);
    t.session.viewport.resize({ ...size, width: 800 });
    t.session.viewport.setCamera(camera);
    t.session.viewport.setDisplay(display);
    assert.deepEqual(await t.session.viewport.pick(10, 20), { uv: [0.1, 0.2], height: 0.5, position: [10, 20, 512] });
    assert.equal(await t.session.viewport.pick(-1, 0), null);
    t.session.viewport.detach();
    assert.deepEqual(t.renderer.calls.slice(1), [
      { call: 'attach', canvas, size }, { call: 'resize', value: { ...size, width: 800 } }, { call: 'setCamera', value: camera },
      { call: 'setDisplay', value: display }, { call: 'pick', x: 10, y: 20 }, { call: 'pick', x: -1, y: 0 }, { call: 'detach' },
    ]);
    assert.equal((t.renderer.calls[1] as { canvas: unknown }).canvas, canvas, 'the canvas itself is handed on');
  } finally {
    await t.dispose();
  }

  const headless = await startSession({ renderer: null });
  try {
    headless.session.viewport.attach({} as OffscreenCanvas, { width: 1, height: 1, dpr: 1 });
    headless.session.viewport.setCamera({ kind: 'top', center: [0, 0], span: 1 });
    headless.session.viewport.detach();
    assert.equal(await headless.session.viewport.pick(1, 1), null);
    headless.session.setDocument(graph(), 1);
    assert.equal((await headless.next('view-updated')).height, true);
    await headless.idle();
    assert.equal(headless.memory().pinnedBytes, bytes('field'), 'the shown result is held without a renderer too');
    assert.equal((await headless.session.inspect(port('out')))?.mean, 48.5);
  } finally {
    await headless.dispose();
  }
});

test('a slice over the hard ceiling is an engine-error that is not fatal, and the session goes on', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    await t.idle();
    t.mark();
    t.overrun({ nodeId: 'walk', service: null, kernels: ['test/session.step'], measuredMs: 612.4, ceilingMs: 500 });
    t.overrun({ nodeId: null, service: 'thumbnail', kernels: ['core/thumbnail.shade'], measuredMs: 260, ceilingMs: 250 });
    assert.deepEqual(t.of('engine-error').map((e) => ({ ...e })), [
      { type: 'engine-error', fatal: false, message: 'A slice of node "walk" took 612 ms, above the hard ceiling of 500 ms (kernels: test/session.step)' },
      { type: 'engine-error', fatal: false, message: 'A slice of the engine\'s thumbnail service took 260 ms, above the hard ceiling of 250 ms (kernels: core/thumbnail.shade)' },
    ]);
    // Nothing else changed: the next edit is evaluated and shown.
    t.session.setDocument(graph({ value: 0.75 }), 2);
    assert.equal((await t.next('view-updated')).revision, 2);
  } finally {
    await t.dispose();
  }
  // After dispose the session hears nothing more of its engine.
  const count = t.events.length;
  t.overrun({ nodeId: 'walk', service: null, kernels: [], measuredMs: 900, ceilingMs: 500 });
  assert.equal(t.events.length, count);
});

test('an inspection under way when the session is disposed ends first: the engine is disposed with nothing held', async () => {
  resetSlow();
  // Both ways an inspection reads: the handle on screen, and a port found through the cache.
  for (const ref of [port('out'), port('walk')]) {
    const t = await startSession();
    const errors: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      t.session.setDocument(graph(), 1);
      await t.next('view-updated');
      await t.idle();
      const asked = t.session.inspect(ref);
      await t.session.dispose();
      const answer = await asked;
      assert.ok(answer === null || typeof answer.mean === 'number');
      const left = t.atDispose!;
      assert.deepEqual(
        [left.workingBytes, left.pinnedBytes, left.cacheBytes, left.freeBytes], [0, 0, 0, 0],
        `nothing is held when the engine is disposed: ${JSON.stringify(left)}`,
      );
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(errors, [], 'nothing was logged: no GPU error, no failed inspection');
    } finally {
      console.error = error;
      await t.dispose();
    }
  }
});

test('dispose aborts what runs, releases every handle and disposes renderer and engine: nothing is left in the pool', async () => {
  resetSlow();
  const t = await startSession();
  t.session.setDocument(graph({}, { height: port('out'), overlay: { ref: port('paint'), as: 'color', opacity: 1 } }), 1);
  await t.next('view-updated');
  await t.idle();
  assert.equal(t.memory().pinnedBytes, bytes('field') + bytes('color'), 'before: the shown result is pinned');

  // Disposed in the middle of the slow node of the next evaluation, with an inspection and a build waiting.
  let disposing: Promise<void> | null = null;
  let inspecting: Promise<unknown> | null = null;
  let building: Promise<string> | null = null;
  slow.at = (i) => {
    if (i !== 12 || disposing) return;
    inspecting = t.session.inspect(port('walk'));
    building = t.session.build({ doc: graph(), outDir: '/out/terrain' }).then((r) => r.status, (e: Error) => e.message);
    disposing = t.session.dispose();
  };
  const count = t.events.length;
  t.session.setDocument(graph({ value: 0.5 }), 2);
  // The hook has not run yet: wait for the evaluation to reach it through the events it emits meanwhile.
  await t.next('node-start', (e) => e.nodeId === 'walk');
  for (let turn = 0; turn < 10_000 && !disposing; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(disposing, 'the slow node reached the iteration that disposes the session');
  await disposing;

  assert.equal(await inspecting, null, 'a waiting inspection is answered with null');
  assert.equal(await building, 'The engine session is disposed', 'a build that had not started is refused');
  assert.deepEqual(t.renderer.calls.slice(-2), [{ call: 'setContent', content: null }, { call: 'dispose' }]);
  const left = t.atDispose!;
  assert.deepEqual(
    [left.workingBytes, left.pinnedBytes, left.cacheBytes, left.freeBytes], [0, 0, 0, 0],
    `no texture is held after dispose: ${JSON.stringify(left)}`,
  );
  await assert.rejects(Promise.resolve().then(() => t.engine.memory()), /disposed/, 'the engine is disposed');

  // Nothing is emitted for the evaluation that was cut off, and the session ignores what it is told afterwards.
  const after = t.events.length;
  assert.equal(t.session.dispose(), disposing, 'a second dispose is the first');
  t.session.setDocument(graph(), 3);
  t.session.beginGesture();
  t.session.endGesture();
  t.session.setPaused(true);
  t.session.requestThumbnails(['level']);
  t.session.setPreferences(DEFAULT_PREFERENCES);
  t.session.setProject({ path: null });
  t.session.retryDevice();
  t.session.cancelBuild();
  t.session.viewport.detach();
  assert.equal(await t.session.inspect(port('out')), null);
  assert.equal(await t.session.viewport.pick(1, 1), null);
  await assert.rejects(t.session.build({ doc: graph(), outDir: '/out' }), /disposed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(t.events.length, after);
  assert.ok(count <= after);
});
