// A node that lends its working state while it runs (runtime.md 5.11, 7.5 rule 2), through the real session and
// the real renderer: the progress of an erosion is drawn from the lent textures, of whatever size the node's
// levels have, and when the loans are withdrawn the picture stays until the result is there. The session hands
// the renderer the terrain that was shown before for that moment (it has nothing else that is valid): a frame
// of it would be the old terrain flashing up between the last step of the erosion and its result.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ViewportContent } from '../../../src/core/runtime.ts';
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

interface Call { readonly content: ViewportContent | null; readonly frames: number }
const HOUR_MS = 3_600_000;
/** A small canvas: a frame is drawn for every loan, and a CPU rasteriser draws these in a fraction of the time. */
const SMALL = { width: 640, height: 400, dpr: 1 };

test('the loans of a running erosion are drawn as they come, and no frame shows the terrain of before between the last loan and the result', async (t) => {
  // Every iteration is a batch boundary (5.14), so the node lends at each one, on an adapter of any speed. And the
  // picture is kept for as long as it takes: how soon a result follows its loans is the adapter's speed, which no
  // test holds anything against.
  const rig = await startView({ size: SMALL, hooks: { sliceTargetMs: 1e-6 }, renderer: { holdMs: HOUR_MS } });
  try {
    // What the session tells the renderer, and how many frames the renderer had drawn when it was told.
    const calls: Call[] = [];
    const renderer = rig.renderer as { setContent(content: ViewportContent | null): void };
    const setContent = renderer.setContent.bind(renderer);
    renderer.setContent = (content) => {
      calls.push({ content, frames: rig.renderer.state.frames });
      setContent(content);
    };
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 200], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });

    const run = async (duration: number): Promise<{ readonly lent: Call[]; readonly back: Call; readonly result: Call; readonly picture: Picture }> => {
      const from = calls.length;
      await rig.show(eroded(duration));
      const mine = calls.slice(from);
      assert.ok(mine.length >= 4, `${mine.length} contents: loans, their withdrawal, and the result`);
      return { lent: mine.slice(0, -2), back: mine.at(-2)!, result: mine.at(-1)!, picture: await rig.picture() };
    };

    // ---- nothing was shown before: the loans, nothing, the result ----
    const first = await run(0.1);
    assert.equal(first.back.content, null, 'the loans are withdrawn to what was shown before: nothing');
    const sizes = [...new Set(first.lent.map((call) => call.content?.height?.width))];
    t.diagnostic(`${first.lent.length} loans of the sizes ${sizes.join(', ')}`);
    assert.ok(first.lent.every((call) => call.content?.height?.kind === 'field'));
    assert.ok(first.lent.at(-1)!.frames > first.lent[0]!.frames, 'the lent textures are drawn while the node runs');
    assert.equal(first.result.frames, first.back.frames, 'and no frame is drawn of nothing before the result is there');
    await writePicture('loans-first-result', first.picture);

    // ---- a result is on screen: another erosion lends, and its loans give way to its own result ----
    const second = await run(1.5);
    assert.equal(second.back.content, first.result.content, 'the loans are withdrawn to the terrain that was shown before, the very content');
    assert.ok(second.lent.at(-1)!.frames > second.lent[0]!.frames);
    assert.equal(second.result.frames, second.back.frames, 'no frame of the earlier terrain between the last loan and the result');
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
    // The same content again, as after loans. A pick is answered meanwhile, for the content that is current, and draws nothing.
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

test('when nothing follows a step back, what the session gave is drawn after the moment the picture is kept', async () => {
  const { rig, shown, setContent, picture } = await shownRange(30);
  try {
    // As after loans that led to no result, because their evaluation failed or was aborted (5.11 rule 5).
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
