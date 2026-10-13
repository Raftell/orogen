// What the hidden-window tests of the viewport share. Not a test file.
//
// Input is synthesised in the page (testing.md 8.5): `viewportTest` holds what a pointer does over the canvas,
// in CSS pixels from the canvas's top-left, beside the `shellTest` of the shell's rig.

import assert from 'node:assert/strict';
import path from 'node:path';

import { nodes } from '../../../src/core/nodes/index.ts';
import {
  addNode, connect, createRegistry, newDoc, setParam, setSettings,
  type CameraState, type DocDraft, type GraphDoc, type PickResult, type ProjectSettings, type ViewBinding,
} from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { EVALUATION_BACKSTOP_MS, install, PAGE_BACKSTOP_MS, quote, sleep } from '../shell/rig.ts';

export { EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, quote, sleep };

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const REGISTRY = createRegistry(nodes);

export interface NodeSpec {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, string>>;
}

/** A document of the product's nodes under the ids given, made with the commands of runtime.md 4.6. */
export function makeDoc(nodesOf: Readonly<Record<string, NodeSpec>>, view: ViewBinding | undefined, settings: Partial<ProjectSettings> = {}): GraphDoc {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { terrainSize: 4032, heightRange: 1008, buildResolution: 1009, previewLevel: 0, seaLevel: 0, seed: 1, ...settings });
  let row = 0;
  for (const [id, spec] of Object.entries(nodesOf)) {
    const made = addNode(draft, REGISTRY, spec.type, { x: 0, y: 160 * row++ });
    const instance = draft.nodes[made]!;
    delete draft.nodes[made];
    draft.nodes[id] = { ...instance, id };
    for (const [name, value] of Object.entries(spec.params ?? {})) setParam(draft, REGISTRY, id, name, value);
  }
  for (const [id, spec] of Object.entries(nodesOf)) {
    for (const [port, from] of Object.entries(spec.inputs ?? {})) {
      const [node, output] = from.split('.') as [string, string];
      connect(draft, REGISTRY, { node, port: output }, { node: id, port });
    }
  }
  if (view) draft.ui.view = structuredClone(view) as DocDraft['ui']['view'];
  return draft as GraphDoc;
}

