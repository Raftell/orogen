// The life of a project in the application (runtime.md 4.5, 8.5, 8.6): the default project, new, open, save and
// save as through the bridge, the question before unsaved changes are discarded, and the recent files. No DOM
// and no React: what needs a window is handed in.

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

export interface ProjectHost {
  readonly doc: StoreApi<DocState>;
  readonly registry: NodeRegistry;
  readonly platform: PlatformApi;
  recent(): readonly string[];
  setRecent(recent: readonly string[]): void;
  /** Asks what becomes of the unsaved changes. */
  askUnsaved(): Promise<UnsavedAnswer>;
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
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  /** True when there is nothing to lose any more: nothing was unsaved, it was saved, or the user discards it. */
  mayDiscard(): Promise<boolean>;
  clearRecent(): void;
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

  async function write(path: string): Promise<boolean> {
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

  async function load(path: string): Promise<boolean> {
    let parsed: ReturnType<typeof parseDoc>;
    try {
      parsed = parseDoc(await platform.readTextFile(path), registry);
    } catch (thrown) {
      host.showFailure(`${baseName(path)} could not be opened`, messageOf(thrown));
      return false;
    }
    doc.getState().load(parsed.doc, path);
    host.setRecent(recentWith(host.recent(), path));
    if (parsed.problems.length > 0) host.showProblems(path, parsed.problems);
    return true;
  }

  return {
    start: () => queued(async () => {
      const file = platform.launchProject;
      if (file !== null && await load(file)) return;
      doc.getState().load(defaultDoc(registry), null);
    }),
    newProject: () => queued(async () => {
      if (!await mayDiscard()) return false;
      doc.getState().load(defaultDoc(registry), null);
      return true;
    }),
    open: () => queued(async () => {
      if (!await mayDiscard()) return false;
      const path = await platform.openProjectDialog();
      return path === null ? false : load(path);
    }),
    openPath: (path) => queued(async () => (await mayDiscard()) && load(path)),
    save: () => queued(save),
    saveAs: () => queued(saveAs),
    mayDiscard: () => queued(mayDiscard),
    clearRecent: () => host.setRecent([]),
  };
}
