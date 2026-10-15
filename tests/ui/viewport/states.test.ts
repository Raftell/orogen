// Every state of the viewport, in the real application (runtime.md 7.3, 7.4 rule 5, 7.8, 8.5): nothing bound, a
// draft during a gesture and its refinement, a node that fails upstream while the last picture stays, a lost
// GPU process and its recovery on a new canvas, and an engine worker that is replaced. What the panel says of
// each is asserted; that the picture is there is asserted through a pick, which the worker answers for what it
// has drawn.
//
// The captures are written for a person: test-output/ui/viewport/states-01 … states-06.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDoc, type CameraState, type PickResult } from '../../../src/core/runtime.ts';
import { launchApp } from '../../helpers/index.ts';
import { gpuProcesses } from '../platform/rig.ts';
import { STATUS_HINT, STATUS_TEXT } from '../../../src/app/panels/viewport/model.ts';
import { attr, camera, canvasSize, capture, EVALUATION_BACKSTOP_MS, makeDoc, PAGE_BACKSTOP_MS, pick, prepare, quote, run, settled, setView, show } from './rig.ts';

const HEIGHT = { node: 'range', port: 'out' };
const NODES = {
  range: { type: 'generate/mountain-range' },
  missing: { type: 'io/import-field', params: { file: '/no/such/folder/heights.png' } },
};

