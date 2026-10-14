// What the hidden-window tests of the library panel share. Not a test file.
//
// The input functions of the shell's rig (`shellTest`) are installed in the page, and beside them `libraryTest`:
// a double-click and an HTML drag, which the shell's tests do not need. A drag is synthesised with a real
// DataTransfer, so that what the library puts into it is what a drop target reads.

import type { GraphDoc } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { appears, docked, install as installShell, PAGE_BACKSTOP_MS, panelSize, quote, ready, sleep, tallest } from '../shell/rig.ts';

export { PAGE_BACKSTOP_MS, EVALUATION_BACKSTOP_MS, appears, vanishes, exists, key, press, quote, run, settled, sleep, withApp, openMenu, closeMenu, choose } from '../shell/rig.ts';

const PAGE = `(() => {
  const el = (target) => {
    const found = typeof target === 'string' ? document.querySelector(target) : target;
    if (!found) throw new Error('No element matches ' + target);
    return found;
  };
  const centre = (element) => {
    const rect = element.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  };
  const api = {
    /** What the page was asked to add (runtime.md 8.7): the detail of every orogen:add-node event, in order. */
    added: [],
    /** A press twice, then the double-click the browser makes of them. */
    doubleClick(target) {
      const element = el(target);
      shellTest.press(element);
      shellTest.press(element);
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, detail: 2, ...centre(element) }));
    },
    /**
     * The start of a drag on the element. Returns what the element put into the drag; the drag stays open for
     * dropOn. A DataTransfer that a script made is not one of a drag, and Chromium then ignores what is assigned
     * to its effectAllowed (measured: it stays 'none'): the assignment is kept on the object itself.
     */
    dragStart(target) {
      const element = el(target);
      const data = new DataTransfer();
      let effect = 'uninitialized';
      Object.defineProperty(data, 'effectAllowed', { configurable: true, get: () => effect, set: (value) => { effect = value; } });
      const started = element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, dataTransfer: data, ...centre(element) }));
      api.drag = data;
      return { started, types: [...data.types], node: data.getData('application/x-orogen-node'), text: data.getData('text/plain'), effectAllowed: effect };
    },
    /** The drag that dragStart began enters the element, moves over a point of it and is dropped there. Returns whether a target accepted it. */
    dropOn(target, fx = 0.5, fy = 0.5) {
      const element = el(target);
      const rect = element.getBoundingClientRect();
      const at = { clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy };
      const at_point = document.elementFromPoint(at.clientX, at.clientY) ?? element;
      const send = (type) => at_point.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: api.drag, ...at }));
      send('dragenter');
      const accepted = !send('dragover');
      if (accepted) send('drop');
      else send('dragleave');
      return { accepted, at, over: at_point.closest('[data-panel]')?.getAttribute('data-panel') ?? null };
    },
    /** The pointer moves to a point of the element: its center, or fx, fy of its size from its top left corner. */
    moveOn(target, fx = 0.5, fy = 0.5) {
      const element = el(target);
      const rect = element.getBoundingClientRect();
      const at = { clientX: Math.round(rect.left + rect.width * fx), clientY: Math.round(rect.top + rect.height * fy) };
      for (const type of ['pointermove', 'mousemove']) {
        element.dispatchEvent(new (type === 'pointermove' ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
      }
      return at;
    },
    /** A move at a given position of the window, on the element: what a list that scrolls under a resting pointer sends its new row. */
    moveAt(target, at) {
      el(target).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
    },
    /** The pointer leaves one element for another. */
    leave(from, to) {
      const source = el(from), target = el(to);
      for (const type of ['pointerout', 'mouseout']) source.dispatchEvent(new (type === 'pointerout' ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, relatedTarget: target, ...centre(source) }));
      for (const type of ['pointerover', 'mouseover']) target.dispatchEvent(new (type === 'pointerover' ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, relatedTarget: source, ...centre(target) }));
      api.moveOn(target);
    },
    /** A vertical drag of the element by dy pixels, in steps, with the primary button. */
    dragY(target, dy, steps = 6) {
      const element = el(target);
      const from = centre(element);
      const send = (type, clientY, buttons) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: from.clientX, clientY,
      }));
      send('pointerdown', from.clientY, 1);
      for (let step = 1; step <= steps; step++) send('pointermove', from.clientY + (dy * step) / steps, 1);
      send('pointerup', from.clientY + dy, 0);
    },
    /** The rows of the node list as the page shows them. */
    rows: () => [...document.querySelectorAll('[data-library="list"] [role="option"]')].map((row) => ({
      section: row.getAttribute('data-section'),
      node: row.getAttribute('data-node'),
      title: (row.querySelector('[class*="nodeTitle"], [class*="sectionTitle"]') ?? row).textContent,
      match: row.querySelector('[data-library="match"]')?.textContent ?? null,
      selected: row.getAttribute('aria-selected') === 'true',
      open: row.getAttribute('aria-expanded'),
    })),
    /** What the panel keeps for the next run: its entry of the preferences file (runtime.md 8.6), written a moment after it changes. */
    state: () => orogenTest.ctx.platform.getPreferences().then((preferences) => preferences.panels.library ?? null),
  };
  window.addEventListener('orogen:add-node', (event) => api.added.push(event.detail));
  window.libraryTest = api;
  return true;
})()`;

