// What the end-to-end tests of the whole application share (gate-*.test.ts). Not a test file.
//
// These tests use the application as its user does: every step is input synthesised in the page (a press, a
// drag, a key, typed text) and nothing is written into a store. The page's stores are read, to know what an
// input did. The functions of the panels' own rigs are installed side by side: `shellTest`, `graphTest`,
// `libraryTest` and `viewportTest`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decode } from 'fast-png';

import type { FieldStats } from '../../../src/core/api.ts';
import type { CameraState, GraphDoc, PortRef } from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { graphSettled, install as installGraph } from '../graph/rig.ts';
import { install as installLibrary } from '../library/rig.ts';
import { prepare as prepareViewport } from '../viewport/rig.ts';
import { docked, EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, quote, ready, ROOT, sleep } from './rig.ts';

export { appears, exists, key, openMenu, closeMenu, press, quote, sleep, vanishes, EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, ROOT } from './rig.ts';
export { graphSettled } from '../graph/rig.ts';

export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'));

export interface Point { readonly x: number; readonly y: number }
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * Starts the application and waits until it is usable: a device, the five panels docked, the project computed
 * and the graph at rest. The desktop's clipboard is the user's own: the page's writes to it are kept in
 * `window.gateCopied` instead.
 */
export async function start(opts: { readonly open?: string } = {}): Promise<AppDriver> {
  const app = await launchApp({ profile: 'core', ...opts });
  try {
    await installGraph(app);
    await installLibrary(app);
    await prepareViewport(app);
    await app.eval(`void (window.gateCopied = [], navigator.clipboard.writeText = (text) => { window.gateCopied.push(text); return Promise.resolve(); },
      navigator.clipboard.readText = () => Promise.resolve(window.gateCopied.at(-1) ?? ''))`);
    await ready(app);
    await docked(app);
    await settled(app);
    await graphSettled(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  return app;
}

/** Waits until the document as the engine was last sent it is shown, refined, and nothing runs. */
export async function settled(app: AppDriver, timeoutMs: number = EVALUATION_BACKSTOP_MS): Promise<void> {
  try {
    await app.waitFor(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      const doc = orogenTest.ctx.doc.getState();
      return doc.gesture === null && engine.evaluation === null && engine.view !== null && !engine.view.draft && engine.view.revision >= doc.engineRevision;
    })()`, timeoutMs);
  } catch (thrown) {
    const state = await app.eval<object>(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      const doc = orogenTest.ctx.doc.getState();
      return { gesture: doc.gesture, engineRevision: doc.engineRevision, view: engine.view, evaluation: engine.evaluation, device: engine.device.state, shows: doc.doc.ui.view ?? null };
    })()`).catch(() => null);
    throw new Error(`The engine did not settle: ${JSON.stringify(state)}`, { cause: thrown });
  }
}

/**
 * A capture of the whole window for a person (testing.md 8.5 rule 1), as <output>/ui/<folder>/<name>.png. The
 * engine has drawn the camera last set when a pick is answered; a window that was never shown draws its page
 * about once a second and capturePage copies the frame before the newest, so the picture is taken two page
 * frames and a good second later.
 */
export async function capture(app: AppDriver, folder: string, name: string): Promise<string> {
  await app.eval(`orogenTest.ctx.engine.viewport.pick(1, 1).catch(() => null)`);
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1500);
  return app.capture(`${folder}/${name}`);
}

// ---- reading the application -------------------------------------------------------------------------------------------

export const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
export const selection = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`[...orogenTest.ctx.ui.getState().selection]`);
export const history = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`orogenTest.ctx.doc.getState().past.map((entry) => entry.label)`);
export const inspect = (app: AppDriver, ref: PortRef): Promise<FieldStats | null> => app.eval<FieldStats | null>(`orogenTest.ctx.engine.inspect(${quote(ref)})`);
export const camera = (app: AppDriver): Promise<CameraState> => app.eval<CameraState>(`viewportTest.camera()`);
export const text = (app: AppDriver, selector: string): Promise<string | null> => app.eval<string | null>(`document.querySelector(${quote(selector)})?.textContent ?? null`);
export const attr = (app: AppDriver, selector: string, name: string): Promise<string | null> =>
  app.eval<string | null>(`document.querySelector(${quote(selector)})?.getAttribute(${quote(name)}) ?? null`);
