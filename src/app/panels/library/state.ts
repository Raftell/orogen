// What the library panel holds between its component and its commands: which tab is in front, what is searched,
// the row that is selected, which sections are folded, the recently used nodes, and the example that is
// selected. None of it is the document's or another panel's. What is kept from one run to the next is the
// panel's entry of the preferences (runtime.md 8.6). No DOM, no React.

import { createStore, type StoreApi } from 'zustand/vanilla';

import { hasPlatform, panelKeep, type PanelKeep } from '../../platform.ts';
import type { DocState } from '../../state/doc-store.ts';
import { addedType, cleanRecent, pushRecent } from './recent.ts';

export type LibraryTab = 'nodes' | 'examples';

export interface LibraryState {
  readonly tab: LibraryTab;
  readonly query: string;
  /** The key of the selected row of the node list (catalog.ts), or null. */
  readonly active: string | null;
  /** The ids of the folded sections. */
  readonly collapsed: readonly string[];
  /** Node types, newest first. */
  readonly recent: readonly string[];
  /** The height the user gave the details of a node, in CSS pixels; null: the height the panel chooses. */
  readonly detailsHeight: number | null;
  /** The id of the selected example. */
  readonly example: string | null;
  /** The dialog of "Open Example…" is open. */
  readonly gallery: boolean;
  /** Raised by "Find Node…": the node list puts the keyboard into its search field and sets it back to 0. */
  readonly searchRequests: number;
  /** The panel's component is mounted: its dialogs can open. */
  readonly mounted: boolean;
}

/** What is kept from one start of the application to the next: conveniences of this user, nothing of a project. */
interface Kept {
  readonly tab: LibraryTab;
  readonly collapsed: readonly string[];
  readonly recent: readonly string[];
  readonly detailsHeight: number | null;
}

/** The heights the details of a node can be given. The panel's own layout keeps four rows of the list above them. */
export const DETAILS_HEIGHT = { min: 72, max: 960, step: 16 } as const;

/** A height for the details within its limits, as a whole number of pixels; null for anything that is no height. */
export function cleanDetailsHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(DETAILS_HEIGHT.max, Math.max(DETAILS_HEIGHT.min, value)));
}

const FIRST: Kept = { tab: 'nodes', collapsed: [], recent: [], detailsHeight: null };
const KEPT_MEMBERS: readonly (keyof Kept)[] = ['tab', 'collapsed', 'recent', 'detailsHeight'];

/** The panel's entry of the preferences, as far as it is of the kind expected: anything else is a first start. */
export function cleanKept(held: unknown): Kept {
  if (typeof held !== 'object' || held === null || Array.isArray(held)) return FIRST;
  const entry = held as Partial<Record<keyof Kept, unknown>>;
  return {
    tab: entry.tab === 'examples' ? 'examples' : 'nodes',
    collapsed: Array.isArray(entry.collapsed) ? entry.collapsed.filter((id): id is string => typeof id === 'string').slice(0, 32) : [],
    recent: cleanRecent(entry.recent),
    detailsHeight: cleanDetailsHeight(entry.detailsHeight),
  };
}

/**
 * `keep` is the panel's entry of the preferences (src/app/platform.ts); null: nothing is kept. The entry is read
 * once, some time after the store was made: a member the user has changed by then stays as they made it, the
 * others take what was kept. From then on every change of a kept member is written.
 */
export function createLibraryStore(keep: PanelKeep | null = null): StoreApi<LibraryState> {
  const store = createStore<LibraryState>()(() => ({
    ...FIRST, query: '', active: null, example: null, gallery: false, searchRequests: 0, mounted: false,
  }));
  if (keep) {
    const first = store.getState();
    /** Until the entry is read nothing is written: a write would replace what the last run kept by what this one started with. */
    let adopted = false;
    const write = (state: LibraryState): void => {
      keep.write({ tab: state.tab, collapsed: state.collapsed, recent: state.recent, detailsHeight: state.detailsHeight } satisfies Kept);
    };
    store.subscribe((next, previous) => {
      if (adopted && KEPT_MEMBERS.some((member) => next[member] !== previous[member])) write(next);
    });
    void keep.read().then((held) => {
      const kept = cleanKept(held);
      const now = store.getState();
      const changed = KEPT_MEMBERS.filter((member) => now[member] !== first[member]);
      const patch: Partial<Record<keyof Kept, unknown>> = {};
      for (const member of KEPT_MEMBERS) if (!changed.includes(member)) patch[member] = kept[member];
      store.setState(patch as Partial<LibraryState>);
      adopted = true;
      // What was changed before the entry arrived was not written then.
      if (changed.length > 0) write(store.getState());
    });
  }
  return store;
}

/** The store of the application. Without a bridge (a test without a window) nothing is kept. */
export const libraryStore: StoreApi<LibraryState> = createLibraryStore(hasPlatform() ? panelKeep('library') : null);

// ---- changes ----------------------------------------------------------------------------------------------------------

/** The longest text a search takes. No title, keyword or name of another tool is a third as long. */
export const QUERY_MAX = 80;

export function setQuery(store: StoreApi<LibraryState>, query: string): void {
  const text = query.slice(0, QUERY_MAX);
  if (store.getState().query !== text) store.setState({ query: text });
}

export function setActive(store: StoreApi<LibraryState>, key: string | null): void {
  if (store.getState().active !== key) store.setState({ active: key });
}

export function toggleSection(store: StoreApi<LibraryState>, section: string, open?: boolean): void {
  const { collapsed } = store.getState();
  const folded = collapsed.includes(section);
  const fold = open === undefined ? !folded : !open;
  if (fold === folded) return;
  store.setState({ collapsed: fold ? [...collapsed, section] : collapsed.filter((id) => id !== section) });
}

/** The height of the details of a node; null gives the choice back to the panel. */
export function setDetailsHeight(store: StoreApi<LibraryState>, height: number | null): void {
  const next = height === null ? null : cleanDetailsHeight(height);
  if (store.getState().detailsHeight !== next) store.setState({ detailsHeight: next });
}

export function noteUsed(store: StoreApi<LibraryState>, type: string): void {
  const { recent } = store.getState();
  if (recent[0] === type) return;
  store.setState({ recent: pushRecent(recent, type) });
}

/**
 * Keeps the recently used nodes current from the document store, whoever adds the node. Returns the function
 * that stops it. `known` says whether a type is one the library lists.
 */
export function watchAddedNodes(store: StoreApi<LibraryState>, doc: StoreApi<DocState>, known: (type: string) => boolean): () => void {
  return doc.subscribe((next, previous) => {
    const type = addedType(previous, next);
    if (type !== null && known(type)) noteUsed(store, type);
  });
}

/** The node type of a row key of the node list; null for the key of a section and for no key. */
export function typeOfRow(key: string | null): string | null {
  if (key === null || key.startsWith('section:')) return null;
  const at = key.indexOf(':');
  return at < 0 ? null : key.slice(at + 1);
}
