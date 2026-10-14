// What the hidden-window tests of the inspector share. Not a test file.
//
// A test builds its project with the commands of runtime.md 4.6, writes it into test-output/inspector/ and has
// the application open it. Input is synthesised in the page: `shellTest` of the shell's rig for presses, keys
// and typed text, and `inspectorTest`, installed here, for a pointer that travels between two places of the
// window, which is what dragging a curve's point or a gradient's stop is.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decode, encode } from 'fast-png';

import type { FieldStats } from '../../../src/core/api.ts';
import { nodes } from '../../../src/core/nodes/index.ts';
import {
  createRegistry, newDoc, serializeDoc, setSettings,
  type DocDraft, type GraphDoc, type NodeRegistry, type PortRef, type ViewBinding,
} from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { appears, docked, EVALUATION_BACKSTOP_MS, install, key, PAGE_BACKSTOP_MS, press, quote, ready, sleep, tallest } from '../shell/rig.ts';

export { appears, key, PAGE_BACKSTOP_MS, press, quote, EVALUATION_BACKSTOP_MS };
export { exists, run, vanishes } from '../shell/rig.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'));
/** The projects these tests write. Captures go to <output>/ui/inspector (AppDriver.capture). */
export const FOLDER = path.join(OUTPUT, 'inspector');
export const REGISTRY: NodeRegistry = createRegistry(nodes);

export const PANEL = '[data-panel="inspector"]';
/** The row of a parameter, the number field in it, and the row of a project setting. */
export const row = (name: string): string => `${PANEL} [data-param="${name}"]`;
export const field = (name: string): string => `${row(name)} [data-ui="number-field"]`;
export const setting = (name: string): string => `${PANEL} [data-setting="${name}"]`;

/**
 * A project made with the commands of 4.6 and written where the application opens it. Its build resolution is
 * 1009 and its previews are 505 × 505: the tests wait for many evaluations.
 */
export function project(name: string, build: (draft: DocDraft, registry: NodeRegistry) => void): string {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { buildResolution: 1009, previewLevel: 1 });
  build(draft, REGISTRY);
  fs.mkdirSync(FOLDER, { recursive: true });
  const file = path.join(FOLDER, `${name}.orogen`);
  fs.writeFileSync(file, serializeDoc(draft as GraphDoc));
  return file;
}

/** Runs in the page: a pointer between two places of the window, on the element that takes it. */
const PAGE = `(() => {
  const el = (target) => {
    const found = typeof target === 'string' ? document.querySelector(target) : target;
    if (!found) throw new Error('No element matches ' + target);
    return found;
  };
  const send = (element, type, x, y, init = {}) => element.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
    bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('up') || type.endsWith('click') ? 0 : 1,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, ...init,
  }));
  window.inspectorTest = {
    /** Pointer down at 'from' on the element, moves in steps to 'to', and up there unless release is false. Places are window coordinates. */
    drag(target, from, to, mods = {}, steps = 6, release = true) {
      const element = el(target);
      send(element, 'pointerdown', from.x, from.y, mods);
      for (let step = 1; step <= steps; step++) {
        send(element, 'pointermove', from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, mods);
      }
      if (release) send(element, 'pointerup', to.x, to.y, mods);
    },
    /** The same for a control that listens to the mouse and not to the pointer (the color picker): both kinds of event, in the order a browser sends them. */
    mouseDrag(target, from, to, steps = 6) {
      const element = el(target);
      send(element, 'pointerdown', from.x, from.y);
      send(element, 'mousedown', from.x, from.y);
      for (let step = 1; step <= steps; step++) {
        const x = from.x + ((to.x - from.x) * step) / steps;
        const y = from.y + ((to.y - from.y) * step) / steps;
        send(element, 'pointermove', x, y);
        send(element, 'mousemove', x, y);
      }
      send(element, 'pointerup', to.x, to.y);
      send(element, 'mouseup', to.x, to.y);
    },
    move(target, to, mods = {}) { send(el(target), 'pointermove', to.x, to.y, mods); },
    up(target, at) { send(el(target), 'pointerup', at.x, at.y); },
    /** A press and release at one place: what a click on a canvas or a plot is. */
    click(target, at) {
      const element = el(target);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) send(element, type, at.x, at.y);
    },
    doubleClick(target, at) {
      const element = el(target);
      for (let i = 0; i < 2; i++) for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) send(element, type, at.x, at.y, { detail: i + 1 });
      send(element, 'dblclick', at.x, at.y, { detail: 2 });
    },
    /** The pointer comes onto the element, as it does before anything is pressed there. */
    enter(target) {
      const element = el(target);
      const r = element.getBoundingClientRect();
      for (const type of ['pointerover', 'pointerenter']) send(element, type, r.left + r.width / 2, r.top + r.height / 2, { bubbles: type !== 'pointerenter', buttons: 0 });
    },
    rect(target) { const r = el(target).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
    /** Brings a row into the part of the panel that is seen. */
    reveal(target) { el(target).scrollIntoView({ block: 'center' }); return true; },
  };
  return true;
})()`;

