// Keys (runtime.md 8.8 rules 2, 3 and 5): the notation, the key of a keyboard event, the keymap the defaults
// and Preferences.keymap make together, and which command a key runs where.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createKeymap, formatKey, isKey, keyName, keyNameOf, keyOf, normalizeKey, reachesBindingsFromControl, reachesBindingsFromTextField, typesWithAltGr,
  type KeyEventLike, type KeymapCommand, type OwnedBinding,
} from '../../../../src/app/shell/keys.ts';

type Held = Partial<Omit<KeyEventLike, 'code' | 'key'>>;
/** An event as Chromium reports it: the place of the key, and the character the layout types on it with the modifiers taken off. */
const event = (code: string, key: string, held: Held = {}): KeyEventLike =>
  ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });
const ctrl = (code: string, key: string, held: Held = {}): string | null => keyOf(event(code, key, { ctrlKey: true, ...held }));

test('a place is named from KeyboardEvent.code', () => {
  assert.equal(keyName('KeyB'), 'B');
  assert.equal(keyName('Digit0'), '0');
  for (const code of ['Tab', 'Delete', 'F2', 'Backquote', 'Home', 'NumpadAdd', 'ArrowUp', 'IntlBackslash']) assert.equal(keyName(code), code);
  for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'CapsLock', '', 'Unidentified']) assert.equal(keyName(code), null, code);
});

test('a key that types a Latin letter is that letter wherever it lies; every other key is its place', () => {
  assert.equal(keyNameOf({ code: 'KeyW', key: 'z' }), 'Z', 'AZERTY: Z is in the W place');
  assert.equal(keyNameOf({ code: 'Semicolon', key: 'm' }), 'M', 'AZERTY: M is right of L');
  assert.equal(keyNameOf({ code: 'KeyY', key: 'Z' }), 'Z', 'a capital is the same letter');
  assert.equal(keyNameOf({ code: 'Digit2', key: 'é' }), '2', 'an accented letter is no Latin letter: AZERTY\'s é is the digit 2');
  assert.equal(keyNameOf({ code: 'KeyE', key: 'ê' }), 'E', 'the E after a dead circumflex');
  assert.equal(keyNameOf({ code: 'BracketLeft', key: 'Dead' }), 'BracketLeft', 'a dead key');
  assert.equal(keyNameOf({ code: 'KeyZ', key: '' }), 'Z', 'a key without a character, as a synthetic event has');
  assert.equal(keyNameOf({ code: '', key: 'a' }), 'A', 'a letter from a keyboard that names no place');
  for (const [code, key] of [['ShiftLeft', 'Shift'], ['ControlLeft', 'Control'], ['AltRight', 'AltGraph'], ['IntlBackslash', 'AltGraph'], ['CapsLock', 'Control']]) {
    assert.equal(keyNameOf({ code: code!, key: key! }), null, `${code} ${key} is a modifier by itself`);
  }
});

test('keyOf writes the modifiers in the order Mod, Ctrl, Alt, Shift', () => {
  assert.equal(keyOf(event('KeyZ', 'Z', { ctrlKey: true, shiftKey: true })), 'Mod+Shift+Z');
  assert.equal(keyOf(event('KeyP', 'P', { shiftKey: true, altKey: true, ctrlKey: true })), 'Mod+Alt+Shift+P');
  assert.equal(keyOf(event('Backquote', '`')), 'Backquote');
  assert.equal(keyOf(event('F6', 'F6')), 'F6');
  assert.equal(keyOf(event('ShiftLeft', 'Shift', { shiftKey: true })), null, 'a modifier alone is no key');
});