export const focusedPanel = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`orogenTest.ctx.ui.getState().focusedPanel`);
export const boxOf = (app: AppDriver, selector: string): Promise<Box> => app.eval<Box>(`shellTest.rect(${quote(selector)})`);

export interface ViewState { readonly revision: number; readonly resolution: number; readonly draft: boolean }
export const viewOf = (app: AppDriver): Promise<ViewState | null> => app.eval<ViewState | null>(`(() => {
  const view = orogenTest.ctx.engineState.getState().view;
  return view === null ? null : { revision: view.revision, resolution: view.resolution, draft: view.draft };
})()`);

/** Statistics of one field on one adapter, computed twice, agree to the last digits a float prints. */
export function sameField(a: FieldStats | null, b: FieldStats | null, tolerance = 1e-6): boolean {
  return a !== null && b !== null && (['min', 'max', 'mean'] as const).every((name) => Math.abs(a[name] - b[name]) <= tolerance);
}

/** The node of the document that `before` did not hold. */
export async function addedNode(app: AppDriver, before: GraphDoc): Promise<string> {
  const ids = Object.keys((await docOf(app)).nodes).filter((id) => !Object.hasOwn(before.nodes, id));
  assert.equal(ids.length, 1, `one node was added: ${ids.join(', ')}`);
  return ids[0]!;
}

// ---- input ---------------------------------------------------------------------------------------------------------------

