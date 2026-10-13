// Keys (runtime.md 8.8 rules 2, 3 and 5): the notation, the key of a keyboard event, the keymap the defaults
// and Preferences.keymap make together, and which command a key runs where.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createKeymap, formatKey, isKey, keyName, keyOf, normalizeKey, reachesBindingsFromTextField,
  type KeyEventLike, type KeymapCommand, type OwnedBinding,
} from '../../../../src/app/shell/keys.ts';

const event = (code: string, held: Partial<Omit<KeyEventLike, 'code'>> = {}): KeyEventLike =>
  ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });

test('a key name is derived from KeyboardEvent.code, whatever the layout prints on the key', () => {
  assert.equal(keyName('KeyB'), 'B');
  assert.equal(keyName('Digit0'), '0');
  for (const code of ['Tab', 'Delete', 'F2', 'Backquote', 'Home', 'NumpadAdd', 'ArrowUp', 'IntlBackslash']) assert.equal(keyName(code), code);
  for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'CapsLock', '', 'Unidentified']) assert.equal(keyName(code), null, code);
});

test('keyOf writes the modifiers in the order Mod, Ctrl, Alt, Shift', () => {
  assert.equal(keyOf(event('KeyZ', { ctrlKey: true, shiftKey: true })), 'Mod+Shift+Z');
  assert.equal(keyOf(event('KeyP', { shiftKey: true, altKey: true, ctrlKey: true })), 'Mod+Alt+Shift+P');
  assert.equal(keyOf(event('Backquote')), 'Backquote');
  assert.equal(keyOf(event('F6')), 'F6');
  assert.equal(keyOf(event('ShiftLeft', { shiftKey: true })), null, 'a modifier alone is no key');
});

test('Mod is Control on Windows and Linux and Command on a Mac', () => {
  assert.equal(keyOf(event('KeyS', { ctrlKey: true }), 'other'), 'Mod+S');
  assert.equal(keyOf(event('KeyS', { metaKey: true }), 'mac'), 'Mod+S');
  assert.equal(keyOf(event('KeyS', { ctrlKey: true }), 'mac'), 'Ctrl+S');
  assert.equal(keyOf(event('KeyS', { ctrlKey: true, metaKey: true }), 'mac'), 'Mod+Ctrl+S');
  assert.equal(keyOf(event('KeyS', { metaKey: true }), 'other'), null, 'a chord with the system key is not ours');
});

test('normalizeKey orders the modifiers and refuses what is no key', () => {
  assert.equal(normalizeKey('Shift+Mod+Z'), 'Mod+Shift+Z');
  assert.equal(normalizeKey('Alt+Ctrl+Mod+F2'), 'Mod+Ctrl+Alt+F2');
  assert.equal(normalizeKey('B'), 'B');
  for (const bad of ['', 'Mod+', 'Mod+Mod+Z', 'Super+Z', 'KeyB', 'Digit1', 'Mod+Shift', 'ctrl+z', 'Mod+z', 'ShiftLeft', 'Mod + Z']) {
    assert.equal(normalizeKey(bad), null, JSON.stringify(bad));
  }
  assert.equal(isKey('Mod+Shift+Z'), true);
  assert.equal(isKey('Shift+Mod+Z'), false, 'a key is written in one way');
});

test('formatKey writes a key as a person reads it', () => {
  assert.equal(formatKey('Mod+Shift+Z'), 'Ctrl+Shift+Z');
  assert.equal(formatKey('Mod+Shift+Z', 'mac'), 'Cmd+Shift+Z');
  assert.equal(formatKey('Backquote'), '`');
  assert.equal(formatKey('Mod+Comma'), 'Ctrl+,');
  assert.equal(formatKey('Delete'), 'Del');
  assert.equal(formatKey('Numpad5'), 'Num 5');
  assert.equal(formatKey('not a key'), 'not a key');
});