/**
 * Lets the 600 ms pass within which two edits of one parameter are one history entry (runtime.md 8.5 rule 3):
 * a test that counts the entries of two edits of one parameter puts this between them.
 */
export const apart = (): Promise<void> => sleep(700);

export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export const rectOf = (app: AppDriver, selector: string): Promise<Rect> => app.eval<Rect>(`inspectorTest.rect(${quote(selector)})`);
/** The width a number field takes for the range of a drag across it. */
export const widthOf = (app: AppDriver, selector: string): Promise<number> => app.eval<number>(`shellTest.el(${quote(selector)}).clientWidth`);

/**
 * Runs `body` on an application that has opened `file`, with the inspector in front and the engine ready, and
 * closes it. close() rejects for any error the application reported (testing.md 8.5 rule 3); when the body has
 * failed already, its failure is the one to read.
 */
export async function withProject(file: string | null, body: (app: AppDriver) => Promise<void>): Promise<void> {
  const app = await launchApp({ profile: 'core', ...(file === null ? {} : { open: file }) });
  try {
    await install(app);
    await app.eval(PAGE);
    await ready(app);
    await docked(app);
    await appears(app, `${PANEL} [data-inspector]`);
    // What these tests look at is the panel: it gets all the height of its column, of which the default layout gives it the larger half.
    await tallest(app, 'inspector');
    await body(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
}

export const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
export const paramOf = async <T>(app: AppDriver, node: string, name: string): Promise<T> => (await docOf(app)).nodes[node]!.params[name] as T;

export interface Entry { readonly label: string; readonly mergeKey: string | null }
/** The history, oldest first. */
export const past = (app: AppDriver): Promise<Entry[]> =>
  app.eval<Entry[]>(`orogenTest.ctx.doc.getState().past.map((entry) => ({ label: entry.label, mergeKey: entry.mergeKey }))`);
export const future = (app: AppDriver): Promise<number> => app.eval<number>(`orogenTest.ctx.doc.getState().future.length`);
export const undo = (app: AppDriver): Promise<void> => app.eval<void>(`void orogenTest.ctx.doc.getState().undo()`);
export const redo = (app: AppDriver): Promise<void> => app.eval<void>(`void orogenTest.ctx.doc.getState().redo()`);

/**
 * Selects nodes, and then shows `view` (the view is no undo step: runtime.md 8.5 rule 5). The view is set after
 * the selection, in a call of its own: a graph panel that lets the view follow the selection has done so by
 * then, and what the test asked for is what is shown.
 */
export async function select(app: AppDriver, ids: readonly string[], view?: ViewBinding): Promise<void> {
  await app.eval(`void orogenTest.ctx.ui.setState({ selection: ${quote(ids)} })`);
  if (view !== undefined) {
    await app.eval(`void orogenTest.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = ${quote(view)}; }, { undoable: false })`);
  }
  await app.waitFor(`document.querySelector(${quote(`${PANEL} [data-inspector]`)}) !== null`, PAGE_BACKSTOP_MS);
}

/** Waits until the document as the engine was last sent it is shown and nothing runs. */
export async function settled(app: AppDriver): Promise<void> {
  try {
    await app.waitFor(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      const doc = orogenTest.ctx.doc.getState();
      return doc.gesture === null && engine.evaluation === null && engine.view !== null && !engine.view.draft && engine.view.revision >= doc.engineRevision;
    })()`, EVALUATION_BACKSTOP_MS);
  } catch (thrown) {
    // What the engine was at when the wait gave up: the failure then says which of the conditions did not come.
    const state = await app.eval<object>(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      const doc = orogenTest.ctx.doc.getState();
      return { gesture: doc.gesture, engineRevision: doc.engineRevision, view: engine.view, evaluation: engine.evaluation, device: engine.device.state, shows: doc.doc.ui.view ?? null };
    })()`).catch(() => null);
    throw new Error(`The engine did not settle: ${JSON.stringify(state)}`, { cause: thrown });
  }
}

