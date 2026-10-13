// The shared controls of src/app/ui/ in the window, each driven by synthesised input: the gallery of controls
// (the command `view.controlGallery`, in test mode only) holds one of each with a value of its own, and
// `orogenTest.shell.gallery` is where those values are read.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromHex } from '../../../src/app/ui/color.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { appears, capture, docked, exists, key, PAGE_BACKSTOP_MS, press, quote, ready, run, vanishes, withApp } from './rig.ts';

interface Gallery {
  amount: number; length: number; angle: number; count: number; frequency: number; offset: number; slider: number;
  checked: boolean; choice: string; text: string; color: [number, number, number]; events: string[];
}

const gallery = (app: AppDriver): Promise<Gallery> => app.eval<Gallery>(`orogenTest.shell.gallery.getState()`);
const value = async <K extends keyof Gallery>(app: AppDriver, name: K): Promise<Gallery[K]> => (await gallery(app))[name];
const field = (label: string): string => `[data-ui="number-field"][aria-label="${label}"]`;
const widthOf = (app: AppDriver, selector: string): Promise<number> => app.eval<number>(`shellTest.el(${quote(selector)}).clientWidth`);
const drag = (app: AppDriver, selector: string, dx: number, mods: object = {}, release = true): Promise<void> =>
  app.eval<void>(`void shellTest.drag(${quote(selector)}, ${dx}, ${JSON.stringify(mods)}, 10, ${release})`);
/** Clicks a number field, replaces the text of its entry and presses Enter. */
async function enter(app: AppDriver, selector: string, text: string): Promise<void> {
  await press(app, selector);
  await appears(app, `${selector} input`);
  await app.eval(`void shellTest.type(${quote(`${selector} input`)}, ${quote(text)})`);
  await key(app, 'Enter', {}, `${selector} input`);
}
const near = (actual: number, expected: number, tolerance: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

async function openGallery(app: AppDriver): Promise<void> {
  await ready(app);
  await docked(app);
  await run(app, 'view.controlGallery');
  await appears(app, '[data-dialog="gallery"]');
}

test('controls: the number field is dragged, slowed by Shift, snapped by Ctrl and taken back by Escape', async () => {
  await withApp({}, async (app) => {
    await openGallery(app);
    const amount = field('Amount');
    const width = await widthOf(app, amount);
    assert.equal(await value(app, 'amount'), 0.5);

    // A drag across a part of the field is that part of the range, and one gesture.
    await drag(app, amount, 60);
    near(await value(app, 'amount'), 0.5 + 60 / width, 1e-6, 'a drag of 60 pixels');
    assert.deepEqual(await value(app, 'events'), ['amount:start', 'amount:end']);
    assert.equal(await exists(app, `${amount} input`), false, 'a drag does not open the entry');
    assert.equal(await app.eval<boolean>(`document.pointerLockElement === null`), true, 'the pointer is free again');

    // While the button is down the field says that it is being dragged.
    const before = await value(app, 'amount');
    await drag(app, amount, -40, {}, false);
    assert.equal(await app.eval<string | null>(`shellTest.attr(${quote(amount)}, 'data-scrubbing')`), '');
    await app.eval(`void shellTest.release(${quote(amount)})`);
    await app.waitFor(`shellTest.attr(${quote(amount)}, 'data-scrubbing') === null`, PAGE_BACKSTOP_MS);
    near(await value(app, 'amount'), before - 40 / width, 1e-6, 'a drag to the left');

    // Shift: a tenth of the way.
    const slow = await value(app, 'amount');
    await drag(app, amount, 100, { shiftKey: true });
    near(await value(app, 'amount'), slow + (100 / width) * 0.1, 1e-6, 'a drag with Shift');

    // Ctrl: on the step.
    await drag(app, amount, 37, { ctrlKey: true });
    const snapped = await value(app, 'amount');
    assert.equal(snapped, Number(snapped.toFixed(2)), `${snapped} is a multiple of the step 0.01`);
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${amount} .og-number-value`)})`), snapped.toFixed(2));

    // Escape during the drag: the value it began with, and the caller is told that the gesture is not kept.
    await app.eval(`void orogenTest.shell.gallery.setState({ events: [] })`);
    await drag(app, amount, 80, {}, false);
    assert.notEqual(await value(app, 'amount'), snapped);
    await key(app, 'Escape', {}, amount);
    assert.equal(await value(app, 'amount'), snapped);
    await app.eval(`void shellTest.release(${quote(amount)})`);
    assert.deepEqual(await value(app, 'events'), ['amount:start', 'amount:end:cancelled']);
    assert.equal(await exists(app, `${amount} input`), false);

    // A drag ends at the soft range; the fill shows where the value is in it.
    await drag(app, amount, 5000);
    assert.equal(await value(app, 'amount'), 1);
    assert.equal(await app.eval<string>(`shellTest.el(${quote(`${amount} .og-number-fill`)}).style.width`), '100%');
    await drag(app, amount, -5000);
    assert.equal(await value(app, 'amount'), 0);

    // A field of integers moves in whole numbers; a log field in ratios; a field without ends by steps.
    await drag(app, field('Octaves'), 30);
    const octaves = await value(app, 'count');
    assert.ok(Number.isInteger(octaves) && octaves > 8 && octaves <= 16, `octaves ${octaves}`);
    const logWidth = await widthOf(app, field('Frequency'));
    await drag(app, field('Frequency'), 50);
    near(await value(app, 'frequency'), 4 * 128 ** (50 / logWidth), 1e-6, 'a drag on a log scale');
    await drag(app, field('Offset'), 20);
    near(await value(app, 'offset'), 1, 1e-9, 'twenty pixels are ten steps of 0.1');

    // A disabled field does nothing.
    await drag(app, field('Disabled number'), 50);
    await press(app, field('Disabled number'));
    assert.equal(await exists(app, `${field('Disabled number')} input`), false);
    assert.equal((await value(app, 'events')).some((event) => event.startsWith('disabled')), false);
  });
});

