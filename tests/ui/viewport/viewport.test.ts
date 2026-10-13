// The viewport panel in the real application, in a window that is never shown (testing.md 8.5): a landform is
// bound and drawn, the camera is moved with the pointer by both conventions and flown, the view modes and the
// display options are switched from the toolbar, by key and by command, a colour and a mask are draped, the sun
// is dragged, and the readout under the pointer is compared with the field.
//
// The captures are written for a person: test-output/ui/viewport/viewport-01 … viewport-12.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CameraState, PickResult } from '../../../src/core/runtime.ts';
import { commands } from '../../../src/app/panels/viewport/commands.ts';
import { DEFAULT_DISPLAY } from '../../../src/app/panels/viewport/model.ts';
import { pixelRay, project, viewOf } from '../../../src/viewport/camera.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { key } from '../shell/rig.ts';
import { attr, camera, canvasSize, capture, makeDoc, PAGE_BACKSTOP_MS, pick, prepare, quote, run, setView, show } from './rig.ts';

/** The sun of a new session (model.ts DEFAULT_DISPLAY): its azimuth and its elevation. */
const SUN = [DEFAULT_DISPLAY.sunAzimuth, DEFAULT_DISPLAY.sunElevation] as const;

type Orbit = Extract<CameraState, { kind: 'orbit' }>;
type Top = Extract<CameraState, { kind: 'top' }>;

const orbitOf = async (app: AppDriver): Promise<Orbit> => {
  const c = await camera(app);
  assert.equal(c.kind, 'orbit');
  return c as Orbit;
};
const topOf = async (app: AppDriver): Promise<Top> => {
  const c = await camera(app);
  assert.equal(c.kind, 'top');
  return c as Top;
};
const drag = (app: AppDriver, from: readonly [number, number], to: readonly [number, number], button = 0, mods: object = {}): Promise<void> =>
  app.eval<void>(`void viewportTest.drag(${quote(from)}, ${quote(to)}, ${button}, ${quote(mods)})`);
const press = (app: AppDriver, selector: string): Promise<void> => app.eval<void>(`void shellTest.press(${quote(selector)})`);
const readout = (app: AppDriver): Promise<{ u: number; v: number; height: number; text: string } | null> => app.eval(`viewportTest.readout()`);

/** The terrain of the journey: a range, a mask of its steep ground, a colour map and a data field of it. */
const LAND = {
  range: { type: 'generate/mountain-range' },
  steep: { type: 'select/slope', inputs: { in: 'range.out' } },
  paint: { type: 'color/natural', inputs: { in: 'range.out' } },
  shelter: { type: 'select/occlusion', inputs: { in: 'range.out' } },
};
const HEIGHT = { node: 'range', port: 'out' };

