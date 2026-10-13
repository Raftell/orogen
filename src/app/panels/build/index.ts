// The build panel (runtime.md 8.7): build settings, start and cancel, progress, the plan and its problems, the
// files written and the numbers Unreal needs. Its commands run whether the panel is in front or not: they act
// on the panel's model (model/store.ts), which the component shows.
//
// `build.start` has Mod+B from the shell's global bindings (8.8). It builds into the folder chosen in the panel
// and asks for one only when none is chosen, or when the one chosen is certain to be refused.

import type { CommandContext, CommandDef, PanelDef } from '../../ui/index.ts';
import { BuildPanel } from './BuildPanel.tsx';
import { importGroups, importText } from './model/manifest.ts';
import { buildModel } from './model/store.ts';
import { copyText } from './parts.tsx';

const running = (ctx: CommandContext): boolean => ctx.engineState.getState().build.running;

/** The values of this project's last build that succeeded, as text; null when there is none. */
function importValues(ctx: CommandContext): string | null {
  const source = buildModel(ctx).importSource();
  if (source === null) return null;
  const groups = importGroups(source.manifest, source.folder);
  return groups.length > 0 ? importText(groups) : null;
}

const commands: readonly CommandDef[] = [
  {
    id: 'build.start',
    title: 'Build',
    enabled: (ctx) => ctx.engineState.getState().device.state === 'ready' && !running(ctx),
    run: (ctx) => buildModel(ctx).start(),
  },
  {
    id: 'build.cancel',
    title: 'Cancel Build',
    enabled: running,
    run: (ctx) => buildModel(ctx).cancel(),
  },
  {
    id: 'build.chooseFolder',
    title: 'Choose Build Folder…',
    enabled: (ctx) => !running(ctx),
    async run(ctx) {
      await buildModel(ctx).chooseFolder();
    },
  },
  {
    id: 'build.revealFolder',
    title: 'Show Build Folder',
    enabled: (ctx) => buildModel(ctx).revealTarget() !== null,
    run: (ctx) => buildModel(ctx).reveal(),
  },
  {
    id: 'build.importGuide',
    title: 'Unreal Import Guide',
    run: (ctx) => buildModel(ctx).setGuideOpen(true),
  },
  {
    id: 'build.copyImportValues',
    title: 'Copy Unreal Import Values',
    // Asked at every change of a store: whether there is a manifest, not what it says.
    enabled: (ctx) => {
      const source = buildModel(ctx).importSource();
      return source !== null && (source.manifest.landscape !== null || source.manifest.textures.length > 0);
    },
    async run(ctx) {
      const text = importValues(ctx);
      if (text !== null) await copyText(text);
    },
  },
  {
    id: 'build.selectProblemNode',
    title: 'Select Node of Build Problem',
    enabled: (ctx) => buildModel(ctx).problemNode() !== null,
    run(ctx) {
      const model = buildModel(ctx);
      const nodeId = model.problemNode();
      if (nodeId !== null) model.selectNode(nodeId);
    },
  },
];

export const panel: PanelDef = {
  id: 'build',
  title: 'Build',
  component: BuildPanel,
  keepMounted: false,
  placement: { relativeTo: 'inspector', direction: 'within' },
  commands,
  keys: [],
  menu: [
    { menu: 'Engine', command: 'build.start', group: 'build' },
    { menu: 'Engine', command: 'build.cancel', group: 'build' },
  ],
};
