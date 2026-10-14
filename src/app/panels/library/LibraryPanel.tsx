// The library panel (runtime.md 8.7): the node catalogue with its search, and the example projects. The panel is
// where a new user starts, so its second tab and the dialog of "Open Example…" hold complete projects to open.

import { useEffect, useMemo, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';

import { commandItems, Dialog, IconButton, Menu, useApp } from '../../ui/index.ts';
import { bindElement, bindPanel } from './actions.ts';
import { catalogOf } from './catalog.ts';
import { EXAMPLES } from './example-files.ts';
import { ExampleBrowser } from './ExampleBrowser.tsx';
import styles from './library.module.css';
import { NodeBrowser } from './NodeBrowser.tsx';
import { libraryStore, watchAddedNodes, type LibraryTab } from './state.ts';

/** The commands of the panel's own menu, in its order; null is a separator. */
const MENU: readonly (string | null)[] = [
  'library.search', 'library.addNode', null,
  'library.expandAll', 'library.collapseAll', 'library.clearRecent', null,
  'library.openExample', 'library.browseExamples',
];

const TABS: readonly { readonly id: LibraryTab; readonly title: string; readonly command: string }[] = [
  { id: 'nodes', title: 'Nodes', command: 'library.showNodes' },
  { id: 'examples', title: 'Examples', command: 'library.showExamples' },
];

export function LibraryPanel() {
  const app = useApp();
  const { ctx } = app;
  const tab = useStore(libraryStore, (state) => state.tab);
  const gallery = useStore(libraryStore, (state) => state.gallery);
  const catalog = useMemo(() => catalogOf(ctx.registry), [ctx.registry]);

  // The dock keeps this component while another tab is in front: the recent nodes follow the document from the
  // start, and "Open Example…" can open its dialog from anywhere.
  useEffect(() => {
    bindPanel(app);
    const stop = watchAddedNodes(libraryStore, ctx.doc, (type) => catalog.get(type) !== undefined);
    return () => {
      stop();
      bindPanel(null);
    };
  }, [app, ctx.doc, catalog]);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = TABS.find((candidate) => candidate.id !== tab)!;
    ctx.run(next.command);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
    event.preventDefault();
  }

  return (
    <div className={styles.root} data-library="root" ref={bindElement}>
      <div className={styles.tabs} role="tablist" aria-label="Library">
        {TABS.map(({ id, title, command }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            data-tab={id}
            onClick={() => ctx.run(command)}
            onKeyDown={onTabKey}
          >
            {title}
            <span className={styles.tabCount}>{id === 'nodes' ? catalog.entries.length : EXAMPLES.length}</span>
          </button>
        ))}
        <div className={styles.tabsEnd}>
          <Menu align="end" trigger={<IconButton icon="more" label="Library Commands" size="small" data-action="menu" />} items={() => commandItems(app, MENU)} />
        </div>
      </div>

      {tab === 'nodes' ? <NodeBrowser catalog={catalog} /> : <div className={styles.view}><ExampleBrowser place="panel" /></div>}

      <Dialog open={gallery} name="library-examples" title="Open Example" width={880} onClose={() => libraryStore.setState({ gallery: false })}>
        {gallery ? <ExampleBrowser place="dialog" /> : null}
      </Dialog>
    </div>
  );
}