const PAGE = `(() => {
  const host = () => {
    const found = document.querySelector('[data-viewport="canvas"]');
    if (!found) throw new Error('The viewport has no canvas host');
    return found;
  };
  const root = () => document.querySelector('[data-viewport="root"]');
  const send = (type, x, y, init = {}) => {
    const rect = host().getBoundingClientRect();
    const Kind = type === 'wheel' ? WheelEvent : type.startsWith('pointer') ? PointerEvent : MouseEvent;
    return host().dispatchEvent(new Kind(type, {
      bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: rect.left + x, clientY: rect.top + y, ...init,
    }));
  };
  const BUTTONS = [1, 4, 2];
  window.viewportTest = {
    size() { const rect = host().getBoundingClientRect(); return { width: rect.width, height: rect.height }; },
    /** A drag over the canvas: press at 'from', move in steps to 'to', release. mods: altKey, shiftKey, ctrlKey. release false keeps the button down. */
    drag(from, to, button = 0, mods = {}, steps = 6, release = true) {
      send('pointerdown', from[0], from[1], { button, buttons: BUTTONS[button], ...mods });
      for (let i = 1; i <= steps; i++) {
        send('pointermove', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, { button: -1, buttons: BUTTONS[button], ...mods });
      }
      if (release) send('pointerup', to[0], to[1], { button, buttons: 0, ...mods });
    },
    release(at, button = 0) { send('pointerup', at[0], at[1], { button, buttons: 0 }); },
    /** The pointer comes to rest over the canvas. */
    hover(x, y) { send('pointermove', x, y, { button: -1, buttons: 0 }); },
    leave() { send('pointerleave', -10, -10, { bubbles: false }); },
    wheel(x, y, deltaY) { send('wheel', x, y, { deltaY }); },
    doubleClick(x, y) { send('dblclick', x, y, { button: 0, buttons: 0, detail: 2 }); },
    /**
     * Where the toolbar's parts end, in pixels from its left edge; 'hidden' for one that takes no room or is cut
     * by the toolbar's edge, 'absent' for one that is not there.
     */
    toolbar() {
      const bar = document.querySelector('[data-viewport="toolbar"]');
      const box = bar.getBoundingClientRect();
      const parts = {
        view: '[data-view="top"]', shading: '[aria-label="Shading"], [aria-label="Top view style"]', overlay: '[data-viewport="overlay"]', sun: '[data-viewport="sun"]',
        scale: '[aria-label="Vertical scale"]', sea: '[data-ui="checkbox"]', frame: '[data-command="viewport.frame"]',
        subject: '[data-viewport="subject"]', state: '[data-viewport="state"]', resolution: '[data-viewport="resolution"]',
      };
      const out = { width: Math.round(box.width) };
      for (const [name, selector] of Object.entries(parts)) {
        const element = bar.querySelector(selector);
        if (!element) { out[name] = 'absent'; continue; }
        const rect = element.getBoundingClientRect();
        const clip = element.closest('[data-viewport="toolbar"] > *').getBoundingClientRect();
        const whole = rect.width > 0 && rect.left >= Math.max(box.left, clip.left) - 0.5 && rect.right <= Math.min(box.right, clip.right) + 0.5;
        out[name] = whole ? Math.round(rect.right - box.left) : 'hidden';
      }
      return out;
    },
    key(type, code, mods = {}) {
      window.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace(/^Key/, '').toLowerCase(), bubbles: true, cancelable: true, ...mods }));
    },
    camera: () => JSON.parse(root().getAttribute('data-camera')),
    attr: (name) => root().getAttribute(name),
    readout() {
      const element = document.querySelector('[data-viewport="readout"]');
      if (!element) return null;
      return { u: Number(element.getAttribute('data-u')), v: Number(element.getAttribute('data-v')), height: Number(element.getAttribute('data-height')), text: element.textContent };
    },
    statusText: () => document.querySelector('[data-viewport="status"]')?.textContent ?? '',
  };
  return true;
})()`;

/** Waits for the frame, installs `shellTest` and `viewportTest`, and waits for the engine's device. */
export async function prepare(app: AppDriver): Promise<void> {
  await install(app);
  await app.waitFor(`document.querySelector('[data-viewport="canvas"] canvas') !== null`, PAGE_BACKSTOP_MS);
  await app.eval(PAGE);
  await app.waitFor(`['ready', 'failed'].includes(orogenTest.ctx.engineState.getState().device.state)`, 60_000);
  assert.equal(await app.eval<string>(`orogenTest.ctx.engineState.getState().device.state`), 'ready');
}

export type ToolbarPart = 'view' | 'shading' | 'overlay' | 'sun' | 'scale' | 'sea' | 'frame' | 'subject' | 'state' | 'resolution';
export type ToolbarLayout = { readonly width: number } & Readonly<Record<ToolbarPart, number | 'hidden' | 'absent'>>;
export const toolbar = (app: AppDriver): Promise<ToolbarLayout> => app.eval<ToolbarLayout>(`viewportTest.toolbar()`);

/**
 * Gives the viewport panel a width and a height (with its tab and toolbar) by the dock's own layout, as dragging
 * the dividers does, and waits until the canvas has followed. The default layout has the viewport above the
 * graph in the left column. A window that is not shown cannot be resized itself: measured, `window.resizeTo`
 * there ends the GPU process.
 */