const CTRL: Held = { ctrlKey: true };
const CTRL_SHIFT: Held = { ctrlKey: true, shiftKey: true };
/** Keys of 8.8 on three Latin layouts: [what is pressed, code, key, modifiers, the key it is]. */
const LAYOUTS: Readonly<Record<string, readonly (readonly [string, string, string, Held, string])[]>> = {
  QWERTY: [
    ['Ctrl+Z', 'KeyZ', 'z', CTRL, 'Mod+Z'],
    ['Ctrl+Shift+Z', 'KeyZ', 'Z', CTRL_SHIFT, 'Mod+Shift+Z'],
    ['Ctrl+Y', 'KeyY', 'y', CTRL, 'Mod+Y'],
    ['Ctrl+S', 'KeyS', 's', CTRL, 'Mod+S'],
    ['Ctrl+0', 'Digit0', '0', CTRL, 'Mod+0'],
    ['Ctrl+,', 'Comma', ',', CTRL, 'Mod+Comma'],
    ['F2', 'F2', 'F2', {}, 'F2'],
    ['Delete', 'Delete', 'Delete', {}, 'Delete'],
    ['`', 'Backquote', '`', {}, 'Backquote'],
  ],
  // Z and W, A and Q trade places; the digit row types &é"'(-è_çà without Shift; M is right of L, where QWERTY has ;.
  AZERTY: [
    ['Ctrl+Z', 'KeyW', 'z', CTRL, 'Mod+Z'],
    ['Ctrl+Shift+Z', 'KeyW', 'Z', CTRL_SHIFT, 'Mod+Shift+Z'],
    ['Ctrl+W', 'KeyZ', 'w', CTRL, 'Mod+W'],
    ['Ctrl+Y', 'KeyY', 'y', CTRL, 'Mod+Y'],
    ['Ctrl+S', 'KeyS', 's', CTRL, 'Mod+S'],
    ['Ctrl+A', 'KeyQ', 'a', CTRL, 'Mod+A'],
    ['M', 'Semicolon', 'm', {}, 'M'],
    ['Ctrl+à0', 'Digit0', 'à', CTRL, 'Mod+0'],
    ['Ctrl+Shift+à0', 'Digit0', '0', CTRL_SHIFT, 'Mod+Shift+0'],
    ['Ctrl+é2', 'Digit2', 'é', CTRL, 'Mod+2'],
    ['Ctrl+ç9', 'Digit9', 'ç', CTRL, 'Mod+9'],
    // Punctuation keeps its place: the preferences are Ctrl with the key that types ; on AZERTY.
    ['Ctrl+;', 'Comma', ';', CTRL, 'Mod+Comma'],
    ['F2', 'F2', 'F2', {}, 'F2'],
    ['Delete', 'Delete', 'Delete', {}, 'Delete'],
    ['²', 'Backquote', '²', {}, 'Backquote'],
  ],
  // Y and Z trade places; ö, ä, ü and ß are not letters of the notation and keep the places of ; ' [ and -.
  QWERTZ: [
    ['Ctrl+Z', 'KeyY', 'z', CTRL, 'Mod+Z'],
    ['Ctrl+Shift+Z', 'KeyY', 'Z', CTRL_SHIFT, 'Mod+Shift+Z'],
    ['Ctrl+Y', 'KeyZ', 'y', CTRL, 'Mod+Y'],
    ['Ctrl+S', 'KeyS', 's', CTRL, 'Mod+S'],
    ['Ctrl+0', 'Digit0', '0', CTRL, 'Mod+0'],
    ['Ctrl+,', 'Comma', ',', CTRL, 'Mod+Comma'],
    ['Ctrl+ö', 'Semicolon', 'ö', CTRL, 'Mod+Semicolon'],
    ['Ctrl+ß', 'Minus', 'ß', CTRL, 'Mod+Minus'],
    ['F2', 'F2', 'F2', {}, 'F2'],
    ['Delete', 'Delete', 'Delete', {}, 'Delete'],
    ['dead ^', 'Backquote', 'Dead', {}, 'Backquote'],
  ],
};

test('Ctrl+Z is the key marked Z on QWERTY, AZERTY and QWERTZ; digits, punctuation and keys named in words keep their places', () => {
  for (const [layout, rows] of Object.entries(LAYOUTS)) {
    for (const [pressed, code, key, held, expected] of rows) assert.equal(keyOf(event(code, key, held)), expected, `${layout} ${pressed} (${code}, ${JSON.stringify(key)})`);
  }
  // What is not undo: the key in QWERTY's Z place types W on AZERTY and Y on QWERTZ.
  assert.equal(ctrl('KeyZ', 'w'), 'Mod+W');
  assert.equal(ctrl('KeyZ', 'y'), 'Mod+Y');
});

test('on a layout without Latin letters a letter key is its QWERTY place, so that the shortcuts still work', () => {
  assert.equal(ctrl('KeyZ', 'я'), 'Mod+Z', 'Russian');
  assert.equal(ctrl('KeyZ', 'Я', { shiftKey: true }), 'Mod+Shift+Z');
  assert.equal(ctrl('KeyS', 'ы'), 'Mod+S');
  assert.equal(ctrl('KeyZ', 'ζ'), 'Mod+Z', 'Greek');
  assert.equal(keyOf(event('KeyB', 'и')), 'B', 'a plain key as well: B bypasses');
  assert.equal(keyOf(event('KeyQ', ';')), 'Q', 'Greek types ; in the Q place');
});