test('controls: the number field takes typed entries with arithmetic and units, arrow keys and the wheel', async (t) => {
  await withApp({}, async (app) => {
    await openGallery(app);
    const amount = field('Amount');
    const radius = field('Radius');

    // A click opens the entry with the value, all of it selected.
    await press(app, amount);
    await appears(app, `${amount} input`);
    assert.deepEqual(await app.eval<unknown[]>(`(() => { const input = shellTest.el(${quote(`${amount} input`)}); return [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input]; })()`), ['0.5', 0, 3, true]);
    await app.eval(`void shellTest.type(${quote(`${amount} input`)}, '0.25')`);
    await key(app, 'Enter', {}, `${amount} input`);
    assert.equal(await value(app, 'amount'), 0.25);
    await vanishes(app, `${amount} input`);
    assert.equal(await app.eval<boolean>(`document.activeElement === shellTest.el(${quote(amount)})`), true, 'the field keeps the focus');

    // Arithmetic, and a change of the current value.
    await enter(app, amount, '1/8 + 0.5');
    assert.equal(await value(app, 'amount'), 0.625);
    await enter(app, amount, '*=0.5');
    assert.equal(await value(app, 'amount'), 0.3125);
    await enter(app, amount, '+=0.1');
    near(await value(app, 'amount'), 0.4125, 1e-12, '+=0.1');

    // What is no entry is refused and the entry stays open; Escape takes it back.
    await press(app, amount);
    await appears(app, `${amount} input`);
    await app.eval(`void shellTest.type(${quote(`${amount} input`)}, 'about half')`);
    await key(app, 'Enter', {}, `${amount} input`);
    assert.equal(await app.eval<string | null>(`shellTest.attr(${quote(amount)}, 'data-invalid')`), '');
    assert.equal(await exists(app, `${amount} input`), true);
    t.diagnostic(`capture: ${await capture(app, 'controls-number-entry')}`);
    await key(app, 'Escape', {}, `${amount} input`);
    await vanishes(app, `${amount} input`);
    near(await value(app, 'amount'), 0.4125, 1e-12, 'an entry that was taken back');
    assert.equal(await exists(app, '[data-dialog="gallery"]'), true, 'Escape closed the entry, not the dialog');

    // Leaving the field commits what it holds.
    await press(app, amount);
    await appears(app, `${amount} input`);
    await app.eval(`void shellTest.type(${quote(`${amount} input`)}, '0.75')`);
    await app.eval(`void shellTest.blur(${quote(`${amount} input`)})`);
    await vanishes(app, `${amount} input`);
    assert.equal(await value(app, 'amount'), 0.75);

    // A typed value is held to the hard limits, not to the soft range.
    await enter(app, amount, '7');
    assert.equal(await value(app, 'amount'), 1);
    await enter(app, radius, '2.5');
    assert.equal(await value(app, 'length'), 2.5, 'beyond the soft maximum of 1, within the hard one of 4');
    await enter(app, radius, '99');
    assert.equal(await value(app, 'length'), 4);

    // A length is typed in metres: 750 m of a terrain 5 km wide is 0.15, and the field says so beside the fraction.
    await enter(app, radius, '750m');
    near(await value(app, 'length'), 0.15, 1e-12, '750m');
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${radius} .og-number-value`)})`), '0.150');
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${radius} .og-number-secondary`)})`), '750 m');
    await enter(app, radius, '1.5 km');
    near(await value(app, 'length'), 0.3, 1e-12, '1.5 km');
    await enter(app, radius, '0.1 + 250m');
    near(await value(app, 'length'), 0.15, 1e-12, 'a fraction and metres');
    await enter(app, field('Direction'), '90°');
    assert.equal(await value(app, 'angle'), 90);
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${field('Direction')} .og-number-value`)})`), '90°');
    await enter(app, field('Octaves'), '11.6');
    assert.equal(await value(app, 'count'), 12);

    // With the focus on the field: arrows step, Shift ten steps, Alt a tenth; a digit begins an entry.
    await app.eval(`void orogenTest.shell.gallery.setState({ amount: 0.5 })`);
    await app.eval(`void shellTest.focus(${quote(amount)})`);
    await key(app, 'ArrowUp', {}, amount);
    assert.equal(await value(app, 'amount'), 0.51);
    await key(app, 'ArrowUp', { shift: true }, amount);
    assert.equal(await value(app, 'amount'), 0.61);
    await key(app, 'ArrowDown', { alt: true }, amount);
    assert.equal(await value(app, 'amount'), 0.609);
    await key(app, 'ArrowLeft', {}, amount);
    assert.equal(await value(app, 'amount'), 0.599);
    await key(app, 'Digit3', {}, amount);
    await appears(app, `${amount} input`);
    assert.equal(await app.eval<string>(`shellTest.el(${quote(`${amount} input`)}).value`), '3');
    await key(app, 'Escape', {}, `${amount} input`);
    await key(app, 'Enter', {}, amount);
    await appears(app, `${amount} input`);
    // In the entry, the arrows step what is typed.
    await app.eval(`void shellTest.type(${quote(`${amount} input`)}, '0.2')`);
    await key(app, 'ArrowUp', {}, `${amount} input`);
    assert.deepEqual([await value(app, 'amount'), await app.eval<string>(`shellTest.el(${quote(`${amount} input`)}).value`)], [0.21, '0.21']);
    await key(app, 'Escape', {}, `${amount} input`);

    // Ctrl and the wheel step the field under the pointer; the wheel alone is the panel's.
    assert.equal(await app.eval<boolean>(`(() => { shellTest.wheel(${quote(amount)}, -100, { ctrl: true }); return true; })()`), true);
    assert.equal(await value(app, 'amount'), 0.22);
    await app.eval(`void shellTest.wheel(${quote(amount)}, 100, { ctrl: true, shift: true })`);
    assert.equal(await value(app, 'amount'), 0.12);
    await app.eval(`void shellTest.wheel(${quote(amount)}, -100)`);
    assert.equal(await value(app, 'amount'), 0.12);
  });
});

