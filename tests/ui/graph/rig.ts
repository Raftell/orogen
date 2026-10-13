// What the hidden-window tests of the graph panel share. Not a test file.
//
// Input is synthesised in the page (testing.md 8.5): `graphTest` holds the pointer as a person does. A press, a
// move and a release each go to the element under the point, as a pointer event and as the mouse event that
// follows it, because the node-graph library listens to both kinds: to pointer events for the selection box and
// to mouse events for dragging nodes, panning and connecting.

import assert from 'node:assert/strict';
import path from 'node:path';

import type { GraphDoc } from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { install as installShell, PAGE_BACKSTOP_MS, quote, sleep } from '../shell/rig.ts';

export { appears, docked, EVALUATION_BACKSTOP_MS, PAGE_BACKSTOP_MS, quote, ready, run, settled, sleep, vanishes } from '../shell/rig.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Files these tests write: <OROGEN_TEST_OUTPUT>/graph-panel. Captures go to <OROGEN_TEST_OUTPUT>/ui/graph. */
export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'graph-panel');

export interface Point { readonly x: number; readonly y: number }
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Runs in the page. Coordinates are client pixels. */
const PAGE = `(() => {
  const fire = (target, type, x, y, init = {}) => {
    const Event = type.startsWith('pointer') ? PointerEvent : type === 'wheel' ? WheelEvent : MouseEvent;
    return target.dispatchEvent(new Event(type, {
      bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init,
    }));
  };
  const under = (x, y) => document.elementFromPoint(x, y) ?? document.body;
  // An element that captures the pointer gets its moves and its release wherever the pointer is: the selection
  // box does. A synthesised event is not routed by the capture, so the rig routes it.
  let captured = null;
  const capture = Element.prototype.setPointerCapture;
  const release = Element.prototype.releasePointerCapture;
  Element.prototype.setPointerCapture = function (id) { capture.call(this, id); captured = this; };
  Element.prototype.releasePointerCapture = function (id) { if (captured === this) captured = null; release.call(this, id); };
  const aimed = (x, y) => (captured && captured.isConnected ? captured : under(x, y));
  const held = (button) => (button === 1 ? 4 : button === 2 ? 2 : 1);
  const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const one = (selector) => {
    const found = document.querySelector(selector);
    if (!found) throw new Error('No element matches ' + selector);
    return found;
  };
  const api = {
    under: (x, y) => { const e = under(x, y); return e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : ''); },
    box: (selector) => box(one(selector)),
    centre: (selector) => { const r = one(selector).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
    /** The pointer moves without a button held: what the graph takes for where the pointer is. */
    hover(x, y) { const t = under(x, y); fire(t, 'pointermove', x, y); fire(t, 'mousemove', x, y); },
    down(x, y, init = {}) {
      const t = under(x, y);
      const buttons = held(init.button ?? 0);
      fire(t, 'pointerdown', x, y, { ...init, buttons });
      fire(t, 'mousedown', x, y, { ...init, buttons });
    },
    move(x, y, init = {}) {
      const t = aimed(x, y);
      const buttons = held(init.button ?? 0);
      fire(t, 'pointermove', x, y, { ...init, buttons });
      fire(t, 'mousemove', x, y, { ...init, buttons });
    },
    /** click: the release is followed by the click a press and a release on one spot make. */
    up(x, y, init = {}, click = false) {
      const t = aimed(x, y);
      fire(t, 'pointerup', x, y, init);
      fire(t, 'mouseup', x, y, init);
      captured = null;
      if (click) fire(t, 'click', x, y, init);
    },
    click(x, y, init = {}) { api.down(x, y, init); api.up(x, y, init, true); },
    doubleClick(x, y) { api.click(x, y); api.click(x, y); fire(under(x, y), 'dblclick', x, y); },
    /** A press of the secondary button: what opens a context menu. */
    secondary(x, y, init = {}) {
      const t = under(x, y);
      fire(t, 'pointerdown', x, y, { ...init, button: 2, buttons: 2 });
      fire(t, 'mousedown', x, y, { ...init, button: 2, buttons: 2 });
      fire(t, 'contextmenu', x, y, { ...init, button: 2, buttons: 2 });
      fire(t, 'pointerup', x, y, { ...init, button: 2 });
      fire(t, 'mouseup', x, y, { ...init, button: 2 });
    },
    /**
     * A drag from one point to another in steps; release false keeps the button down. It begins as a hand does,
     * with a move of a few pixels: the library takes a node along from where the pointer is when it has moved
     * past its threshold, so a first move of many pixels would leave the node that far behind.
     */
    drag(from, to, init = {}, steps = 8, release = true) {
      api.down(from.x, from.y, init);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length > 6) api.move(from.x + ((to.x - from.x) * 3) / length, from.y + ((to.y - from.y) * 3) / length, init);
      for (let step = 1; step <= steps; step++) {
        api.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, init);
      }
      if (release) api.up(to.x, to.y, init);
    },
    wheel(x, y, deltaY, init = {}) { fire(under(x, y), 'wheel', x, y, { deltaY, deltaMode: 0, ...init }); },
    /** A key goes down and stays down, as a modifier of what the pointer does next. */
    keyDown(code, key, init = {}) { document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, composed: true, ...init })); },
    keyUp(code, key, init = {}) { document.body.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true, cancelable: true, composed: true, ...init })); },
    /** A clipboard event at the graph panel with a clipboard of its own. Returns the text the panel put there, and whether it took the event. */
    clipboard(type, text) {
      const data = new DataTransfer();
      if (typeof text === 'string') data.setData('text/plain', text);
      const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
      one('[data-panel="graph"]').dispatchEvent(event);
      return { taken: event.defaultPrevented, text: data.getData('text/plain') };
    },
    /** A drag from the library that ends over the graph: dragover, then drop (runtime.md 8.7). */
    libraryDrop(type, x, y) {
      const data = new DataTransfer();
      data.setData('application/x-orogen-node', type);
      data.effectAllowed = 'copy';
      const t = under(x, y);
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data };
      const over = new DragEvent('dragover', init);
      t.dispatchEvent(over);
      t.dispatchEvent(new DragEvent('drop', init));
      return over.defaultPrevented;
    },
    /** Where things of the graph are on the screen. */
    node: (id) => box(one('[data-node="' + CSS.escape(id) + '"]')),
    port(id, side, name) {
      const r = one('[data-node="' + CSS.escape(id) + '"] .react-flow__handle[data-side="' + side + '"][data-port="' + CSS.escape(name) + '"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    title(id) { const r = one('[data-node="' + CSS.escape(id) + '"] [data-role="title"]').getBoundingClientRect(); return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 }; },
    /** The middle of a wire, on the screen. */
    wire(id) {
      const path = one('.react-flow__edge[data-id="e-' + encodeURIComponent(id) + '"] path');
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM();
      return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    },
    /** The title bar of a group: what it is dragged by. */
    group(id) { const r = one('[data-group="' + CSS.escape(id) + '"] [data-group-drag]').getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }; },
    groupBox: (id) => box(one('[data-group="' + CSS.escape(id) + '"]')),
    /** The transform the library draws the graph with. */
    drawn() {
      const found = /translate\\(([-0-9.e]+)px, ?([-0-9.e]+)px\\) scale\\(([-0-9.e]+)\\)/.exec(one('[data-graph="root"] .react-flow__viewport').style.transform);
      return found ? { x: Number(found[1]), y: Number(found[2]), zoom: Number(found[3]) } : null;
    },
    lod: () => one('[data-graph="root"]').getAttribute('data-lod'),
    graph: () => box(one('[data-graph="root"]')),
    viewport: () => orogenTest.ctx.doc.getState().doc.ui.graphViewport ?? null,
  };
  window.graphTest = api;
  return true;
})()`;