/** Waits for the frame and installs `shellTest` and `libraryTest` in the page. */
export async function install(app: AppDriver): Promise<void> {
  await installShell(app);
  await app.eval(PAGE);
}

export const pressTab = (app: AppDriver, title: string): Promise<void> =>
  app.eval<void>(`void shellTest.press([...document.querySelectorAll('.dv-tab')].find((tab) => tab.textContent === ${quote(title)}))`);

/**
 * The application with a device and its dock, and the Library panel in front of its group with all the height
 * of its column: what these tests look at is the panel, and the default layout gives it less than half the
 * column (tests/ui/shell/layout.test.ts looks at that).
 */
export async function showLibrary(app: AppDriver): Promise<void> {
  await ready(app);
  await docked(app);
  await pressTab(app, 'Library');
  await appears(app, '[data-panel="library"] [data-library="root"]');
  await tallest(app, 'library');
}

/** Waits until the preferences file holds `value` as `member` of the library's entry; `null` also for an entry that is not there. */
export async function keeps(app: AppDriver, member: 'tab' | 'collapsed' | 'recent' | 'detailsHeight', value: unknown): Promise<void> {
  await app.waitFor(`libraryTest.state().then((kept) => JSON.stringify(kept?.[${quote(member)}] ?? null) === ${quote(JSON.stringify(value ?? null))})`, PAGE_BACKSTOP_MS);
}

export interface ListRow {
  readonly section: string | null;
  readonly node: string | null;
  readonly title: string;
  readonly match: string | null;
  readonly selected: boolean;
  readonly open: string | null;
}
export const rows = (app: AppDriver): Promise<ListRow[]> => app.eval<ListRow[]>(`libraryTest.rows()`);
export const added = (app: AppDriver): Promise<{ type: string }[]> => app.eval<{ type: string }[]>(`libraryTest.added`);
export const docOf = (app: AppDriver): Promise<GraphDoc> => app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
export const typeInto = (app: AppDriver, selector: string, text: string): Promise<void> => app.eval<void>(`void shellTest.type(${quote(selector)}, ${quote(text)})`);
export const focus = (app: AppDriver, selector: string): Promise<void> => app.eval<void>(`void shellTest.focus(${quote(selector)})`);
export const text = (app: AppDriver, selector: string): Promise<string> => app.eval<string>(`shellTest.text(${quote(selector)})`);
export const height = (app: AppDriver, selector: string): Promise<number> => app.eval<number>(`shellTest.rect(${quote(selector)}).height`);

/** Gives the column of the Library panel a width, as a drag of the sash beside it does, and returns the width the panel has then. */
export async function setLibraryWidth(app: AppDriver, width: number): Promise<number> {
  await appears(app, '[data-panel="library"] [data-library="root"]');
  return (await panelSize(app, 'library', { width })).width;
}

/**
 * A capture for a person (testing.md 8.5 rule 1), under ui/library/. Taken as the shell's rig takes one: when the
 * page has drawn two frames after what the test did and a further second has passed, because a window that was
 * never shown draws about once a second and capturePage copies the frame before the newest.
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1200);
  return app.capture(`library/${name}`);
}