export async function resizeViewport(app: AppDriver, width: number, height: number): Promise<{ width: number; height: number }> {
  await app.eval(`(() => {
    const saved = JSON.parse(JSON.stringify(orogenTest.shell.layout()));
    const columns = saved.dock.grid.root.data;
    const left = columns.find((column) => column.type === 'branch' && column.data.some((row) => row.data.views.includes('viewport')));
    const right = columns.find((column) => column !== left);
    if (!left || !right) throw new Error('The viewport is not above the graph in a column of its own');
    const rows = left.data;
    const mine = rows.find((row) => row.data.views.includes('viewport')), other = rows.find((row) => row !== mine);
    right.size += left.size - ${width};
    left.size = ${width};
    other.size += mine.size - ${height};
    mine.size = ${height};
    return orogenTest.shell.dock.restore(saved);
  })()`);
  await app.waitFor(`document.querySelector('[data-viewport="canvas"] canvas') !== null && Math.abs(viewportTest.size().width - ${width}) <= 6`, PAGE_BACKSTOP_MS);
  // The engine hears of the size through a ResizeObserver, which a window that is not shown serves about once a second.
  await app.waitFor(`(() => { const size = viewportTest.size(); return viewportTest.attr('data-size') === Math.round(size.width) + ' ' + Math.round(size.height); })()`, PAGE_BACKSTOP_MS);
  return canvasSize(app);
}

/** Loads a document as the application's project and waits until its view is shown and nothing runs. */
export async function show(app: AppDriver, doc: GraphDoc, timeoutMs: number = EVALUATION_BACKSTOP_MS): Promise<void> {
  await app.eval(`void orogenTest.ctx.doc.getState().load(${quote(doc)}, null)`);
  await settled(app, timeoutMs);
}

export async function settled(app: AppDriver, timeoutMs: number = EVALUATION_BACKSTOP_MS): Promise<void> {
  await app.waitFor(`(() => {
    const engine = orogenTest.ctx.engineState.getState();
    return engine.evaluation === null && engine.view !== null && engine.view.revision >= orogenTest.ctx.doc.getState().engineRevision;
  })()`, timeoutMs);
}

/** Changes the view of the document, as a panel does: a transaction that is not undoable. */
export async function setView(app: AppDriver, view: ViewBinding): Promise<void> {
  await app.eval(`void orogenTest.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = ${quote(view)}; }, { undoable: false })`);
  await settled(app);
}

export const run = (app: AppDriver, command: string): Promise<void> => app.eval<void>(`void orogenTest.ctx.run(${quote(command)})`);

/**
 * Runs a command that frames the terrain and waits until the camera has come to rest: the framing asks the engine
 * where the terrain's heights lie and frames again around them, and the engine answers in the order asked.
 */
export async function frame(app: AppDriver, command: 'viewport.frame' | 'viewport.resetView' = 'viewport.frame'): Promise<void> {
  await run(app, command);
  await app.eval(`orogenTest.ctx.engine.inspect(orogenTest.ctx.doc.getState().doc.ui.view?.height ?? { node: '', port: '' })`);
}
export const camera = (app: AppDriver): Promise<CameraState> => app.eval<CameraState>(`viewportTest.camera()`);
export const attr = (app: AppDriver, name: string): Promise<string | null> => app.eval<string | null>(`viewportTest.attr(${quote(name)})`);
export const canvasSize = (app: AppDriver): Promise<{ width: number; height: number }> => app.eval(`viewportTest.size()`);

/** What lies under a point of the canvas, asked of the engine as the panel asks it. It answers when the frame of the camera last set is drawn. */
export const pick = (app: AppDriver, x: number, y: number): Promise<PickResult | null> =>
  app.eval<PickResult | null>(`orogenTest.ctx.engine.viewport.pick(${x}, ${y})`);

/**
 * A capture of the whole window for a person (testing.md 8.5 rule 1): <OROGEN_TEST_OUTPUT>/ui/viewport/<name>.png.
 * The worker has drawn the camera last set when a pick is answered; the light maps are refined over the frames
 * after that, and what capturePage copies of a window that is not shown lags the page, so the picture is taken
 * two page frames and a good second later.
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await pick(app, 1, 1);
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1500);
  return app.capture(`viewport/${name}`);
}
