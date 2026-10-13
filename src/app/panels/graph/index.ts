// The graph panel (runtime.md 8.7): the node graph, the add-node palette, groups, clipboard, node thumbnails
// and status. Its commands, keys and menu entries are in commands.ts; its component is GraphPanel.tsx.

import type { PanelDef } from '../../ui/index.ts';
import { commands, keys, menu } from './commands.ts';
import { GraphPanel } from './GraphPanel.tsx';

export const panel: PanelDef = {
  id: 'graph',
  title: 'Graph',
  component: GraphPanel,
  keepMounted: true,
  placement: { relativeTo: 'viewport', direction: 'below' },
  commands,
  keys,
  menu,
};
