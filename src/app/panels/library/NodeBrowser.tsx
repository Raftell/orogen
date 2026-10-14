// The Nodes tab: a search field, the catalogue by category (or what a search found, best first), and the details
// of the node under the pointer or of the selected one. A node goes into the graph by a drag, a double-click or
// Enter (src/app/ui/add-node.ts).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from 'zustand';

import { Button, Icon, SearchField, startNodeDrag, Tooltip, useCommandContext } from '../../ui/index.ts';
import { addNode } from './actions.ts';
import {
  catalogRows, categoryTitle, moveActive, RECENT_SECTION, SEARCH_SECTION, sectionKey,
  type Catalog, type CatalogEntry, type Move, type PortInfo, type PortKind, type Row, type SectionId,
} from './catalog.ts';
import styles from './library.module.css';
import { createSearchIndex, matchText, searchCatalog, searchRows, titleRuns } from './search.ts';
import { cleanDetailsHeight, DETAILS_HEIGHT, libraryStore, QUERY_MAX, setActive, setDetailsHeight, setQuery, toggleSection } from './state.ts';

/** The colour of a section: that of its category (testing.md 6.7). The recent nodes and a search have none of their own. */
const sectionStyle = (section: SectionId, category?: string): CSSProperties | undefined => {
  const named = section === RECENT_SECTION || section === SEARCH_SECTION ? category : section;
  return named === undefined ? undefined : ({ '--library-section': `var(--og-category-${named})` } as CSSProperties);
};

const PORT_COLOR: Readonly<Record<PortKind, string>> = {
  terrain: 'var(--og-port-height)',
  mask: 'var(--og-port-mask)',
  data: 'var(--og-port-data)',
  color: 'var(--og-port-color)',
  any: 'var(--og-port-height)',
  same: 'var(--og-port-height)',
};

const MOVES: Readonly<Record<string, Move>> = { ArrowDown: 'next', ArrowUp: 'previous', PageDown: 'pageDown', PageUp: 'pageUp' };
const LIST_MOVES: Readonly<Record<string, Move>> = { ...MOVES, Home: 'first', End: 'last' };

const rowId = (key: string): string => `library-row-${key.replace(/[^A-Za-z0-9]+/g, '-')}`;

