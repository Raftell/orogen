// A node that lends its working state while it runs (runtime.md 5.11, 7.5 rule 2), through the real session and
// the real renderer: the progress of an erosion is drawn from the lent textures, of whatever size the node's
// levels have, and when the loans are withdrawn the picture stays until the node's result is there. The session
// gives the renderer nothing of before for that moment, not the terrain that was shown and not nothing: it tells
// it to keep its picture, and the node's result follows as soon as it is published, also when other nodes of the
// evaluation still have to run. So no frame of the earlier terrain can be drawn in between, on any adapter: the
// tests hold what the session gives, not how many frames a fast GPU happened to draw meanwhile.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ViewportContent } from '../../../src/core/runtime.ts';
import type { Viewport } from '../../../src/viewport/index.ts';
import { testGpu } from '../gpu/rig.ts';
import { difference, makeDoc, startView, writePicture, type Picture } from './rig.ts';

const reported: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]): void => {
  reported.push(args.map(String).join(' '));
  consoleError(...args);
};
after(() => {
  console.error = consoleError;
  assert.deepEqual(reported, [], 'no frame reported an error');
});

// A preview of 253 texels a side, which a CPU rasteriser erodes in seconds too.
const eroded = (duration: number) => makeDoc({
  range: { type: 'generate/mountain-range' },
  eroded: { type: 'simulate/hydraulic-erosion', inputs: { in: 'range.out' }, params: { duration } },
}, { height: { node: 'eroded', port: 'out' } }, { buildResolution: 1009, previewLevel: 2 });

/** What the session told the renderer: a content, or `keep`; and how many frames the renderer had drawn then. */
interface Call { readonly content: ViewportContent | null; readonly kept: boolean; readonly frames: number }
const HOUR_MS = 3_600_000;
/** A small canvas: a frame is drawn for every loan, and a CPU rasteriser draws these in a fraction of the time. */
const SMALL = { width: 640, height: 400, dpr: 1 };
/**
 * The longer of two erosions. On a software adapter every iteration is a slice, a wait and a frame on the CPU:
 * 1.5 took 131 s on WARP. A third of it is another picture as well.
 */
const LONGER = (await testGpu()).caps.software ? 0.5 : 1.5;

/** Records every content the session gives the renderer, and every `keep`, with `extra()` beside each. */
function record<T extends object>(renderer: Viewport, extra: () => T): (Call & T)[] {
  const calls: (Call & T)[] = [];
  const own = renderer as { setContent(content: ViewportContent | null): void; keep(): void };
  const setContent = own.setContent.bind(own);
  const keep = own.keep.bind(own);
  own.setContent = (content) => {
    calls.push({ content, kept: false, frames: renderer.state.frames, ...extra() });
    setContent(content);
  };
  own.keep = () => {
    calls.push({ content: null, kept: true, frames: renderer.state.frames, ...extra() });
    keep();
  };
  return calls;
}

test('the loans of a running erosion are drawn as they come, and when they are withdrawn the picture is kept for the result: nothing of before is given', async (t) => {
  // Every iteration is a batch boundary (5.14), so the node lends at each one, on an adapter of any speed. The
  // picture a step back keeps is kept for a millisecond only: it is not what keeps the picture after loans.
  const rig = await startView({ size: SMALL, hooks: { sliceTargetMs: 1e-6 }, renderer: { holdMs: 1 } });
  try {
    const calls = record(rig.renderer, () => ({}));
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });

    const run = async (duration: number): Promise<{ readonly mine: Call[]; readonly lent: Call[]; readonly kept: Call; readonly own: Call; readonly result: Call; readonly picture: Picture }> => {
      const from = calls.length;
      await rig.show(eroded(duration));
      const mine = calls.slice(from);
      assert.ok(mine.length >= 5, `${mine.length} calls: loans, the picture kept, the node's result, and the result`);
      return { mine, lent: mine.slice(0, -3).filter((call) => !call.kept), kept: mine.at(-3)!, own: mine.at(-2)!, result: mine.at(-1)!, picture: await rig.picture() };
    };

    // ---- nothing was shown before: the loans, the picture kept, the node's result, the result ----
    const first = await run(0.1);
    assert.ok(first.kept.kept, 'when the loans are withdrawn the renderer keeps their picture');
    assert.ok(first.mine.every((call) => call.kept || call.content !== null), 'nothing, which is what was shown before, is never given');
    assert.ok(!first.own.kept && !first.result.kept);
    assert.equal(first.own.content?.height?.view, first.result.content?.height?.view, 'then the node\'s published result is given, before the evaluation has ended');
    const sizes = [...new Set(first.lent.map((call) => call.content?.height?.width))];
    t.diagnostic(`${first.lent.length} loans of the sizes ${sizes.join(', ')}; the picture kept ${first.mine.filter((call) => call.kept).length} times`);
    assert.ok(first.lent.every((call) => call.content?.height?.kind === 'field'));
    assert.ok(first.lent.at(-1)!.frames > first.lent[0]!.frames, 'the lent textures are drawn while the node runs');
    await writePicture('loans-first-result', first.picture);

    // ---- a result is on screen: another erosion lends, and its loans give way to its own result ----
    const second = await run(LONGER);
    assert.ok(second.kept.kept);
    assert.ok(second.mine.every((call) => call.content !== first.result.content), 'the terrain that was shown before is never given while the erosion runs and settles');
    assert.ok(second.lent.at(-1)!.frames > second.lent[0]!.frames);
    assert.equal(second.own.content?.height?.view, second.result.content?.height?.view);
    assert.ok(difference(second.picture, first.picture) > 0.03, `a longer erosion is another picture: ${difference(second.picture, first.picture)}`);

    // The picture is the result's and nothing of a loan: the same document again is the same picture.
    const frames = rig.renderer.state.frames;
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 301, pitch: 30, distance: 6500, fovY: 35 });
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });
    assert.ok(difference(await rig.picture(), second.picture) < 0.05);
    assert.ok(rig.renderer.state.frames > frames);
    // What the renderer holds follows what is shown: the light maps of the loans' sizes are not kept beside the result's.
    assert.ok(rig.renderer.state.reservedBytes < 300 * 2 ** 20, `${Math.round(rig.renderer.state.reservedBytes / 2 ** 20)} MB`);
  } finally {
    await rig.dispose();
  }
});