test('controls: slider, checkbox, select and text field', async () => {
  await withApp({}, async (app) => {
    await openGallery(app);

    // ---- slider: the keyboard on its thumb, and a press on its track ----
    const thumb = '[data-ui="slider"] input[type="range"]';
    assert.equal(await value(app, 'slider'), 0.25);
    await key(app, 'ArrowRight', {}, thumb);
    near(await value(app, 'slider'), 0.3, 1e-9, 'one step of 0.05');
    await key(app, 'End', {}, thumb);
    assert.equal(await value(app, 'slider'), 1);
    await key(app, 'Home', {}, thumb);
    assert.equal(await value(app, 'slider'), 0);
    const track = await app.eval<{ x: number; y: number; width: number; height: number }>(`shellTest.rect('[data-ui="slider"] .og-slider-control')`);
    await app.eval(`void shellTest.press('[data-ui="slider"] .og-slider-control', { clientX: ${track.x + track.width * 0.5}, clientY: ${track.y + track.height / 2} })`);
    near(await value(app, 'slider'), 0.5, 0.051, 'a press in the middle of the track');
    assert.ok((await value(app, 'events')).some((event) => event.startsWith('slider:commit:')), 'the end of an interaction is said once');

    // ---- checkbox: the box and its label ----
    assert.equal(await value(app, 'checked'), false);
    await press(app, '[data-dialog="gallery"] [data-ui="checkbox"]');
    assert.equal(await value(app, 'checked'), true);
    assert.equal(await app.eval<string | null>(`shellTest.attr('[data-dialog="gallery"] [data-ui="checkbox"]', 'data-checked')`), '');
    await app.eval(`void shellTest.el('[data-dialog="gallery"] .og-check').click()`);
    assert.equal(await value(app, 'checked'), false);

    // ---- select ----
    const select = '[data-dialog="gallery"] [data-ui="select"]';
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${select} .og-select-value`)})`), 'Ridged');
    await press(app, select);
    await appears(app, '[data-ui="select-list"] [data-value="billow"]');
    assert.deepEqual(await app.eval<string[]>(`shellTest.texts('[data-ui="select-list"] [data-value]')`), ['Smooth', 'Ridged', 'Billow', 'Cells']);
    assert.equal(await app.eval<string | null>(`shellTest.attr('[data-ui="select-list"] [data-value="cells"]', 'data-disabled')`), '');
    await press(app, '[data-ui="select-list"] [data-value="cells"]');
    assert.equal(await value(app, 'choice'), 'ridged', 'an option that is disabled is not chosen');
    await press(app, '[data-ui="select-list"] [data-value="billow"]');
    await vanishes(app, '[data-ui="select-list"]');
    assert.equal(await value(app, 'choice'), 'billow');
    assert.equal(await app.eval<string>(`shellTest.text(${quote(`${select} .og-select-value`)})`), 'Billow');

    // ---- text field: Enter commits, Escape takes back, leaving commits ----
    const name = '[data-dialog="gallery"] [data-ui="text-field"]';
    await app.eval(`void (shellTest.focus(${quote(name)}), shellTest.type(${quote(name)}, 'Crest'))`);
    assert.equal(await value(app, 'text'), 'Ridge', 'typing commits nothing');
    await key(app, 'Enter', {}, name);
    assert.equal(await value(app, 'text'), 'Crest');
    await app.eval(`void shellTest.type(${quote(name)}, 'Nothing')`);
    await key(app, 'Escape', {}, name);
    assert.deepEqual([await value(app, 'text'), await app.eval<string>(`shellTest.el(${quote(name)}).value`)], ['Crest', 'Crest']);
    assert.equal(await exists(app, '[data-dialog="gallery"]'), true, 'Escape took the text back, and left the dialog open');
    await app.eval(`void shellTest.type(${quote(name)}, 'Summit')`);
    await app.eval(`void shellTest.blur(${quote(name)})`);
    assert.equal(await value(app, 'text'), 'Summit');
    assert.deepEqual((await value(app, 'events')).filter((event) => event.startsWith('text:')), ['text:commit:Crest', 'text:commit:Summit']);
  });
});