function Ports(props: { readonly title: string; readonly ports: readonly PortInfo[]; readonly none: string }) {
  return (
    <div>
      <div className={styles.portsTitle}>{props.title}</div>
      {props.ports.length === 0 ? <div className={styles.portNone}>{props.none}</div> : (
        <ul className={styles.portList}>
          {props.ports.map((port) => (
            <li key={port.name} className={styles.port} data-port={port.name}>
              <span className={styles.portDot} style={{ '--library-port': PORT_COLOR[port.kind] } as CSSProperties} />
              <span className={styles.portName}>{port.label}</span>
              <span className={styles.portKind}>{port.optional ? `${port.carries}, optional` : port.carries}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `selected`: the entry is the selected node, which the button adds; a node the pointer is on is only described. */
function Details(props: { readonly entry: CatalogEntry | null; readonly selected: boolean; readonly height: number | null; readonly rest: boolean }) {
  const { entry } = props;
  const ctx = useCommandContext();
  const sized = props.height === null ? undefined : '';
  const height = props.height === null ? undefined : ({ '--library-details-height': `${props.height}px` } as CSSProperties);
  if (!entry) {
    return (
      <div className={styles.details} id="library-node-details" data-library="details" data-sized={sized} data-rest={props.rest ? '' : undefined} style={height}>
        <div className={styles.detailsHint}>Drag a node into the graph, or double-click it</div>
      </div>
    );
  }
  // 'Gaea: Erosion2, Erosion · World Machine: Erosion'
  const tools = new Map<string, string[]>();
  for (const alias of entry.aliases) tools.set(alias.tool, [...(tools.get(alias.tool) ?? []), alias.name]);
  const elsewhere = [...tools].map(([tool, names]) => `${tool}: ${names.join(', ')}`).join(' · ');
  return (
    <div className={styles.details} id="library-node-details" data-library="details" data-type={entry.type} data-sized={sized} style={{ ...sectionStyle(entry.category), ...height }}>
      <div className={styles.detailsHead}>
        <h3 className={styles.detailsTitle}>{entry.title}</h3>
        {/* Kept in its place, unseen, for a node that is only looked at: the head does not move as the pointer does. */}
        <span className={styles.detailsAdd} data-preview={props.selected ? undefined : ''}>
          <Tooltip content="Add this node at the center of the graph" keyLabel="Enter">
            <Button size="small" icon="plus" data-action="add" onClick={() => ctx.run('library.addNode')}>Add</Button>
          </Tooltip>
        </span>
      </div>
      <div className={styles.detailsMeta}>
        <span className={styles.chip}>{categoryTitle(entry.category)}</span>
        <span className={styles.detailsType}>{entry.type}</span>
      </div>
      <p className={styles.detailsText} data-library="description">{entry.description}</p>
      <div className={styles.ports}>
        <Ports title="Inputs" ports={entry.inputs} none="None: it starts a graph" />
        <Ports title="Outputs" ports={entry.outputs} none="None: it ends a branch" />
      </div>
      {entry.notes.length > 0 ? <p className={styles.notes}>{entry.notes.join(' · ')}</p> : null}
      {entry.keywords.length > 0 ? <p className={styles.found}><b>Also found by</b> {entry.keywords.join(', ')}</p> : null}
      {elsewhere !== '' ? <p className={styles.found} data-library="elsewhere"><b>In other tools</b> {elsewhere}</p> : null}
    </div>
  );
}

/**
 * The bar between the list and the details. A drag sets the height of the details, the arrow keys change it by a
 * step, and a double-click or Home gives the choice back to the panel. The height is kept when the drag ends.
 */
function Splitter(props: { readonly height: number | null; onLive(height: number | null): void }) {
  const drag = useRef<{ readonly y: number; readonly height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const shownHeight = (bar: Element): number => bar.nextElementSibling?.getBoundingClientRect().height ?? DETAILS_HEIGHT.min;

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    drag.current = { y: event.clientY, height: shownHeight(event.currentTarget) };
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is not one of the system's cannot be captured; its events still arrive here.
    }
    event.preventDefault();
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    props.onLive(cleanDetailsHeight(drag.current.height + drag.current.y - event.clientY));
  }
  function onPointerEnd(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    const moved = drag.current.y - event.clientY;
    // A press without a move changes nothing: the panel's own height stays the panel's choice.
    if (event.type === 'pointerup' && moved !== 0) setDetailsHeight(libraryStore, drag.current.height + moved);
    drag.current = null;
    setDragging(false);
    props.onLive(null);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.key === 'ArrowUp' ? DETAILS_HEIGHT.step : event.key === 'ArrowDown' ? -DETAILS_HEIGHT.step : 0;
    if (step !== 0) setDetailsHeight(libraryStore, shownHeight(event.currentTarget) + step);
    else if (event.key === 'Home') setDetailsHeight(libraryStore, null);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <Tooltip content="Drag to resize the details; double-click for the default height" side="left">
      <div
        className={styles.splitter}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Height of the details"
        aria-controls="library-node-details"
        aria-valuenow={props.height ?? undefined}
        aria-valuemin={DETAILS_HEIGHT.min}
        aria-valuemax={DETAILS_HEIGHT.max}
        tabIndex={0}
        data-library="splitter"
        data-dragging={dragging ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onDoubleClick={() => setDetailsHeight(libraryStore, null)}
        onKeyDown={onKeyDown}
      />
    </Tooltip>
  );
}

export function NodeBrowser(props: { readonly catalog: Catalog }) {
  const { catalog } = props;
  const query = useStore(libraryStore, (state) => state.query);
  const active = useStore(libraryStore, (state) => state.active);
  const collapsed = useStore(libraryStore, (state) => state.collapsed);
  const recent = useStore(libraryStore, (state) => state.recent);
  const searchRequests = useStore(libraryStore, (state) => state.searchRequests);
  const detailsHeight = useStore(libraryStore, (state) => state.detailsHeight);
  /** The height of the details while the bar above them is dragged. */
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  /** The key of the node row the pointer is on, while the pointer is what the user works with. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Where the pointer last moved to: a list that scrolls under a resting pointer is not a pointer that moved. */
  const pointer = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /**
   * Whether the details have described a node since the panel was made. Until they have, they are one line of
   * hint and the list has the room: at first start the panel showed four nodes above an empty box. From the
   * first node on they keep their height whatever they show, so that the list does not move as the pointer does.
   */
  const described = useRef(false);

  const index = useMemo(() => createSearchIndex(catalog), [catalog]);
  const searching = query.trim() !== '';
  const found = useMemo(() => searchRows(searchCatalog(index, query)), [index, query]);
  const listed = useMemo(() => catalogRows(catalog, recent, collapsed), [catalog, recent, collapsed]);
  const rows: readonly Row[] = searching ? found : listed;
  const rowOf = (key: string | null): Row | undefined => (key === null ? undefined : rows.find((row) => row.key === key));
  const activeRow = rowOf(active);

  // Each text typed selects its best hit, so that Enter adds it, and ends the look at the row under the pointer.
  useEffect(() => {
    if (searching) setActive(libraryStore, found[0]?.key ?? null);
    setHovered(null);
  }, [searching, found]);
  // A selection that is no row any more, in a section that was folded or of a search that ended, is none. The
  // store is asked, not this render: the effect above has just selected a row of the new list.
  useEffect(() => {
    const held = libraryStore.getState().active;
    if (held !== null && !rows.some((row) => row.key === held)) setActive(libraryStore, null);
  }, [rows]);

  // "Find Node…": the keyboard goes to the search field, whose text is selected to be typed over. The request is
  // answered once: the list that is shown again later, after a look at the examples, leaves the keyboard alone.
  useEffect(() => {
    if (searchRequests === 0) return;
    input.current?.focus();
    input.current?.select();
    libraryStore.setState({ searchRequests: 0 });
  }, [searchRequests]);

  // The selected row is kept in view; the section headers stay at the top of the list above it.
  useEffect(() => {
    if (active === null) return;
    list.current?.querySelector(`#${CSS.escape(rowId(active))}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** The node under the pointer is described while the pointer moves over the list, and no longer when it has left. */
  function onListPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const at = pointer.current;
    if (at !== null && at.x === event.clientX && at.y === event.clientY) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    const key = (event.target as Element).closest?.('[data-row]')?.getAttribute('data-row') ?? null;
    if (key !== hovered) setHovered(key);
  }
  function onListPointerLeave(): void {
    pointer.current = null;
    if (hovered !== null) setHovered(null);
  }

  function activate(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'section') toggleSection(libraryStore, row.section);
    else addNode(row.entry.type);
  }

  /** The keys the search field and the list share. True when the key was taken. */
  function navigate(event: KeyboardEvent, moves: Readonly<Record<string, Move>>): boolean {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const move = moves[event.key];
    if (move) {
      setActive(libraryStore, moveActive(rows, active, move));
      return true;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      activate(activeRow);
      return true;
    }
    return false;
  }

  /** The arrows and Enter are the list's; Escape, which empties the field, is the field's own. */
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (navigate(event, MOVES)) event.preventDefault();
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (navigate(event, LIST_MOVES)) {
      event.preventDefault();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' && activeRow && !searching) {
      // A node goes to its section; an open section folds.
      if (activeRow.kind === 'node') setActive(libraryStore, sectionKey(activeRow.section));
      else if (activeRow.open) toggleSection(libraryStore, activeRow.section, false);
      event.preventDefault();
    } else if (event.key === 'ArrowRight' && activeRow?.kind === 'section') {
      if (!activeRow.open) toggleSection(libraryStore, activeRow.section, true);
      else setActive(libraryStore, moveActive(rows, active, 'next'));
      event.preventDefault();
    } else if (event.key === ' ' && activeRow?.kind === 'section') {
      toggleSection(libraryStore, activeRow.section);
      event.preventDefault();
    } else if (event.key === 'Escape' && query !== '') {
      setQuery(libraryStore, '');
      event.preventDefault();
    } else if (event.key === 'Backspace' && query !== '') {
      setQuery(libraryStore, query.slice(0, -1));
      input.current?.focus();
      event.preventDefault();
    } else if (event.key.length === 1 && event.key !== ' ') {
      // A letter typed on the list is the start of a search.
      setQuery(libraryStore, query + event.key);
      input.current?.focus();
      event.preventDefault();
    }
  }

  const shown = rowOf(hovered) ?? activeRow;
  if (shown?.kind === 'node') described.current = true;
  const count = catalog.entries.length;

  return (
    // A key ends the look at the node under the pointer: the keyboard works on the selected one.
    <div className={`${styles.view} ${styles.browser}`} data-library="nodes" onKeyDownCapture={() => { if (hovered !== null) setHovered(null); }}>
      <div className={styles.search}>
        <SearchField
          ref={input}
          data-library="search"
          maxLength={QUERY_MAX}
          placeholder={`Search ${count} nodes`}
          aria-label="Search nodes"
          aria-controls="library-node-list"
          value={query}
          onChange={(text) => setQuery(libraryStore, text)}
          onKeyDown={onSearchKey}
        />
      </div>

      <div
        ref={list}
        id="library-node-list"
        className={styles.list}
        role="listbox"
        tabIndex={0}
        aria-label={searching ? 'Nodes found' : 'Nodes by category'}
        aria-activedescendant={active === null ? undefined : rowId(active)}
        data-library="list"
        onKeyDown={onListKey}
        onPointerMove={onListPointerMove}
        onPointerLeave={onListPointerLeave}
      >
        {rows.map((row) => {
          if (row.kind === 'section') {
            return (
              <Tooltip key={row.key} content={row.hint} side="left">
                <div
                  id={rowId(row.key)}
                  className={styles.section}
                  role="option"
                  aria-selected={row.key === active}
                  aria-expanded={row.open}
                  aria-label={`${row.title}, ${row.count} nodes`}
                  data-section={row.section}
                  style={sectionStyle(row.section)}
                  onClick={() => {
                    setActive(libraryStore, row.key);
                    toggleSection(libraryStore, row.section);
                  }}
                >
                  <Icon name={row.open ? 'chevron-down' : 'chevron-right'} />
                  <span className={styles.sectionTitle}>{row.title}</span>
                  <span className={styles.sectionCount}>{row.count}</span>
                </div>
              </Tooltip>
            );
          }
          const { entry, hit } = row;
          const match = hit ? matchText(hit) : null;
          return (
            <div
              key={row.key}
              id={rowId(row.key)}
              className={styles.node}
              role="option"
              aria-selected={row.key === active}
              data-node={entry.type}
              data-row={row.key}
              style={sectionStyle(row.section, entry.category)}
              draggable
              onDragStart={(event) => {
                startNodeDrag(event.dataTransfer, entry.type);
                setActive(libraryStore, row.key);
              }}
              onClick={() => setActive(libraryStore, row.key)}
              onDoubleClick={() => addNode(entry.type)}
            >
              <div className={styles.nodeHead}>
                <span className={styles.nodeTitle}>
                  {titleRuns(entry.title, hit?.titleIndexes ?? []).map((run, at) => (run.strong ? <strong key={at}>{run.text}</strong> : run.text))}
                </span>
                {match !== null ? <span className={styles.nodeMatch} data-library="match">{match}</span> : null}
              </div>
              <div className={styles.nodeDescription}>{entry.description}</div>
            </div>
          );
        })}
        {rows.length === 0 ? (
          <div className={styles.none} data-library="none">
            <div className={styles.noneTitle}>No node matches “{query.trim()}”</div>
            <div>A search looks at titles, keywords and the names other tools use</div>
          </div>
        ) : null}
      </div>

      <Splitter height={detailsHeight} onLive={setLiveHeight} />
      <Details
        entry={shown?.kind === 'node' ? shown.entry : null} selected={shown !== undefined && shown === activeRow} height={liveHeight ?? detailsHeight}
        rest={!described.current}
      />
    </div>
  );
}
