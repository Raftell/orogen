// The commands of the graph panel, their default keys and their menu entries (runtime.md 8.8). Everything a
// user does in the graph that is not direct manipulation is one of these. Cut, copy and paste are not among
// them: they arrive as the DOM's clipboard events (8.8 rules 3 and 6), and the shell's Edit commands send those
// to the panel. No DOM and no React: the mounted graph is reached through `graphHost`.

// The types alone, from the file that declares them: this module is also loaded where no React is (the window-free tests).
import type { CommandContext, CommandDef, KeyBinding, MenuEntry } from '../../ui/types.ts';
import {
  bypassable, canToggleViewLock, deleteSelection, duplicateSelection, groupSelection, hasSelection, insertTarget, renameTarget, selectAll, selectContents,
  selectedGroups, selectedNodes, terrainCandidate, toggleBypass, toggleCollapsed, toggleViewLock, useAsTerrain,
} from './actions.ts';
import { graphHost, graphStore } from './state.ts';

const hasNodes = (ctx: CommandContext): boolean => Object.keys(ctx.doc.getState().doc.nodes).length > 0;
const hasAnything = (ctx: CommandContext): boolean => hasNodes(ctx) || Object.keys(ctx.doc.getState().doc.groups).length > 0;

export const commands: readonly CommandDef[] = [
  { id: 'graph.addNode', title: 'Add Node…', enabled: () => graphHost() !== null, run: () => graphHost()?.openPalette() },
  {
    id: 'graph.insertNode',
    title: 'Insert Node…',
    enabled: (ctx) => graphHost() !== null && insertTarget(ctx) !== null,
    run(ctx) {
      const wire = insertTarget(ctx);
      if (wire !== null) graphHost()?.openPalette(wire);
    },
  },
  { id: 'graph.delete', title: 'Delete', enabled: hasSelection, run: (ctx) => { deleteSelection(ctx); } },
  { id: 'graph.selectAll', title: 'Select All', enabled: hasAnything, run: selectAll },
  { id: 'graph.duplicate', title: 'Duplicate', enabled: (ctx) => selectedNodes(ctx).length > 0, run: (ctx) => { duplicateSelection(ctx); } },
  {
    id: 'graph.rename',
    title: 'Rename',
    enabled: (ctx) => renameTarget(ctx) !== null,
    run(ctx) {
      const target = renameTarget(ctx);
      if (target) graphStore.setState({ renaming: target, palette: null });
    },
  },
  { id: 'graph.toggleBypass', title: 'Bypass', enabled: (ctx) => bypassable(ctx).length > 0, run: (ctx) => { toggleBypass(ctx); } },
  { id: 'graph.toggleCollapse', title: 'Collapse or Expand', enabled: (ctx) => selectedNodes(ctx).length > 0, run: (ctx) => { toggleCollapsed(ctx); } },
  { id: 'graph.useAsTerrain', title: 'Use as Terrain', enabled: (ctx) => terrainCandidate(ctx) !== null, run: (ctx) => { useAsTerrain(ctx); } },
  { id: 'graph.toggleViewLock', title: 'Lock or Unlock the View', enabled: canToggleViewLock, run: (ctx) => { toggleViewLock(ctx); } },
  { id: 'graph.group', title: 'Group', enabled: (ctx) => selectedNodes(ctx).length > 0, run: (ctx) => { groupSelection(ctx); } },
  { id: 'graph.selectContents', title: 'Select Group Contents', enabled: (ctx) => selectedGroups(ctx).length > 0, run: (ctx) => { selectContents(ctx); } },
  { id: 'graph.fit', title: 'Fit Graph', enabled: (ctx) => graphHost() !== null && hasAnything(ctx), run: () => graphHost()?.fit() },
  { id: 'graph.toggleMinimap', title: 'Show or Hide the Minimap', run: () => graphStore.setState({ minimap: !graphStore.getState().minimap }) },
];

// The default bindings of the graph scope (8.8), and three the panel adds in its own scope.
export const keys: readonly KeyBinding[] = [
  { key: 'Tab', command: 'graph.addNode', scope: 'graph' },
  { key: 'Delete', command: 'graph.delete', scope: 'graph' },
  { key: 'Backspace', command: 'graph.delete', scope: 'graph' },
  { key: 'Mod+D', command: 'graph.duplicate', scope: 'graph' },
  { key: 'B', command: 'graph.toggleBypass', scope: 'graph' },
  { key: 'F', command: 'graph.toggleViewLock', scope: 'graph' },
  { key: 'G', command: 'graph.useAsTerrain', scope: 'graph' },
  { key: 'Mod+G', command: 'graph.group', scope: 'graph' },
  { key: 'F2', command: 'graph.rename', scope: 'graph' },
  { key: 'Mod+0', command: 'graph.fit', scope: 'graph' },
  { key: 'Home', command: 'graph.fit', scope: 'graph' },
  { key: 'Mod+A', command: 'graph.selectAll', scope: 'graph' },
  { key: 'H', command: 'graph.toggleCollapse', scope: 'graph' },
  { key: 'M', command: 'graph.toggleMinimap', scope: 'graph' },
];

export const menu: readonly MenuEntry[] = [
  { menu: 'Graph', command: 'graph.addNode', group: 'add' },
  { menu: 'Graph', command: 'graph.insertNode', group: 'add' },
  { menu: 'Graph', command: 'graph.duplicate', group: 'nodes' },
  { menu: 'Graph', command: 'graph.rename', group: 'nodes' },
  { menu: 'Graph', command: 'graph.toggleBypass', group: 'nodes' },
  { menu: 'Graph', command: 'graph.toggleCollapse', group: 'nodes' },
  { menu: 'Graph', command: 'graph.group', group: 'nodes' },
  { menu: 'Graph', command: 'graph.selectContents', group: 'nodes' },
  { menu: 'Graph', command: 'graph.useAsTerrain', group: 'view' },
  { menu: 'Graph', command: 'graph.toggleViewLock', group: 'view' },
  { menu: 'Graph', command: 'graph.fit', group: 'canvas' },
  { menu: 'Graph', command: 'graph.toggleMinimap', group: 'canvas' },
];
