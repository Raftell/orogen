// The shell's own commands, global keys and menu entries (runtime.md 8.8): the list the command registry gets
// beside those of the panels. Their ids begin with `file`, `edit`, `view` or `engine`. No DOM and no React: what
// needs a window is in the host.

import type { CommandDef, KeyBinding, MenuEntry, PanelId } from '../ui/types.ts';
import { SHELL_OWNER, type CommandSource } from './commands.ts';
import type { ProjectService } from './project.ts';

export type EditAction = 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';
export const EDIT_ACTIONS: readonly EditAction[] = ['cut', 'copy', 'paste', 'delete', 'selectAll'];
const CLIPBOARD: readonly EditAction[] = ['cut', 'copy', 'paste'];

/** The part of the edit commands that touches the document's focus and clipboard. */
export interface EditHost {
  /** Whether the element that last had the focus outside menus and the palette is a text field. */
  textField(): boolean;
  /** Does the action in that text field. */
  inTextField(action: EditAction): void;
  /** Sends the DOM clipboard event of the action to the panel's focused element. */
  clipboardEvent(action: 'cut' | 'copy' | 'paste', panel: PanelId): void;
}

export type EditRoute =
  | { readonly to: 'text-field' }
  | { readonly to: 'command'; readonly id: string }
  | { readonly to: 'clipboard-event'; readonly panel: PanelId }
  | null;

/**
 * Where an edit command goes: to the text field that has the focus; else to the focused panel, as its command
 * `<panel>.<action>` when it declares one, and for cut, copy and paste as the DOM clipboard event (8.8 rule 3).
 * Null: nowhere, and the command is disabled.
 */
export function editRoute(
  action: EditAction,
  where: { readonly textField: boolean; readonly focusedPanel: PanelId | null; has(commandId: string): boolean },
): EditRoute {
  if (where.textField) return { to: 'text-field' };
  const panel = where.focusedPanel;
  if (panel === null) return null;
  const id = `${panel}.${action}`;
  if (where.has(id)) return { to: 'command', id };
  return CLIPBOARD.includes(action) ? { to: 'clipboard-event', panel } : null;
}

export type PaletteMode = 'commands' | 'recent';

export interface ShellCommandHost {
  readonly project: ProjectService;
  readonly edit: EditHost;
  readonly testMode: boolean;
  hasCommand(id: string): boolean;
  /** Whether a command would run now. Without it a panel's edit command counts as enabled whenever it is declared. */
  commandEnabled?(id: string): boolean;
  recent(): readonly string[];
  paused(): boolean;
  setPaused(paused: boolean): void;
  openPalette(mode: PaletteMode): void;
  showDialog(kind: 'preferences' | 'errors' | 'gallery'): void;
  resetLayout(): void;
  closeWindow(): void;
  /** Ends the engine worker and starts another in its place. */
  restartEngine(): void;
}

const EDIT_TITLES: Readonly<Record<EditAction, string>> = { cut: 'Cut', copy: 'Copy', paste: 'Paste', delete: 'Delete', selectAll: 'Select All' };