/** Waits for the frame, installs `shellTest` and `graphTest`, and waits for the graph to be mounted. */
export async function install(app: AppDriver): Promise<void> {
  await installShell(app);
  await app.eval(PAGE);
  await app.waitFor(`document.querySelector('[data-graph="root"] .react-flow__pane') !== null`, PAGE_BACKSTOP_MS);
}

/**
 * Waits until the graph has the place the dock gave it and its viewport has come to rest in the document: the
 * library learns the size of its panel a frame after the panel has it, which in a window that was never shown
 * is up to a second, and a project that brings no viewport is fitted again then.
 */
export async function graphSettled(app: AppDriver): Promise<void> {
  await app.waitFor(`(() => {
    const root = document.querySelector('[data-graph="root"]');
    const rect = root.getBoundingClientRect();
    if (rect.width === 0 || root.getAttribute('data-size') !== Math.round(rect.width) + 'x' + Math.round(rect.height)) return false;
    const drawn = /translate\\(([-0-9.e]+)px, ?([-0-9.e]+)px\\) scale\\(([-0-9.e]+)\\)/.exec(root.querySelector('.react-flow__viewport').style.transform);
    const held = graphTest.viewport();
    return drawn !== null && held !== null && Math.abs(drawn[1] - held.x) < 0.01 && Math.abs(drawn[2] - held.y) < 0.01 && Math.abs(drawn[3] - held.zoom) < 0.0001;
  })()`, PAGE_BACKSTOP_MS);
}

/**
 * Runs `body` on a launched application whose page has `shellTest` and `graphTest`, and closes it. close()
 * rejects for any error the application reported (testing.md 8.5 rule 3); when the body has failed already, its
 * failure is the one to read.
 */
