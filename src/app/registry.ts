// The panel registry (runtime.md 8.7 rule 1): the five panels, each from its own folder. Not the node registry
// of 5.1. Written once and frozen: a panel changes what it brings in its own PanelDef, never here.
//
// The order is the order of the tabs where panels share a group, and of the menus the panels add.

import { panel as build } from './panels/build/index.ts';
import { panel as graph } from './panels/graph/index.ts';
import { panel as inspector } from './panels/inspector/index.ts';
import { panel as library } from './panels/library/index.ts';
import { panel as viewport } from './panels/viewport/index.ts';
import type { PanelDef } from './ui/types.ts';

export type { CommandContext, CommandDef, KeyBinding, MenuEntry, PanelDef, PanelId } from './ui/types.ts';

export const panels: readonly PanelDef[] = [viewport, graph, inspector, library, build];