test('controls: the colour swatch opens a picker that takes a drag, a hex code and channel values', async (t) => {
  await withApp({}, async (app) => {
    await openGallery(app);
    const swatch = '[data-ui="color-swatch"]';
    assert.equal(await app.eval<string>(`shellTest.attr(${quote(swatch)}, 'data-color')`), '#7caae7', 'linear (0.2, 0.4, 0.8) is shown as sRGB');
    await press(app, swatch);
    await appears(app, '[data-ui="color-picker"]');

    // A hex code is sRGB; what is stored is linear.
    const hex = '[data-ui="color-picker"] [data-ui="text-field"]';
    await app.eval(`void (shellTest.focus(${quote(hex)}), shellTest.type(${quote(hex)}, '#ff8000'))`);
    await key(app, 'Enter', {}, hex);
    assert.deepEqual(await value(app, 'color'), fromHex('#ff8000'));
    await app.waitFor(`shellTest.attr(${quote(swatch)}, 'data-color') === '#ff8000'`, PAGE_BACKSTOP_MS);
    // What is no hex code is marked and changes nothing.
    await app.eval(`void shellTest.type(${quote(hex)}, 'orange')`);
    assert.equal(await app.eval<string | null>(`shellTest.attr(${quote(hex)}, 'data-invalid')`), '');
    await key(app, 'Enter', {}, hex);
    assert.deepEqual(await value(app, 'color'), fromHex('#ff8000'));

    // A channel is the stored value.
    const blue = '[data-ui="color-picker"] [data-ui="number-field"][aria-label="B"]';
    await press(app, blue);
    await appears(app, `${blue} input`);
    await app.eval(`void shellTest.type(${quote(`${blue} input`)}, '0.5')`);
    await key(app, 'Enter', {}, `${blue} input`);
    assert.equal((await value(app, 'color'))[2], 0.5);
    assert.equal(await app.eval<string>(`shellTest.attr(${quote(swatch)}, 'data-color')`), '#ff80bc');

    // A press in the picker's field of saturation and brightness: the top right corner is the pure hue.
    await app.eval(`void orogenTest.shell.gallery.setState({ events: [] })`);
    const area = await app.eval<{ x: number; y: number; width: number; height: number }>(`shellTest.rect('.react-colorful__saturation')`);
    await app.eval(`void shellTest.press('.react-colorful__saturation .react-colorful__interactive', { clientX: ${area.x + area.width - 1}, clientY: ${area.y + 1} })`);
    const picked = await value(app, 'color');
    assert.ok(Math.max(...picked) > 0.95 && Math.min(...picked) < 0.05, `a saturated, bright colour: ${picked.join(', ')}`);
    assert.deepEqual(await value(app, 'events'), ['color:start', 'color:end'], 'a drag in the picker is one gesture');
    t.diagnostic(`capture: ${await capture(app, 'controls-color')}`);

    // A drag that leaves the popover and is let go over the page behind it is one gesture too: the release is
    // heard wherever it happens, and the caller's gesture is not left open.
    await app.eval(`void orogenTest.shell.gallery.setState({ events: [] })`);
    await app.eval(`void (() => {
      const inside = document.querySelector('.react-colorful__saturation .react-colorful__interactive');
      const fire = (target, type, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y,
      }));
      fire(inside, 'pointerdown', ${area.x + 20}, ${area.y + 20}, 1);
      fire(inside, 'pointermove', ${area.x + 60}, ${area.y + 30}, 1);
      fire(document.body, 'pointerup', 5, 5, 0);
    })()`);
    assert.deepEqual(await value(app, 'events'), ['color:start', 'color:end'], 'a drag released outside the popover ends its gesture');
    // And the next press begins another.
    await app.eval(`void shellTest.press('.react-colorful__saturation .react-colorful__interactive', { clientX: ${area.x + 10}, clientY: ${area.y + 10} })`);
    assert.deepEqual(await value(app, 'events'), ['color:start', 'color:end', 'color:start', 'color:end']);

    // Escape closes the picker and leaves the dialog.
    await key(app, 'Escape', {}, '[data-ui="color-picker"]');
    await vanishes(app, '[data-ui="color-picker"]');
    assert.equal(await exists(app, '[data-dialog="gallery"]'), true);
  });
});

