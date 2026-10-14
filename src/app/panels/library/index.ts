// The library panel (runtime.md 8.7): the node catalogue by category with a search, the recently used nodes, and
// the example projects. It reads the node registry and changes no document: an example is opened by the shell's
// project service, as File > Open opens a file, and adding a node is the graph's work (src/app/ui/add-node.ts).
//
// A command that shows something in the panel brings its tab to the front first (`showPanel`), so it works with
// any tab in front; one that acts on what the panel shows is disabled while the panel is hidden.

import type { CommandDef, PanelDef } from '../../ui/index.ts';
import { addNode, panelShown, requestExample, revealPanel, selectedNodeType } from './actions.ts';
import { CATEGORIES, RECENT_SECTION } from './catalog.ts';
import { LibraryPanel } from './LibraryPanel.tsx';
import { libraryStore } from './state.ts';

const state = libraryStore.getState;
/** Every section the node list can have. */
const SECTIONS: readonly string[] = [RECENT_SECTION, ...CATEGORIES.map((category) => category.id)];

const commands: readonly CommandDef[] = [
  {
    id: 'library.search',
    title: 'Find Node…',
    // Behind another tab the panel comes to the front first: the field to type into is in it.
    enabled: () => state().mounted,
    run() {
      revealPanel();
      libraryStore.setState({ tab: 'nodes', searchRequests: state().searchRequests + 1 });
    },
  },
  {
    id: 'library.addNode',
    title: 'Add Selected Node to Graph',
    // The selected node of a list that is shown: nobody adds what they cannot see.
    enabled: () => panelShown() && selectedNodeType() !== null,
    run() {
      const type = selectedNodeType();
      if (type !== null) addNode(type);
    },
  },
  {
    id: 'library.expandAll',
    title: 'Expand All Categories',
    enabled: () => state().collapsed.length > 0,
    run: () => libraryStore.setState({ collapsed: [] }),
  },
  {
    id: 'library.collapseAll',
    title: 'Collapse All Categories',
    enabled: () => SECTIONS.some((section) => !state().collapsed.includes(section)),
    run: () => libraryStore.setState({ collapsed: [...SECTIONS] }),
  },
  {
    id: 'library.clearRecent',
    title: 'Clear Recently Used Nodes',
    enabled: () => state().recent.length > 0,
    run: () => libraryStore.setState({ recent: [] }),
  },
  {
    id: 'library.showNodes',
    title: 'Show Node Library',
    enabled: () => state().mounted,
    run() {
      revealPanel();
      libraryStore.setState({ tab: 'nodes' });
    },
  },
  {
    id: 'library.showExamples',
    title: 'Show Example Projects',
    enabled: () => state().mounted,
    run() {
      revealPanel();
      libraryStore.setState({ tab: 'examples' });
    },
  },
  {
    id: 'library.openExample',
    title: 'Open Selected Example',
    // The selection of the list that is shown: the Examples tab, or the dialog of "Open Example…".
    enabled: () => state().example !== null && (state().tab === 'examples' || state().gallery),
    async run(ctx) {
      const { example } = state();
      if (example !== null) await requestExample(ctx, example);
    },
  },
  {
    id: 'library.browseExamples',
    title: 'Open Example…',
    // The dialog is the panel's: there while the dock holds the panel, whichever tab is in front.
    enabled: () => state().mounted,
    run: () => libraryStore.setState({ gallery: true }),
  },
];

export const panel: PanelDef = {
  id: 'library',
  title: 'Library',
  component: LibraryPanel,
  keepMounted: false,
  // Under the inspector, not behind it: a node that is selected shows its parameters while the library stays open.
  placement: { relativeTo: 'inspector', direction: 'below' },
  commands,
  keys: [
    { key: 'Mod+F', command: 'library.search', scope: 'library' },
  ],
  menu: [
    { menu: 'File', command: 'library.browseExamples', group: 'open' },
    { menu: 'Library', command: 'library.search', group: 'nodes' },
    { menu: 'Library', command: 'library.addNode', group: 'nodes' },
    { menu: 'Library', command: 'library.showNodes', group: 'view' },
    { menu: 'Library', command: 'library.showExamples', group: 'view' },
    { menu: 'Library', command: 'library.expandAll', group: 'view' },
    { menu: 'Library', command: 'library.collapseAll', group: 'view' },
    { menu: 'Library', command: 'library.clearRecent', group: 'view' },
    { menu: 'Library', command: 'library.openExample', group: 'examples' },
  ],
};
