// The name of a key (runtime.md 8.8 rule 2): a key that types a Latin letter is that letter in the user's layout,
// as text editors, browsers and Unreal's editor read Ctrl+Z; every other key is named by its place. The shell's key
// listener names keys with this, and so does a panel that handles a held key of its own (the graph's Y).

/** Codes of a modifier or a lock by itself: pressing one is no key of a binding. */
export const NOT_A_KEY: ReadonlySet<string> = new Set([
  '', 'Unidentified', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'ContextMenu',
]);

/** KeyboardEvent.key of a modifier or a lock, on whichever key the system put it (AltGr on the key left of Z, Control on Caps Lock). */
const MODIFIER_VALUES: ReadonlySet<string> = new Set([
  'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Symbol', 'SymbolLock',
]);

/** A key name of the notation: a capital letter, a digit, or a code that is no letter's or digit's. */
export const KEY_NAME = /^[A-Z][A-Za-z0-9]*$|^[0-9]$/;

/** Only these 52: `é`, `ö`, `ß` and `я` are no Latin letter here, and their keys keep their places. */
export const LATIN_LETTER = /^[A-Za-z]$/;

/** The key name of a place, a `KeyboardEvent.code`: `KeyB` is `B`, `Digit0` is `0`, every other code is its own name. Null: no key. */
export function keyName(code: string): string | null {
  if (NOT_A_KEY.has(code)) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  return KEY_NAME.test(code) ? code : null;
}

/**
 * The key name of a keyboard event, without its modifiers. `key` is what Chromium reports: the layout's character
 * with the modifiers taken off, so that Ctrl+Z on AZERTY says `z` (Ctrl on Windows and Linux, and Command on a
 * Mac, leave the letter; Shift makes it a capital). When that character is a Latin letter, the key is that letter
 * wherever it lies: AZERTY's Z is in QWERTY's W place. Every other key is named by its place (`keyName(code)`):
 * - a digit, since AZERTY's digit row types &é"'(-è_çà without Shift, and its é must not be E;
 * - punctuation, dead keys and accented letters, whose characters move between layouts and Shift levels;
 * - a key named in words (`Tab`, `F2`, `Delete`, `Home`), the same on every layout;
 * - a letter of a layout without Latin letters (Cyrillic, Greek): its place is QWERTY's, so Ctrl+я is Mod+Z;
 * - a key typed with AltGr (on AZERTY E it types €), and on a Mac a letter with Option (Option+Z types Ω).
 * Null: a modifier by itself.
 */
export function keyNameOf(event: { readonly code: string; readonly key: string }): string | null {
  if (MODIFIER_VALUES.has(event.key)) return null;
  if (LATIN_LETTER.test(event.key)) return event.key.toUpperCase();
  return keyName(event.code);
}
