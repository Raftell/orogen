// The viewport panel (runtime.md 8.7): the canvas the engine worker draws the shown terrain to, the camera and
// its control, the display options, and the readout of what lies under the pointer. `viewport.toggleTop` has F6
// from the shell's global bindings (8.8).

import type { PanelDef } from '../../ui/index.ts';
import { commands, keys, menu } from './commands.ts';
import { ViewportPanel } from './ViewportPanel.tsx';

export const panel: PanelDef = {
  id: 'viewport',
  title: 'Viewport',
  component: ViewportPanel,
  keepMounted: true,
  placement: {},
  commands,
  keys,
  menu,
};
