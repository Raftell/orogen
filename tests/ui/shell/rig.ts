// What the hidden-window tests of the shell share. Not a test file.
//
// Input is synthesised in the page: a window that is never shown gets none from the desktop. The functions of
// PAGE are installed in the page once per launch, as `shellTest`, and a test calls them through `AppDriver.eval`.
// A window that was never shown does not have the system's focus, so Chromium dispatches no focus events in it:
// where a control acts on losing the focus, the test says so with `shellTest.blur`.

import assert from 'node:assert/strict';
import path from 'node:path';

import type { GpuCaps } from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Files these tests write: <OROGEN_TEST_OUTPUT>/shell. Captures go to <OROGEN_TEST_OUTPUT>/ui/shell (AppDriver.capture). */
export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'shell');
/** Backstops: an evaluation of a small document, and the page doing what an input asked for. */
export const EVALUATION_BACKSTOP_MS = 60_000;
export const PAGE_BACKSTOP_MS = 15_000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const quote = (value: unknown): string => JSON.stringify(value);

/** Runs in the page. Every function takes a selector or an element. */
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
  const mouse = (element, type, init) => element.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
    bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('up') || type === 'click' ? 0 : 1,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, ...centre(element), ...init,
  }));
  const KEYS = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backquote: '\`', Comma: ',', Space: ' ', Home: 'Home', End: 'End' };
  const api = {
    el,
    exists: (selector) => document.querySelector(selector) !== null,
    count: (selector) => document.querySelectorAll(selector).length,
    text: (target) => el(target).textContent,
    texts: (selector) => [...document.querySelectorAll(selector)].map((element) => element.textContent),
    attr: (target, name) => el(target).getAttribute(name),
    rect: (target) => { const r = el(target).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
    /** A press of the primary button on the element: what a click is made of. */
    press(target, init = {}) {
      const element = el(target);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) mouse(element, type, init);
    },
    /** A press of the secondary button: what opens a context menu. */
    secondary(target) {
      const element = el(target);
      mouse(element, 'pointerdown', { button: 2, buttons: 2 });
      mouse(element, 'mousedown', { button: 2, buttons: 2 });
      mouse(element, 'contextmenu', { button: 2, buttons: 2 });
      mouse(element, 'pointerup', { button: 2 });
      mouse(element, 'mouseup', { button: 2 });
    },
    /** A horizontal drag from the element's centre, in steps. mods holds shiftKey and ctrlKey for every step; release false keeps the button down. */
    drag(target, dx, mods = {}, steps = 8, release = true) {
      const element = el(target);
      const from = centre(element);
      mouse(element, 'pointerdown', { ...mods });
      for (let step = 1; step <= steps; step++) {
        mouse(element, 'pointermove', { ...mods, clientX: from.clientX + (dx * step) / steps, movementX: dx / steps });
      }
      if (release) mouse(element, 'pointerup', { ...mods, clientX: from.clientX + dx });
    },
    release(target) { mouse(el(target), 'pointerup', {}); },
    /** The pointer comes to rest on the element: what opens a submenu or a tooltip. */
    hover(target) {
      const element = el(target);
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(element, type, { bubbles: !type.endsWith('enter'), buttons: 0 });
    },
    /** A key by its KeyboardEvent.code, with the modifiers named, on the element that has the focus or the one given. */
    key(code, mods = {}, target) {
      const element = target ? el(target) : (document.activeElement ?? document.body);
      const letter = /^Key([A-Z])$/.exec(code);
      const digit = /^Digit([0-9])$/.exec(code);
      const key = letter ? (mods.shift ? letter[1] : letter[1].toLowerCase()) : digit ? digit[1] : KEYS[code] ?? code;
      const init = { code, key, bubbles: true, cancelable: true, composed: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta };
      const went = element.dispatchEvent(new KeyboardEvent('keydown', init));
      element.dispatchEvent(new KeyboardEvent('keyup', init));
      return went;
    },
    /** Replaces the text of an input as typing does: React hears the input event. */
    type(target, text) {
      const element = el(target);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    focus(target) {
      const element = el(target);
      element.focus();
      element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    },
    blur(target) {
      el(target).dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    },
    wheel(target, deltaY, mods = {}) {
      el(target).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, ...centre(el(target)) }));
    },
  };
  window.shellTest = api;
  return true;
})()`;

/** Waits for the frame and installs `shellTest` in the page. */
export async function install(app: AppDriver): Promise<void> {
  await app.waitFor(`typeof orogenTest === 'object' && document.querySelector('[data-ui="shell"]') !== null`, PAGE_BACKSTOP_MS);
  await app.eval(PAGE);
}

/**
 * Runs `body` on a launched application whose page has `shellTest`, and closes it. close() rejects for any error
 * the application reported (testing.md 8.5 rule 3); when the body has failed already, its failure is the one to read.
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

/** Waits until the engine worker has a device, or fails with what it reported instead. */
export async function ready(app: AppDriver): Promise<GpuCaps> {
  await app.waitFor(`['ready', 'failed'].includes(orogenTest.ctx.engineState.getState().device.state)`, 60_000);
  const device = await app.eval<{ state: string; caps: GpuCaps | null; message: string | null }>(`orogenTest.ctx.engineState.getState().device`);
  assert.equal(device.state, 'ready', `the engine did not start: ${device.message}`);
  return device.caps!;
}

/** Waits until the view of the document as the engine was last sent it is shown and nothing runs. */
export async function settled(app: AppDriver): Promise<void> {
  await app.waitFor(`(() => {
    const engine = orogenTest.ctx.engineState.getState();
    return engine.evaluation === null && engine.view !== null && engine.view.revision >= orogenTest.ctx.doc.getState().engineRevision;
  })()`, EVALUATION_BACKSTOP_MS);
}

/** Waits until the dock holds its five panels: each has a tab, whether its content is in front or not. */
export async function docked(app: AppDriver): Promise<void> {
  await app.waitFor(`document.querySelectorAll('.dv-tab').length === 5 && orogenTest.shell.layout() !== null`, PAGE_BACKSTOP_MS);
}

/**
 * A capture of the whole window, written for a person (testing.md 8.5 rule 1); no test looks at its pixels. A
 * window that was never shown draws about once a second, later still in its first seconds, and what
 * capturePage copies is the frame before the newest: measured, a picture taken a second after a change showed
 * parts of the page as they were before it. The picture is therefore taken when the page has drawn two frames
 * after what the test did and a further second has passed.
 */
export async function capture(app: AppDriver, name: string): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const done = () => resolve(true);
    setTimeout(done, 5000);
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);
  await sleep(1200);
  return app.capture(`shell/${name}`);
}

export const run = (app: AppDriver, commandId: string): Promise<void> => app.eval<void>(`void orogenTest.ctx.run(${quote(commandId)})`);
export const press = (app: AppDriver, selector: string): Promise<void> => app.eval<void>(`void shellTest.press(${quote(selector)})`);
export const exists = (app: AppDriver, selector: string): Promise<boolean> => app.eval<boolean>(`shellTest.exists(${quote(selector)})`);
export const appears = (app: AppDriver, selector: string): Promise<void> => app.waitFor(`shellTest.exists(${quote(selector)})`, PAGE_BACKSTOP_MS);
export const vanishes = (app: AppDriver, selector: string): Promise<void> => app.waitFor(`!shellTest.exists(${quote(selector)})`, PAGE_BACKSTOP_MS);

/** Opens a menu of the menu bar and returns its items: the command, the label, the key shown, whether it is enabled. The menu stays open. */
export async function openMenu(app: AppDriver, title: string): Promise<{ readonly id: string | null; readonly label: string; readonly key: string | null; readonly enabled: boolean }[]> {
  await press(app, `.og-menubar-item[data-menu="${title}"]`);
  await appears(app, `[data-ui="menu"][data-menu="${title}"] .og-menu-item`);
  return app.eval(`[...document.querySelectorAll('[data-ui="menu"][data-menu="${title}"] > .og-menu-item')].map((item) => ({
    id: item.getAttribute('data-item'),
    label: item.querySelector('.og-menu-item-label').textContent,
    key: item.querySelector('.og-menu-item-key')?.textContent ?? null,
    enabled: !item.hasAttribute('data-disabled'),
  }))`);
}

/** Chooses an item of a menu of the menu bar: a press on the menu, then on the item. */
export async function choose(app: AppDriver, title: string, item: string): Promise<void> {
  await openMenu(app, title);
  await press(app, `[data-ui="menu"][data-menu="${title}"] [data-item="${item}"]`);
  await vanishes(app, `[data-ui="menu"][data-menu="${title}"]`);
}

/** Closes whatever menu is open, as Escape does. */
export async function closeMenu(app: AppDriver): Promise<void> {
  await app.eval(`void shellTest.key('Escape', {}, document.querySelector('[data-ui="menu"]'))`);
  await vanishes(app, '[data-ui="menu"]');
}

/** A key on the page, as the keyboard gives it to whatever has the focus. */
export const key = (app: AppDriver, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, target?: string): Promise<void> =>
  app.eval<void>(`void shellTest.key(${quote(code)}, ${quote(mods)}${target === undefined ? '' : `, ${quote(target)}`})`);

/** A change of the document that can be undone and that the engine computes: another seed. */
export const setSeed = (app: AppDriver, seed: number): Promise<void> =>
  app.eval<void>(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = ${seed}; })`);
export const seedOf = (app: AppDriver): Promise<number> => app.eval<number>(`orogenTest.ctx.doc.getState().doc.settings.seed`);
