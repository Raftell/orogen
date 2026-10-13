// The menu bar (runtime.md 8.8 rule 1): every menu is built from the menu entries the shell and the panels
// registered, at the moment it opens, so that titles, keys and what is enabled are those of that moment.

import { Menu as Base } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import { useStore } from 'zustand';

import { CommandButton, IconButton, MenuItems, type MenuItemSpec } from '../ui/index.ts';
import { baseName, folderOf, projectName } from './format.ts';
import { formatKey } from './keys.ts';
import type { Shell } from './shell.ts';

/** The folder of a recent project, shortened from the left when it is long. */
function shortFolder(path: string): string {
  const folder = folderOf(path);
  return folder.length <= 36 ? folder : `…${folder.slice(-35)}`;
}

function recentItems(shell: Shell): MenuItemSpec {
  const { recent } = shell.state.getState().preferences;
  return {
    type: 'submenu',
    label: 'Open Recent',
    id: 'file.openRecent',
    disabled: recent.length === 0,
    items: [
      ...recent.map((path): MenuItemSpec => ({
        label: baseName(path),
        keyLabel: shortFolder(path),
        id: `recent:${path}`,
        onSelect: () => { void shell.project.openPath(path); },
      })),
      { type: 'separator' },
      { label: 'Clear Recent Projects', id: 'file.clearRecent', onSelect: () => shell.runner.run('file.clearRecent') },
    ],
  };
}

/** Rendered while its menu is open only, and so made anew at each opening. */
function MenuContent(props: { readonly shell: Shell; readonly title: string }) {
  const { shell } = props;
  const menu = shell.menus().find((candidate) => candidate.title === props.title);
  const items = (menu?.items ?? []).map((item): MenuItemSpec => {
    if (item.kind === 'separator') return { type: 'separator' };
    if (item.command === 'file.openRecent') return recentItems(shell);
    return {
      label: item.title,
      keyLabel: item.key === null ? null : formatKey(item.key, shell.keyPlatform),
      disabled: !shell.runner.enabled(item.command),
      id: item.command,
      onSelect: () => shell.runner.run(item.command),
    };
  });
  return <MenuItems items={items} />;
}

export function MenuBar(props: { readonly shell: Shell }) {
  const { shell } = props;
  const path = useStore(shell.ctx.doc, (state) => state.path);
  const unsaved = useStore(shell.ctx.doc, (state) => state.unsaved);
  const paused = useStore(shell.state, (state) => state.paused);
  // The keys of the tooltips below follow the keymap.
  useStore(shell.state, (state) => state.preferences.keymap);
  const titles = shell.menus().map((menu) => menu.title);

  return (
    <header className="og-menubar" data-shell="menubar">
      <Menubar className="og-menubar-menus">
        {titles.map((title) => (
          <Base.Root key={title}>
            <Base.Trigger className="og-menubar-item" data-menu={title}>{title}</Base.Trigger>
            <Base.Portal>
              <Base.Positioner side="bottom" align="start" sideOffset={3} collisionPadding={6} data-chrome="">
                <Base.Popup className="og-popup og-menu" data-ui="menu" data-menu={title}>
                  <MenuContent shell={shell} title={title} />
                </Base.Popup>
              </Base.Positioner>
            </Base.Portal>
          </Base.Root>
        ))}
      </Menubar>
      <div className="og-menubar-title" data-ui="project-title" title={path ?? undefined}>
        <span className="og-menubar-title-name">{projectName(path)}</span>{unsaved ? ' (unsaved)' : ''}
      </div>
      <div className="og-menubar-tools">
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? 'Resume Previews' : 'Pause Previews'}
          keyLabel={shell.services.keyLabel('engine.togglePause')}
          pressed={paused}
          onClick={() => shell.runner.run('engine.togglePause')}
          data-command="engine.togglePause"
        />
        <CommandButton command="edit.preferences" icon="settings" />
      </div>
    </header>
  );
}
