// What the graph panel holds for itself while it is used: which wires and groups are selected, the open
// palette, the name being edited, where a group is while it is dragged. None of it is the document, nothing
// here is undoable or saved, and no other panel reads it; the selection of nodes is uiStore's (runtime.md 8.5).
// The commands of the panel (index.ts) reach the mounted graph through `graphHost`. No DOM and no React.

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { Pending } from './connect.ts';
import type { Point, Rect } from './geometry.ts';
import type { PortTone } from './model.ts';

export interface PaletteRequest {
  /** Where the palette opens, in pixels from the panel's top-left corner. */
  readonly at: Point;
  /** Where the node goes, in graph coordinates: its centre, or with a wire the port that takes the wire. */
  readonly position: Point;
  /** The fixed end of the wire the palette was opened for, and what the wire carries. */
  readonly pending: Pending | null;
  readonly tone: PortTone | null;
  /** The wire the new node is inserted into; null: none. */
  readonly intoEdge: string | null;
}

export interface GraphUiState {
  /** Edge ids. */
  readonly edgeSelection: readonly string[];
  /** Group ids. */
  readonly groupSelection: readonly string[];
  readonly palette: PaletteRequest | null;
  readonly renaming: { readonly kind: 'node' | 'group'; readonly id: string } | null;
  /** The user wants the minimap. It is drawn while part of the graph lies outside the panel: `offscreen`. */
  readonly minimap: boolean;
  readonly offscreen: boolean;
  /** Group id → where the group is while it is moved or resized. */
  readonly groupRects: Readonly<Record<string, Rect>> | null;
  /** The wire a dragged node would be inserted into. */
  readonly dropEdge: string | null;
  /**
   * Why the connection under the pointer is refused, and where to say so, in pixels of the panel. `sticky`: the
   * wire was dropped there, and the reason stays for a moment after the drag has ended.
   */
  readonly refusal: { readonly message: string; readonly at: Point; readonly sticky: boolean } | null;
}

export const INITIAL_GRAPH_UI: GraphUiState = {
  edgeSelection: [], groupSelection: [], palette: null, renaming: null, minimap: true, offscreen: false, groupRects: null, dropEdge: null, refusal: null,
};

export function createGraphStore(): StoreApi<GraphUiState> {
  return createStore<GraphUiState>()(() => INITIAL_GRAPH_UI);
}

export const graphStore: StoreApi<GraphUiState> = createGraphStore();

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** Sets the selected wires and groups. Lists that hold what is selected already leave the state as it is. */
export function selectWiresAndGroups(store: StoreApi<GraphUiState>, edges: readonly string[], groups: readonly string[]): void {
  const state = store.getState();
  const patch: { edgeSelection?: readonly string[]; groupSelection?: readonly string[] } = {};
  if (!sameList(state.edgeSelection, edges)) patch.edgeSelection = [...new Set(edges)];
  if (!sameList(state.groupSelection, groups)) patch.groupSelection = [...new Set(groups)];
  if (patch.edgeSelection || patch.groupSelection) store.setState(patch);
}

/** What the mounted graph does for the panel's commands. */
export interface GraphHost {
  /** Shows the whole graph, or the nodes given. */
  fit(ids?: readonly string[]): void;
  /** Gives the graph the keyboard focus, so that keys and clipboard events arrive at it. */
  focus(): void;
  /** Opens the add-node palette where the pointer is, or in the middle of the graph; with a wire, for a node that goes into it. */
  openPalette(intoEdge?: string): void;
}

let mounted: GraphHost | null = null;

export function setGraphHost(host: GraphHost | null): void {
  mounted = host;
}

/** The graph when it is mounted; null in a window-free test and before the panel has rendered. */
export function graphHost(): GraphHost | null {
  return mounted;
}
