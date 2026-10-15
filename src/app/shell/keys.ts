// Keys (runtime.md 8.8 rules 2, 3 and 5): the notation, the key of a keyboard event, the keymap that the default
// bindings and Preferences.keymap make together, and which command a key runs where. No DOM and no React: the
// one key listener of the shell (dom.ts) calls this.

import { KEY_NAME, keyName, keyNameOf, LATIN_LETTER, NOT_A_KEY } from '../ui/key-name.ts';
import type { KeyBinding, PanelId } from '../ui/types.ts';

export { keyName, keyNameOf };

/** The members of a KeyboardEvent that say which key it is. */
export interface KeyEventLike {
  readonly code: string;
  /** The character the key types in the user's layout, or the name of one that types none (`Enter`, `Dead`, `F2`). */
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** KeyboardEvent's, for `AltGraph`: Linux reports AltGr as that, apart from Ctrl and Alt. */
  getModifierState?(key: string): boolean;
}

/** `Mod` is Command on a Mac and Control everywhere else. */
export type KeyPlatform = 'mac' | 'other';

export type KeyScope = PanelId | 'global';

/** In this order in every key (rule 2). */
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** The key of a keyboard event in the notation of rule 2, or null when the event is a modifier alone. */
export function keyOf(event: KeyEventLike, platform: KeyPlatform = 'other'): string | null {
  const name = keyNameOf(event);
  if (name === null) return null;
  // Elsewhere than on a Mac the Meta key is the system's: a chord with it is not ours.
  if (platform === 'other' && event.metaKey) return null;
  const held: Record<Modifier, boolean> = {
    Mod: platform === 'mac' ? event.metaKey : event.ctrlKey,
    Ctrl: platform === 'mac' && event.ctrlKey,
    Alt: event.altKey,
    Shift: event.shiftKey,
  };
  return [...MODIFIERS.filter((modifier) => held[modifier]), name].join('+');
}

/**
 * Rule 3: whether the event types a character with AltGr. Windows reports AltGr as Ctrl and Alt held together, so
 * AZERTY's € (AltGr+E) arrives as Ctrl+Alt+E: in a text field it is a character, and not the key Mod+Alt+E.
 */
export function typesWithAltGr(event: KeyEventLike): boolean {
  if (event.metaKey) return false;
  if (!(event.getModifierState?.('AltGraph') === true || (event.ctrlKey && event.altKey))) return false;
  // Ctrl+Alt+Z on AZERTY, whose Z has no character on AltGr, still says z: that is a chord.
  return event.key === 'Dead' || ([...event.key].length === 1 && event.key !== ' ' && !LATIN_LETTER.test(event.key));
}

interface ParsedKey { readonly modifiers: readonly Modifier[]; readonly name: string }

function parse(key: string): ParsedKey | null {
  if (typeof key !== 'string' || key === '') return null;
  const parts = key.split('+');
  const name = parts.pop()!;
  // `KeyB` and `Digit0` are written `B` and `0`; a modifier is no key by itself.
  if (!KEY_NAME.test(name) || /^Key[A-Z]$|^Digit[0-9]$/.test(name) || NOT_A_KEY.has(name) || MODIFIERS.some((m) => m === name)) return null;
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS.find((m) => m === part);
    if (modifier === undefined || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  return { modifiers, name };
}

/** A key as rule 2 writes it: its modifiers in the order Mod, Ctrl, Alt, Shift. Null: not a key. */
export function normalizeKey(key: string): string | null {
  const parsed = parse(key);
  if (!parsed) return null;
  return [...MODIFIERS.filter((modifier) => parsed.modifiers.includes(modifier)), parsed.name].join('+');
}

export const isKey = (key: string): boolean => normalizeKey(key) === key;

const SHOWN: Readonly<Record<string, string>> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backslash: '\\', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Delete: 'Del',
  PageUp: 'PgUp', PageDown: 'PgDn', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadEnter: 'Num Enter', NumpadDecimal: 'Num .',
};

/** A key as a person reads it: `Mod+Shift+Z` is `Ctrl+Shift+Z`, `Backquote` is the character on the key. */
export function formatKey(key: string, platform: KeyPlatform = 'other'): string {
  const parsed = parse(key);
  if (!parsed) return key;
  const modifier = (m: Modifier): string => (m === 'Mod' ? (platform === 'mac' ? 'Cmd' : 'Ctrl') : m);
  const numpad = /^Numpad([0-9])$/.exec(parsed.name);
  const name = SHOWN[parsed.name] ?? (numpad ? `Num ${numpad[1]}` : parsed.name);
  return [...parsed.modifiers.map(modifier), name].join('+');
}

/** While a text field has focus these belong to the field (rule 3): its own undo, redo, select all and clipboard. */
const FIELD_KEYS: ReadonlySet<string> = new Set(['Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+A', 'Mod+C', 'Mod+X', 'Mod+V']);