test('with nodes after the erosion, its result is on screen while they run: the earlier terrain is never given', async (t) => {
  // The picture a step back keeps is kept for one millisecond only: a renderer that were handed the earlier
  // terrain at any moment of the evaluation, for the time the erosion settles or the nodes after it take, would
  // draw it. Whether it does depends on the adapter's speed; that it is never handed it does not.
  const rig = await startView({ size: SMALL, hooks: { sliceTargetMs: 1e-6 }, renderer: { holdMs: 1 } });
  try {
    // The erosion is the terrain; a slope mask of it, blurred, is drawn over it: two nodes that run after it.
    const chain = (duration: number, seed: number) => makeDoc({
      range: { type: 'generate/mountain-range', params: { seed } },
      eroded: { type: 'simulate/hydraulic-erosion', inputs: { in: 'range.out' }, params: { duration } },
      steep: { type: 'select/slope', inputs: { in: 'eroded.out' } },
      soft: { type: 'filter/blur', inputs: { in: 'steep.out' } },
    }, { height: { node: 'eroded', port: 'out' }, overlay: { ref: { node: 'soft', port: 'out' }, as: 'mask', opacity: 0.6 } }, { buildResolution: 1009, previewLevel: 2 });
    // What the renderer is told, and which node of the evaluation was running when it was told.
    let at: string | null = null;
    rig.session.subscribe((e) => {
      if (e.type === 'node-start') at = e.nodeId;
      if (e.type === 'eval-end') at = null;
    });
    const calls = record(rig.renderer, () => ({ at }));
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });
    await rig.show(chain(0.2, 1));
    const shown = calls.at(-1)!.content;
    assert.ok(shown?.height && shown.overlay, 'the earlier terrain, under its overlay');
    const overlayBefore = shown.overlay.texture.view;
    const earlier = await rig.picture();

    const from = calls.length;
    const before = rig.renderer.state.frames;
    await rig.show(chain(0.2, 2));
    const mine = calls.slice(from);
    const result = mine.at(-1)!;
    const own = mine.at(-2)!;
    const kept = mine.at(-3)!;
    assert.ok(mine.length >= 5, `${mine.length} calls`);
    assert.ok(mine.every((call) => call.content !== shown), 'the terrain shown before is never given, so no frame of it is drawn on any adapter');
    assert.deepEqual([kept.kept, kept.at, own.kept, own.at], [true, 'eroded', false, 'eroded'], 'the picture of the loans is kept, and the node\'s result is given while the erosion settles, before the next node starts');
    assert.equal(own.content?.height?.view, result.content?.height?.view, 'the erosion\'s result');
    assert.equal(own.content?.overlay?.texture.view, overlayBefore, 'under the overlay of before, until the new one is made');
    assert.notEqual(result.content?.overlay?.texture.view, overlayBefore);
    // Before that the loans, each over the overlay of before, and the picture kept between the levels of the erosion.
    assert.ok(mine.slice(0, -3).every((call) => call.at === 'eroded' && (call.kept || (call.content?.height?.kind === 'field' && call.content.overlay?.texture.view === overlayBefore))));
    t.diagnostic(`${mine.slice(0, -3).filter((call) => !call.kept).length} loans; ${result.frames - own.frames} frames of the erosion's result while the two nodes after it ran; ${rig.renderer.state.frames - before} frames in all`);
    assert.ok(difference(await rig.picture(), earlier) > 0.03, 'another terrain');
    await rig.capture('loans-nodes-after-result');
  } finally {
    await rig.dispose();
  }
});