test('AltGr, which Windows reports as Ctrl and Alt, types a character in a text field and leaves Ctrl+Alt with a letter a chord', () => {
  const euro = event('KeyE', '€', { ctrlKey: true, altKey: true });
  assert.equal(keyOf(euro), 'Mod+Alt+E', 'outside a text field it is a chord of its place');
  assert.equal(typesWithAltGr(euro), true);
  assert.equal(typesWithAltGr(event('Digit0', '@', { ctrlKey: true, altKey: true })), true, 'AZERTY AltGr+à0 types @');
  assert.equal(typesWithAltGr(event('Digit2', 'Dead', { ctrlKey: true, altKey: true })), true, 'AZERTY AltGr+é2 is a dead ~');
  assert.equal(typesWithAltGr(event('KeyQ', '@', { getModifierState: (key) => key === 'AltGraph' })), true, 'Linux reports AltGraph by itself');
  const chord = event('KeyW', 'z', { ctrlKey: true, altKey: true });
  assert.equal(keyOf(chord), 'Mod+Alt+Z');
  assert.equal(typesWithAltGr(chord), false, 'AZERTY Z has no character on AltGr: Ctrl+Alt+Z is a chord');
  assert.equal(typesWithAltGr(event('KeyE', '€', { altKey: true })), false, 'Alt alone is no AltGr');
  assert.equal(typesWithAltGr(event('KeyZ', 'z', { ctrlKey: true })), false);
  assert.equal(typesWithAltGr(event('Space', ' ', { ctrlKey: true, altKey: true })), false, 'Ctrl+Alt+Space types nothing');
});

test('Mod is Control on Windows and Linux and Command on a Mac', () => {
  assert.equal(keyOf(event('KeyS', 's', { ctrlKey: true }), 'other'), 'Mod+S');
  assert.equal(keyOf(event('KeyS', 's', { metaKey: true }), 'mac'), 'Mod+S');
  assert.equal(keyOf(event('KeyS', 's', { ctrlKey: true }), 'mac'), 'Ctrl+S');
  assert.equal(keyOf(event('KeyS', 's', { ctrlKey: true, metaKey: true }), 'mac'), 'Mod+Ctrl+S');
  assert.equal(keyOf(event('KeyS', 's', { metaKey: true }), 'other'), null, 'a chord with the system key is not ours');
  // Option types a character of its own on a Mac: the key keeps its place.
  assert.equal(keyOf(event('KeyZ', 'Ω', { altKey: true }), 'mac'), 'Alt+Z');
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
  // A menu shows what was pressed: Ctrl with the key marked Z, on AZERTY as on QWERTY.
  assert.equal(formatKey(ctrl('KeyW', 'z')!), 'Ctrl+Z');
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

test('a number field that shows its value, or a list, keeps plain keys and has no undo of its own: Mod+Z and Mod+Y are the application\'s there', () => {
  for (const key of ['Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+A', 'Mod+S', 'F2', 'F6']) assert.equal(reachesBindingsFromControl(key), true, key);
  for (const key of ['B', 'Tab', 'Delete', 'Backquote', 'Shift+A', 'Alt+B', 'Home', 'ArrowUp', 'Enter']) assert.equal(reachesBindingsFromControl(key), false, key);
  const keymap = createKeymap(DEFAULTS, COMMANDS);
  // The value was dragged, the field has the focus: redo is the document's, and so is undo.
  assert.equal(keymap.resolve('Mod+Shift+Z', { focusedPanel: 'inspector', textField: true, typing: false }), 'edit.redo');
  assert.equal(keymap.resolve('Mod+Y', { focusedPanel: 'inspector', textField: true, typing: false }), 'edit.redo');
  assert.equal(keymap.resolve('Mod+S', { focusedPanel: 'inspector', textField: true, typing: false }), 'file.save');
  // Its plain keys stay its own: B is no bypass and Delete no deletion while it has the focus.
  assert.equal(keymap.resolve('B', { focusedPanel: 'graph', textField: true, typing: false }), null);
  assert.equal(keymap.resolve('Delete', { focusedPanel: 'graph', textField: true, typing: false }), null);
  // An entry that is being typed is a text field as any other.
  assert.equal(keymap.resolve('Mod+Shift+Z', { focusedPanel: 'inspector', textField: true, typing: true }), null);
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