/** What the engine computed for a node: the key of its content, which changes exactly when its picture does (runtime.md 5.4). */
export const contentKey = (app: AppDriver, node: string): Promise<string | undefined> =>
  app.eval<string | undefined>(`orogenTest.ctx.engineState.getState().keys[${quote(node)}]`);
export const inspect = (app: AppDriver, ref: PortRef): Promise<FieldStats | null> =>
  app.eval<FieldStats | null>(`orogenTest.ctx.engine.inspect(${quote(ref)})`);
export const nodeState = (app: AppDriver, node: string): Promise<string> =>
  app.eval<string>(`orogenTest.ctx.engineState.getState().nodes[${quote(node)}]?.state ?? 'none'`);

/** Statistics of one field on one adapter, computed twice, agree to the last digits a float prints. */
export function differs(a: FieldStats | null, b: FieldStats | null): boolean {
  return a !== null && b !== null && (['min', 'max', 'mean'] as const).some((name) => Math.abs(a[name] - b[name]) > 1e-6);
}

/** Clicks a number field, replaces the text of its entry and presses Enter. */
export async function enter(app: AppDriver, selector: string, text: string): Promise<void> {
  await press(app, selector);
  await appears(app, `${selector} input`);
  await app.eval(`void shellTest.type(${quote(`${selector} input`)}, ${quote(text)})`);
  await key(app, 'Enter', {}, `${selector} input`);
}

/** A horizontal drag across an element, from its centre: what scrubbing a number field is. */
export const scrub = (app: AppDriver, selector: string, dx: number, mods: object = {}, release = true): Promise<void> =>
  app.eval<void>(`void shellTest.drag(${quote(selector)}, ${dx}, ${JSON.stringify(mods)}, 8, ${release})`);

export const textOf = (app: AppDriver, selector: string): Promise<string> => app.eval<string>(`shellTest.text(${quote(selector)})`);
export const attrOf = (app: AppDriver, selector: string, name: string): Promise<string | null> =>
  app.eval<string | null>(`shellTest.attr(${quote(selector)}, ${quote(name)})`);
export const count = (app: AppDriver, selector: string): Promise<number> => app.eval<number>(`shellTest.count(${quote(selector)})`);

/** Chooses an option of a select of the inspector: a press on the control, then on the option. */
export async function choose(app: AppDriver, selector: string, value: string): Promise<void> {
  await press(app, `${selector} [data-ui="select"]`);
  await appears(app, `[data-ui="select-list"] [data-value="${value}"]`);
  await press(app, `[data-ui="select-list"] [data-value="${value}"]`);
  await app.waitFor(`!shellTest.exists('[data-ui="select-list"]')`, PAGE_BACKSTOP_MS);
}

/**
 * A capture for a person (testing.md 8.5 rule 1): the whole window as <output>/ui/inspector/<name>.png and the
 * inspector alone, which is what these pictures are about, as <name>-panel.png. A window that was never shown
 * draws about once a second and capturePage copies the frame before the newest, so the picture is taken when the
 * page has drawn two frames and a further second has passed (tests/ui/shell/rig.ts).
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1200);
  const file = await app.capture(`inspector/${name}`);
  const panel = await rectOf(app, PANEL);
  const view = await app.eval<{ width: number; height: number }>(`({ width: window.innerWidth, height: window.innerHeight })`);
  const image = decode(fs.readFileSync(file));
  assert.ok(image.width > 0 && image.height > 0 && image.depth === 8, 'the capture is an 8-bit image');
  const scale = image.width / view.width;
  const left = Math.max(0, Math.round(panel.x * scale));
  const top = Math.max(0, Math.round(panel.y * scale));
  const width = Math.min(image.width - left, Math.round(panel.width * scale));
  const height = Math.min(image.height - top, Math.round(panel.height * scale));
  const channels = image.channels;
  const cut = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * channels;
    cut.set((image.data as Uint8Array).subarray(from, from + width * channels), y * width * channels);
  }
  const cropped = file.replace(/\.png$/, '-panel.png');
  fs.writeFileSync(cropped, encode({ width, height, data: cut, channels, depth: 8 }));
  return cropped;
}