test('the states of the viewport: nothing bound, a draft and its refinement, a failing node, a lost device and a restarted engine', async (t) => {
  const app = await launchApp({ profile: 'core' });
  const statusText = (): Promise<string> => app.eval<string>(`viewportTest.statusText()`);
  const cover = (): Promise<string | null> => app.eval<string | null>(`document.querySelector('[data-viewport="cover"]')?.textContent ?? null`);
  const covered = (): Promise<{ state: string; title: string; hint: string } | null> => app.eval(`viewportTest.cover()`);
  /** The title a menu gives a command: the menu is opened, read and closed. */
  const menuLabel = async (menu: string, command: string): Promise<string> => {
    await app.eval(`void shellTest.press('.og-menubar-item[data-menu="${menu}"]')`);
    await app.waitFor(`document.querySelector('[data-ui="menu"][data-menu="${menu}"] [data-item="${command}"]') !== null`, PAGE_BACKSTOP_MS);
    const label = await app.eval<string>(`document.querySelector('[data-ui="menu"][data-menu="${menu}"] [data-item="${command}"] .og-menu-item-label').textContent`);
    await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="menu"]'))`);
    await app.waitFor(`document.querySelector('[data-ui="menu"]') === null`, PAGE_BACKSTOP_MS);
    return label;
  };
  try {
    await prepare(app);
    const size = await canvasSize(app);
    const mid: readonly [number, number] = [size.width / 2, size.height * 0.55];

    // ---- a project without a node: there is none to show, and the cover says where nodes come from ----
    await app.eval(`void orogenTest.ctx.doc.getState().load(${quote(newDoc())}, null)`);
    await app.waitFor(`viewportTest.attr('data-status') === 'bare'`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await covered(), { state: 'bare', title: STATUS_TEXT.bare, hint: STATUS_HINT.bare });
    assert.match(STATUS_HINT.bare, /Library/);

    // ---- previews are paused before anything was computed: no picture, and the cover says why and what resumes them ----
    await run(app, 'engine.togglePause');
    await app.eval(`void orogenTest.ctx.doc.getState().load(${quote(makeDoc(NODES, { height: HEIGHT }, { buildResolution: 2017, previewLevel: 1 }))}, null)`);
    await app.waitFor(`viewportTest.attr('data-status') === 'paused'`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await covered(), { state: 'paused', title: 'Previews are paused', hint: STATUS_HINT.paused });
    assert.equal(await statusText(), 'Paused', 'the toolbar says it too, and gives no size of a picture that is not there');
    // What a cover names of the menus is there under that name: the hints are held to the menus as they are.
    for (const [hint, menu, command] of [[STATUS_HINT.paused, 'Engine', 'engine.togglePause'], [STATUS_HINT.failed, 'Engine', 'engine.retryDevice'], [STATUS_HINT.error, 'View', 'view.showErrors']] as const) {
      assert.ok(hint.startsWith(`${menu} › ${await menuLabel(menu, command)} `), `"${hint}" names ${command} as the ${menu} menu does`);
    }
    t.diagnostic(`capture: ${await capture(app, 'states-00-paused-before-the-first-picture')}`);
    await run(app, 'engine.togglePause');
    await settled(app);
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await covered(), null);

    // ---- nothing bound ----
    await app.eval(`void orogenTest.ctx.doc.getState().load(${quote(makeDoc(NODES, undefined, { buildResolution: 2017, previewLevel: 1 }))}, null)`);
    await app.waitFor(`viewportTest.attr('data-status') === 'empty' && orogenTest.ctx.engineState.getState().evaluation === null`, EVALUATION_BACKSTOP_MS);
    assert.deepEqual(await covered(), { state: 'empty', title: 'Nothing is shown', hint: 'Select a node in the graph to see its terrain' });
    // The panel says so from the document, at once; the engine shows nothing when it has taken the document in
    // (7.4 rule 5), and until then the last terrain is still what a pick finds.
    await settled(app);
    assert.equal(await pick(app, mid[0], mid[1]), null);
    assert.equal(await statusText(), '', 'and nothing is claimed in the toolbar');
    t.diagnostic(`capture: ${await capture(app, 'states-01-nothing-bound')}`);

    // ---- bound ----
    await setView(app, { height: HEIGHT });
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await cover(), null);
    assert.equal(await statusText(), '1009 × 1009');
    // The range itself is drawn, not only the plain it stands on: the highest of a few pixels shows it.
    let shown = await pick(app, mid[0], mid[1]);
    for (let i = 0; i < 25; i++) {
      const hit = await pick(app, size.width * (0.3 + 0.1 * (i % 5)), size.height * (0.3 + 0.1 * Math.floor(i / 5)));
      if (hit && (!shown || hit.height > shown.height)) shown = hit;
    }
    assert.ok(shown !== null && shown.height > 0.15, `the terrain is drawn: ${JSON.stringify(shown)}`);

    // ---- a draft during a gesture, then the refinement ----
    // Compared at one place of the terrain, from above, where a pixel shows the ground at its uv whatever the heights
    // are. In the 3D view a pixel near a ridge shows the ground behind the ridge of a coarse draft and the ridge
    // itself once refined: measured under one pixel of a canvas of 1217 × 401, 0.15 in the draft and 0.34 refined.
    await run(app, 'viewport.toggleTop');
    await app.waitFor(`viewportTest.attr('data-mode') === 'top'`, PAGE_BACKSTOP_MS);
    const above = await camera(app) as Extract<CameraState, { kind: 'top' }>;
    /** The pixel that shows a place, by the arithmetic of the top camera (src/viewport/camera.ts). */
    const pixelOf = (u: number, v: number): readonly [number, number] => [
      ((u - above.center[0]) / above.span + 0.5) * size.width,
      ((v - above.center[1]) / ((above.span * size.height) / size.width) + 0.5) * size.height,
    ];
    const samePlace = (a: PickResult, b: PickResult): boolean => Math.abs(a.uv[0] - b.uv[0]) < 1e-5 && Math.abs(a.uv[1] - b.uv[1]) < 1e-5;
    // A place on the range, not on the plain it stands on: the highest of a few.
    let place = pixelOf(0.5, 0.5);
    let high = await pick(app, place[0], place[1]);
    for (let i = 0; i < 25; i++) {
      const at = pixelOf(0.3 + 0.1 * (i % 5), 0.3 + 0.1 * Math.floor(i / 5));
      const hit = await pick(app, at[0], at[1]);
      if (hit && (!high || hit.height > high.height)) [high, place] = [hit, at];
    }
    assert.ok(high !== null && high.height > 0.15, `the terrain is drawn from above: ${JSON.stringify(high)}`);
    await app.eval(`void (orogenTest.ctx.doc.getState().beginGesture('param:range:height'),
      orogenTest.ctx.doc.getState().transact('Mountain Range: Height', (draft) => { draft.nodes.range.params.height = 0.4; }, { mergeKey: 'param:range:height' }))`);
    await app.waitFor(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      return engine.evaluation === null && engine.view !== null && engine.view.draft && engine.view.revision >= orogenTest.ctx.doc.getState().engineRevision;
    })()`, EVALUATION_BACKSTOP_MS);
    await app.waitFor(`viewportTest.attr('data-status') === 'draft'`, PAGE_BACKSTOP_MS);
    const drafted = await statusText();
    assert.match(drafted, /^Draft(253|505) × \1$/, `the toolbar says what is shown: ${drafted}`);
    const coarse = await pick(app, place[0], place[1]);
    assert.ok(coarse !== null && samePlace(coarse, high) && coarse.height < high.height - 1e-4, `the draft is drawn: the terrain is lower at the same place: ${JSON.stringify(coarse)} after ${JSON.stringify(high)}`);
    t.diagnostic(`capture: ${await capture(app, 'states-02-draft')}`);
    await app.eval(`void orogenTest.ctx.doc.getState().endGesture()`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().view?.draft === false`, EVALUATION_BACKSTOP_MS);
    await settled(app);
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await statusText(), '1009 × 1009');
    const refined = await pick(app, place[0], place[1]);
    assert.ok(refined !== null && samePlace(refined, coarse) && Math.abs(refined.height - coarse.height) < 0.05, `the refinement is the same terrain, finer: ${JSON.stringify(refined)} after ${JSON.stringify(coarse)}`);

    // ---- the shown node fails: the panel says so, and the last picture stays ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height: { node: 'missing', port: 'out' } }; }, { undoable: false })`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes.missing?.state === 'error'`, EVALUATION_BACKSTOP_MS);
    await app.waitFor(`viewportTest.attr('data-status') === 'error'`, PAGE_BACKSTOP_MS);
    assert.match(await statusText(), /^Node failed/);
    const kept = await pick(app, place[0], place[1]);
    assert.ok(kept !== null && samePlace(kept, refined) && Math.abs(kept.height - refined.height) < 1e-6, 'what was on screen is still there (7.3 rule 6)');
    t.diagnostic(`capture: ${await capture(app, 'states-03-node-failed')}`);
    await setView(app, { height: HEIGHT });
    assert.equal(await attr(app, 'data-status'), 'shown');
    await run(app, 'viewport.toggleTop');
    await app.waitFor(`viewportTest.attr('data-mode') === 'orbit'`, PAGE_BACKSTOP_MS);

    // ---- the GPU process is gone: a new device, a new canvas, the same terrain (7.8) ----
    if (process.platform === 'linux') {
      // Near the middle of the canvas, where the framing puts the terrain's middle.
      const before = await pick(app, mid[0], mid[1]);
      assert.ok(before !== null, 'the terrain is under the middle of the 3D view');
      const pids = gpuProcesses();
      assert.equal(pids.length, 1, `one application, one GPU process: ${pids.join(', ')}`);
      await app.eval(`void (window.viewportCanvas = document.querySelector('[data-viewport="canvas"] canvas'), window.viewportEvents = [],
        orogenTest.ctx.engine.subscribe((e) => { if (e.type === 'device-lost' || e.type === 'device-ready') window.viewportEvents.push(e.type); }),
        new MutationObserver(() => window.viewportEvents.push('status:' + viewportTest.attr('data-status'))).observe(document.querySelector('[data-viewport="root"]'), { attributes: true, attributeFilter: ['data-status'] }))`);
      process.kill(pids[0]!, 'SIGKILL');
      await app.waitFor(`window.viewportEvents.includes('device-ready')`, EVALUATION_BACKSTOP_MS);
      await settled(app);
      await app.waitFor(`viewportTest.attr('data-status') === 'shown'`, PAGE_BACKSTOP_MS);
      const events = await app.eval<string[]>(`window.viewportEvents`);
      assert.ok(events.includes('status:lost'), `the panel said that the device was lost: ${events.join(', ')}`);
      assert.equal(await app.eval<boolean>(`(() => {
        const canvas = document.querySelector('[data-viewport="canvas"] canvas');
        return canvas !== null && canvas !== window.viewportCanvas && !window.viewportCanvas.isConnected;
      })()`), true, 'a canvas element of its own for the new device (7.8 rule 6)');
      const back = await pick(app, mid[0], mid[1]);
      assert.ok(back !== null && Math.abs(back.height - before.height) < 1e-4 && Math.abs(back.uv[0] - before.uv[0]) < 1e-4, 'the same terrain under the same pixel, on the new device');
      t.diagnostic(`capture: ${await capture(app, 'states-04-after-device-loss')}`);
    }

    // ---- the engine worker is replaced: the new one is told the camera and the display again (8.5) ----
    await run(app, 'viewport.toggleTop');
    await run(app, 'viewport.topHeight');
    const top = await camera(app) as Extract<CameraState, { kind: 'top' }>;
    await app.eval(`void (window.viewportCanvas = document.querySelector('[data-viewport="canvas"] canvas'), orogenTest.ctx.run('engine.restart'))`);
    await app.waitFor(`document.querySelector('[data-viewport="canvas"] canvas') !== window.viewportCanvas`, PAGE_BACKSTOP_MS);
    t.diagnostic(`the panel while the engine starts: "${await cover()}"`);
    await app.waitFor(`orogenTest.ctx.engineState.getState().device.state === 'ready'`, EVALUATION_BACKSTOP_MS);
    await settled(app);
    await app.waitFor(`viewportTest.attr('data-status') === 'shown'`, PAGE_BACKSTOP_MS);
    assert.equal(await attr(app, 'data-mode'), 'top');
    // A pick in the top view: the uv under a pixel is the camera's arithmetic, so the new worker has the camera.
    const [x, y] = [Math.round(size.width * 0.45), Math.round(size.height * 0.4)];
    const hit = await pick(app, x, y);
    const u = top.center[0] + (x / size.width - 0.5) * top.span, v = top.center[1] + (y / size.height - 0.5) * top.span * (size.height / size.width);
    assert.ok(hit !== null && Math.abs(hit.uv[0] - u) < 1e-5 && Math.abs(hit.uv[1] - v) < 1e-5, `the new engine draws the top view: ${JSON.stringify(hit)} for ${u} ${v}`);
    t.diagnostic(`capture: ${await capture(app, 'states-05-after-engine-restart')}`);
    await run(app, 'viewport.toggleTop');
    await run(app, 'viewport.topHillshade');
    t.diagnostic(`capture: ${await capture(app, 'states-06-back-in-3d')}`);

    // Restarting the engine is said by the shell as a notice; nothing here is an error of the application.
    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
