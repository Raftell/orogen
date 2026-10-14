// The life of a project in the application (runtime.md 4.5, 8.5, 8.6): the default project, new, open, save and
// save as through the bridge, the questions before a project is left (a build that runs, changes that are not
// saved), the question before a file is overwritten that another program changed, what is kept of an unsaved
// project for a run that ends without a save, and the recent files. No DOM and no React: what needs a window is
// handed in.

import type { StoreApi } from 'zustand/vanilla';

import {
  addNode, newDoc, parseDoc, serializeDoc, setParam, setView,
  type DocDraft, type DocProblem, type GraphDoc, type NodeRegistry,
} from '../../core/runtime.ts';
import type { PlatformApi } from '../platform.ts';
import type { DocState } from '../state/doc-store.ts';
import type { Notice } from '../ui/types.ts';
import { baseName, folderOf, isAbsolutePath } from './format.ts';

/** The node a new project starts with: a terrain to look at and to build on. */
export const DEFAULT_NODE = 'generate/mountain-range';
/** Paths kept in Preferences.recent, newest first. */
export const RECENT_MAX = 12;
/** A save is repeated when the document changed while the file was written; this often at most. Then the project stays unsaved. */
const SAVE_ATTEMPTS = 3;
/**
 * An unsaved project is kept for recovery this long after a change (8.6): a run that ends without a save costs
 * the changes of these seconds. The wait begins with the first change that is not kept and is not begun again
 * by the next, so that a value dragged for a minute is kept every few seconds of that minute.
 */
export const RECOVERY_DELAY_MS = 3000;

/** A new project: the default settings and one terrain, shown. Without that node type in the registry, an empty document. */
export function defaultDoc(registry: NodeRegistry): GraphDoc {
  const draft = structuredClone(newDoc()) as DocDraft;
  const def = registry.get(DEFAULT_NODE);
  const output = def?.outputs[0];
  if (def && output) {
    const id = addNode(draft, registry, DEFAULT_NODE, { x: 0, y: 0 });
    setView(draft, { height: { node: id, port: output.name } });
  }
  return draft as GraphDoc;
}

/** `path` at the front of the list, once. */
export function recentWith(recent: readonly string[], path: string): string[] {
  return [path, ...recent.filter((entry) => entry !== path)].slice(0, RECENT_MAX);
}

export interface FileMove { readonly nodeId: string; readonly name: string; readonly value: string }

/**
 * The `file` parameters whose stored path changes when the project file moves from `from` to `to` (6.1 rule 2: a
 * path is stored relative to the project file when the file lies under its folder, and absolute otherwise).
 * A relative path of a project that was never saved names nothing and stays.
 */
export function relocatedFiles(
  doc: GraphDoc, registry: NodeRegistry, from: string | null, to: string, toProjectPath: PlatformApi['toProjectPath'],
): FileMove[] {
  const moves: FileMove[] = [];
  for (const node of Object.values(doc.nodes)) {
    const def = registry.get(node.type);
    if (!def) continue;
    for (const param of def.params) {
      if (param.kind !== 'file') continue;
      const stored = Object.hasOwn(node.params, param.name) ? node.params[param.name] : undefined;
      if (typeof stored !== 'string' || stored === '') continue;
      let absolute = stored;
      if (!isAbsolutePath(stored)) {
        if (from === null) continue;
        absolute = `${folderOf(from)}/${stored}`;
      }
      const value = toProjectPath(to, absolute);
      if (value !== stored) moves.push({ nodeId: node.id, name: param.name, value });
    }
  }
  return moves;
}

export type UnsavedAnswer = 'save' | 'discard' | 'cancel';
/** What becomes of a save onto a file another program changed: write over it, save under another name, or leave both as they are. */
export type ChangedAnswer = 'overwrite' | 'saveAs' | 'cancel';

/** What the user is about to do to the project that is open: make another, open another, or close the window. */
export type Leaving = 'new' | 'open' | 'close';

