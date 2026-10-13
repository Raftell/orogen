// The frame of the application (runtime.md 8.7 rule 3): the menu bar, the dock with the panels, the status
// bar, and above them the palette, the notices and the shell's dialogs.

import { useEffect } from 'react';

import { AppProvider, TooltipProvider } from '../ui/index.ts';
import { Dialogs } from './Dialogs.tsx';
import { Dock, type DockHandle } from './Dock.tsx';
import { windowTitle } from './format.ts';
import { MenuBar } from './MenuBar.tsx';
import { Notices } from './Notices.tsx';
import { Palette } from './Palette.tsx';
import type { Shell } from './shell.ts';
import { StatusBar } from './StatusBar.tsx';

export function ShellFrame(props: { readonly shell: Shell; exposeDock?(handle: DockHandle | null): void }) {
  const { shell } = props;

  // The window's title is the page's: the project, and a star while it has unsaved changes.
  useEffect(() => {
    const { doc } = shell.ctx;
    const write = (): void => { document.title = windowTitle(doc.getState().path, doc.getState().unsaved); };
    write();
    return doc.subscribe((state, previous) => {
      if (state.path !== previous.path || state.unsaved !== previous.unsaved) write();
    });
  }, [shell]);

  return (
    <TooltipProvider>
      <AppProvider services={shell.services}>
        <div className="og-shell" data-ui="shell">
          <MenuBar shell={shell} />
          <main className="og-dock-host"><Dock shell={shell} expose={props.exposeDock} /></main>
          <StatusBar shell={shell} />
          <Notices shell={shell} />
          <Palette shell={shell} />
        </div>
        <Dialogs shell={shell} />
      </AppProvider>
    </TooltipProvider>
  );
}