export function shellCommands(host: ShellCommandHost): CommandDef[] {
  const edit = (action: EditAction): CommandDef => {
    const route = (focusedPanel: PanelId | null): EditRoute =>
      editRoute(action, { textField: host.edit.textField(), focusedPanel, has: host.hasCommand });
    return {
      id: `edit.${action}`,
      title: EDIT_TITLES[action],
      enabled(ctx) {
        const target = route(ctx.ui.getState().focusedPanel);
        // "Delete" with nothing selected in the graph is the graph's own disabled command, and is shown as that.
        return target !== null && (target.to !== 'command' || (host.commandEnabled?.(target.id) ?? true));
      },
      run(ctx) {
        const target = route(ctx.ui.getState().focusedPanel);
        if (target?.to === 'text-field') host.edit.inTextField(action);
        else if (target?.to === 'command') ctx.run(target.id);
        else if (target?.to === 'clipboard-event') host.edit.clipboardEvent(action as 'cut' | 'copy' | 'paste', target.panel);
      },
    };
  };

  const commands: CommandDef[] = [
    { id: 'file.new', title: 'New Project', run: async () => { await host.project.newProject(); } },
    { id: 'file.open', title: 'Open Project…', run: async () => { await host.project.open(); } },
    { id: 'file.openRecent', title: 'Open Recent…', enabled: () => host.recent().length > 0, run: () => host.openPalette('recent') },
    { id: 'file.clearRecent', title: 'Clear Recent Projects', enabled: () => host.recent().length > 0, run: () => host.project.clearRecent() },
    { id: 'file.save', title: 'Save', run: async () => { await host.project.save(); } },
    { id: 'file.saveAs', title: 'Save As…', run: async () => { await host.project.saveAs(); } },
    { id: 'file.exit', title: 'Exit', run: () => host.closeWindow() },

    { id: 'edit.undo', title: 'Undo', enabled: (ctx) => ctx.doc.getState().past.length > 0, run: (ctx) => ctx.doc.getState().undo() },
    { id: 'edit.redo', title: 'Redo', enabled: (ctx) => ctx.doc.getState().future.length > 0, run: (ctx) => ctx.doc.getState().redo() },
    ...EDIT_ACTIONS.map(edit),
    { id: 'edit.preferences', title: 'Preferences…', run: () => host.showDialog('preferences') },

    { id: 'view.commandPalette', title: 'Command Palette…', run: () => host.openPalette('commands') },
    { id: 'view.resetLayout', title: 'Reset Layout', run: () => host.resetLayout() },
    { id: 'view.showErrors', title: 'Show Errors', run: () => host.showDialog('errors') },

    { id: 'engine.togglePause', title: 'Pause or Resume Previews', run: () => host.setPaused(!host.paused()) },
    {
      id: 'engine.retryDevice',
      title: 'Retry Graphics Device',
      enabled: (ctx) => ctx.engineState.getState().device.state === 'failed',
      run(ctx) {
        // An engine that never had a device has no session to ask (8.3): its worker stopped, and only another
        // worker tries again. One that lost its device recovers in place (7.8 rule 3).
        if (ctx.engineState.getState().device.caps === null) host.restartEngine();
        else ctx.engine.retryDevice();
      },
    },
    { id: 'engine.restart', title: 'Restart Engine', run: () => host.restartEngine() },
  ];
  // A page with one of every shared control: what tests/ui/shell/controls.test.ts drives. Not in the product's menus.
  if (host.testMode) commands.push({ id: 'view.controlGallery', title: 'Control Gallery', run: () => host.showDialog('gallery') });
  return commands;
}

/** The global default bindings (8.8). `build.start` and `viewport.toggleTop` are commands of their panels. */
export const SHELL_KEYS: readonly KeyBinding[] = [
  { key: 'Mod+N', command: 'file.new', scope: 'global' },
  { key: 'Mod+O', command: 'file.open', scope: 'global' },
  { key: 'Mod+S', command: 'file.save', scope: 'global' },
  { key: 'Mod+Shift+S', command: 'file.saveAs', scope: 'global' },
  { key: 'Mod+Z', command: 'edit.undo', scope: 'global' },
  { key: 'Mod+Shift+Z', command: 'edit.redo', scope: 'global' },
  { key: 'Mod+Y', command: 'edit.redo', scope: 'global' },
  { key: 'Mod+Comma', command: 'edit.preferences', scope: 'global' },
  { key: 'Mod+Shift+P', command: 'view.commandPalette', scope: 'global' },
  { key: 'F1', command: 'view.commandPalette', scope: 'global' },
  { key: 'Backquote', command: 'engine.togglePause', scope: 'global' },
  { key: 'Mod+B', command: 'build.start', scope: 'global' },
  { key: 'F6', command: 'viewport.toggleTop', scope: 'global' },
];

export const SHELL_MENU: readonly MenuEntry[] = [
  { menu: 'File', command: 'file.new', group: 'open' },
  { menu: 'File', command: 'file.open', group: 'open' },
  { menu: 'File', command: 'file.openRecent', group: 'open' },
  { menu: 'File', command: 'file.save', group: 'save' },
  { menu: 'File', command: 'file.saveAs', group: 'save' },
  { menu: 'File', command: 'file.exit', group: 'exit' },
  { menu: 'Edit', command: 'edit.undo', group: 'history' },
  { menu: 'Edit', command: 'edit.redo', group: 'history' },
  { menu: 'Edit', command: 'edit.cut', group: 'clipboard' },
  { menu: 'Edit', command: 'edit.copy', group: 'clipboard' },
  { menu: 'Edit', command: 'edit.paste', group: 'clipboard' },
  { menu: 'Edit', command: 'edit.delete', group: 'clipboard' },
  { menu: 'Edit', command: 'edit.selectAll', group: 'clipboard' },
  { menu: 'Edit', command: 'edit.preferences', group: 'preferences' },
  { menu: 'View', command: 'view.commandPalette', group: 'palette' },
  { menu: 'View', command: 'view.resetLayout', group: 'layout' },
  { menu: 'View', command: 'view.showErrors', group: 'layout' },
  { menu: 'Engine', command: 'engine.togglePause', group: 'engine' },
  { menu: 'Engine', command: 'engine.retryDevice', group: 'engine' },
  { menu: 'Engine', command: 'engine.restart', group: 'engine' },
];

export function shellSource(host: ShellCommandHost): CommandSource {
  return { owner: SHELL_OWNER, commands: shellCommands(host), keys: SHELL_KEYS, menu: SHELL_MENU };
}
