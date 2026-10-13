// The inspector panel (runtime.md 8.7): the parameters of the selected node, generated from its ParamDefs, and
// the project settings while nothing is selected. Its commands, their keys and their menu are in commands.ts.

import type { PanelDef } from '../../ui/index.ts';
import { commands, keys, menu } from './commands.ts';
import { InspectorPanel } from './InspectorPanel.tsx';

export const panel: PanelDef = {
  id: 'inspector',
  title: 'Inspector',
  component: InspectorPanel,
  keepMounted: false,
  // Without a panel to stand beside: the right edge of the whole window.
  placement: { direction: 'right' },
  commands,
  keys,
  menu,
};
