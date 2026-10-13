// uiStore (runtime.md 8.5): what the interface holds that is neither the document nor the engine's report.
// Nothing here is undoable and nothing is saved. The panels change it with `setState` or the functions below.

import { createStore, type StoreApi } from 'zustand/vanilla';

import { setView, viewAfterSelect, type NodeRegistry, type PortRef, type ViewBinding } from '../../core/runtime.ts';
import type { DocState } from './doc-store.ts';

export type PanelId = 'graph' | 'viewport' | 'inspector' | 'library' | 'build';

export interface UiState {
  readonly selection: readonly string[];           // node ids
  readonly focusedPanel: PanelId | null;
  readonly dragPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>> | null;
}

export function createUiStore(): StoreApi<UiState> {
  return createStore<UiState>()(() => ({ selection: [], focusedPanel: null, dragPositions: null }));
}

export const uiStore: StoreApi<UiState> = createUiStore();

/** The ids without repeats, in the order given. The same array when it holds none. */
function distinct(ids: readonly string[]): readonly string[] {
  const seen = new Set(ids);
  return seen.size === ids.length ? ids : [...seen];
}

/** Sets the selection. A selection of the same ids in the same order leaves the state object as it is, so no subscriber runs. */
export function setSelection(ui: StoreApi<UiState>, ids: readonly string[]): void {
  const next = distinct(ids);
  const current = ui.getState().selection;
  if (current.length === next.length && current.every((id, i) => id === next[i])) return;
  ui.setState({ selection: [...next] });
}

/** What a function that changes the view needs: the three members of CommandContext (8.8) that it reads. */
export interface ViewContext {
  readonly doc: StoreApi<DocState>;
  readonly ui: StoreApi<UiState>;
  readonly registry: NodeRegistry;
}

/**
 * The user selected an output: the view becomes `viewAfterSelect` (7.4). A locked view stays, which is the pin.
 * The change is a transaction that is not undoable (8.5 rule 5), and none at all when the view stays as it is.
 */
export function viewOutput(ctx: Pick<ViewContext, 'doc' | 'registry'>, ref: PortRef): void {
  const state = ctx.doc.getState();
  const current = state.doc.ui.view;
  const next = viewAfterSelect(state.doc, ctx.registry, ref);
  if (next === current || next === undefined) return;
  state.transact('View', (draft) => setView(draft, next), { undoable: false });
}

/**
 * The pin (7.4 rule 4): a locked view stays when the selection changes. Like every change of the view, a
 * transaction that is not undoable.
 */
export function setViewLocked(ctx: Pick<ViewContext, 'doc'>, locked: boolean): void {
  const state = ctx.doc.getState();
  const { locked: was, ...view } = state.doc.ui.view ?? {};
  if ((was === true) === locked) return;
  const next: ViewBinding = locked ? { ...view, locked: true } : view;
  state.transact(locked ? 'Lock view' : 'Unlock view', (draft) => setView(draft, next), { undoable: false });
}

/**
 * The user selected these nodes. The view follows a selection of exactly one node, by its `outputs[0]`
 * (7.4); a selection of several nodes, or of none, leaves the view as it is.
 */
export function selectNodes(ctx: ViewContext, ids: readonly string[]): void {
  setSelection(ctx.ui, ids);
  const selection = ctx.ui.getState().selection;
  if (selection.length !== 1) return;
  const node = selection[0]!;
  const doc = ctx.doc.getState().doc;
  const instance = Object.hasOwn(doc.nodes, node) ? doc.nodes[node] : undefined;
  const port = instance ? ctx.registry.get(instance.type)?.outputs[0] : undefined;
  if (port) viewOutput(ctx, { node, port: port.name });
}
