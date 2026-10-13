// The command palette (runtime.md 8.8 rule 1): every command by its title, found by typing a few of its
// letters, with its current key. The same list opens recent projects.

import fuzzysort from 'fuzzysort';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';

import { Icon } from '../ui/index.ts';
import type { PaletteMode } from './app-commands.ts';
import { folderOf, projectName } from './format.ts';
import { formatKey } from './keys.ts';
import type { Shell } from './shell.ts';

interface Entry {
  readonly id: string;
  readonly title: string;
  /** Searched beside the title, and not shown for a command. */
  readonly extra: string;
  readonly note: string | null;
  readonly keyLabel: string | null;
  readonly enabled: boolean;
  run(): void;
}

/** What the list holds when the palette opens. */
function entriesOf(shell: Shell, mode: PaletteMode): Entry[] {
  if (mode === 'recent') {
    return shell.state.getState().preferences.recent.map((path) => ({
      id: path, title: projectName(path), extra: path, note: folderOf(path), keyLabel: null, enabled: true,
      run: () => { void shell.project.openPath(path); },
    }));
  }
  const keymap = shell.keymap();
  const panelTitles = new Map<string, string>(shell.panels.map((panel) => [panel.id, panel.title]));
  return shell.commands.commands
    // The palette does not offer itself.
    .filter(({ def }) => def.id !== 'view.commandPalette')
    .map(({ def }) => {
      const key = keymap.keysOf(def.id)[0];
      const prefix = def.id.slice(0, def.id.indexOf('.'));
      return {
        id: def.id,
        title: def.title.replace(/…$/, ''),
        extra: def.id,
        // Whose command it is: "Delete" and "Rename" are commands of more than one panel.
        note: panelTitles.get(prefix) ?? prefix.charAt(0).toUpperCase() + prefix.slice(1),
        keyLabel: key === undefined ? null : formatKey(key, shell.keyPlatform),
        enabled: shell.runner.enabled(def.id),
        run: () => shell.runner.run(def.id),
      };
    });
}

/** Matches shown for what was typed. */
const SHOWN_MAX = 60;
/**
 * Entries listed while nothing is typed: every command of the shell and of the five panels (about eighty), so
 * that a list read from top to bottom is the whole list. A bound, not a page: nothing is behind it.
 */
const LISTED_MAX = 400;

interface Row { readonly entry: Entry; readonly title: ReactNode }

function rowsOf(entries: readonly Entry[], query: string): Row[] {
  if (query.trim() === '') return entries.slice(0, LISTED_MAX).map((entry) => ({ entry, title: entry.title }));
  return fuzzysort.go(query.trim(), entries, { keys: ['title', 'extra'], limit: SHOWN_MAX, threshold: 0.2 }).map((found) => {
    const inTitle = found[0];
    const title = inTitle && inTitle.score > 0 ? inTitle.highlight((match, index) => <b key={index}>{match}</b>) : found.obj.title;
    return { entry: found.obj, title };
  });
}

function PaletteList(props: { readonly shell: Shell; readonly mode: PaletteMode }) {
  const { shell, mode } = props;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const entries = useMemo(() => entriesOf(shell, mode), [shell, mode]);
  const rows = useMemo(() => rowsOf(entries, query), [entries, query]);
  const list = useRef<HTMLUListElement>(null);
  /** What had the focus before: it gets the focus back, so a command still finds its panel. */
  const before = useRef<Element | null>(document.activeElement);

  const index = Math.min(selected, Math.max(0, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, rows]);

  function close(): void {
    shell.closePalette();
    if (before.current instanceof HTMLElement && before.current.isConnected) before.current.focus();
  }

  function run(row: Row | undefined): void {
    if (!row || !row.entry.enabled) return;
    close();
    row.entry.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const page = 8;
    const moves: Readonly<Record<string, number>> = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      setSelected(Math.min(rows.length - 1, Math.max(0, moves[event.key]!)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(rows[index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      // The palette keeps the focus while it is open.
      event.preventDefault();
    }
  }

  return (
    <>
      <div className="og-palette-backdrop" data-chrome="" onPointerDown={close} />
      <div className="og-palette" role="dialog" aria-label={mode === 'recent' ? 'Open Recent' : 'Command Palette'} data-chrome="" data-ui="palette" data-mode={mode}>
        <div className="og-palette-input-row">
          <Icon name="search" />
          <input
            className="og-palette-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="og-palette-list"
            aria-activedescendant={rows[index] ? `og-palette-item-${index}` : undefined}
            placeholder={mode === 'recent' ? 'Open a recent project' : 'Type the name of a command'}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              // A click on an item takes the focus for a moment and gives it back; anything else closes the palette.
              if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.og-palette')) shell.closePalette();
            }}
          />
        </div>
        {rows.length === 0 ? (
          <div className="og-palette-empty">{mode === 'recent' ? 'No recent project matches' : 'No command matches'}</div>
        ) : (
          <ul className="og-palette-list" id="og-palette-list" role="listbox" ref={list} tabIndex={-1}>
            {rows.map((row, at) => (
              <li
                key={row.entry.id}
                id={`og-palette-item-${at}`}
                className="og-palette-item"
                role="option"
                aria-selected={at === index}
                aria-disabled={!row.entry.enabled}
                data-id={row.entry.id}
                onPointerMove={() => { if (at !== index) setSelected(at); }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => run(row)}
              >
                <span className="og-palette-item-title">{row.title}</span>
                {row.entry.note ? <span className="og-palette-item-note">{row.entry.note}</span> : null}
                {row.entry.keyLabel ? <span className="og-key">{row.entry.keyLabel}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function Palette(props: { readonly shell: Shell }) {
  const mode = useStore(props.shell.state, (state) => state.palette);
  if (mode === null) return null;
  // Keyed by the mode: the list of recent projects starts with an empty search of its own.
  return <PaletteList key={mode} shell={props.shell} mode={mode} />;
}
