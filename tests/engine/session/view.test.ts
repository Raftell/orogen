// The view and the viewport host (runtime.md 7.4, 7.5 rule 2, 5.11), inspect (7.1), the memory report and the
// preferences (2.4, 7.7), and what dispose leaves behind (testing.md 2.8). The renderer is the rig's recording one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BYTES_PER_TEXEL } from '../../../src/core/gpu/pool.ts';
import type { ViewportContent } from '../../../src/core/runtime.ts';
import { budgetBytes, budgetInForce, DEFAULT_PREFERENCES, MIN_FIELD_BYTES } from '../../../src/core/session/budget.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, endings, MIB, PREVIEW, recordingRenderer, RENDERER_BYTES, resetSlow, slow, startSession, within } from './rig.ts';

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

test('a loan of the viewed port is drawn while its node runs, withdrawn before the node settles, and followed by the node\'s result', async () => {
  resetSlow();
  // Every iteration is a batch boundary, so the node lends at each one. Preview at 65.
  const t = await startSession({ hooks: { sliceTargetMs: 1e-6 } });
  const small = { buildResolution: 129, previewLevel: 1 };
  const lending = (value: number, view: object) => graph({ value, iterations: 6, lend: true }, view, small);
  try {
    // 1. Nothing is shown yet: the loans; nothing again when they are withdrawn; the node's result in their
    // place as soon as it is published; then the result of the evaluation.
    t.session.setDocument(lending(0.25, { height: port('walk') }), 1);
    await t.next('view-updated');
    const first = contents(t.renderer.calls, 0);
    const result = first.at(-1)!;
    assert.ok(first.length >= 5, `${first.length} contents: at least two loans, their withdrawal, the node's result and the result`);
    assert.equal(first.at(-3), null, 'the loans are withdrawn before the node settles: a step back to what was shown, which is nothing');
    assert.deepEqual([first.at(-2)?.height?.view === result.height?.view, first.at(-2) === result, first.at(-2)?.overlay], [true, false, null], 'then the node\'s published result stands in');
    for (const lent of first.slice(0, -3)) {
      assert.deepEqual([lent?.height?.kind, lent?.height?.width, lent?.overlay, lent?.terrainSize], ['field', 65, null, 4096]);
    }
    // The node's state alternates between two fields; whichever holds the latest is the one lent.
    assert.equal(new Set(first.slice(0, -3).map((lent) => lent?.height?.view)).size, 2);
    assert.equal(t.of('node-preview').length > 0, true, 'the engine reported the previews');

    // 2. With a result on screen: the loans stand in for it; it comes back, the same object, when they are
    // withdrawn (the renderer keeps its picture for that, 7.5 rule 2); the new result follows.
    let from = t.renderer.calls.length;
    t.session.setDocument(lending(0.5, { height: port('walk') }), 2);
    await t.next('view-updated');
    const second = contents(t.renderer.calls, from);
    assert.ok(second.length >= 5);
    assert.equal(second.at(-3), result, 'after the loans, the content that was shown before: the same object');
    assert.notEqual(second.at(-1)?.height?.view, result.height?.view);
    assert.equal(second.at(-2)?.height?.view, second.at(-1)?.height?.view, 'the node\'s result is drawn before the evaluation has ended');
    for (const lent of second.slice(0, -3)) assert.notEqual(lent?.height?.view, result.height?.view);

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

    // 5. As a heat overlay the loan is the kind asked for: it is drawn over the height that is on screen. The
    // height is `out`, which runs after the lending node: the node's result stays on screen meanwhile.
    const shownBefore = t.renderer.content;
    const shownHeight = shownBefore?.height?.view;
    from = t.renderer.calls.length;
    t.session.setDocument(lending(0.375, { height: port('out'), overlay: { ref: port('walk'), as: 'heat', opacity: 0.5 } }), 5);
    await t.next('view-updated');
    const fifth = contents(t.renderer.calls, from);
    assert.ok(fifth.length >= 5);
    assert.equal(fifth.at(-3), shownBefore, 'the step back when the loans end');
    for (const lent of fifth.slice(0, -3).concat([fifth.at(-2)!])) {
      assert.deepEqual([lent?.overlay?.as, lent?.overlay?.opacity, lent?.overlay?.texture.kind], ['heat', 0.5, 'field']);
      assert.equal(lent?.height?.view, shownHeight, 'the other part stays what it was');
    }
    assert.equal(fifth.at(-2)?.overlay?.texture.view, fifth.at(-1)?.overlay?.texture.view, 'the overlay drawn after the loans is the node\'s result');
    assert.notEqual(fifth.at(-1)?.height?.view, shownHeight);

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

test('while the nodes after a lending node run, the viewport shows that node\'s result, not the earlier terrain', async () => {
  resetSlow();
  const t = await startSession({ hooks: { sliceTargetMs: 1e-6 } });
  // level → walk (lends) → after (slow as well, told from walk by its iteration count); the view is walk with `after` over it.
  const chain = (value: number) => doc({
    level: { type: 'ref/constant', params: { value } },
    walk: { type: 'ref/slow', params: { iterations: 6, lend: true }, inputs: { in: 'level.out' } },
    after: { type: 'ref/slow', params: { iterations: 5 }, inputs: { in: 'walk.out' } },
  }, { height: port('walk'), overlay: { ref: port('after'), as: 'heat', opacity: 0.5 } }, { buildResolution: 129, previewLevel: 1 });
  /** What the renderer holds while `after` is in its loop; set from inside the node, behind the type checker's back. */
  const seen: { during: ViewportContent | null | undefined; pause: boolean } = { during: undefined, pause: false };
  slow.at = (i, ctx) => {
    if (ctx.params.iterations !== 5 || i !== 2) return;
    seen.during = t.renderer.content;
    if (seen.pause) t.session.setPaused(true);
  };
  const duringOf = (): ViewportContent | null | undefined => seen.during;
  try {
    t.session.setDocument(chain(0.25), 1);
    await t.next('view-updated');
    await t.idle();
    const earlier = t.renderer.content!;
    const held = t.memory().pinnedBytes;
    assert.equal(held, 2 * 65 * 65 * 4, 'the two parts of the shown result');

    // 1. A new terrain: its loans, and from the moment the lending node has settled its result, with the earlier
    // overlay still over it, until the whole evaluation is shown.
    seen.during = undefined;
    let from = t.renderer.calls.length;
    t.session.setDocument(chain(0.5), 2);
    await t.next('view-updated');
    await t.idle();
    const shown = t.renderer.content!;
    const during = duringOf();
    assert.ok(during, 'the node after the lending one ran');
    assert.notEqual(during.height?.view, earlier.height?.view, 'not the earlier terrain');
    assert.equal(during.height?.view, shown.height?.view, 'the lending node\'s own result');
    assert.equal(during.overlay?.texture.view, earlier.overlay?.texture.view, 'the part no loan stood in for is still the earlier one');
    assert.notEqual(shown.overlay?.texture.view, earlier.overlay?.texture.view);
    const second = contents(t.renderer.calls, from);
    assert.deepEqual([second.at(-3) === earlier, second.at(-2) === during, second.at(-1) === shown], [true, true, true], 'the step back, the node\'s result, the result');
    assert.equal(t.memory().pinnedBytes, held, 'the handle that held the node\'s result meanwhile is released');

    // 2. Aborted while the node after it runs: the viewport shows what it showed before (5.11 rule 5), the same object.
    seen.during = undefined;
    seen.pause = true;
    from = t.renderer.calls.length;
    t.session.setDocument(chain(0.75), 3);
    assert.equal((await t.next('eval-end')).status, 'aborted');
    await t.idle();
    assert.ok(duringOf() && duringOf()?.height?.view !== shown.height?.view, 'the new terrain was on screen when the evaluation was aborted');
    assert.equal(t.renderer.content, shown, 'and the shown result is back');
    assert.equal(t.of('view-updated').length, 2, 'nothing was shown for the aborted revision');
    // The lending node completed, so its result stays cached; nothing but the shown result is pinned.
    assert.equal(t.memory().pinnedBytes, held);

    // 3. Resumed: the lending node is a cache hit now, lends nothing, and the result is shown in one call.
    seen.pause = false;
    from = t.renderer.calls.length;
    t.session.setPaused(false);
    await t.next('view-updated');
    await t.idle();
    assert.equal(contents(t.renderer.calls, from).length, 1);
    assert.equal(t.memory().pinnedBytes, held);
  } finally {
    await t.dispose();
  }
});

test('a memory event follows a change of what the renderer has reserved, one for the changes of a task', async () => {
  // A renderer that registers its textures when it draws, as the real one does in the frame after a result is shown.
  const renderer = recordingRenderer();
  let ledger: { reserve(bytes: number, label: string): { release(): void } } | null = null;
  const init = renderer.init.bind(renderer);
  renderer.init = (device, given) => {
    ledger = given;
    init(device, given);
  };
  const t = await startSession({ renderer });
  try {
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    // The buffer the thumbnails of the three nodes are read back through is reserved until they have arrived.
    // Bounded by the events that can arrive: each wait consumes at least one.
    for (let round = 0; round < 8 && t.of('thumbnail').length < 3; round++) await t.next('thumbnail');
    await t.idle();
    const settled = t.memory().reservedBytes;

    // A frame: two textures made and one dropped in one task.
    let from = t.mark();
    const picture = ledger!.reserve(3 * MIB, 'picture');
    const maps = ledger!.reserve(5 * MIB, 'light maps');
    picture.release();
    assert.equal(t.of('memory', from).length, 0, 'not in the middle of the frame');
    await t.idle();
    const after = t.of('memory', from);
    assert.equal(after.length, 1, 'one event for the three changes');
    assert.equal(after[0]!.reservedBytes, settled + 5 * MIB);
    assert.deepEqual(t.events.slice(from).map((e) => e.type), ['memory'], 'and no evaluation was needed for it');

    from = t.mark();
    maps.release();
    await t.idle();
    assert.deepEqual(t.of('memory', from).map((e) => e.reservedBytes), [settled]);
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

test('inspect answers for a cached port whose source was evicted, and a view evaluation does not run that source again', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    await t.idle();
    // The cache holds level, walk (two outputs) and out; out is on screen and pinned. A budget one byte short of
    // what is held makes the next allocation, the scratch of an inspection, evict the least recently used entry: level.
    const held = t.memory();
    assert.deepEqual([held.cacheBytes, held.pinnedBytes], [3 * bytes('field'), bytes('field')]);
    t.engine.setBudget(held.reservedBytes + held.pinnedBytes + held.cacheBytes - 1);
    assert.deepEqual(await t.session.inspect(port('out')), { min: 48.5, max: 48.5, mean: 48.5, nonFinite: 0 });
    assert.equal(t.memory().cacheBytes, 2 * bytes('field'), 'the entry of level went');
    const runs = new Map(slow.runs);
    const requests = t.of('eval-start').length;

    // walk is cached; that level, which it reads, is not does not matter: nothing reads level now.
    assert.deepEqual(await t.session.inspect(port('walk')), { min: 24.25, max: 24.25, mean: 24.25, nonFinite: 0 });
    assert.deepEqual(await t.session.inspect(port('walk', 'steps')), { min: 24, max: 24, mean: 24, nonFinite: 0 });
    // level itself is not cached: answering would run it.
    assert.equal(await t.session.inspect(port('level')), null);
    assert.deepEqual(slow.runs, runs, 'inspect ran no node');
    assert.equal(t.of('eval-start').length, requests, 'and is not in the event stream');

    // An edit downstream of walk: out runs, walk is a hit, and level is left alone.
    t.engine.setBudget(512 * MIB);
    const from = t.mark();
    t.session.setDocument(graph({ gain: 3 }), 2);
    const start = await t.next('eval-start');
    await t.next('view-updated');
    assert.deepEqual(start.plan.map((p) => `${p.nodeId} ${p.state}`), ['level unused', 'walk cached', 'out run']);
    assert.deepEqual(endings(t.events.slice(from), start.requestId), { level: 'cached', walk: 'cached', out: 'run' });
    assert.deepEqual(slow.runs, runs);
    assert.deepEqual(await t.session.inspect(port('out')), { min: 72.75, max: 72.75, mean: 72.75, nonFinite: 0 });
  } finally {
    await t.dispose();
  }
});

test('preferences that ask for less than the engine has reserved leave room for fields: the view, inspect and thumbnails work', async () => {
  resetSlow();
  const t = await startSession();
  try {
    assert.equal(MIN_FIELD_BYTES, 64 * MIB);
    assert.deepEqual([budgetInForce(500, 3 * MIB), budgetInForce(512 * MIB, 3 * MIB)], [67 * MIB, 512 * MIB]);
    // A vramBytes typed in the wrong unit: the formula gives 500 bytes, below what any engine reserves.
    t.session.setPreferences({ vramBytes: 1000, budgetFraction: 0.5 });
    const first = t.memory();
    assert.ok(first.reservedBytes > 500, 'the engine has reserved more than the preferences allow in all');
    assert.equal(first.budgetBytes, first.reservedBytes + MIN_FIELD_BYTES, 'the budget in force is what is reserved and room for fields');

    t.session.requestThumbnails(['level', 'walk', 'out']);
    t.session.setDocument(graph(), 1);
    const shown = await t.next('view-updated');
    assert.deepEqual([shown.height, t.of('node-error').length], [true, 0], 'no node fails for the budget');
    await t.idle();
    // The shown port, and one the view does not name: both need scratch of their own.
    assert.deepEqual(await t.session.inspect(port('out')), { min: 48.5, max: 48.5, mean: 48.5, nonFinite: 0 });
    assert.deepEqual(await t.session.inspect(port('walk')), { min: 24.25, max: 24.25, mean: 24.25, nonFinite: 0 });
    while (t.of('thumbnail').length < 3) await t.next('thumbnail');
    assert.deepEqual(t.of('thumbnail').map((e) => e.nodeId).sort(), ['level', 'out', 'walk']);

    // What is reserved has grown by the atlas and the staging buffer; the budget follows with the next piece of work.
    const grown = t.memory();
    assert.ok(grown.reservedBytes >= first.reservedBytes + 16 * MIB, 'the atlas is reserved');
    t.session.setDocument(graph({ value: 0.5 }), 2);
    await t.next('view-updated');
    await t.idle();
    const after = t.memory();
    assert.ok(after.budgetBytes >= grown.reservedBytes + MIN_FIELD_BYTES && after.budgetBytes > first.budgetBytes, `${after.budgetBytes} bytes, with ${grown.reservedBytes} reserved before that work`);
    assert.equal(t.of('node-error').length, 0);

    // Preferences that leave more than that are applied as the formula gives them.
    t.session.setPreferences({ vramBytes: 1024 * MIB, budgetFraction: 0.5 });
    assert.equal(t.memory().budgetBytes, 512 * MIB);
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
    // From here on: a slice of the evaluation above may really have taken that long on this adapter.
    const from = t.mark();
    t.overrun({ nodeId: 'walk', service: null, kernels: ['test/session.step'], measuredMs: 612.4, ceilingMs: 500 });
    t.overrun({ nodeId: null, service: 'thumbnail', kernels: ['core/thumbnail.shade'], measuredMs: 260, ceilingMs: 250 });
    assert.deepEqual(t.of('engine-error', from).map((e) => ({ ...e })), [
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
  const reached = new Promise<void>((resolve) => {
    slow.at = (i) => {
      if (i !== 12 || disposing) return;
      inspecting = t.session.inspect(port('walk'));
      building = t.session.build({ doc: graph(), outDir: '/out/terrain' }).then((r) => r.status, (e: Error) => e.message);
      disposing = t.session.dispose();
      resolve();
    };
  });
  const count = t.events.length;
  t.session.setDocument(graph({ value: 0.5 }), 2);
  // How many slices the iterations before it take is the adapter's to say: the wait is for the hook itself.
  await within(reached, 'the slow node reached the iteration that disposes the session');
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
