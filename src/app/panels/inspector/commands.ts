// The inspector's commands (runtime.md 8.8): what it does that is not the direct handling of a control. A button
// of the panel, the menu, the palette and a key all run these; each acts on what is selected, and "Reset
// Parameter" on the parameter under the pointer, else on the one last pressed or focused (state.ts).

// From types.ts and not from the index of src/app/ui/: this file is loaded by tests that have no window, and the index loads the controls.
import { canBypass } from '../../../core/runtime.ts';
import type { CommandContext, CommandDef, KeyBinding, MenuEntry } from '../../ui/types.ts';
import { randomSeed, resetParamsOf, setFlagsOf, setParamOf, setSettingOf } from './edit.ts';
import { isChanged, isVisible, nodeValues, targetOf, type Target } from './model.ts';
import { activeParam, inspectorStore, sectionKey, setSectionOpen } from './state.ts';

type NodesTarget = Extract<Target, { kind: 'nodes' }>;

const targetIn = (ctx: CommandContext): Target => targetOf(ctx.doc.getState().doc.nodes, ctx.registry, ctx.ui.getState().selection);

/** The selected nodes of one type, when their parameters can be edited. */
function editable(ctx: CommandContext): NodesTarget | null {
  const target = targetIn(ctx);
  return target.kind === 'nodes' && target.locked === null ? target : null;
}

/**
 * The parameters of the target that some node holds at another value than the default: all of them, or the one
 * named, which counts only while its row is shown (a row that `visibleWhen` has hidden is none the user points at).
 */
function changedParams(target: NodesTarget, only?: string | null) {
  const all = target.nodes.map((node) => nodeValues(target.def, node));
  return target.def.params.filter((param) => {
    if (only !== undefined && (param.name !== only || !all.some((values) => isVisible(param, values)))) return false;
    return all.some((values) => isChanged(param, values[param.name]));
  });
}

/** The selected nodes that can be bypassed (engine.md 4.14). */
function bypassable(ctx: CommandContext): { readonly ids: string[]; readonly all: boolean } {
  const target = targetIn(ctx);
  if (target.kind === 'settings') return { ids: [], all: false };
  const nodes = target.nodes.filter((node) => {
    const def = ctx.registry.get(node.type);
    return def !== undefined && canBypass(def);
  });
  return { ids: nodes.map((node) => node.id), all: nodes.length > 0 && nodes.every((node) => node.bypass === true) };
}

const groupsOf = (target: NodesTarget): string[] => [...new Set(target.def.params.flatMap((param) => (param.group ? [param.group] : [])))];

export const commands: readonly CommandDef[] = [
  {
    id: 'inspector.rename',
    title: 'Rename Node',
    // One node of a type this build has: a node of an unknown type is a summary, which has no title field.
    enabled: (ctx) => {
      const target = targetIn(ctx);
      return target.kind === 'nodes' && target.nodes.length === 1;
    },
    run: () => inspectorStore.setState({ renameRequests: inspectorStore.getState().renameRequests + 1 }),
  },
  {
    id: 'inspector.toggleBypass',
    title: 'Bypass Node',
    enabled: (ctx) => bypassable(ctx).ids.length > 0,
    run(ctx) {
      const { ids, all } = bypassable(ctx);
      if (ids.length > 0) setFlagsOf(ctx, ids, all ? 'Enable Node' : 'Bypass Node', { bypass: !all });
    },
  },
  {
    id: 'inspector.resetParameter',
    title: 'Reset Parameter',
    enabled: (ctx) => {
      const target = editable(ctx);
      return target !== null && changedParams(target, activeParam()).length > 0;
    },
    run(ctx) {
      const target = editable(ctx);
      if (target) resetParamsOf(ctx, target, changedParams(target, activeParam()));
    },
  },
  {
    id: 'inspector.resetAll',
    title: 'Reset All Parameters',
    enabled: (ctx) => {
      const target = editable(ctx);
      return target !== null && changedParams(target).length > 0;
    },
    run(ctx) {
      const target = editable(ctx);
      if (target) resetParamsOf(ctx, target, changedParams(target));
    },
  },
  {
    id: 'inspector.randomizeSeed',
    title: 'Randomize Seed',
    // With nothing selected the seed is the project's.
    enabled: (ctx) => {
      const target = targetIn(ctx);
      return target.kind === 'settings' || (target.kind === 'nodes' && target.locked === null && target.def.params.some((param) => param.kind === 'seed'));
    },
    run(ctx) {
      const target = targetIn(ctx);
      if (target.kind === 'settings') {
        setSettingOf(ctx, 'seed', randomSeed());
        return;
      }
      const seed = target.kind === 'nodes' && target.locked === null ? target.def.params.find((param) => param.kind === 'seed') : undefined;
      if (target.kind === 'nodes' && seed) setParamOf(ctx, target, seed, randomSeed());
    },
  },
  {
    id: 'inspector.reloadFiles',
    title: 'Reload Files',
    enabled: (ctx) => {
      const target = targetIn(ctx);
      return target.kind === 'nodes' && target.def.params.some((param) => param.kind === 'file');
    },
    // Told its project again, the engine looks at every file anew and computes what reads a file that changed (runtime.md 7.1).
    run: (ctx) => ctx.engine.setProject({ path: ctx.doc.getState().path }),
  },
  {
    id: 'inspector.expandAll',
    title: 'Expand All Sections',
    enabled: (ctx) => {
      const target = targetIn(ctx);
      return target.kind === 'nodes' && groupsOf(target).length > 0;
    },
    run(ctx) {
      const target = targetIn(ctx);
      if (target.kind === 'nodes') for (const group of groupsOf(target)) setSectionOpen(sectionKey(target.def.type, group), true);
    },
  },
  {
    id: 'inspector.collapseAll',
    title: 'Collapse All Sections',
    enabled: (ctx) => {
      const target = targetIn(ctx);
      return target.kind === 'nodes' && groupsOf(target).length > 0;
    },
    run(ctx) {
      const target = targetIn(ctx);
      if (target.kind === 'nodes') for (const group of groupsOf(target)) setSectionOpen(sectionKey(target.def.type, group), false);
    },
  },
];

/** The keys the graph gives the same two actions, here for the panel that shows the node. */
export const keys: readonly KeyBinding[] = [
  { key: 'F2', command: 'inspector.rename', scope: 'inspector' },
  { key: 'B', command: 'inspector.toggleBypass', scope: 'inspector' },
];

export const menu: readonly MenuEntry[] = [
  { menu: 'Inspector', command: 'inspector.rename', group: 'node' },
  { menu: 'Inspector', command: 'inspector.toggleBypass', group: 'node' },
  { menu: 'Inspector', command: 'inspector.resetParameter', group: 'parameters' },
  { menu: 'Inspector', command: 'inspector.resetAll', group: 'parameters' },
  { menu: 'Inspector', command: 'inspector.randomizeSeed', group: 'parameters' },
  { menu: 'Inspector', command: 'inspector.reloadFiles', group: 'parameters' },
  { menu: 'Inspector', command: 'inspector.expandAll', group: 'sections' },
  { menu: 'Inspector', command: 'inspector.collapseAll', group: 'sections' },
];
