// docStore (runtime.md 8.5): the document, its revision and the history. The document changes through
// transactions only: a recipe that calls the commands of 4.6 on an immer draft. Each transaction that is undoable
// leaves the patches that make it and the patches that take it back.

import { applyPatches, enablePatches, freeze, produceWithPatches, type Patch } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { newDoc, type DocDraft, type GraphDoc } from '../../core/runtime.ts';
import { setSelection, uiStore, type UiState } from './ui-store.ts';

enablePatches();

export interface HistoryEntry {
  readonly label: string;                          // shown in the history list: 'Erosion: Duration'
  readonly forward: readonly Patch[];
  readonly inverse: readonly Patch[];
  readonly mergeKey: string | null;
  readonly time: number;                           // performance.now() of the last transaction merged in
  readonly selectionBefore: readonly string[];
  readonly selectionAfter: readonly string[];
}

export interface DocState {
  readonly doc: GraphDoc;
  readonly revision: number;                       // +1 on every change of `doc`
  readonly engineRevision: number;                 // the revision of the last change the evaluator can see
  readonly unsaved: boolean;
  readonly path: string | null;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly gesture: string | null;                 // the merge key of the gesture in progress

  /**
   * Runs the recipe on a draft of the document. A recipe that throws changes nothing and the error reaches the
   * caller. A command that selects what it made sets the selection inside the recipe: the entry records the
   * selection as it is when the recipe returns.
   */
  transact(label: string, recipe: (doc: DocDraft) => void, opts?: { mergeKey?: string; undoable?: boolean }): void;
  beginGesture(mergeKey: string): void;
  endGesture(): void;
  /**
   * Ends the gesture in progress and takes back what it changed: the document is as it was when the gesture
   * began, the gesture's entry is not in the history, and `future` is what it was then, so that a drag that was
   * taken back (Escape) can be neither undone nor redone and has cost no redo step. Without a gesture it does
   * nothing. When an undoable transaction of another key was made while the gesture was in progress, that
   * change stays and the gesture's changes with it: the gesture then only ends.
   */
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  load(doc: GraphDoc, path: string | null): void;  // replaces the document, clears the history
  /**
   * The project is in the file `path`. `revision` is the revision the file holds; left out, the file holds the
   * document as it is now. A file that holds an earlier revision leaves the project unsaved.
   */
  markSaved(path: string, revision?: number): void;
  /**
   * No file holds the document as it is: a project that was restored from what a run before kept of it (8.6,
   * recovery) is the project of its file with changes nobody saved. The history is not touched; no undo leads
   * back to the file's state, which this run never held.
   */
  markUnsaved(): void;
}

/** Rule 3: transactions with one merge key that are closer together than this are one entry. */
export const MERGE_WINDOW_MS = 600;
/** Rule 7. */
export const HISTORY_MAX_ENTRIES = 500;
export const HISTORY_MAX_BYTES = 64 * 2 ** 20;

export interface DocStoreOptions {
  /** The selection that entries record and that undo and redo restore. */
  readonly ui: StoreApi<UiState>;
  /** The clock of HistoryEntry.time; default performance.now. */
  readonly now?: () => number;
  /** The limits of rule 7, for a test that reaches them. */
  readonly limits?: { readonly entries?: number; readonly bytes?: number };
}

const NODE_MEMBERS_EVALUATED: ReadonlySet<unknown> = new Set(['type', 'version', 'params', 'bypass']);

/** Whether the patch touches a path the evaluator reads (8.5, "What the engine is sent"). */
function evaluatorReads(patch: Patch): boolean {
  const [root, key, member] = patch.path;
  if (root === 'groups') return false;
  // A node added or removed has a path of two members; below it only these four members matter.
  if (root === 'nodes') return patch.path.length <= 2 || NODE_MEMBERS_EVALUATED.has(member);
  if (root === 'ui') return patch.path.length === 1 || key === 'view';
  return true;
}

/** The paths of rule 5: what a transaction that is not undoable changes, and no other transaction does. */
function outsideHistory(patch: Patch): boolean {
  const [root, key] = patch.path;
  return root === 'ui' || (root === 'settings' && (key === 'buildResolution' || key === 'previewLevel'));
}

/** The size of an entry for the limit of rule 7: the length of its patches as JSON text. */
function patchBytes(patches: readonly Patch[]): number {
  return JSON.stringify(patches).length;
}

function existing(ids: readonly string[], doc: GraphDoc): readonly string[] {
  return ids.every((id) => Object.hasOwn(doc.nodes, id)) ? ids : ids.filter((id) => Object.hasOwn(doc.nodes, id));
}

