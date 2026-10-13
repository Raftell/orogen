// The build panel (runtime.md 8.7): build settings, start and cancel, progress, the plan and its problems, the
// list of written files. This is the panel's starting state, a PanelDef with an empty component; its owner
// builds it. `build.start` and `build.cancel` are here from the start because the shell binds Mod+B to the first
// (8.8) and a binding to a command nobody declares stops start-up: they do the least a build needs, which is to
// ask for the output folder every time.

import type { CommandDef, PanelDef } from '../../ui/index.ts';
import { BuildPanel } from './BuildPanel.tsx';

const commands: readonly CommandDef[] = [
  {
    id: 'build.start',
    title: 'Build…',
    enabled: (ctx) => {
      const { device, build } = ctx.engineState.getState();
      return device.state === 'ready' && !build.running;
    },
    async run(ctx) {
      const outDir = await ctx.platform.chooseFolder();
      if (outDir === null) return;
      // The result arrives in engineStore.build with the events; a build that fails resolves as well (7.6).
      await ctx.engine.build({ doc: ctx.doc.getState().doc, outDir });
    },
  },
  {
    id: 'build.cancel',
    title: 'Cancel Build',
    enabled: (ctx) => ctx.engineState.getState().build.running,
    run: (ctx) => ctx.engine.cancelBuild(),
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