/** A press on the tab of a panel in the dock, as a person brings a panel to the front. */
export async function showTab(app: AppDriver, title: 'Viewport' | 'Graph' | 'Inspector' | 'Library' | 'Build'): Promise<void> {
  await app.eval(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === ${quote(title)}))`);
  await app.waitFor(`(() => {
    const panel = document.querySelector('[data-panel="${title.toLowerCase()}"]');
    return panel !== null && panel.getBoundingClientRect().width > 0;
  })()`, PAGE_BACKSTOP_MS);
}

/** Where a node of the graph is drawn: its title, which is what it is pressed and dragged by. */
export const titleAt = (app: AppDriver, id: string): Promise<Point> => app.eval<Point>(`graphTest.title(${quote(id)})`);
export const nodeBox = (app: AppDriver, id: string): Promise<Box> => app.eval<Box>(`graphTest.node(${quote(id)})`);
export const portAt = (app: AppDriver, id: string, side: 'in' | 'out', name: string): Promise<Point> => app.eval<Point>(`graphTest.port(${quote(id)}, ${quote(side)}, ${quote(name)})`);
export const graphClick = (app: AppDriver, at: Point, init: object = {}): Promise<void> => app.eval<void>(`void graphTest.click(${at.x}, ${at.y}, ${quote(init)})`);
export const graphDrag = (app: AppDriver, from: Point, to: Point, init: object = {}, steps = 10): Promise<void> =>
  app.eval<void>(`void graphTest.drag(${quote(from)}, ${quote(to)}, ${quote(init)}, ${steps}, true)`);
export const graphHover = (app: AppDriver, at: Point): Promise<void> => app.eval<void>(`void graphTest.hover(${at.x}, ${at.y})`);
/** The wheel over a point of the graph: zooms about it. */
export const graphWheel = (app: AppDriver, at: Point, deltaY: number): Promise<void> => app.eval<void>(`void graphTest.wheel(${at.x}, ${at.y}, ${deltaY})`);

/** Presses a node of the graph by its title: the selection is that node. */
export async function selectNode(app: AppDriver, id: string): Promise<void> {
  const at = await titleAt(app, id);
  await graphClick(app, at);
  try {
    await app.waitFor(`(() => { const s = orogenTest.ctx.ui.getState().selection; return s.length === 1 && s[0] === ${quote(id)}; })()`, PAGE_BACKSTOP_MS);
  } catch (thrown) {
    const found = await app.eval<string>(`graphTest.under(${at.x}, ${at.y})`).catch(() => 'nothing');
    throw new Error(`A press on the title of the node ${id} at ${at.x}, ${at.y} did not select it: ${found} lies there, and ${JSON.stringify(await selection(app))} is selected`, { cause: thrown });
  }
}

/** A key as the keyboard gives it to whatever has the focus. */
export const keyPress = (app: AppDriver, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, target?: string): Promise<boolean> =>
  app.eval<boolean>(`shellTest.key(${quote(code)}, ${quote(mods)}${target === undefined ? '' : `, ${quote(target)}`})`);

/** Replaces the text of an input, as typing over its selected text does. */
export const typeInto = (app: AppDriver, selector: string, value: string): Promise<void> => app.eval<void>(`void shellTest.type(${quote(selector)}, ${quote(value)})`);

/** Chooses an option of a select: a press on the control, then on the option. */
export async function chooseOption(app: AppDriver, select: string, value: string): Promise<void> {
  await app.eval(`void shellTest.press(${quote(select)})`);
  await app.waitFor(`shellTest.exists('[data-ui="select-list"] [data-value="${value}"]')`, PAGE_BACKSTOP_MS);
  await app.eval(`void shellTest.press('[data-ui="select-list"] [data-value="${value}"]')`);
  await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
}

/** Dismisses the shell's notices, as a press on each one's cross does. */
export const dismissNotices = (app: AppDriver): Promise<void> =>
  app.eval<void>(`void [...document.querySelectorAll('[data-ui="notice"] [aria-label="Dismiss"]')].forEach((button) => shellTest.press(button))`);

// ---- pictures --------------------------------------------------------------------------------------------------------------

export interface Cut { readonly width: number; readonly height: number; readonly channels: number; readonly data: Uint8Array }

/** The part of a capture that a box of the page covers. */
export function cut(file: string, box: Box, page: { readonly width: number; readonly height: number }): Cut {
  const image = decode(fs.readFileSync(file));
  assert.equal(image.depth, 8, 'the capture is an 8-bit image');
  const scale = image.width / page.width;
  const left = Math.max(0, Math.round(box.x * scale));
  const top = Math.max(0, Math.round(box.y * scale));
  const width = Math.min(image.width - left, Math.round(box.width * scale));
  const height = Math.min(image.height - top, Math.round(box.height * scale));
  const data = new Uint8Array(width * height * image.channels);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * image.channels;
    data.set((image.data as Uint8Array).subarray(from, from + width * image.channels), y * width * image.channels);
  }
  return { width, height, channels: image.channels, data };
}

/** How far two pictures of one size are apart: the mean and the largest difference of a colour channel, in steps of 255. */
export function difference(a: Cut, b: Cut): { readonly mean: number; readonly worst: number; readonly differing: number } {
  assert.deepEqual([a.width, a.height, a.channels], [b.width, b.height, b.channels], 'the two pictures have one size');
  let sum = 0;
  let worst = 0;
  let differing = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.channels === 4 && i % 4 === 3) continue;
    const d = Math.abs(a.data[i]! - b.data[i]!);
    sum += d;
    if (d > worst) worst = d;
    if (d > 8) differing++;
    count++;
  }
  return { mean: sum / count, worst, differing: differing / count };
}

/** How much of a picture is not one flat colour: the share of pixels that differ from its first pixel. */
export function drawnShare(picture: Cut): number {
  let other = 0;
  const pixels = picture.width * picture.height;
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < Math.min(3, picture.channels); c++) {
      if (Math.abs(picture.data[p * picture.channels + c]! - picture.data[c]!) > 6) { other++; break; }
    }
  }
  return other / pixels;
}

export const pageSize = (app: AppDriver): Promise<{ width: number; height: number }> => app.eval(`({ width: window.innerWidth, height: window.innerHeight })`);
