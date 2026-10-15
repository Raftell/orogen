// The hand on the viewport, in the real application: two fingers on a trackpad and a pinch, as a browser hands
// them over (wheel events, a pinch with ctrlKey); the wheel of a mouse beside them; a drag that is exact and
// ends where the pointer ends; and keys that are a text field's while one has the focus.
//
// All input is synthesised in the page (testing.md 8.5): what a real trackpad sends is taken from Chromium's
// own convention, not from a device.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CameraState } from '../../../src/core/runtime.ts';
import { FINE, WHEEL_STREAM_MS } from '../../../src/app/panels/viewport/model.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { attr, camera, canvasSize, makeDoc, PAGE_BACKSTOP_MS, prepare, quote, run, show, sleep } from './rig.ts';

type Orbit = Extract<CameraState, { kind: 'orbit' }>;
type Top = Extract<CameraState, { kind: 'top' }>;
const HEIGHT = { node: 'range', port: 'out' };
const wheel = (app: AppDriver, at: readonly [number, number], deltaY: number, init: object = {}): Promise<void> =>
  app.eval<void>(`void viewportTest.wheel(${at[0]}, ${at[1]}, ${deltaY}, ${quote(init)})`);
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(...a.map((v, i) => v - b[i]!));

test('a trackpad: two fingers move the picture, a pinch brings it nearer, and the wheel of a mouse still dollies', async () => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }));
    const size = await canvasSize(app);
    const mid = [Math.round(size.width / 2), Math.round(size.height / 2)] as const;
    /** A gesture ends when the fingers have rested: the next one is judged for itself. */
    const rest = (): Promise<void> => sleep(WHEEL_STREAM_MS + 80);

    // ---- the 3D view ----
    const first = await camera(app) as Orbit;
    // Two fingers that begin slowly and go faster, mostly across: nine events of one gesture.
    const swipe: [number, number][] = [[2, 0], [5, 1], [12, 2], [30, 4], [64, 6], [48, 3], [20, 1], [6, 0], [1, 0]];
    for (const [dx, dy] of swipe) await wheel(app, mid, dy, { deltaX: dx });
    const panned = await camera(app) as Orbit;
    assert.deepEqual([panned.distance, panned.yaw, panned.pitch], [first.distance, first.yaw, first.pitch], 'two fingers neither dolly nor turn');
    // The picture goes where the fingers go: the target moves across the picture's plane by as many pixels the other way.
    const across = swipe.reduce((sum, [dx]) => sum + dx, 0), down = swipe.reduce((sum, [, dy]) => sum + dy, 0);
    const metresPerPixel = (2 * first.distance * Math.tan((first.fovY * Math.PI / 180) / 2)) / size.height;
    assert.ok(Math.abs(distance(panned.target, first.target) - Math.hypot(across, down) * metresPerPixel) < 1e-6 * first.distance,
      `the target moved ${distance(panned.target, first.target)} m for ${Math.hypot(across, down)} pixels of ${metresPerPixel} m`);
    await rest();

    // A pinch: wheel events with ctrlKey, each a hundredth of the fingers' spread. Three of ten are 0.3 nearer in the logarithm.
    for (let i = 0; i < 3; i++) await wheel(app, mid, -10, { ctrlKey: true });
    const pinched = await camera(app) as Orbit;
    assert.ok(Math.abs(pinched.distance / panned.distance - Math.exp(-0.3)) < 1e-9, `a pinch brings the picture nearer: ${pinched.distance / panned.distance}`);
    for (let i = 0; i < 3; i++) await wheel(app, mid, 10, { ctrlKey: true });
    assert.ok(Math.abs((await camera(app) as Orbit).distance / panned.distance - 1) < 1e-9, 'and the opposite pinch takes it back');
    await rest();

    // The wheel of a mouse: a notch, straight along its axis. It dollies, as it always did; so does a wheel that counts in lines.
    const before = await camera(app) as Orbit;
    await wheel(app, mid, -100);
    const notched = await camera(app) as Orbit;
    assert.ok(notched.distance < before.distance * 0.9, 'a notch dollies in');
    await rest();
    await wheel(app, mid, 3, { deltaMode: 1 });
    assert.ok((await camera(app) as Orbit).distance > notched.distance, 'a wheel that counts in lines dollies too');
    await rest();
    // A wheel that is turned gently between two notches stays a wheel: nothing of the gesture pans.
    const gentle = await camera(app) as Orbit;
    await wheel(app, mid, -100);
    await wheel(app, mid, -12);
    const still = await camera(app) as Orbit;
    assert.ok(still.distance < gentle.distance && still.yaw === gentle.yaw, 'the small step of a wheel dollies with its notches');
    await rest();

    // ---- the top view ----
    await run(app, 'viewport.toggleTop');
    const top = await camera(app) as Top;
    for (const [dx, dy] of [[3, 2], [14, 9], [22, 14], [6, 4]] as const) await wheel(app, mid, dy, { deltaX: dx });
    const moved = await camera(app) as Top;
    assert.equal(moved.span, top.span);
    assert.ok(Math.abs(moved.center[0] - (top.center[0] + (45 * top.span) / size.width)) < 1e-9 && Math.abs(moved.center[1] - (top.center[1] + (29 * top.span) / size.width)) < 1e-9,
      `the terrain went 45 pixels left and 29 up with the fingers: ${moved.center.join(' ')} from ${top.center.join(' ')}`);
    await rest();
    await wheel(app, [mid[0] + 150, mid[1] - 40], -20, { ctrlKey: true });
    const zoomed = await camera(app) as Top;
    assert.ok(Math.abs(zoomed.span / moved.span - Math.exp(-0.2)) < 1e-9, 'a pinch zooms the top view');
    await run(app, 'viewport.toggleTop');

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('a drag is exact and stops with the pointer; with Ctrl it is a fine one; and while a text field has the focus the keys are its own', async () => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }));
    const size = await canvasSize(app);
    const mid = [Math.round(size.width / 2), Math.round(size.height / 2)] as const;
    const drag = (to: readonly [number, number], mods: object = {}, steps = 6): Promise<void> =>
      app.eval<void>(`void viewportTest.drag(${quote(mid)}, ${quote(to)}, 0, ${quote(mods)}, ${steps})`);

    // The same way in three moves and in forty: the same camera, 0.3 degrees a pixel.
    const first = await camera(app) as Orbit;
    await drag([mid[0] + 90, mid[1] + 30], {}, 3);
    const few = await camera(app) as Orbit;
    assert.ok(Math.abs(few.yaw - (first.yaw + 27)) < 1e-9 && Math.abs(few.pitch - (first.pitch + 9)) < 1e-9, `${few.yaw} ${few.pitch}`);
    await drag([mid[0] - 90, mid[1] - 30], {}, 40);
    const back = await camera(app) as Orbit;
    assert.ok(Math.abs(back.yaw - first.yaw) < 1e-9 && Math.abs(back.pitch - first.pitch) < 1e-9, 'there and back, in other steps, is where it began');
    // No momentum: when the button is up the camera is where it was left, and stays there.
    await drag([mid[0] + 200, mid[1]], {}, 2);
    const released = await app.eval<string>(`viewportTest.attr('data-camera')`);
    await sleep(250);
    assert.equal(await app.eval<string>(`viewportTest.attr('data-camera')`), released, 'nothing moves after the release');
    assert.equal(await attr(app, 'data-drag'), null);

    // With Ctrl the same drag turns a quarter as far.
    const coarse = await camera(app) as Orbit;
    await drag([mid[0] + 120, mid[1]], { ctrlKey: true });
    const fine = await camera(app) as Orbit;
    assert.ok(Math.abs(((fine.yaw - coarse.yaw + 540) % 360) - 180 - 120 * 0.3 * FINE) < 1e-9, `a fine drag of 120 pixels turns ${fine.yaw - coarse.yaw} degrees`);

    // ---- keys: the canvas's while it has the focus ----
    const settledCamera = await camera(app) as Orbit;
    await app.eval(`void viewportTest.hostKey('ArrowLeft')`);
    const turned = await camera(app) as Orbit;
    assert.ok(turned.yaw !== settledCamera.yaw, 'an arrow key turns the camera while the picture has the focus');
    await app.eval(`void viewportTest.hostKey('Equal', { key: '=' })`);
    const nearer = await camera(app) as Orbit;
    assert.ok(nearer.distance < turned.distance, 'and plus brings it nearer');
    // Plus and minus are the keys that type them (runtime.md 8.8 rule 2): on AZERTY minus is the key of 6, and the
    // US place of minus types ")" there.
    await app.eval(`void viewportTest.hostKey('Minus', { key: ')' })`);
    assert.equal((await camera(app) as Orbit).distance, nearer.distance, 'AZERTY ) is no minus');
    await app.eval(`void viewportTest.hostKey('Digit6', { key: '-' })`);
    assert.ok((await camera(app) as Orbit).distance > nearer.distance, 'AZERTY - takes the camera away');

    // ---- and a text field's while one has it: the entry of the vertical scale, in the panel's own toolbar ----
    await app.eval(`void (shellTest.focus('[data-viewport="toolbar"] [aria-label="Vertical scale"]'), shellTest.key('Enter', {}, '[data-viewport="toolbar"] [aria-label="Vertical scale"]'))`);
    await app.waitFor(`document.querySelector('[data-viewport="toolbar"] .og-number-input') !== null`, PAGE_BACKSTOP_MS);
    await app.eval(`void document.querySelector('[data-viewport="toolbar"] .og-number-input').focus()`);
    assert.equal(await app.eval<boolean>(`document.activeElement === document.querySelector('[data-viewport="toolbar"] .og-number-input')`), true);
    const typing = await app.eval<string>(`viewportTest.attr('data-camera')`);
    const mode = await attr(app, 'data-mode');
    // What the canvas takes (arrows, plus, minus), what the panel binds (F, Home), what a flight takes (W), each on the field.
    for (const code of ['ArrowLeft', 'ArrowUp', 'Equal', 'Minus', 'NumpadAdd', 'KeyF', 'Home', 'KeyW', 'KeyA', 'KeyQ']) {
      await app.eval(`void shellTest.key(${quote(code)}, {}, '[data-viewport="toolbar"] .og-number-input')`);
    }
    await sleep(120);
    assert.equal(await app.eval<string>(`viewportTest.attr('data-camera')`), typing, 'no key moved the camera while the field had the focus');
    assert.equal(await attr(app, 'data-mode'), mode);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="toolbar"] .og-number-input') !== null`), true, 'and the field is still being typed in');
    await app.eval(`void shellTest.key('Escape', {}, '[data-viewport="toolbar"] .og-number-input')`);
    await app.waitFor(`document.querySelector('[data-viewport="toolbar"] .og-number-input') === null`, PAGE_BACKSTOP_MS);

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
