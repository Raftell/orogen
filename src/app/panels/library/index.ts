// The library panel (runtime.md 8.7): the node catalogue by category, with search. This is the panel's starting
// state, a PanelDef with an empty component; its owner builds it.

import type { PanelDef } from '../../ui/index.ts';
import { LibraryPanel } from './LibraryPanel.tsx';

export const panel: PanelDef = {
  id: 'library',
  title: 'Library',
  component: LibraryPanel,
  keepMounted: false,
  placement: { relativeTo: 'inspector', direction: 'within' },
  commands: [],
  keys: [],
};