export interface ProjectHost {
  readonly doc: StoreApi<DocState>;
  readonly registry: NodeRegistry;
  readonly platform: PlatformApi;
  recent(): readonly string[];
  setRecent(recent: readonly string[]): void;
  /** Asks what becomes of the unsaved changes. */
  askUnsaved(): Promise<UnsavedAnswer>;
  /** Whether a build is running: it was started from the project that is about to be left, and writes into its folder. */
  building(): boolean;
  /** Asks whether the build that runs is stopped for what the user is about to do. True: stop it and go on; false: stay. */
  askBuilding(leaving: Leaving): Promise<boolean>;
  /** Cancels the build and resolves when it has ended, or when it has not within a time the host chooses. */
  stopBuild(): Promise<void>;
  /** The project file is not the file this application read or wrote last: another program, or another Orogen, changed it. */
  askChanged(path: string): Promise<ChangedAnswer>;
  /**
   * A run before this one ended with changes no file holds, and kept them (8.6): whether they are restored.
   * `path` is the project file they belong to, null for a project that never had one; `savedAt` when they were kept.
   */
  askRecover(kept: { readonly path: string | null; readonly savedAt: number }): Promise<boolean>;
  /** Default RECOVERY_DELAY_MS. */
  readonly recoveryDelayMs?: number;
  notify(notice: Notice): void;
  /** A project opened with problems (4.5): they are shown, and the project is open. */
  showProblems(file: string, problems: readonly DocProblem[]): void;
  /** A file that is no project, or could not be read or written. */
  showFailure(title: string, message: string): void;
}

export interface ProjectService {
  /** Opens the project the application was started with, or the default project. */
  start(): Promise<void>;
  /** Each resolves true when it did what it says, false when the user cancelled or it failed. */
  newProject(): Promise<boolean>;
  open(): Promise<boolean>;
  openPath(path: string): Promise<boolean>;
  /** A document as a new project without a file: an example of the library. Asks as `open` does. */
  openDocument(document: GraphDoc): Promise<boolean>;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  /** True when there is nothing to lose any more: nothing was unsaved, it was saved, or the user discards it. */
  mayDiscard(): Promise<boolean>;
  /**
   * The questions before the project is left, in their order: first whether a build that runs is stopped, then
   * what becomes of unsaved changes. True when the user may go on: no build runs any more, and nothing is unsaved.
   */
  mayLeave(leaving: Leaving): Promise<boolean>;
  clearRecent(): void;
  /** Keeps the project for recovery now, when it has changes that are not kept: before a build, which may take the page's process with it. */
  keepNow(): Promise<void>;
  /** The window is about to close with the user's consent: nothing is kept for the next start. Resolves when what was kept is gone. */
  closing(): Promise<void>;
  /** Stops keeping. */
  dispose(): void;
}

const messageOf = (thrown: unknown): string => {
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  // The bridge wraps what the main process threw: "Error invoking remote method '…': Error: <message>".
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
};