test('controls: buttons, tooltip, menu, context menu, popover and dialog', async (t) => {
  await withApp({}, async (app) => {
    await openGallery(app);
    const events = (): Promise<string[]> => value(app, 'events');
    t.diagnostic(`capture: ${await capture(app, 'controls-gallery')}`);

    // ---- buttons ----
    for (const name of ['default', 'primary', 'danger', 'quiet', 'icon']) await press(app, `[data-button="${name}"]`);
    await app.eval(`void [...document.querySelectorAll('[data-dialog="gallery"] button:disabled')].forEach((button) => button.click())`);
    assert.deepEqual(await events(), ['button:default', 'button:primary', 'button:danger', 'button:quiet', 'button:icon']);
    assert.deepEqual(
      await app.eval<unknown[]>(`[shellTest.attr('[data-button="icon"]', 'aria-label'), shellTest.attr('[aria-label="Lock the View"]', 'aria-pressed'), shellTest.el('[aria-label="Delete"]').disabled]`),
      ['Fit to Panel', 'true', true],
    );

    // ---- tooltip: the name of a control and its key, when the pointer rests on it ----
    await app.eval(`void shellTest.hover('[data-button="icon"]')`);
    await appears(app, '[data-ui="tooltip"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-ui="tooltip"]')`), 'Fit to PanelHome');
    t.diagnostic(`capture: ${await capture(app, 'controls-tooltip')}`);
    await app.eval(`void (() => {
      const button = shellTest.el('[data-button="icon"]');
      for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) button.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: !type.endsWith('leave') }));
    })()`);
    await vanishes(app, '[data-ui="tooltip"]');

    // ---- menu ----
    await app.eval(`void orogenTest.shell.gallery.setState({ events: [] })`);
    await press(app, '[data-button="menu"]');
    await appears(app, '[data-ui="menu"] [data-item="duplicate"]');
    const items = await app.eval<{ id: string | null; label: string; key: string | null; disabled: boolean; checked: boolean; danger: boolean }[]>(`[...document.querySelectorAll('[data-ui="menu"] > .og-menu-item')].map((item) => ({
      id: item.getAttribute('data-item'), label: item.querySelector('.og-menu-item-label').textContent, key: item.querySelector('.og-menu-item-key')?.textContent ?? null,
      disabled: item.hasAttribute('data-disabled'), checked: item.querySelector('.og-menu-item-mark') !== null, danger: item.hasAttribute('data-danger'),
    }))`);
    assert.deepEqual(items, [
      { id: 'duplicate', label: 'Duplicate', key: 'Ctrl+D', disabled: false, checked: false, danger: false },
      { id: 'bypass', label: 'Bypass', key: null, disabled: false, checked: true, danger: false },
      { id: 'align', label: 'Align', key: null, disabled: false, checked: false, danger: false },
      { id: 'unavailable', label: 'Unavailable', key: null, disabled: true, checked: false, danger: false },
      { id: 'delete', label: 'Delete', key: 'Del', disabled: false, checked: false, danger: true },
    ]);
    assert.equal(await app.eval<number>(`shellTest.count('[data-ui="menu"] .og-menu-separator')`), 1);
    // A submenu opens when the pointer rests on its entry.
    await app.eval(`void shellTest.hover('[data-ui="menu"] [data-item="align"]')`);
    await appears(app, '[data-ui="menu"] [data-item="left"]');
    t.diagnostic(`capture: ${await capture(app, 'controls-menu')}`);
    await press(app, '[data-ui="menu"] [data-item="left"]');
    await vanishes(app, '[data-ui="menu"]');
    // An entry that is disabled is not chosen; one that is closes the menu.
    await press(app, '[data-button="menu"]');
    await appears(app, '[data-ui="menu"] [data-item="unavailable"]');
    await press(app, '[data-ui="menu"] [data-item="unavailable"]');
    await press(app, '[data-ui="menu"] [data-item="duplicate"]');
    await vanishes(app, '[data-ui="menu"]');
    // Escape closes a menu without choosing.
    await press(app, '[data-button="menu"]');
    await appears(app, '[data-ui="menu"]');
    await key(app, 'Escape', {}, '[data-ui="menu"]');
    await vanishes(app, '[data-ui="menu"]');
    assert.deepEqual(await events(), ['menu:left', 'menu:duplicate']);
    assert.equal(await exists(app, '[data-dialog="gallery"]'), true);

    // ---- context menu: the secondary button, with its items made at that moment ----
    await app.eval(`void shellTest.secondary('[data-area="context"]')`);
    await appears(app, '[data-ui="menu"] [data-item="delete"]');
    await press(app, '[data-ui="menu"] [data-item="delete"]');
    await vanishes(app, '[data-ui="menu"]');
    assert.deepEqual(await events(), ['menu:left', 'menu:duplicate', 'menu:delete']);

    // ---- popover ----
    await press(app, '[data-button="popover"]');
    await appears(app, '[data-ui="popover"]');
    assert.equal(await app.eval<string>(`shellTest.text('[data-ui="popover"] .og-popover-title')`), 'Display');
    await press(app, '[data-ui="popover"] [data-ui="checkbox"]');
    assert.equal(await value(app, 'checked'), true);
    await key(app, 'Escape', {}, '[data-ui="popover"]');
    await vanishes(app, '[data-ui="popover"]');
    assert.equal(await exists(app, '[data-dialog="gallery"]'), true);

    // ---- dialog: its close button, Escape, and a press beside it ----
    assert.equal(await app.eval<string>(`shellTest.text('[data-dialog="gallery"] .og-dialog-title')`), 'Control Gallery');
    await press(app, '[data-dialog="gallery"] .og-dialog-header [aria-label="Close"]');
    await vanishes(app, '[data-dialog="gallery"]');
    await run(app, 'view.controlGallery');
    await appears(app, '[data-dialog="gallery"]');
    await key(app, 'Escape', {}, '[data-dialog="gallery"]');
    await vanishes(app, '[data-dialog="gallery"]');
    await run(app, 'view.controlGallery');
    await appears(app, '[data-dialog="gallery"]');
    await press(app, '.og-dialog-backdrop');
    await vanishes(app, '[data-dialog="gallery"]');
    assert.equal(await app.eval<unknown>(`orogenTest.shell.state.getState().dialog`), null);
  });
});
