// What the inspector holds of its own: nothing of the document, the engine or the selection (runtime.md 8.5),
// only how the panel itself stands. It lives beside the component because the panel is unmounted while its tab
// is behind another, and its commands (index.ts) act on it.

import { createStore } from 'zustand/vanilla';

export interface InspectorState {
  /** The parameter whose row the pointer is on; null while it is on none. */
  readonly hoverParam: string | null;
  /** The parameter that was last pressed or given the focus. */
  readonly touchedParam: string | null;
  /** The sections that are closed, by `sectionKey`. */
  readonly collapsed: Readonly<Record<string, true>>;
  /** Raised by the command that renames: the title field of the header takes the focus. */
  readonly renameRequests: number;
}

export const inspectorStore = createStore<InspectorState>()(() => ({ hoverParam: null, touchedParam: null, collapsed: {}, renameRequests: 0 }));

/**
 * The parameter the command "Reset Parameter" acts on: the one under the pointer, which is what a key means, and
 * with the pointer on no row the one that was last pressed or focused, which is what the menu means. A pointer on
 * its way to the menu bar crosses other rows and leaves them again: they are not what the user chose.
 */
export const activeParam = (state: InspectorState = inspectorStore.getState()): string | null => state.hoverParam ?? state.touchedParam;

/** A section is closed for every node of its type: the user who closes "Warp" does not want it on the next noise either. */
export const sectionKey = (nodeType: string, title: string): string => `${nodeType}/${title}`;

export function setSectionOpen(key: string, open: boolean): void {
  const { collapsed } = inspectorStore.getState();
  if (Object.hasOwn(collapsed, key) !== open) return;
  const next: Record<string, true> = { ...collapsed };
  if (open) delete next[key];
  else next[key] = true;
  inspectorStore.setState({ collapsed: next });
}

/** The pointer came onto the row of a parameter (`on` true) or left it. */
export function setHoverParam(name: string, on: boolean): void {
  const { hoverParam } = inspectorStore.getState();
  if (on && hoverParam !== name) inspectorStore.setState({ hoverParam: name });
  else if (!on && hoverParam === name) inspectorStore.setState({ hoverParam: null });
}

export function setTouchedParam(name: string): void {
  if (inspectorStore.getState().touchedParam !== name) inspectorStore.setState({ touchedParam: name });
}

/** Another node is inspected: no parameter of the one before is meant any more. */
export function forgetParams(): void {
  const { hoverParam, touchedParam } = inspectorStore.getState();
  if (hoverParam !== null || touchedParam !== null) inspectorStore.setState({ hoverParam: null, touchedParam: null });
}
