// What the viewport keeps between runs, in the real application (runtime.md 7.5 "What is kept"): a project opens
// with the cameras, the sun, the scale and the sea it was left with and is not changed by being opened; what a
// hand changes is in the file after a save and in the picture of the next run; a project that holds nothing
// opens by the defaults; and the user's choices are in the preferences.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseDoc, serializeDoc, type CameraState, type GraphDoc, type PickResult } from '../../../src/core/runtime.ts';
import { DEFAULT_DISPLAY } from '../../../src/app/panels/viewport/model.ts';
import { readProjectView, type ProjectView } from '../../../src/app/panels/viewport/persist.ts';
import { launchApp } from '../../helpers/index.ts';
import { attr, camera, canvasSize, capture, makeDoc, PAGE_BACKSTOP_MS, pick, prepare, quote, REGISTRY, ROOT, run, settled } from './rig.ts';

type Orbit = Extract<CameraState, { kind: 'orbit' }>;
const FOLDER = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'viewport-kept');
const HEIGHT = { node: 'range', port: 'out' };
const KEPT: ProjectView = {
  version: 1, mode: 'orbit',
  orbit: { kind: 'orbit', target: [1500, 2300, 280], yaw: 20, pitch: 22, distance: 3600, fovY: 35 },
  top: { kind: 'top', center: [0.42, 0.61], span: 0.5 },
  sun: [120, 18], verticalScale: 1.5, showSea: false,
};
const kept = (doc: GraphDoc): unknown => (doc.ui as { viewport?: unknown }).viewport;