export async function withApp(opts: { readonly open?: string }, body: (app: AppDriver) => Promise<void>): Promise<void> {
  const app = await launchApp({ profile: 'core', ...opts });
  try {
    await install(app);
    await body(app);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
}

export const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
export const selection = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`[...orogenTest.ctx.ui.getState().selection]`);
export const history = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`orogenTest.ctx.doc.getState().past.map((entry) => entry.label)`);
export const graphBox = (app: AppDriver): Promise<Box> => app.eval<Box>(`graphTest.graph()`);
export const nodeBox = (app: AppDriver, id: string): Promise<Box> => app.eval<Box>(`graphTest.node(${quote(id)})`);
export const port = (app: AppDriver, id: string, side: 'in' | 'out', name: string): Promise<Point> => app.eval<Point>(`graphTest.port(${quote(id)}, ${quote(side)}, ${quote(name)})`);
export const titleOf = (app: AppDriver, id: string): Promise<Point> => app.eval<Point>(`graphTest.title(${quote(id)})`);
export const attr = (app: AppDriver, selector: string, name: string): Promise<string | null> =>
  app.eval<string | null>(`document.querySelector(${quote(selector)})?.getAttribute(${quote(name)}) ?? null`);
export const text = (app: AppDriver, selector: string): Promise<string | null> => app.eval<string | null>(`document.querySelector(${quote(selector)})?.textContent ?? null`);
export const nodeSelector = (id: string): string => `[data-node="${id}"]`;
export const wireAt = (app: AppDriver, edgeId: string): Promise<Point> => app.eval<Point>(`graphTest.wire(${quote(edgeId)})`);
export const drawn = (app: AppDriver): Promise<{ x: number; y: number; zoom: number }> => app.eval(`graphTest.drawn()`);
export const wires = async (app: AppDriver): Promise<string[]> =>
  Object.values((await docOf(app)).edges).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`).sort();
/** The items of the menu that is open: the id of each, and whether it can be chosen. */
export const menuItems = (app: AppDriver): Promise<{ id: string | null; label: string; enabled: boolean }[]> =>
  app.eval(`[...document.querySelectorAll('[data-ui="menu"]')].at(-1) ? [...[...document.querySelectorAll('[data-ui="menu"]')].at(-1).querySelectorAll('.og-menu-item')].map((item) => ({
    id: item.getAttribute('data-item'), label: item.querySelector('.og-menu-item-label').textContent, enabled: !item.hasAttribute('data-disabled'),
  })) : []`);
export const secondary = (app: AppDriver, at: Point, init: object = {}): Promise<void> => app.eval<void>(`void graphTest.secondary(${at.x}, ${at.y}, ${quote(init)})`);
/** Chooses an item of the open menu by its id. */
export async function chooseItem(app: AppDriver, id: string): Promise<void> {
  await app.waitFor(`shellTest.exists('[data-ui="menu"] [data-item="${id}"]')`, PAGE_BACKSTOP_MS);
  await app.eval(`void shellTest.press('[data-ui="menu"] [data-item="${id}"]')`);
  await app.waitFor(`!shellTest.exists('[data-ui="menu"]')`, PAGE_BACKSTOP_MS);
}
export const undo = (app: AppDriver): Promise<void> => key(app, 'KeyZ', { ctrl: true });
export const redo = (app: AppDriver): Promise<void> => key(app, 'KeyZ', { ctrl: true, shift: true });

export const click = (app: AppDriver, at: Point, init: object = {}): Promise<void> => app.eval<void>(`void graphTest.click(${at.x}, ${at.y}, ${quote(init)})`);
export const drag = (app: AppDriver, from: Point, to: Point, init: object = {}, steps = 8, release = true): Promise<void> =>
  app.eval<void>(`void graphTest.drag(${quote(from)}, ${quote(to)}, ${quote(init)}, ${steps}, ${release})`);
/** A key by its code on whatever has the focus, as the shell's one key listener hears it. */
export const key = (app: AppDriver, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, target?: string): Promise<void> =>
  app.eval<void>(`void shellTest.key(${quote(code)}, ${quote(mods)}${target === undefined ? '' : `, ${quote(target)}`})`);

/** The graph has the focus of the application: its keys run its commands (runtime.md 8.8 rule 3). */
export async function focusGraph(app: AppDriver): Promise<void> {
  await app.eval(`void (orogenTest.ctx.ui.setState({ focusedPanel: 'graph' }), document.querySelector('[data-panel="graph"]').focus())`);
}

/** The ids of the nodes the document holds that `before` did not. */
export async function added(app: AppDriver, before: GraphDoc): Promise<string[]> {
  return Object.keys((await docOf(app)).nodes).filter((id) => !Object.hasOwn(before.nodes, id));
}

/**
 * A capture of the whole window, written for a person (testing.md 8.5 rule 1); no test looks at its pixels. A
 * window that was never shown draws about once a second, so the picture is taken two frames and a second after
 * what the test did.
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1200);
  return app.capture(`graph/${name}`);
}

/** Two numbers are the same but for what a screen pixel and a zoom make of them. */
export function near(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);
}
