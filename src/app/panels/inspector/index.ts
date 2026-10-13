// The inspector panel (runtime.md 8.7): the parameters of the selected node, generated from its ParamDefs, and
// the project settings. This is the panel's starting state, a PanelDef with an empty component; its owner builds it.

import type { PanelDef } from '../../ui/index.ts';
import { InspectorPanel } from './InspectorPanel.tsx';

export const panel: PanelDef = {
  id: 'inspector',
  title: 'Inspector',
  component: InspectorPanel,
  keepMounted: false,
  // Without a panel to stand beside: the right edge of the whole window.
  placement: { direction: 'right' },
  commands: [],
  keys: [],
};
