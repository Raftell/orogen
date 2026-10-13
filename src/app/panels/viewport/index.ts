// The viewport panel (runtime.md 8.7): the canvas, camera control, overlays, the height readout. This is the
// panel's starting state; its owner builds it. Two things are here from the start. The canvas, because the
// engine worker draws the shown terrain to whatever canvas is attached and the pipeline is checked end to end
// by looking at it: this is what the page did before the frame existed. And `viewport.toggleTop`, because the
// shell binds F6 to it (8.8) and a binding to a command nobody declares stops start-up; it has no camera to
// switch yet and is disabled.

import type { PanelDef } from '../../ui/index.ts';
import { ViewportPanel } from './ViewportPanel.tsx';

export const panel: PanelDef = {
  id: 'viewport',
  title: 'Viewport',
  component: ViewportPanel,
  keepMounted: true,
  placement: {},
  commands: [
    { id: 'viewport.toggleTop', title: 'Toggle Top View', enabled: () => false, run: () => undefined },
  ],
  keys: [],
  menu: [{ menu: 'View', command: 'viewport.toggleTop', group: 'viewport' }],
};