export function createDocStore(options: DocStoreOptions): StoreApi<DocState> {
  const { ui } = options;
  const now = options.now ?? (() => performance.now());
  const maxEntries = options.limits?.entries ?? HISTORY_MAX_ENTRIES;
  const maxBytes = options.limits?.bytes ?? HISTORY_MAX_BYTES;

  // What the history needs beside the entries themselves. None of it is state a component reads.
  const sizes = new WeakMap<HistoryEntry, number>();
  let pastBytes = 0;
  /**
   * Where the saved document is in the history: the entry after which it was saved, 'base' for the state before
   * the oldest entry, null when no undo or redo leads back to it. An entry that a later transaction merged into
   * is another object and no longer in the history, so a save that named it is found nowhere, which is the truth.
   */
  let saved: HistoryEntry | 'base' | null = 'base';
  /** A change outside the history (rule 5) that a save would write was made since the last save. */
  let changedOutsideHistory = false;
  /** The entry the gesture in progress has made. A gesture never continues an entry that was there before it. */
  let gestureEntry: HistoryEntry | null = null;
  /**
   * What `cancelGesture` needs of the gesture in progress: the `future` and the selection it began with, the
   * patches that take back what it has changed, newest first, and the entry its first transaction merged into
   * by the 600 ms of rule 3, which is then no longer in the history and is put back.
   */
  let gestureStart: { readonly future: readonly HistoryEntry[]; readonly selection: readonly string[]; inverse: Patch[]; replaced: HistoryEntry | null } | null = null;
  let inRecipe = false;

  const sizeOf = (entry: HistoryEntry): number => sizes.get(entry) ?? 0;
  const isUnsaved = (past: readonly HistoryEntry[]): boolean =>
    changedOutsideHistory || (saved === 'base' ? past.length > 0 : saved === null || past[past.length - 1] !== saved);

  /** Rule 7: drops the oldest entries of `past`, which the caller owns, until both limits hold. */
  function dropOldest(past: HistoryEntry[]): void {
    let dropped = 0;
    while (dropped < past.length && (past.length - dropped > maxEntries || pastBytes > maxBytes)) {
      const entry = past[dropped++]!;
      pastBytes -= sizeOf(entry);
      // The state before the oldest entry is now the state after this one.
      saved = saved === entry ? 'base' : saved === 'base' ? null : saved;
      if (gestureEntry === entry) gestureEntry = null;
      if (gestureStart?.replaced === entry) gestureStart.replaced = null;
    }
    if (dropped > 0) past.splice(0, dropped);
  }

  function notInRecipe(what: string): void {
    if (inRecipe) throw new Error(`${what} was called inside the recipe of a transaction: a recipe changes its draft and nothing else`);
  }

  return createStore<DocState>()((set, get) => ({
    doc: freeze(newDoc(), true),
    revision: 0,
    engineRevision: 0,
    unsaved: false,
    path: null,
    past: [],
    future: [],
    gesture: null,

    transact(label, recipe, opts) {
      notInRecipe('transact');
      const state = get();
      const undoable = opts?.undoable !== false;
      const mergeKey = opts?.mergeKey ?? null;
      const selectionBefore = ui.getState().selection;

      let produced: readonly [GraphDoc, Patch[], Patch[]];
      inRecipe = true;
      try {
        // The recipe's return value is dropped: immer would take a returned object for the new document.
        produced = produceWithPatches(state.doc, (draft) => { recipe(draft); });
      } finally {
        inRecipe = false;
      }
      const [doc, forward, inverse] = produced;
      if (forward.length === 0) return;

      // Rule 5. A history whose patches share a path with a change it does not hold cannot be replayed.
      const stray = forward.find((patch) => outsideHistory(patch) === undoable);
      if (stray) {
        throw new Error(undoable
          ? `"${label}" changes ${stray.path.join('.')}: what lies under ui (the view, the graph viewport, the viewport's own state), buildResolution and previewLevel are changed with undoable: false`
          : `"${label}" is not undoable and changes ${stray.path.join('.')}: only what lies under ui, buildResolution and previewLevel are changed that way`);
      }

      const revision = state.revision + 1;
      const engineRevision = forward.some(evaluatorReads) ? revision : state.engineRevision;

      if (!undoable) {
        if (forward.some((patch) => patch.path[0] !== 'ui')) changedOutsideHistory = true;
        set({ doc, revision, engineRevision, unsaved: isUnsaved(state.past) });
        return;
      }

      const selectionAfter = existing(ui.getState().selection, doc);
      const time = now();
      const top = state.past[state.past.length - 1];
      const merges = top !== undefined && mergeKey !== null && top.mergeKey === mergeKey
        && ((state.gesture === mergeKey && gestureEntry === top) || time - top.time < MERGE_WINDOW_MS);

      const entry: HistoryEntry = merges
        ? { ...top, forward: [...top.forward, ...forward], inverse: [...inverse, ...top.inverse], time, selectionAfter }
        : { label, forward, inverse, mergeKey, time, selectionBefore, selectionAfter };
      const added = patchBytes(forward) + patchBytes(inverse);
      sizes.set(entry, (merges ? sizeOf(top) : 0) + added);
      pastBytes += added;
      if (state.gesture !== null && state.gesture === mergeKey) {
        if (gestureStart) {
          // The first transaction of the gesture went into an entry that was there before it: that entry comes back on a cancel.
          if (merges && gestureEntry !== top) gestureStart.replaced = top;
          gestureStart.inverse = [...inverse, ...gestureStart.inverse];
        }
        gestureEntry = entry;
      } else if (gestureStart) {
        // Another undoable change in the middle of a gesture: the gesture can no longer be taken back as a whole.
        gestureStart = null;
      }

      const past = merges ? [...state.past.slice(0, -1), entry] : [...state.past, entry];
      dropOldest(past);
      set({ doc, revision, engineRevision, past, future: [], unsaved: isUnsaved(past) });
      setSelection(ui, selectionAfter);
    },

    beginGesture(mergeKey) {
      notInRecipe('beginGesture');
      gestureEntry = null;
      gestureStart = { future: get().future, selection: ui.getState().selection, inverse: [], replaced: null };
      if (get().gesture !== mergeKey) set({ gesture: mergeKey });
    },

    endGesture() {
      notInRecipe('endGesture');
      gestureEntry = null;
      gestureStart = null;
      if (get().gesture !== null) set({ gesture: null });
    },

    cancelGesture() {
      notInRecipe('cancelGesture');
      const state = get();
      const entry = gestureEntry;
      const start = gestureStart;
      gestureEntry = null;
      gestureStart = null;
      if (state.gesture === null) return;
      // Nothing was changed, the entry left the history (rule 7), or another change lies on top of it: the gesture ends.
      if (!entry || !start || state.past[state.past.length - 1] !== entry) {
        set({ gesture: null });
        return;
      }
      const doc = applyPatches(state.doc, start.inverse);
      const past = start.replaced ? [...state.past.slice(0, -1), start.replaced] : state.past.slice(0, -1);
      pastBytes += (start.replaced ? sizeOf(start.replaced) : 0) - sizeOf(entry);
      // A file written in the middle of the gesture holds a state that no undo leads back to.
      if (saved === entry) saved = null;
      const revision = state.revision + 1;
      set({
        doc, revision, past, future: start.future, gesture: null, unsaved: isUnsaved(past),
        engineRevision: start.inverse.some(evaluatorReads) ? revision : state.engineRevision,
      });
      setSelection(ui, existing(start.selection, doc));
    },

    undo() {
      notInRecipe('undo');
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      const doc = applyPatches(state.doc, entry.inverse);
      const past = state.past.slice(0, -1);
      pastBytes -= sizeOf(entry);
      gestureEntry = null;
      gestureStart = null;
      const revision = state.revision + 1;
      set({
        doc, revision, past, future: [...state.future, entry], gesture: null, unsaved: isUnsaved(past),
        engineRevision: entry.inverse.some(evaluatorReads) ? revision : state.engineRevision,
      });
      setSelection(ui, existing(entry.selectionBefore, doc));
    },

    redo() {
      notInRecipe('redo');
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      const doc = applyPatches(state.doc, entry.forward);
      const past = [...state.past, entry];
      pastBytes += sizeOf(entry);
      gestureEntry = null;
      gestureStart = null;
      const revision = state.revision + 1;
      set({
        doc, revision, past, future: state.future.slice(0, -1), gesture: null, unsaved: isUnsaved(past),
        engineRevision: entry.forward.some(evaluatorReads) ? revision : state.engineRevision,
      });
      setSelection(ui, existing(entry.selectionAfter, doc));
    },

    load(doc, path) {
      notInRecipe('load');
      pastBytes = 0;
      saved = 'base';
      changedOutsideHistory = false;
      gestureEntry = null;
      gestureStart = null;
      // The revision goes on from where it was: the engine takes no revision that is not above every earlier one (7.1).
      const revision = get().revision + 1;
      set({ doc: freeze(doc, true), revision, engineRevision: revision, unsaved: false, path, past: [], future: [], gesture: null });
      setSelection(ui, []);
      if (ui.getState().dragPositions !== null) ui.setState({ dragPositions: null });
    },

    markSaved(path, revision) {
      notInRecipe('markSaved');
      const { past, revision: current } = get();
      if (revision !== undefined && revision !== current) {
        // The document went on while the file was written. The file holds a state the history may not have
        // any more (a merged entry), so no undo is known to lead back to it: unsaved wherever undo goes.
        saved = null;
        set({ path, unsaved: true });
        return;
      }
      saved = past[past.length - 1] ?? 'base';
      changedOutsideHistory = false;
      set({ path, unsaved: false });
    },

    markUnsaved() {
      notInRecipe('markUnsaved');
      saved = null;
      if (!get().unsaved) set({ unsaved: true });
    },
  }));
}

export const docStore: StoreApi<DocState> = createDocStore({ ui: uiStore });
