// The viewport under hard use, in the real application: the readout follows the picture and not only the
// pointer; a flight ends when the window can no longer hear its keys; a double click centres; input that comes
// faster than frames, undo and redo in the middle of a drag, a project of three hundred nodes, settings at the
// ends of their ranges and a GPU process that dies in mid-flight leave a camera, a picture and no error.
//
// The captures are written for a person: test-output/ui/viewport/interaction-01 … interaction-08.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CameraState, PickResult } from '../../../src/core/runtime.ts';
import { project, viewOf } from '../../../src/viewport/camera.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { gpuProcesses } from '../platform/rig.ts';
import { attr, camera, canvasSize, capture, EVALUATION_BACKSTOP_MS, frame, makeDoc, PAGE_BACKSTOP_MS, pick, prepare, quote, run, settled, show, type NodeSpec } from './rig.ts';

type Orbit = Extract<CameraState, { kind: 'orbit' }>;
type Top = Extract<CameraState, { kind: 'top' }>;
interface Readout { readonly u: number; readonly v: number; readonly height: number; readonly text: string }

const HEIGHT = { node: 'range', port: 'out' };
const readout = (app: AppDriver): Promise<Readout | null> => app.eval(`viewportTest.readout()`);
const finite = (c: CameraState): boolean => (c.kind === 'orbit' ? [...c.target, c.yaw, c.pitch, c.distance] : [...c.center, c.span]).every(Number.isFinite);
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(...a.map((v, i) => v - b[i]!));

