// The native menu of runtime.md 8.1: its entries are commands of 8.8, shown with their keys and never
// registered as accelerators.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceleratorOf, MENU_COMMANDS, menuTemplate } from '../../../../src/platform/electron/main/menu.ts';

/** The default bindings of runtime.md 8.8 for the commands the menu offers. */
const CONTRACT_KEYS: Readonly<Record<string, string>> = {
  'file.new': 'Mod+N', 'file.open': 'Mod+O', 'file.save': 'Mod+S', 'file.saveAs': 'Mod+Shift+S',
  'edit.undo': 'Mod+Z', 'edit.redo': 'Mod+Shift+Z', 'view.commandPalette': 'Mod+Shift+P',
  'engine.togglePause': 'Backquote', 'build.start': 'Mod+B', 'viewport.toggleTop': 'F6',
};

interface Item { label?: string; role?: string; type?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void; submenu?: Item[] }
const flat = (items: readonly Item[]): Item[] => items.flatMap((item) => [item, ...flat(item.submenu ?? [])]);

test('menu: a key of 8.8 becomes the accelerator Electron shows', () => {
  assert.equal(acceleratorOf('Mod+S'), 'CmdOrCtrl+S');
  assert.equal(acceleratorOf('Mod+Shift+Z'), 'CmdOrCtrl+Shift+Z');
  assert.equal(acceleratorOf('Ctrl+Alt+Shift+0'), 'Ctrl+Alt+Shift+0');
  assert.equal(acceleratorOf('Backquote'), '`');
  assert.equal(acceleratorOf('F6'), 'F6');
  assert.equal(acceleratorOf('Delete'), 'Delete');
  assert.equal(acceleratorOf('ArrowUp'), 'Up');
  assert.equal(acceleratorOf('Mod+IntlBackslash'), undefined, 'a key Electron has no name for is shown without one');
  assert.equal(acceleratorOf('Hyper+S'), undefined);
});

test('menu: every entry is a command of the shell with the default key of the contract', () => {
  const ids = MENU_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const command of MENU_COMMANDS) {
    assert.equal(command.key, CONTRACT_KEYS[command.id], `${command.id} has the key of runtime.md 8.8`);
    assert.ok(acceleratorOf(command.key) !== undefined, `${command.id}: ${command.key} can be shown`);
    assert.ok(command.label.length > 0 && command.label.length <= 24);
  }
});

test('menu: choosing an entry sends its command id, and nothing else does', () => {
  const sent: string[] = [];
  const items = flat(menuTemplate((id) => void sent.push(id), {}) as Item[]);
  for (const command of MENU_COMMANDS) {
    const item = items.find((i) => i.label === command.label);
    assert.ok(item?.click, `${command.id} is in the menu`);
    item.click();
  }
  assert.deepEqual(sent, MENU_COMMANDS.map((command) => command.id));
  assert.equal(items.filter((i) => i.click).length, MENU_COMMANDS.length);
});

test('menu: keys are shown and never registered, so that the page alone dispatches them', () => {
  const items = flat(menuTemplate(() => {}, {}) as Item[]);
  for (const item of items) {
    if (item.accelerator !== undefined) assert.equal(item.registerAccelerator, false, `${item.label} shows ${item.accelerator}`);
    if (['cut', 'copy', 'paste', 'selectAll'].includes(item.role ?? '')) assert.equal(item.registerAccelerator, false, `${item.role}`);
  }
  assert.equal(items.find((i) => i.label === 'Save')!.accelerator, 'CmdOrCtrl+S');
});

test("menu: the user's keymap replaces the default key of a command", () => {
  const items = flat(menuTemplate(() => {}, { 'file.save': 'Mod+Alt+S', 'build.start': 'IntlRo' }) as Item[]);
  assert.equal(items.find((i) => i.label === 'Save')!.accelerator, 'CmdOrCtrl+Alt+S');
  assert.equal(items.find((i) => i.label === 'Build')!.accelerator, undefined);
  assert.equal(items.find((i) => i.label === 'Undo')!.accelerator, 'CmdOrCtrl+Z');
});