/** Rule 3: whether a key is looked up at all while a text field has focus. */
export function reachesBindingsFromTextField(key: string): boolean {
  const parsed = parse(key);
  if (!parsed) return false;
  if (FIELD_KEYS.has(key)) return false;
  return parsed.modifiers.includes('Mod') || FUNCTION_KEY.test(parsed.name);
}

/**
 * Rule 3, for a control that uses plain keys for itself and holds no typed text: a number field that shows its
 * value, a list. It has no undo and no clipboard of its own, so the keys of FIELD_KEYS are the application's
 * there: Mod+Z after a value was dragged undoes the drag.
 */
export function reachesBindingsFromControl(key: string): boolean {
  const parsed = parse(key);
  if (!parsed) return false;
  return parsed.modifiers.includes('Mod') || FUNCTION_KEY.test(parsed.name);
}

/** A default binding with who declared it. */
export interface OwnedBinding extends KeyBinding { readonly owner: string }

export interface BoundKey extends OwnedBinding {
  /** True for a key of Preferences.keymap. */
  readonly user: boolean;
}

export interface KeymapCommand {
  readonly id: string;
  /** The scope a user key of this command gets when the command has no default binding. */
  readonly scope: KeyScope;
}

export interface Keymap {
  readonly bindings: readonly BoundKey[];
  /** The keys of a command; the first is the one shown in menus, the palette and tooltips. */
  keysOf(commandId: string): readonly string[];
  /**
   * Rule 3: a binding scoped to the focused panel wins over a global one. `textField`: the focus is in an element
   * that takes plain keys for itself. `typing` (default: as `textField`): that element holds typed text, with an
   * undo and a clipboard of its own; false for a number field that shows its value and for a list.
   */
  resolve(key: string, where: { readonly focusedPanel: PanelId | null; readonly textField: boolean; readonly typing?: boolean }): string | null;
  /** One sentence for each entry of Preferences.keymap that was not applied as written, and each default it displaced. */
  readonly problems: readonly string[];
}

/**
 * The bindings in force (rule 5): a command named in `overrides` has the one key given there in place of all
 * its default keys, or no key for ''. A default binding of another command with that key in that scope gives
 * way to the user's.
 */
export function createKeymap(
  defaults: readonly OwnedBinding[],
  commands: readonly KeymapCommand[],
  overrides: Readonly<Record<string, string>> = {},
  platform: KeyPlatform = 'other',
): Keymap {
  const known = new Map(commands.map((command) => [command.id, command]));
  const problems: string[] = [];
  const user: BoundKey[] = [];
  const replaced = new Set<string>();
  const slot = (key: string, scope: KeyScope): string => `${scope} ${key}`;
  const taken = new Map<string, BoundKey>();

  for (const [commandId, wanted] of Object.entries(overrides)) {
    const command = known.get(commandId);
    if (!command) {
      problems.push(`The key for "${commandId}" is ignored: there is no such command`);
      continue;
    }
    if (wanted === '') {
      replaced.add(commandId);
      continue;
    }
    const key = normalizeKey(wanted);
    if (key === null) {
      problems.push(`The key "${wanted}" for "${commandId}" is ignored: it is not a key`);
      continue;
    }
    const scope = defaults.find((binding) => binding.command === commandId)?.scope ?? command.scope;
    const other = taken.get(slot(key, scope));
    if (other) {
      problems.push(`${formatKey(key, platform)} is given to both "${other.command}" and "${commandId}": it runs "${other.command}"`);
      continue;
    }
    const bound: BoundKey = { key, command: commandId, scope, owner: 'user', user: true };
    replaced.add(commandId);
    taken.set(slot(key, scope), bound);
    user.push(bound);
  }

  const bindings: BoundKey[] = [];
  for (const binding of defaults) {
    if (replaced.has(binding.command)) continue;
    const winner = taken.get(slot(binding.key, binding.scope));
    if (winner) {
      problems.push(`${formatKey(binding.key, platform)} now runs "${winner.command}" and no longer "${binding.command}"`);
      continue;
    }
    bindings.push({ ...binding, user: false });
  }
  bindings.push(...user);

  const byCommand = new Map<string, string[]>();
  const bySlot = new Map<string, string>();
  for (const binding of bindings) {
    const keys = byCommand.get(binding.command);
    if (keys) keys.push(binding.key);
    else byCommand.set(binding.command, [binding.key]);
    bySlot.set(slot(binding.key, binding.scope), binding.command);
  }
  const NONE: readonly string[] = [];

  return {
    bindings,
    problems,
    keysOf: (commandId) => byCommand.get(commandId) ?? NONE,
    resolve(key, where) {
      if (where.textField && !((where.typing ?? true) ? reachesBindingsFromTextField(key) : reachesBindingsFromControl(key))) return null;
      const scoped = where.focusedPanel === null ? undefined : bySlot.get(slot(key, where.focusedPanel));
      return scoped ?? bySlot.get(slot(key, 'global')) ?? null;
    },
  };
}