test('the readout is of the picture: it follows the wheel, a terrain that changes under a resting pointer, and a command that moves the camera', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    // A ramp along +X: its height at a uv is u, so what the readout says can be held against where it says it.
    await show(app, makeDoc({ range: { type: 'generate/gradient', params: { angle: 0 } } }, { height: HEIGHT }, { terrainSize: 2000, heightRange: 500 }));
    const size = await canvasSize(app);
    const at = [Math.round(size.width * 0.55), Math.round(size.height * 0.5)] as const;
    const rest = async (): Promise<Readout> => {
      await app.eval(`void viewportTest.hover(${at[0]}, ${at[1]})`);
      await app.waitFor(`viewportTest.readout() !== null`, PAGE_BACKSTOP_MS);
      return (await readout(app))!;
    };
    /** Waits until the readout says what a pick says now: it was asked again after what changed the picture. */
    const current = async (): Promise<Readout> => {
      const hit = await pick(app, at[0], at[1]) as PickResult;
      await app.waitFor(`(() => { const r = viewportTest.readout(); return r !== null && Math.abs(r.u - ${hit.uv[0]}) < 1e-6 && Math.abs(r.height - ${hit.height}) < 1e-6; })()`, PAGE_BACKSTOP_MS);
      return (await readout(app))!;
    };
    await frame(app);
    const first = await rest();
    assert.ok(Math.abs(first.height - first.u) < 1e-4, `the ramp is as high as it is far along X: ${JSON.stringify(first)}`);

    // The wheel dollies towards the point under the pointer: the same point is read, again and again.
    for (let i = 0; i < 3; i++) await app.eval(`void viewportTest.wheel(${at[0]}, ${at[1]}, -240)`);
    const nearer = await current();
    assert.ok(Math.abs(nearer.u - first.u) < 2e-3 && Math.abs(nearer.v - first.v) < 2e-3, `three turns of the wheel keep the point: ${JSON.stringify(nearer)} after ${JSON.stringify(first)}`);

    // A command changes the picture while the pointer rests: another point is under it, and the readout says that one.
    await run(app, 'viewport.toggleTop');
    const top = await camera(app) as Top;
    const above = await current();
    assert.ok(Math.abs(above.u - (top.center[0] + (at[0] / size.width - 0.5) * top.span)) < 1e-5, `the top view's own point: ${JSON.stringify(above)}`);
    assert.ok(distance([above.u, above.v], [nearer.u, nearer.v]) > 1e-3, 'which is another than the 3D view had there');
    await run(app, 'viewport.toggleTop');
    const framed = await current();
    assert.ok(distance([framed.u, framed.v], [nearer.u, nearer.v]) < 1e-5, 'and back');

    // The terrain changes under the pointer: the ramp is turned, and the height read at the same pixel is the new one.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Gradient: Direction', (draft) => { draft.nodes.range.params.angle = 180; })`);
    await settled(app);
    const turned = await current();
    assert.ok(Math.abs(turned.height - (1 - turned.u)) < 1e-4, `the ramp now falls along X: ${JSON.stringify(turned)}`);
    assert.ok(Math.abs(turned.height - framed.height) > 1e-3, 'another height than was read there before');

    // The vertical scale moves the picture under the pointer too. Half as high: a terrain that grows can put the side of its slab under the pointer.
    await frame(app);
    const whole = await current();
    await app.eval(`void (shellTest.focus('[data-viewport="toolbar"] [aria-label="Vertical scale"]'), shellTest.key('Enter', {}, '[data-viewport="toolbar"] [aria-label="Vertical scale"]'))`);
    await app.waitFor(`document.querySelector('[data-viewport="toolbar"] .og-number-input') !== null`, PAGE_BACKSTOP_MS);
    await app.eval(`void (shellTest.type('[data-viewport="toolbar"] .og-number-input', '0.5'), shellTest.key('Enter', {}, '[data-viewport="toolbar"] .og-number-input'))`);
    await app.waitFor(`viewportTest.attr('data-scale') === '0.5'`, PAGE_BACKSTOP_MS);
    const scaled = await current();
    assert.ok(Math.abs(scaled.height - (1 - scaled.u)) < 1e-4 && distance([scaled.u, scaled.v], [whole.u, whole.v]) > 1e-4, 'the readout is of the scaled picture, and its height the terrain\'s own');
    assert.match(scaled.text, /^X[\d ]+ mY[\d ]+ mHeight[\d .]+ m0\.\d{4}$/);
    t.diagnostic(`capture: ${await capture(app, 'interaction-01-readout')}`);
    await run(app, 'viewport.resetVerticalScale');

    // A project of another size while the pointer rests: nothing of the old terrain is left in the readout.
    await show(app, makeDoc({ range: { type: 'generate/gradient', params: { angle: 0 } } }, { height: HEIGHT }, { terrainSize: 80, heightRange: 20 }));
    await frame(app);
    const small = await current();
    assert.ok(small.text.startsWith('X') && !/\d{3,} m/.test(small.text), `metres of a terrain 80 m wide: ${small.text}`);

    // A double click brings the point under it to the middle, in both views.
    const before = await camera(app) as Orbit;
    const corner = [Math.round(size.width * 0.42), Math.round(size.height * 0.62)] as const;
    const picked = await pick(app, corner[0], corner[1]) as PickResult;
    await app.eval(`void viewportTest.doubleClick(${corner[0]}, ${corner[1]})`);
    await app.waitFor(`Math.abs(viewportTest.camera().target[0] - ${picked.position[0]}) < 1e-6`, PAGE_BACKSTOP_MS);
    const centered = await camera(app) as Orbit;
    assert.ok(distance(centered.target, picked.position) < 1e-6 && centered.distance === before.distance && centered.yaw === before.yaw);
    const middle = project(viewOf(centered, size), size, picked.position, 80)!;
    assert.ok(Math.abs(middle.x - size.width / 2) < 0.5 && Math.abs(middle.y - size.height / 2) < 0.5, `the point is in the middle of the picture: ${middle.x} ${middle.y}`);
    await run(app, 'viewport.toggleTop');
    const spot = await pick(app, corner[0], corner[1]) as PickResult;
    await app.eval(`void viewportTest.doubleClick(${corner[0]}, ${corner[1]})`);
    await app.waitFor(`Math.abs(viewportTest.camera().center[0] - ${spot.uv[0]}) < 1e-9`, PAGE_BACKSTOP_MS);
    assert.ok(distance((await camera(app) as Top).center, spot.uv) < 1e-9);
    await run(app, 'viewport.toggleTop');

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('a flight ends when the window loses the focus or the GPU its process; rapid input, undo and redo in mid-drag and the keys of other commands leave a camera and a picture', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }));
    const size = await canvasSize(app);
    const mid = [size.width / 2, size.height / 2] as const;
    const fly = (): Promise<void> => app.eval<void>(`void (viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 10, mid[1]])}, 2, {}, 2, false), viewportTest.key('keydown', 'KeyW'))`);
    const flown = async (from: Orbit): Promise<void> => app.waitFor(`Math.hypot(...viewportTest.camera().target.map((v, i) => v - ${quote(from.target)}[i])) > 20`, PAGE_BACKSTOP_MS);

    // ---- the window loses the focus while W is held: no key and no button is heard to be released after that ----
    const start = await camera(app) as Orbit;
    await fly();
    await flown(start);
    assert.equal(await attr(app, 'data-drag'), 'fly');
    await app.eval(`void window.dispatchEvent(new Event('blur'))`);
    assert.equal(await attr(app, 'data-drag'), null, 'the flight is over');
    // What the camera does after that is read twice, with frames of the flight's timer in between.
    const stopped = await camera(app) as Orbit;
    await pick(app, mid[0], mid[1]);
    await app.eval(`new Promise((resolve) => setTimeout(resolve, 120))`);
    assert.deepEqual((await camera(app) as Orbit).target, stopped.target, 'and the camera stands still');
    // The key that is still down flies no further when the button is pressed again: the held keys were forgotten.
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 10, mid[1]])}, 2, {}, 2, false)`);
    await app.eval(`new Promise((resolve) => setTimeout(resolve, 120))`);
    const eye = (c: Orbit): number[] => {
      const yaw = c.yaw * Math.PI / 180, pitch = c.pitch * Math.PI / 180;
      return [c.target[0] - c.distance * Math.cos(pitch) * Math.cos(yaw), c.target[1] - c.distance * Math.cos(pitch) * Math.sin(yaw), c.target[2] + c.distance * Math.sin(pitch)];
    };
    assert.ok(distance(eye(await camera(app) as Orbit), eye(stopped)) < 1e-6, 'the eye is where the flight ended');
    await app.eval(`void (viewportTest.key('keyup', 'KeyW'), viewportTest.release(${quote(mid)}, 2))`);
    await frame(app);

    // ---- input faster than frames: twenty drags of forty moves and two hundred turns of the wheel in one task ----
    await app.eval(`(() => {
      for (let k = 0; k < 20; k++) {
        viewportTest.drag([${mid[0]}, ${mid[1]}], [${mid[0]} + 300 * Math.sin(k), ${mid[1]} + 100 * Math.cos(k)], k % 3, { altKey: k % 2 === 0 }, 40);
        for (let w = 0; w < 10; w++) viewportTest.wheel(${mid[0]} + w * 7, ${mid[1]}, (w % 2 ? 1 : -1) * 240);
      }
      return true;
    })()`);
    const shaken = await camera(app);
    assert.ok(finite(shaken), JSON.stringify(shaken));
    assert.equal(await attr(app, 'data-drag'), null);
    // Home is the way back from wherever that left the camera: the first direction, on the whole terrain.
    await app.eval(`void (document.querySelector('[data-viewport="canvas"]').focus(), shellTest.key('Home'))`);
    await frame(app, 'viewport.resetView');
    const home = await camera(app) as Orbit;
    assert.deepEqual([home.yaw, home.pitch], [300, 30]);
    assert.ok((await pick(app, mid[0], mid[1])) !== null, 'the frame of the last camera is drawn, and the terrain is under its middle');

    // ---- a camera that moves renders nothing of the panel: its picture is the worker's, and the toolbar says nothing of it ----
    // Every render of the panel or of its toolbar reads the document's store; a move of the camera must not.
    const reads = await app.eval<number>(`(async () => {
      const doc = orogenTest.ctx.doc;
      const getState = doc.getState;
      let count = 0;
      doc.getState = () => { count++; return getState(); };
      try {
        viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 5, mid[1]])}, 0, {}, 1, false);
        await new Promise((resolve) => setTimeout(resolve, 30));
        count = 0;
        for (let i = 1; i <= 40; i++) {
          viewportTest.hover(${mid[0]} + 5 + i * 3, ${mid[1]} + i);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return count;
      } finally {
        doc.getState = getState;
        viewportTest.release(${quote([mid[0] + 125, mid[1] + 40])}, 0);
      }
    })()`);
    assert.ok(reads < 20, `forty moves of an orbit read the document ${reads} times: the panel is rendered for them`);
    assert.ok((await camera(app) as Orbit).yaw !== home.yaw, 'and the camera turned');
    await frame(app, 'viewport.resetView');

    // ---- undo and redo while a drag is held: the document changes, the drag goes on, and ends as a drag ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Mountain Range: Height', (draft) => { draft.nodes.range.params.height = 0.5; })`);
    await settled(app);
    const held = await camera(app) as Orbit;
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 40, mid[1]])}, 0, {}, 4, false)`);
    await run(app, 'edit.undo');
    assert.equal(await attr(app, 'data-drag'), 'orbit', 'an undo does not end the drag');
    await app.eval(`void viewportTest.hover(${mid[0] + 90}, ${mid[1] + 10})`);
    await run(app, 'edit.redo');
    await app.eval(`void viewportTest.release(${quote([mid[0] + 90, mid[1] + 10])}, 0)`);
    await settled(app);
    const dragged = await camera(app) as Orbit;
    assert.ok(dragged.yaw !== held.yaw && dragged.pitch > held.pitch && distance(dragged.target, held.target) === 0, 'the camera turned by the whole drag');
    assert.deepEqual([await attr(app, 'data-drag'), await app.eval<number>(`orogenTest.ctx.doc.getState().doc.nodes.range.params.height`)], [null, 0.5]);
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().past.length`), 1, 'no drag of the camera is a step of the history');

    // ---- F6 in the middle of a drag: the view changes, the drag moves the view that is shown, and its end is its end ----
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 30, mid[1]])}, 0, {}, 3, false)`);
    await app.eval(`void shellTest.key('F6')`);
    assert.equal(await attr(app, 'data-mode'), 'top');
    const top = await camera(app) as Top;
    await app.eval(`void (viewportTest.hover(${mid[0] + 130}, ${mid[1]}), viewportTest.release(${quote([mid[0] + 130, mid[1]])}, 0))`);
    assert.ok((await camera(app) as Top).center[0] < top.center[0], 'the drag pans the top view');
    assert.equal(await attr(app, 'data-drag'), null);
    await app.eval(`void shellTest.key('F6')`);
    await run(app, 'viewport.frame');

    // ---- the GPU process dies while the camera flies: the flight goes on, and the terrain is back under the camera ----
    if (process.platform === 'linux') {
      const pids = gpuProcesses();
      assert.equal(pids.length, 1);
      await app.eval(`void (window.viewportLost = false, orogenTest.ctx.engine.subscribe((e) => { if (e.type === 'device-ready') window.viewportLost = true; }))`);
      const takeoff = await camera(app) as Orbit;
      await fly();
      process.kill(pids[0]!, 'SIGKILL');
      await app.waitFor(`window.viewportLost`, EVALUATION_BACKSTOP_MS);
      await flown(takeoff);
      await app.eval(`void (viewportTest.key('keyup', 'KeyW'), viewportTest.release(${quote(mid)}, 2))`);
      await settled(app);
      await app.waitFor(`viewportTest.attr('data-status') === 'shown'`, PAGE_BACKSTOP_MS);
      await run(app, 'viewport.frame');
      assert.ok((await pick(app, mid[0], mid[1])) !== null, 'the terrain is drawn on the new device');
      t.diagnostic(`capture: ${await capture(app, 'interaction-02-after-loss-in-flight')}`);
    }

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('three hundred nodes, settings at the ends of their ranges, a sea above the terrain and a view of an overlay alone: each is a picture', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    const size = await canvasSize(app);
    const mid = [size.width / 2, size.height / 2] as const;
    const under = async (): Promise<PickResult | null> => pick(app, mid[0], mid[1]);

    // ---- a chain of three hundred nodes, the last one shown ----
    const chain: Record<string, NodeSpec> = { n0: { type: 'generate/mountain-range' } };
    for (let i = 1; i < 300; i++) chain[`n${i}`] = { type: 'adjust/invert', inputs: { in: `n${i - 1}.out` } };
    await show(app, makeDoc(chain, { height: { node: 'n298', port: 'out' } }), 2 * EVALUATION_BACKSTOP_MS);
    assert.equal(await attr(app, 'data-status'), 'shown');
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 200, mid[1] + 30])}, 0, {}, 60)`);
    await run(app, 'viewport.frame');
    assert.ok((await under()) !== null);
    t.diagnostic(`capture: ${await capture(app, 'interaction-03-three-hundred-nodes')}`);

    // ---- the ends of the settings' ranges (runtime.md 4.2): a needle, a sheet, a sea far above and far below ----
    const land = (settings: object) => makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }, settings);
    for (const [name, settings] of [
      ['needle', { terrainSize: 1, heightRange: 100_000 }], ['sheet', { terrainSize: 1_000_000, heightRange: 1 }],
      ['flooded', { seaLevel: 2 }], ['sea-nowhere', { seaLevel: -1e9 }], ['sea-absurd', { seaLevel: 1e9 }],
    ] as const) {
      await show(app, land(settings));
      await run(app, 'viewport.frame');
      const c = await camera(app) as Orbit;
      assert.ok(finite(c) && c.distance > 0, `${name}: ${JSON.stringify(c)}`);
      assert.equal(await attr(app, 'data-status'), 'shown', name);
      // The frame of that camera is drawn: a pick is answered for it, whatever it finds.
      await under();
      if (name === 'sheet') assert.ok((await under()) !== null, 'a terrain a thousand kilometres wide and a metre high is under the middle of its picture');
      if (name === 'flooded') {
        // The sea stands a height range above the summits: its surface is in the picture, where the terrain alone would end.
        const view = viewOf(c, size);
        for (const corner of [[0, 0], [4032, 0], [0, 4032], [4032, 4032]] as const) {
          const at = project(view, size, [corner[0], corner[1], 2 * 1008], 4032);
          assert.ok(at !== null && at.x >= 0 && at.x <= size.width && at.y >= 0 && at.y <= size.height, `a corner of the sea at ${at?.x} ${at?.y}`);
        }
      }
      if (name === 'needle' || name === 'flooded') t.diagnostic(`capture: ${await capture(app, `interaction-04-${name}`)}`);
    }

    // ---- the display at the ends of its ranges ----
    await show(app, land({}));
    for (const [label, selector, value, attribute, said] of [
      ['Vertical scale', '[data-viewport="toolbar"]', '20', 'data-scale', '20'], ['Vertical scale', '[data-viewport="toolbar"]', '0.05', 'data-scale', '0.05'],
    ] as const) {
      await app.eval(`void (shellTest.focus('${selector} [aria-label="${label}"]'), shellTest.key('Enter', {}, '${selector} [aria-label="${label}"]'))`);
      await app.waitFor(`document.querySelector('${selector} .og-number-input') !== null`, PAGE_BACKSTOP_MS);
      await app.eval(`void (shellTest.type('${selector} .og-number-input', '${value}'), shellTest.key('Enter', {}, '${selector} .og-number-input'))`);
      await app.waitFor(`viewportTest.attr('${attribute}') === '${said}'`, PAGE_BACKSTOP_MS);
      await run(app, 'viewport.frame');
      assert.ok(finite(await camera(app)));
      await under();
      t.diagnostic(`capture: ${await capture(app, `interaction-05-scale-${value.replace('.', '')}`)}`);
    }
    await run(app, 'viewport.resetVerticalScale');
    // The sun on the horizon and at the zenith, dragged there.
    await run(app, 'viewport.frame');
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0], mid[1] + 600])}, 0, { shiftKey: true }, 12)`);
    assert.equal((await attr(app, 'data-sun'))!.split(' ')[1], '0');
    assert.ok((await under()) !== null);
    t.diagnostic(`capture: ${await capture(app, 'interaction-06-sun-on-the-horizon')}`);
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0], mid[1] - 900])}, 0, { shiftKey: true }, 12)`);
    assert.equal((await attr(app, 'data-sun'))!.split(' ')[1], '90');
    assert.ok((await under()) !== null);
    await run(app, 'viewport.resetSun');

    // ---- an overlay alone: it is drawn on a flat plane (7.4 rule 5), and the plane is what is read ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { overlay: { ref: { node: 'range', port: 'out' }, as: 'heat', opacity: 1 } }; }, { undoable: false })`);
    await settled(app);
    await run(app, 'viewport.frame');
    assert.equal(await attr(app, 'data-status'), 'shown');
    const plane = await under();
    assert.ok(plane !== null && plane.height === 0 && plane.position[2] === 0, JSON.stringify(plane));
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-viewport="subject"]')?.textContent ?? null`), 'Mountain Range', 'the toolbar names the overlay\'s output when there is no terrain');
    t.diagnostic(`capture: ${await capture(app, 'interaction-07-overlay-alone')}`);

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