/** A view of one mountain range that is shown, with the content the session gave the renderer for it and the renderer's own setContent. */
async function shownRange(holdMs: number) {
  const rig = await startView({ size: SMALL, renderer: { holdMs } });
  const plain = makeDoc({ range: { type: 'generate/mountain-range' } }, { height: { node: 'range', port: 'out' } }, { buildResolution: 1009, previewLevel: 1 });
  rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });
  const calls: (ViewportContent | null)[] = [];
  const renderer = rig.renderer as { setContent(content: ViewportContent | null): void };
  const setContent = renderer.setContent.bind(renderer);
  renderer.setContent = (content) => {
    calls.push(content);
    setContent(content);
  };
  await rig.show(plain);
  return { rig, shown: calls.at(-1)!, setContent, picture: await rig.picture() };
}

test('a content the session steps back to: the picture is kept while nothing else asks for a frame, and a camera that moves is drawn at once', async () => {
  const { rig, shown, setContent, picture } = await shownRange(HOUR_MS);
  try {
    // The same content again, as after an evaluation that was aborted (5.11 rule 5). A pick is answered meanwhile,
    // for the content that is current, and draws nothing.
    const frames = rig.renderer.state.frames;
    setContent(shown);
    assert.ok((await rig.session.viewport.pick(320, 224)) !== null);
    assert.equal(rig.renderer.state.frames, frames, 'the picture is kept: a result usually follows at once');

    // A camera that moves does not wait, and what it shows is the content that was given.
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 320, pitch: 30, distance: 6500, fovY: 35 });
    const turned = await rig.picture();
    assert.ok(rig.renderer.state.frames > frames && difference(turned, picture) > 0.5);

    // Nothing to show after a content is a step back too, and a pick finds nothing at once.
    const before = rig.renderer.state.frames;
    setContent(null);
    assert.equal(await rig.session.viewport.pick(320, 224), null);
    assert.equal(rig.renderer.state.frames, before);
    // The next content ends the wait.
    setContent({ ...shown });
    assert.ok(difference(await rig.picture(), turned) < 0.05);
    assert.ok(rig.renderer.state.frames > before);
  } finally {
    await rig.dispose();
  }
});

test('loans withdrawn: the picture is kept until the next content, whatever the camera and the size do, and that content is drawn with them', async () => {
  // A step back would keep its picture for an hour here; `keep` has no time at all, only the next content.
  const { rig, shown, setContent, picture } = await shownRange(HOUR_MS);
  try {
    const frames = rig.renderer.state.frames;
    rig.renderer.keep();
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 320, pitch: 30, distance: 6500, fovY: 35 });
    rig.resize({ width: 480, height: 300, dpr: 1 });
    assert.equal(await rig.session.viewport.pick(320, 224), null, 'a pick finds nothing: no view of what was withdrawn is used');
    const kept = await rig.picture();
    assert.equal(rig.renderer.state.frames, frames, 'no frame is drawn while the picture is kept, though the camera moved');
    assert.deepEqual(rig.renderer.state.canvas, [640, 400], 'the canvas keeps its size');
    assert.equal(difference(kept, picture), 0, 'and its picture');

    // The node's result, a content never given before: drawn with the camera and the size of now.
    setContent({ ...shown });
    const turned = await rig.picture();
    assert.ok(rig.renderer.state.frames > frames);
    assert.deepEqual([turned.width, turned.height], [480, 300]);

    // Kept again and then given what was shown before, as when the node failed: the camera moved meanwhile, so it
    // is drawn at once rather than held for the hour a step back is.
    const again = rig.renderer.state.frames;
    rig.renderer.keep();
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });
    setContent(shown);
    assert.ok(difference(await rig.picture(), turned) > 0.5);
    assert.ok(rig.renderer.state.frames > again);
  } finally {
    await rig.dispose();
  }
});

test('when nothing follows a step back, what the session gave is drawn after the moment the picture is kept', async () => {
  const { rig, shown, setContent, picture } = await shownRange(30);
  try {
    // As after loans that led to no result, because their node failed or their evaluation was aborted (5.11 rule 5).
    const frames = rig.renderer.state.frames;
    setContent(shown);
    assert.ok(difference(await rig.picture(), picture) < 0.05, 'the content that was shown before, drawn again');
    assert.ok(rig.renderer.state.frames > frames, 'with its light maps made again, which the loans had used');

    setContent(null);
    const empty = await rig.picture();
    let spread = 0;
    for (let i = 0; i < empty.rgba.length; i += 4) spread = Math.max(spread, Math.abs(empty.rgba[i]! - empty.rgba[0]!));
    assert.equal(spread, 0, 'nothing to show is the background');
  } finally {
    await rig.dispose();
  }
});
