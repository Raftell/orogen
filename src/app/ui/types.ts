// What a panel is to the shell (runtime.md 8.7, 8.8): the types of a PanelDef and of the commands, keys and menu
// entries it brings. They live here because a panel imports from src/app/ui/ and never from src/app/shell/ or
// src/app/registry.ts. This file has no code and no import that runs.

import type { ComponentType } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { EngineSession, NodeRegistry } from '../../core/runtime.ts';
import type { PlatformApi } from '../platform.ts';
import type { DocState } from '../state/doc-store.ts';
import type { EngineState } from '../state/engine-store.ts';
import type { PanelId, UiState } from '../state/ui-store.ts';

export type { PanelId };

export interface CommandContext {
  readonly doc: StoreApi<DocState>;
  readonly engineState: StoreApi<EngineState>;
  readonly ui: StoreApi<UiState>;
  readonly engine: EngineSession;            // the EngineClient
  readonly platform: PlatformApi;
  readonly registry: NodeRegistry;           // createRegistry(nodes), made once in src/app/main.tsx
  /** Runs a command when it is enabled. Throws for an id no panel and no shell list declares. */
  run(commandId: string): void;
}

export interface CommandDef {
  readonly id: string;                       // '<owner>.<name>': 'graph.toggleBypass'
  readonly title: string;                    // shown in the palette and in menus
  enabled?(ctx: CommandContext): boolean;    // default: always
  run(ctx: CommandContext): void | Promise<void>;
}

export interface KeyBinding {
  readonly key: string;                      // 'Mod+Shift+Z', 'Tab', 'B', 'F2', 'Backquote'
  readonly command: string;
  readonly scope: PanelId | 'global';
}

/** One entry of the menu bar. The item's label is the command's title and its key the command's current key. */
export interface MenuEntry {
  readonly menu: string;                     // the title of a top-level menu: 'File', 'Edit', 'View', 'Graph'
  readonly command: string;
  readonly group?: string;                   // entries of one group stay together; a separator is drawn between groups
}

export interface PanelDef {
  readonly id: PanelId;
  readonly title: string;
  readonly component: ComponentType;
  readonly keepMounted: boolean;             // true for panels that own a canvas
  readonly placement: { readonly relativeTo?: PanelId; readonly direction?: 'left' | 'right' | 'above' | 'below' | 'within' };
  readonly commands: readonly CommandDef[];
  readonly keys: readonly KeyBinding[];
  readonly menu?: readonly MenuEntry[];
}

/** A message of the notification area. An error stays until it is dismissed; the others leave by themselves. */
export interface Notice {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;                  // one sentence, no full stop (testing.md 6.2)
  readonly detail?: string;                  // shown when the notice is opened: a stack, a GPU message
}

/** What the shell gives every panel component through `useApp()` (src/app/ui/app.tsx). */
export interface AppServices {
  readonly ctx: CommandContext;
  /** The key that runs the command now, as shown to the user ('Ctrl+Shift+Z'); null: none. Follows Preferences.keymap. */
  keyLabel(commandId: string): string | null;
  /** The command's title; null for an id nobody declares. */
  commandTitle(commandId: string): string | null;
  /** Whether `ctx.run(commandId)` would run the command now. */
  enabled(commandId: string): boolean;
  /** Shows a message in the notification area. */
  notify(notice: Notice): void;
}