test('while a text field has the focus only keys with Mod or a function key reach the bindings, and the field keeps its own', () => {
  for (const key of ['Mod+S', 'Mod+Shift+P', 'F1', 'F6', 'Mod+B', 'Shift+F2']) assert.equal(reachesBindingsFromTextField(key), true, key);
  for (const key of ['B', 'Tab', 'Delete', 'Backquote', 'Shift+A', 'Alt+B', 'Home']) assert.equal(reachesBindingsFromTextField(key), false, key);
  for (const key of ['Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+A', 'Mod+C', 'Mod+X', 'Mod+V']) assert.equal(reachesBindingsFromTextField(key), false, `${key} is the field's`);
});

const DEFAULTS: readonly OwnedBinding[] = [
  { key: 'Mod+S', command: 'file.save', scope: 'global', owner: 'shell' },
  { key: 'Mod+Shift+Z', command: 'edit.redo', scope: 'global', owner: 'shell' },
  { key: 'Mod+Y', command: 'edit.redo', scope: 'global', owner: 'shell' },
  { key: 'F', command: 'viewport.frame', scope: 'viewport', owner: 'viewport' },
  { key: 'F', command: 'graph.toggleViewLock', scope: 'graph', owner: 'graph' },
  { key: 'B', command: 'graph.toggleBypass', scope: 'graph', owner: 'graph' },
  { key: 'Mod+B', command: 'build.start', scope: 'global', owner: 'shell' },
  { key: 'Delete', command: 'graph.delete', scope: 'graph', owner: 'graph' },
];
const COMMANDS: readonly KeymapCommand[] = [
  { id: 'file.save', scope: 'global' }, { id: 'edit.redo', scope: 'global' }, { id: 'viewport.frame', scope: 'viewport' },
  { id: 'graph.toggleViewLock', scope: 'graph' }, { id: 'graph.toggleBypass', scope: 'graph' }, { id: 'build.start', scope: 'global' },
  { id: 'graph.delete', scope: 'graph' }, { id: 'graph.fit', scope: 'graph' }, { id: 'view.resetLayout', scope: 'global' },
];

test('a binding scoped to the focused panel wins over a global one, and one key means different things in two panels', () => {
  const keymap = createKeymap([...DEFAULTS, { key: 'B', command: 'view.resetLayout', scope: 'global', owner: 'shell' }], COMMANDS);
  assert.deepEqual(keymap.problems, []);
  assert.equal(keymap.resolve('F', { focusedPanel: 'graph', textField: false }), 'graph.toggleViewLock');
  assert.equal(keymap.resolve('F', { focusedPanel: 'viewport', textField: false }), 'viewport.frame');
  assert.equal(keymap.resolve('F', { focusedPanel: 'inspector', textField: false }), null);
  assert.equal(keymap.resolve('B', { focusedPanel: 'graph', textField: false }), 'graph.toggleBypass');
  assert.equal(keymap.resolve('B', { focusedPanel: 'viewport', textField: false }), 'view.resetLayout');
  assert.equal(keymap.resolve('B', { focusedPanel: null, textField: false }), 'view.resetLayout');
  assert.equal(keymap.resolve('Mod+S', { focusedPanel: 'graph', textField: false }), 'file.save');
});

test('in a text field a plain key is typed, Mod+S saves, and Delete deletes a character', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS);
  assert.equal(keymap.resolve('B', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('Delete', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('Mod+S', { focusedPanel: 'graph', textField: true }), 'file.save');
  assert.equal(keymap.resolve('Mod+Shift+Z', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('Mod+Y', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('Mod+B', { focusedPanel: 'inspector', textField: true }), 'build.start');
});

test('keysOf lists the keys of a command, the first being the one shown', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS);
  assert.deepEqual(keymap.keysOf('edit.redo'), ['Mod+Shift+Z', 'Mod+Y']);
  assert.deepEqual(keymap.keysOf('graph.fit'), []);
  assert.deepEqual(keymap.keysOf('nobody.knows'), []);
});