export function createProjectService(host: ProjectHost): ProjectService {
  const { doc, registry, platform } = host;

  // One file operation at a time: a save that is still writing is not overtaken by an open.
  let last: Promise<unknown> = Promise.resolve();
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const run = last.then(work, work);
    last = run.catch(() => undefined);
    return run;
  }

  // ---- the file as this application last read or wrote it ----
  /** Its size and time then; null for a project without a file, and where the file could not be looked at. */
  let known: { readonly path: string; readonly size: number; readonly mtimeMs: number } | null = null;
  async function remember(path: string | null): Promise<void> {
    known = null;
    if (path === null) return;
    try {
      const stat = await platform.statPath(path);
      if (stat.exists && stat.isFile) known = { path, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // A bridge that cannot say: the next save asks nothing.
    }
  }
  /** Whether the file is another than the one read or written last: a second application, or another program, saved it since. */
  async function changedElsewhere(path: string): Promise<boolean> {
    if (known === null || known.path !== path) return false;
    try {
      const stat = await platform.statPath(path);
      // A file that is gone is written anew without a question: nothing of anybody's is lost by that.
      return stat.exists && (stat.size !== known.size || stat.mtimeMs !== known.mtimeMs);
    } catch {
      return false;
    }
  }

  // ---- what is kept for recovery (8.6) ----
  /** The revision the recovery file holds; null when it holds none of this run's. */
  let keptRevision: number | null = null;
  let keepTimer: ReturnType<typeof setTimeout> | null = null;
  /** `start` has read and dealt with what a run before kept: until then nothing is written over it or removed. */
  let settled = false;
  let disposed = false;
  let keeping: Promise<void> = Promise.resolve();
  const cancelKeep = (): void => {
    if (keepTimer !== null) clearTimeout(keepTimer);
    keepTimer = null;
  };
  function keepNow(): Promise<void> {
    cancelKeep();
    const state = doc.getState();
    if (!settled || disposed || !state.unsaved || state.revision === keptRevision) return keeping;
    const revision = state.revision;
    keeping = keeping.then(() => platform.writeRecovery({ path: state.path, text: serializeDoc(state.doc) })).then(
      () => { keptRevision = revision; },
      (thrown: unknown) => { console.warn('[orogen] the project could not be kept for recovery', thrown); },
    );
    return keeping;
  }
  function forget(): Promise<void> {
    cancelKeep();
    keptRevision = null;
    keeping = keeping.then(() => platform.writeRecovery(null)).catch(() => undefined);
    return keeping;
  }
  const stopKeeping = doc.subscribe((state, previous) => {
    if (!settled || disposed) return;
    if (!state.unsaved) {
      // Saved, or another project in its place: what was kept is of changes that are in a file now, or given up.
      if (previous.unsaved || keptRevision !== null || keepTimer !== null) void forget();
      return;
    }
    if (state.revision !== keptRevision) keepTimer ??= setTimeout(() => { void keepNow(); }, host.recoveryDelayMs ?? RECOVERY_DELAY_MS);
  });

  async function write(path: string): Promise<boolean> {
    // Another program, or a second Orogen, saved this file after it was opened or last saved here: writing now
    // would take its changes away without a word.
    if (await changedElsewhere(path)) {
      const answer = await host.askChanged(path);
      if (answer === 'cancel') return false;
      if (answer === 'saveAs') return saveAs();
    }
    const from = doc.getState().path;
    const moved = (held: GraphDoc): FileMove[] => (from === path ? [] : relocatedFiles(held, registry, from, path, platform.toProjectPath));
    /** The file's text: the document with its file paths as they are stored beside the new project file. */
    const textOf = (held: GraphDoc): string => {
      const moves = moved(held);
      if (moves.length === 0) return serializeDoc(held);
      const copy = structuredClone(held) as DocDraft;
      for (const move of moves) setParam(copy, registry, move.nodeId, move.name, move.value);
      return serializeDoc(copy as GraphDoc);
    };
    /** The revision the file holds. */
    let written: number;
    try {
      for (let attempt = 1; ; attempt++) {
        written = doc.getState().revision;
        await platform.writeTextFile(path, textOf(doc.getState().doc));
        if (doc.getState().revision === written || attempt === SAVE_ATTEMPTS) break;
      }
    } catch (thrown) {
      host.showFailure(`${baseName(path)} could not be saved`, messageOf(thrown));
      return false;
    }
    await remember(path);
    // Edited through every attempt (a drag that goes on): the file is behind the project, and the project stays unsaved.
    const complete = doc.getState().revision === written;
    doc.getState().markSaved(path, written);
    // The project has its new place before the paths change: the engine resolves them from the new folder.
    const moves = moved(doc.getState().doc);
    if (moves.length > 0) {
      doc.getState().transact('Relocate Files', (draft) => {
        for (const move of moves) setParam(draft, registry, move.nodeId, move.name, move.value);
      });
      if (complete) doc.getState().markSaved(path);
    }
    host.setRecent(recentWith(host.recent(), path));
    if (!complete) host.notify({ level: 'warning', message: `${baseName(path)} was written while the project changed and lacks the last changes: save again` });
    return complete;
  }

  async function saveAs(): Promise<boolean> {
    const path = await platform.saveProjectDialog(doc.getState().path ?? undefined);
    return path === null ? false : write(path);
  }

  function save(): Promise<boolean> {
    const { path } = doc.getState();
    return path === null ? saveAs() : write(path);
  }

  async function mayDiscard(): Promise<boolean> {
    if (!doc.getState().unsaved) return true;
    const answer = await host.askUnsaved();
    if (answer === 'cancel') return false;
    return answer === 'discard' || save();
  }

  async function mayLeave(leaving: Leaving): Promise<boolean> {
    // The build first: it was started from this project, and its progress and its result are this project's to show.
    if (host.building()) {
      if (!await host.askBuilding(leaving)) return false;
      await host.stopBuild();
    }
    return mayDiscard();
  }

  async function load(path: string): Promise<boolean> {
    let parsed: ReturnType<typeof parseDoc>;
    try {
      parsed = parseDoc(await platform.readTextFile(path), registry);
    } catch (thrown) {
      host.showFailure(`${baseName(path)} could not be opened`, messageOf(thrown));
      return false;
    }
    await remember(path);
    doc.getState().load(parsed.doc, path);
    host.setRecent(recentWith(host.recent(), path));
    if (parsed.problems.length > 0) host.showProblems(path, parsed.problems);
    return true;
  }

  /** A document without a file takes the place of the project. */
  function loadUnfiled(document: GraphDoc): void {
    known = null;
    doc.getState().load(document, null);
  }

  /**
   * What a run before this one kept of an unsaved project (8.6): offered, and on a yes the project is that one,
   * with its file's name and unsaved, so that Save writes it where it belongs. What cannot be read as a project
   * is not offered. Either way the file is this run's from here on.
   */
  async function recover(): Promise<void> {
    let record: Awaited<ReturnType<PlatformApi['readRecovery']>> = null;
    try {
      record = await platform.readRecovery();
    } catch {
      // A bridge without recovery, or a file that cannot be read: nothing to offer.
    }
    if (record !== null) {
      let parsed: ReturnType<typeof parseDoc> | null = null;
      try {
        parsed = parseDoc(record.text, registry);
      } catch {
        // No project: it is removed below.
      }
      if (parsed !== null && await host.askRecover({ path: record.path, savedAt: record.savedAt })) {
        await remember(record.path);
        doc.getState().load(parsed.doc, record.path);
        doc.getState().markUnsaved();
        // What the file holds is this state: it stays until the project is saved or given up.
        keptRevision = doc.getState().revision;
        settled = true;
        return;
      }
    }
    settled = true;
    if (record !== null) await forget();
    // Changed while the question stood: kept as any change is.
    else if (doc.getState().unsaved) void keepNow();
  }

  return {
    start: () => queued(async () => {
      const file = platform.launchProject;
      if (!(file !== null && await load(file))) loadUnfiled(defaultDoc(registry));
      await recover();
    }),
    newProject: () => queued(async () => {
      if (!await mayLeave('new')) return false;
      loadUnfiled(defaultDoc(registry));
      return true;
    }),
    open: () => queued(async () => {
      if (!await mayLeave('open')) return false;
      const path = await platform.openProjectDialog();
      return path === null ? false : load(path);
    }),
    openPath: (path) => queued(async () => (await mayLeave('open')) && load(path)),
    openDocument: (document) => queued(async () => {
      if (!await mayLeave('open')) return false;
      loadUnfiled(document);
      return true;
    }),
    save: () => queued(save),
    saveAs: () => queued(saveAs),
    mayDiscard: () => queued(mayDiscard),
    mayLeave: (leaving) => queued(() => mayLeave(leaving)),
    clearRecent: () => host.setRecent([]),
    keepNow,
    closing: forget,
    dispose() {
      disposed = true;
      cancelKeep();
      stopKeeping();
    },
  };
}
