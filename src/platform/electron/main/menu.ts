// The native menu (runtime.md 8.1). Its entries are commands of the interface (8.8): choosing one sends the
// command id to the page, which runs it. Pure: main.ts builds the Menu from this template.

import type { MenuItemConstructorOptions } from 'electron';

export interface MenuCommand {
  readonly menu: 'File' | 'Edit' | 'View' | 'Engine';
  readonly id: string;                 // a command id of runtime.md 8.8
  readonly label: string;
  readonly key: string;                // its default key, in the notation of 8.8 rule 2
}

/** The commands of the shell that the native menu offers, with the default keys of the table in 8.8. */
export const MENU_COMMANDS: readonly MenuCommand[] = [
  { menu: 'File', id: 'file.new', label: 'New Project', key: 'Mod+N' },
  { menu: 'File', id: 'file.open', label: 'Open Project…', key: 'Mod+O' },
  { menu: 'File', id: 'file.save', label: 'Save', key: 'Mod+S' },
  { menu: 'File', id: 'file.saveAs', label: 'Save As…', key: 'Mod+Shift+S' },
  { menu: 'Edit', id: 'edit.undo', label: 'Undo', key: 'Mod+Z' },
  { menu: 'Edit', id: 'edit.redo', label: 'Redo', key: 'Mod+Shift+Z' },
  { menu: 'View', id: 'view.commandPalette', label: 'Command Palette…', key: 'Mod+Shift+P' },
  { menu: 'View', id: 'viewport.toggleTop', label: 'Top View', key: 'F6' },
  { menu: 'Engine', id: 'engine.togglePause', label: 'Pause Previews', key: 'Backquote' },
  { menu: 'Engine', id: 'build.start', label: 'Build', key: 'Mod+B' },
];

const MODIFIERS: Readonly<Record<string, string>> = { Mod: 'CmdOrCtrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
/** KeyboardEvent.code names whose Electron accelerator is spelled otherwise. */
const NAMED: Readonly<Record<string, string>> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backslash: '\\', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Esc', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
};
const AS_IS = /^([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4])|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/;

/** A key of 8.8 rule 2 as an Electron accelerator, or undefined when Electron has no name for it. */
export function acceleratorOf(key: string): string | undefined {
  const parts = key.split('+');
  const name = parts.pop() ?? '';
  const code = NAMED[name] ?? (AS_IS.test(name) ? name : undefined);
  if (code === undefined) return undefined;
  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier === undefined) return undefined;
    modifiers.push(modifier);
  }
  return [...modifiers, code].join('+');
}

/**
 * `keymap` is Preferences.keymap. Keys are shown, never registered: the page's one key listener dispatches them
 * (8.8 rule 3), and a registered accelerator would run the command a second time.
 */
export function menuTemplate(send: (commandId: string) => void, keymap: Readonly<Record<string, string>>): MenuItemConstructorOptions[] {
  const item = (command: MenuCommand): MenuItemConstructorOptions => {
    const accelerator = acceleratorOf(Object.hasOwn(keymap, command.id) ? keymap[command.id]! : command.key);
    return {
      label: command.label,
      click: () => send(command.id),
      ...(accelerator === undefined ? {} : { accelerator, registerAccelerator: false }),
    };
  };
  const of = (menu: MenuCommand['menu']): MenuItemConstructorOptions[] => MENU_COMMANDS.filter((command) => command.menu === menu).map(item);
  const editing: MenuItemConstructorOptions[] = (['cut', 'copy', 'paste', 'selectAll'] as const).map((role) => ({ role, registerAccelerator: false }));
  return [
    { label: 'File', submenu: [...of('File'), { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [...of('Edit'), { type: 'separator' }, ...editing] },
    { label: 'View', submenu: [...of('View'), { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Engine', submenu: of('Engine') },
  ];
}