test('a user key replaces every default key of its command and keeps the scope', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS, { 'edit.redo': 'Mod+Shift+Y', 'graph.toggleBypass': 'Shift+B' });
  assert.deepEqual(keymap.problems, []);
  assert.deepEqual(keymap.keysOf('edit.redo'), ['Mod+Shift+Y']);
  assert.equal(keymap.resolve('Mod+Y', { focusedPanel: null, textField: false }), null);
  assert.equal(keymap.resolve('Mod+Shift+Z', { focusedPanel: null, textField: false }), null);
  assert.equal(keymap.resolve('Mod+Shift+Y', { focusedPanel: 'graph', textField: false }), 'edit.redo');
  assert.equal(keymap.resolve('Shift+B', { focusedPanel: 'graph', textField: false }), 'graph.toggleBypass');
  assert.equal(keymap.resolve('Shift+B', { focusedPanel: 'viewport', textField: false }), null, 'a panel command stays a key of its panel');
  assert.equal(keymap.resolve('B', { focusedPanel: 'graph', textField: false }), null);
  assert.deepEqual(keymap.bindings.filter((binding) => binding.user).map((binding) => binding.command), ['edit.redo', 'graph.toggleBypass']);
});

test('a user key for a command without a default is scoped to the command: its panel, or global', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS, { 'graph.fit': 'Mod+0', 'view.resetLayout': 'Mod+Alt+L' });
  assert.equal(keymap.resolve('Mod+0', { focusedPanel: 'graph', textField: false }), 'graph.fit');
  assert.equal(keymap.resolve('Mod+0', { focusedPanel: 'build', textField: false }), null);
  assert.equal(keymap.resolve('Mod+Alt+L', { focusedPanel: 'build', textField: false }), 'view.resetLayout');
});

test('an empty user key leaves the command without a key', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS, { 'build.start': '' });
  assert.deepEqual(keymap.keysOf('build.start'), []);
  assert.equal(keymap.resolve('Mod+B', { focusedPanel: null, textField: false }), null);
  assert.deepEqual(keymap.problems, []);
});

test('a user key takes the key from the default of another command, and the keymap says so', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS, { 'view.resetLayout': 'Mod+S' });
  assert.equal(keymap.resolve('Mod+S', { focusedPanel: 'graph', textField: false }), 'view.resetLayout');
  assert.deepEqual(keymap.keysOf('file.save'), []);
  assert.equal(keymap.problems.length, 1);
  assert.match(keymap.problems[0]!, /Ctrl\+S now runs "view\.resetLayout" and no longer "file\.save"/);
});

test('what cannot be applied of Preferences.keymap is said and the defaults stay', () => {
  const keymap = createKeymap(DEFAULTS, COMMANDS, {
    'nobody.knows': 'Mod+K',
    'file.save': 'not a key',
    'graph.fit': 'Mod+J',
    'graph.delete': 'Mod+J',
    'edit.redo': 'Shift+Mod+R',
  });
  assert.deepEqual(keymap.keysOf('file.save'), ['Mod+S'], 'a key that is none leaves the default');
  assert.deepEqual(keymap.keysOf('graph.fit'), ['Mod+J']);
  assert.deepEqual(keymap.keysOf('graph.delete'), ['Delete'], 'the second claim of one key loses and its command keeps its default');
  assert.deepEqual(keymap.keysOf('edit.redo'), ['Mod+Shift+R'], 'a user key is put into the notation');
  assert.equal(keymap.problems.length, 3);
  assert.match(keymap.problems[0]!, /"nobody\.knows".*no such command/);
  assert.match(keymap.problems[1]!, /"not a key".*"file\.save".*not a key/);
  assert.match(keymap.problems[2]!, /Ctrl\+J is given to both "graph\.fit" and "graph\.delete"/);
});

test('the keymap of the same preferences is the same every time', () => {
  const a = createKeymap(DEFAULTS, COMMANDS, { 'graph.fit': 'Home' });
  const b = createKeymap(DEFAULTS, COMMANDS, { 'graph.fit': 'Home' });
  assert.deepEqual(a.bindings, b.bindings);
});
