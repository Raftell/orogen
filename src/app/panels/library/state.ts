// What the library panel holds between its component and its commands: which tab is in front, what is searched,
// the row that is selected, which sections are folded, the recently used nodes, and the example that is selected
// or waits for an answer. None of it is the document's or another panel's. No DOM beyond the storage, no React.

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { DocState } from '../../state/doc-store.ts';
import { addedType, cleanRecent, pushRecent } from './recent.ts';

export type LibraryTab = 'nodes' | 'examples';
/** What becomes of the unsaved changes of the project an example would replace. */
export type UnsavedAnswer = 'save' | 'discard' | 'cancel';

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
  /** The id of the example that waits for the answer about the project's unsaved changes. */
  readonly confirm: string | null;
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

export type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const STORAGE_KEY = 'orogen.library';

function readKept(storage: LibraryStorage | null): Kept {
  const first: Kept = { tab: 'nodes', collapsed: [], recent: [], detailsHeight: null };
  if (!storage) return first;
  try {
    const held = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<Record<keyof Kept, unknown>> | null;
    if (typeof held !== 'object' || held === null) return first;
    return {
      tab: held.tab === 'examples' ? 'examples' : 'nodes',
      collapsed: Array.isArray(held.collapsed) ? held.collapsed.filter((id): id is string => typeof id === 'string').slice(0, 32) : [],
      recent: cleanRecent(held.recent),
      detailsHeight: cleanDetailsHeight(held.detailsHeight),
    };
  } catch {
    return first;
  }
}

/**
 * The storage of the page; null where there is no page (a test without a window, where Node has a storage of
 * its own that is no user's) or the storage may not be used.
 */
function pageStorage(): LibraryStorage | null {
  try {
    const scope = globalThis as { readonly document?: unknown; readonly localStorage?: LibraryStorage };
    return scope.document === undefined ? null : scope.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createLibraryStore(storage: LibraryStorage | null = null): StoreApi<LibraryState> {
  const kept = readKept(storage);
  const store = createStore<LibraryState>()(() => ({
    ...kept, query: '', active: null, example: null, gallery: false, confirm: null, searchRequests: 0, mounted: false,
  }));
  if (storage) {
    store.subscribe((next, previous) => {
      if (next.tab === previous.tab && next.collapsed === previous.collapsed && next.recent === previous.recent && next.detailsHeight === previous.detailsHeight) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ tab: next.tab, collapsed: next.collapsed, recent: next.recent, detailsHeight: next.detailsHeight } satisfies Kept));
      } catch {
        // A full or forbidden storage: the panel works without remembering.
      }
    });
  }
  return store;
}

export const libraryStore: StoreApi<LibraryState> = createLibraryStore(pageStorage());

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