test('the viewport: a landform is drawn; the camera orbits, pans, dollies and flies; the modes, the overlays and the sun change the picture', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc(LAND, { height: HEIGHT }));
    const size = await canvasSize(app);
    const mid = [size.width / 2, size.height / 2] as const;

    // ---- what is shown, and that it is said ----
    assert.equal(await attr(app, 'data-status'), 'shown');
    assert.equal(await attr(app, 'data-mode'), 'orbit');
    assert.equal(await app.eval<string>(`document.querySelector('[data-viewport="resolution"]').textContent`), '1009 × 1009');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="cover"]') === null`), true);
    assert.ok((await pick(app, mid[0], mid[1])) !== null, 'the terrain is under the middle of the canvas');
    t.diagnostic(`capture: ${await capture(app, 'viewport-01-terrain')}`);

    // ---- the camera, by the pointer ----
    const framed = await orbitOf(app);
    assert.ok(Math.hypot(framed.target[0] - 2016, framed.target[1] - 2016) < 800, `the camera is framed on the middle of the terrain: ${framed.target.join(' ')}`);
    await drag(app, mid, [mid[0] + 120, mid[1] + 40]);
    const turned = await orbitOf(app);
    assert.ok(turned.yaw !== framed.yaw && turned.pitch > framed.pitch, `the left button orbits: ${JSON.stringify(turned)}`);
    assert.deepEqual([turned.target, turned.distance], [framed.target, framed.distance]);
    await drag(app, mid, [mid[0] - 60, mid[1]], 1);
    assert.ok((await orbitOf(app)).yaw !== turned.yaw, 'the middle button orbits');
    await drag(app, mid, [mid[0] + 60, mid[1]], 0, { altKey: true });
    assert.ok(Math.abs((await orbitOf(app)).yaw - turned.yaw) < 1e-9, 'Alt with the left button orbits, here back to where it was');

    await drag(app, mid, [mid[0] + 80, mid[1] - 30], 1, { altKey: true });
    const panned = await orbitOf(app);
    assert.ok(Math.hypot(panned.target[0] - turned.target[0], panned.target[1] - turned.target[1], panned.target[2] - turned.target[2]) > 10, 'Alt with the middle button pans');
    assert.deepEqual([panned.yaw, panned.pitch, panned.distance], [turned.yaw, turned.pitch, turned.distance]);
    await drag(app, mid, [mid[0] - 80, mid[1] + 30], 1, { shiftKey: true });
    assert.ok(Math.hypot(...(await orbitOf(app)).target.map((v, i) => v - turned.target[i]!)) < 1e-6, 'Shift with the middle button pans, here back');

    await drag(app, mid, [mid[0] + 100, mid[1]], 2, { altKey: true });
    const nearer = await orbitOf(app);
    assert.ok(nearer.distance < turned.distance * 0.7, 'Alt with the right button dollies in');
    await app.eval(`void viewportTest.wheel(${mid[0]}, ${mid[1]}, 300)`);
    assert.ok((await orbitOf(app)).distance > nearer.distance * 1.3, 'the wheel dollies out');
    t.diagnostic(`capture: ${await capture(app, 'viewport-02-orbited')}`);

    // Flying: the right button held turns the camera about itself, and W moves it along its view.
    const before = await orbitOf(app);
    await app.eval(`void viewportTest.drag(${quote(mid)}, ${quote([mid[0] + 40, mid[1] - 20])}, 2, {}, 4, false)`);
    assert.equal(await attr(app, 'data-drag'), 'fly');
    const looking = await orbitOf(app);
    assert.ok(looking.yaw !== before.yaw && looking.pitch < before.pitch, 'the right button looks around');
    await app.eval(`void viewportTest.key('keydown', 'KeyW')`);
    await app.waitFor(`Math.hypot(...viewportTest.camera().target.map((v, i) => v - ${quote(looking.target)}[i])) > 50`, PAGE_BACKSTOP_MS);
    await app.eval(`void (viewportTest.key('keyup', 'KeyW'), viewportTest.release(${quote(mid)}, 2))`);
    const flown = await orbitOf(app);
    assert.deepEqual([flown.yaw, flown.pitch, flown.distance], [looking.yaw, looking.pitch, looking.distance], 'W moves the camera and keeps its direction');
    assert.equal(await attr(app, 'data-drag'), null);

    // F frames the terrain again, from the direction the camera has.
    await key(app, 'KeyF');
    const again = await orbitOf(app);
    assert.ok(Math.hypot(again.target[0] - 2016, again.target[1] - 2016) < 800 && Math.abs(again.distance - framed.distance) < framed.distance * 0.25 && again.yaw === flown.yaw, `F frames: ${JSON.stringify(again)}`);

    // ---- the sun ----
    const sun = await attr(app, 'data-sun');
    await drag(app, mid, [mid[0] + 150, mid[1] - 60], 0, { shiftKey: true });
    const dragged = (await attr(app, 'data-sun'))!.split(' ').map(Number);
    assert.deepEqual(dragged, [SUN[0] + 60, SUN[1] + 15], `Shift-drag turns and raises the sun: from ${sun}`);
    assert.deepEqual((await orbitOf(app)).yaw, again.yaw, 'and leaves the camera');
    await run(app, 'viewport.resetSun');
    assert.equal(await attr(app, 'data-sun'), SUN.join(' '));
    // From the toolbar: a low sun.
    await press(app, '[data-viewport="sun"]');
    await app.waitFor(`document.querySelector('[data-ui="popover"] [aria-label="Sun elevation"]') !== null`, PAGE_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'viewport-03-sun-popover')}`);
    await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="popover"]'))`);
    await app.waitFor(`document.querySelector('[data-ui="popover"]') === null`, PAGE_BACKSTOP_MS);
    await app.eval(`void orogenTest.ctx.run('viewport.resetSun')`);

    // ---- overlays: a colour draped, a mask tinted, a data field through a palette ----
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'paint', port: 'out' }, as: 'color', opacity: 1 } });
    t.diagnostic(`capture: ${await capture(app, 'viewport-04-color-draped')}`);
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'steep', port: 'out' }, as: 'mask', opacity: 0.85 } });
    t.diagnostic(`capture: ${await capture(app, 'viewport-05-mask-tinted')}`);
    await press(app, '[data-viewport="overlay"]');
    await app.waitFor(`document.querySelector('[data-ui="popover"] [aria-label="Overlay palette"]') !== null`, PAGE_BACKSTOP_MS);
    assert.match(await app.eval<string>(`document.querySelector('[data-ui="popover"]').textContent`), /Mask/);
    await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="popover"]'))`);
    await app.waitFor(`document.querySelector('[data-ui="popover"]') === null`, PAGE_BACKSTOP_MS);
    await run(app, 'viewport.paletteBlue');
    assert.equal(await attr(app, 'data-palette'), 'blue');
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'shelter', port: 'out' }, as: 'heat', opacity: 1 } });
    await run(app, 'viewport.paletteViridis');
    await run(app, 'viewport.shadingClay');
    assert.equal(await attr(app, 'data-shading'), 'clay');
    t.diagnostic(`capture: ${await capture(app, 'viewport-06-data-viridis-clay')}`);
    await run(app, 'viewport.removeOverlay');
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.doc.getState().doc.ui.view.overlay ?? null`), null);
    await run(app, 'viewport.shadingMaterial');

    // ---- the top view: F6, pan and zoom, its three styles ----
    await key(app, 'F6');
    assert.equal(await attr(app, 'data-mode'), 'top');
    const whole = await topOf(app);
    assert.deepEqual(whole.center, [0.5, 0.5]);
    assert.ok(whole.span >= 1.08, 'the whole terrain is in the picture');
    t.diagnostic(`capture: ${await capture(app, 'viewport-07-top-hillshade')}`);
    await drag(app, mid, [mid[0] + 100, mid[1] + 50]);
    const moved = await topOf(app);
    assert.ok(Math.abs(moved.center[0] - (0.5 - (100 * whole.span) / size.width)) < 1e-9 && moved.center[1] < 0.5, 'a drag moves the terrain with the pointer');
    await app.eval(`void viewportTest.wheel(${mid[0] + 200}, ${mid[1]}, -400)`);
    const zoomed = await topOf(app);
    assert.ok(zoomed.span < moved.span * 0.7, 'the wheel zooms in');
    await run(app, 'viewport.topHeight');
    assert.equal(await attr(app, 'data-top-style'), 'grey');
    t.diagnostic(`capture: ${await capture(app, 'viewport-08-top-height-zoomed')}`);
    await run(app, 'viewport.frame');
    assert.deepEqual((await topOf(app)).center, [0.5, 0.5]);
    await setView(app, { height: HEIGHT, overlay: { ref: { node: 'paint', port: 'out' }, as: 'color', opacity: 1 } });
    await run(app, 'viewport.topOverlay');
    t.diagnostic(`capture: ${await capture(app, 'viewport-09-top-overlay')}`);
    await run(app, 'viewport.topHillshade');
    // The toolbar's own button goes back to 3D.
    await press(app, '[data-viewport="toolbar"] [data-view="orbit"]');
    assert.equal(await attr(app, 'data-mode'), 'orbit');
    assert.equal(await app.eval<string>(`document.querySelector('[data-viewport="toolbar"] [data-view="orbit"]').getAttribute('aria-pressed')`), 'true');

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('the readout under the pointer is the field\'s own height and position, in the top view and in the 3D view', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    // A ramp that rises along 30 degrees: its height at any uv is known.
    const cos = Math.cos(Math.PI / 6), sin = Math.sin(Math.PI / 6);
    const height = (u: number, v: number): number => Math.min(1, Math.max(0, (u - 0.5) * cos + (v - 0.5) * sin + 0.5));
    await show(app, makeDoc({ ramp: { type: 'generate/gradient', params: { angle: 30 } } }, { height: { node: 'ramp', port: 'out' } }, { terrainSize: 2000, heightRange: 500 }));
    const size = await canvasSize(app);
    const hover = async (x: number, y: number): Promise<NonNullable<Awaited<ReturnType<typeof readout>>>> => {
      await app.eval(`void viewportTest.leave()`);
      await app.waitFor(`viewportTest.readout() === null`, PAGE_BACKSTOP_MS);
      await app.eval(`void viewportTest.hover(${x}, ${y})`);
      await app.waitFor(`viewportTest.readout() !== null`, PAGE_BACKSTOP_MS);
      return (await readout(app))!;
    };

    // The top view: the uv of a pixel is the camera's arithmetic.
    await run(app, 'viewport.toggleTop');
    const top = await camera(app) as Top;
    for (const [fx, fy] of [[0.5, 0.5], [0.42, 0.3], [0.61, 0.72]] as const) {
      const x = Math.round(fx * size.width), y = Math.round(fy * size.height);
      const u = top.center[0] + (x / size.width - 0.5) * top.span, v = top.center[1] + (y / size.height - 0.5) * top.span * (size.height / size.width);
      const said = await hover(x, y);
      assert.ok(Math.abs(said.u - u) < 1e-5 && Math.abs(said.v - v) < 1e-5, `uv ${said.u} ${said.v} for ${u} ${v}`);
      assert.ok(Math.abs(said.height - height(u, v)) < 1e-5, `height ${said.height} for ${height(u, v)}`);
      // As a person reads it: metres, and the stored height beside them.
      const metres = (value: number): string => (Math.abs(value) >= 100 ? `${Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')} m` : `${Number(value.toPrecision(3))} m`);
      assert.equal(said.text, `X${metres(said.u * 2000)}Y${metres(said.v * 2000)}Height${metres(said.height * 500)}${said.height.toFixed(4)}`);
    }
    t.diagnostic(`capture: ${await capture(app, 'viewport-10-readout-top')}`);
    // Beside the terrain there is nothing to read.
    await app.eval(`void viewportTest.leave()`);
    await app.waitFor(`viewportTest.readout() === null`, PAGE_BACKSTOP_MS);
    await app.eval(`void viewportTest.hover(3, ${size.height / 2})`);
    assert.equal(await pick(app, 3, size.height / 2), null);
    assert.equal(await readout(app), null);

    // The 3D view: the ramp is a plane, so the point under a pixel is where its ray meets that plane.
    await run(app, 'viewport.toggleTop');
    const orbit = await camera(app) as Orbit;
    const view = viewOf(orbit, size);
    const pixels: [number, number][] = [];
    for (const [pu, pv] of [[0.5, 0.5], [0.35, 0.62], [0.62, 0.4]] as const) {
      // The pixel a point of the ramp is drawn at, to the whole pixel; what is expected under it follows from the pixel.
      const drawn = project(view, size, [pu * 2000, pv * 2000, height(pu, pv) * 500], 2000)!;
      const x = Math.round(drawn.x), y = Math.round(drawn.y);
      pixels.push([x, y]);
      const ray = pixelRay(view, size, x, y, 2000);
      // z = (a·x + b·y + c) with x, y in metres: the plane of the ramp where it is not clamped.
      const a = (cos / 2000) * 500, b = (sin / 2000) * 500, c = (0.5 - 0.5 * cos - 0.5 * sin) * 500;
      const along = (a * ray.origin[0] + b * ray.origin[1] + c - ray.origin[2]) / (ray.direction[2] - a * ray.direction[0] - b * ray.direction[1]);
      const u = (ray.origin[0] + along * ray.direction[0]) / 2000, v = (ray.origin[1] + along * ray.direction[1]) / 2000;
      assert.ok(u > 0.05 && u < 0.95 && v > 0.05 && v < 0.95 && height(u, v) > 0.01 && height(u, v) < 0.99, `the pixel ${x} ${y} looks at the ramp at ${u} ${v}`);
      const said = await hover(x, y);
      assert.ok(Math.abs(said.u - u) < 2e-4 && Math.abs(said.v - v) < 2e-4, `uv ${said.u} ${said.v} for ${u} ${v}`);
      assert.ok(Math.abs(said.height - height(said.u, said.v)) < 1e-5, `height ${said.height} at ${said.u} ${said.v}, where the ramp has ${height(said.u, said.v)}`);
      const hit = await pick(app, x, y) as PickResult;
      assert.ok(Math.abs(hit.position[2] - said.height * 500) < 1e-3 && Math.abs(hit.position[0] - said.u * 2000) < 1e-2, 'the position is in metres');
    }
    t.diagnostic(`capture: ${await capture(app, 'viewport-11-readout-orbit')}`);
    // The wheel dollies towards what is under the pointer: that point keeps its pixel.
    const [x, y] = pixels[1]!;
    const under = await hover(x, y);
    await app.eval(`void viewportTest.wheel(${x}, ${y}, -500)`);
    const nearer = await camera(app) as Orbit;
    assert.ok(nearer.distance < orbit.distance * 0.6);
    const after = await pick(app, x, y) as PickResult;
    assert.ok(Math.abs(after.uv[0] - under.u) < 2e-3 && Math.abs(after.uv[1] - under.v) < 2e-3, `the point under the pointer stayed: ${after.uv.join(' ')} for ${under.u} ${under.v}`);

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});