test('a project opens as it was left, a hand\'s changes are saved with it and come back in the next run; the user\'s choices go to the preferences', async (t) => {
  fs.mkdirSync(FOLDER, { recursive: true });
  const file = path.join(FOLDER, 'kept.orogen');
  const doc = makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT });
  const text = serializeDoc({ ...doc, ui: { ...doc.ui, viewport: KEPT } as GraphDoc['ui'] });
  fs.writeFileSync(file, text);

  // ---- the first run: the project's own view ----
  let left: { camera: Orbit; under: PickResult; sun: string; mid: readonly [number, number] };
  const first = await launchApp({ profile: 'core', open: file });
  try {
    await prepare(first);
    await settled(first);
    assert.deepEqual(await camera(first), KEPT.orbit);
    assert.deepEqual([await attr(first, 'data-mode'), await attr(first, 'data-sun'), await attr(first, 'data-scale'), await attr(first, 'data-sea')], ['orbit', '120 18', '1.5', null]);
    // Opened and looked at: what the document keeps of the viewport is the file's, the very value it was loaded
    // with, and nothing is unsaved. (The graph panel writes its own viewport beside it when a file brings none.)
    await first.eval(`void (window.keptAtLoad = orogenTest.ctx.doc.getState().doc.ui.viewport)`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await first.eval<boolean>(`orogenTest.ctx.doc.getState().doc.ui.viewport === window.keptAtLoad`), true, 'the viewport wrote nothing into a project that was only opened');
    assert.deepEqual(await first.eval<unknown>(`orogenTest.ctx.doc.getState().doc.ui.viewport`), KEPT);
    assert.equal(await first.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), false);
    // The other camera is the project's too.
    await run(first, 'viewport.toggleTop');
    assert.deepEqual(await camera(first), KEPT.top);
    await run(first, 'viewport.toggleTop');
    t.diagnostic(`capture: ${await capture(first, 'kept-01-as-the-project-was-left')}`);

    // A hand moves the camera and the sun: when they have rested they are in the document, and after a save in the file.
    const size = await canvasSize(first);
    const mid = [Math.round(size.width / 2), Math.round(size.height / 2)] as const;
    await first.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 70, mid[1] + 25])}, 0, {})`);
    await first.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 50, mid[1] - 40])}, 0, { shiftKey: true })`);
    const moved = await camera(first) as Orbit;
    assert.ok(moved.yaw !== KEPT.orbit!.yaw);
    await first.waitFor(`JSON.stringify(orogenTest.ctx.doc.getState().doc.ui.viewport?.orbit) === ${quote(JSON.stringify(moved))}`, PAGE_BACKSTOP_MS);
    assert.equal(await first.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), false, 'a camera that moved leaves the project as saved as it was');
    assert.equal(await first.eval<number>(`orogenTest.ctx.doc.getState().past.length`), 0, 'and is no step to undo');
    await first.eval(`orogenTest.ctx.run('file.save')`);
    await first.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    const sun = (await attr(first, 'data-sun'))!;
    // The file holds it once the save has written: read from here, as the next run reads it.
    const deadline = Date.now() + PAGE_BACKSTOP_MS;
    let saved: ProjectView | null = null;
    while (Date.now() < deadline) {
      saved = readProjectView(kept(parseDoc(fs.readFileSync(file, 'utf8'), REGISTRY).doc));
      if (saved && JSON.stringify(saved.orbit) === JSON.stringify(moved)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(saved!.orbit, moved, 'the file holds the camera as it was left');
    assert.deepEqual([saved!.sun.join(' '), saved!.verticalScale, saved!.showSea, saved!.top], [sun, 1.5, false, KEPT.top]);
    left = { camera: moved, under: await pick(first, mid[0], mid[1]) as PickResult, sun, mid };
    assert.ok(left.under !== null, 'the terrain is under the middle of the picture');

    // ---- the user's choices: in the preferences, not in the project ----
    await run(first, 'viewport.shadingClay');
    await run(first, 'viewport.paletteViridis');
    await first.waitFor(`orogenPlatform.getPreferences().then((preferences) => preferences.viewport?.shading === 'clay' && preferences.viewport?.palette === 'viridis')`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await first.eval<unknown>(`orogenPlatform.getPreferences().then((preferences) => preferences.viewport)`), { version: 1, shading: 'clay', topStyle: 'hillshade', palette: 'viridis' });
    assert.equal(await first.eval<string>(`JSON.stringify(orogenTest.ctx.doc.getState().doc.ui.viewport)`).then((json) => /clay|viridis/.test(json)), false);

    // ---- another project in the same run: one that holds nothing opens by the defaults, framed, with the user's shading ----
    await first.eval(`void orogenTest.ctx.doc.getState().load(${quote(makeDoc({ range: { type: 'generate/island' } }, { height: HEIGHT }, { seaLevel: 0.2 }))}, null)`);
    await settled(first);
    assert.deepEqual([await attr(first, 'data-mode'), await attr(first, 'data-sun'), await attr(first, 'data-scale'), await attr(first, 'data-sea'), await attr(first, 'data-shading')],
      ['orbit', `${DEFAULT_DISPLAY.sunAzimuth} ${DEFAULT_DISPLAY.sunElevation}`, '1', '', 'clay']);
    const framed = await camera(first) as Orbit;
    assert.ok(framed.yaw === 300 && Math.hypot(framed.target[0] - 2016, framed.target[1] - 2016) < 900 && framed.distance > 4000, `a new project is framed from the first direction: ${JSON.stringify(framed)}`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(await first.eval<boolean>(`orogenTest.ctx.doc.getState().doc.ui.viewport === undefined`), true, 'and nothing is written into it for being shown');
    assert.deepEqual(await first.errors(), []);
  } catch (thrown) {
    await first.close().catch(() => {});
    throw thrown;
  }
  await first.close();

  // ---- the next run: the picture the first one left ----
  const second = await launchApp({ profile: 'core', open: file });
  try {
    await prepare(second);
    await settled(second);
    assert.deepEqual(await camera(second), left.camera);
    assert.deepEqual([await attr(second, 'data-sun'), await attr(second, 'data-scale'), await attr(second, 'data-sea')], [left.sun, '1.5', null]);
    const under = await pick(second, left.mid[0], left.mid[1]) as PickResult;
    assert.ok(under !== null && Math.abs(under.uv[0] - left.under.uv[0]) < 1e-6 && Math.abs(under.uv[1] - left.under.uv[1]) < 1e-6, `the same point is under the same pixel: ${JSON.stringify(under)} for ${JSON.stringify(left.under)}`);
    t.diagnostic(`capture: ${await capture(second, 'kept-02-in-the-next-run')}`);
    // Frame Terrain gives the camera back to the framing, and the project then holds none.
    await run(second, 'viewport.frame');
    await second.waitFor(`orogenTest.ctx.doc.getState().doc.ui.viewport?.orbit === undefined`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await second.errors(), []);
  } catch (thrown) {
    await second.close().catch(() => {});
    throw thrown;
  }
  await second.close();
});