test('every command of the panel runs, from the palette of commands and from its menu, and the sea is shown at the project\'s level', async (t) => {
  const app = await launchApp({ profile: 'core' });
  try {
    await prepare(app);
    await show(app, makeDoc({ island: { type: 'generate/island' }, coast: { type: 'select/height', inputs: { in: 'island.out' } } },
      { height: { node: 'island', port: 'out' }, overlay: { ref: { node: 'coast', port: 'out' }, as: 'mask', opacity: 0.5 } }, { seaLevel: 0.25 }));
    t.diagnostic(`capture: ${await capture(app, 'viewport-12-island-sea')}`);

    // The menu the panel brings: its entries are its commands, with the key of each.
    await press(app, '.og-menubar-item[data-menu="Viewport"]');
    await app.waitFor(`document.querySelector('[data-ui="menu"][data-menu="Viewport"] .og-menu-item') !== null`, PAGE_BACKSTOP_MS);
    const items = await app.eval<{ id: string; label: string; key: string | null; enabled: boolean }[]>(`[...document.querySelectorAll('[data-ui="menu"][data-menu="Viewport"] > .og-menu-item')].map((item) => ({
      id: item.getAttribute('data-item'), label: item.querySelector('.og-menu-item-label').textContent,
      key: item.querySelector('.og-menu-item-key')?.textContent ?? null, enabled: !item.hasAttribute('data-disabled'),
    }))`);
    assert.deepEqual(items.map((item) => `${item.id}${item.key ? ` [${item.key}]` : ''}${item.enabled ? '' : ' (disabled)'}`), [
      'viewport.frame [F]', 'viewport.resetView [Home]', 'viewport.toggleTop [F6]',
      'viewport.shadingMaterial', 'viewport.shadingClay', 'viewport.topHillshade', 'viewport.topHeight', 'viewport.topOverlay',
      'viewport.toggleSea', 'viewport.resetSun', 'viewport.resetVerticalScale',
      'viewport.nextPalette', 'viewport.removeOverlay',
    ]);
    assert.equal(items.find((item) => item.id === 'viewport.toggleSea')!.label, 'Show or Hide Sea');
    await press(app, '[data-ui="menu"][data-menu="Viewport"] [data-item="viewport.toggleSea"]');
    await app.waitFor(`document.querySelector('[data-ui="menu"]') === null`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-viewport="toolbar"] [data-ui="checkbox"]').hasAttribute('data-checked')`), false, 'the toolbar shows what the menu did');

    // Every command the panel declares, once (testing.md 5.6 rule 3), in the order it declares them.
    const declared = commands.map((command) => command.id);
    assert.equal(declared.length, 20);
    assert.equal(await app.eval<number>(`(() => {
      let ran = 0;
      for (const id of ${quote(declared)}) {
        orogenTest.ctx.run(id);
        ran++;
      }
      return ran;
    })()`), declared.length);
    assert.deepEqual(
      [await attr(app, 'data-mode'), await attr(app, 'data-shading'), await attr(app, 'data-top-style'), await attr(app, 'data-palette'), await attr(app, 'data-sun')],
      ['top', 'clay', 'overlay', 'red', SUN.join(' ')],
    );
    assert.equal(await app.eval<unknown>(`orogenTest.ctx.doc.getState().doc.ui.view.overlay ?? null`), null);
    // The vertical scale, typed into its field in the toolbar.
    await app.eval(`void orogenTest.ctx.run('viewport.toggleTop')`);
    await app.eval(`void (shellTest.focus('[data-viewport="toolbar"] [aria-label="Vertical scale"]'), shellTest.key('Enter', {}, '[data-viewport="toolbar"] [aria-label="Vertical scale"]'))`);
    await app.waitFor(`document.querySelector('[data-viewport="toolbar"] .og-number-input') !== null`, PAGE_BACKSTOP_MS);
    await app.eval(`void (shellTest.type('[data-viewport="toolbar"] .og-number-input', '2.5'), shellTest.key('Enter', {}, '[data-viewport="toolbar"] .og-number-input'))`);
    await app.waitFor(`document.querySelector('[data-viewport="toolbar"] .og-number-input') === null`, PAGE_BACKSTOP_MS);
    assert.equal(await attr(app, 'data-scale'), '2.5');
    await run(app, 'viewport.shadingMaterial');
    await run(app, 'viewport.toggleSea');
    t.diagnostic(`capture: ${await capture(app, 'viewport-13-vertical-scale')}`);
    await run(app, 'viewport.resetVerticalScale');

    assert.deepEqual(await app.errors(), []);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
