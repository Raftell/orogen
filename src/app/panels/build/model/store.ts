// The build panel's own state and what it does (runtime.md 8.7): the output folder of each project, what the
// event stream said of the build beyond engineStore (log.ts), and the manifest and the report of the last build
// as the bridge read them. One model serves the panel's component and its commands, which run whether the
// component is mounted or not. Nothing here copies a store: the build's state is engineStore's. No DOM and no
// React.
//
// A plan before a build. The session has no method that plans without building, and the interface may not plan
// (export-unreal.md 3.1). The model asks for one where it can: `planner` is `EngineSession.plan(doc)` when the
// session has such a member, which today it has not, so `draft` stays null and the panel lists the export nodes
// instead (plan.ts). The day the session plans, the plan of the project as it stands is shown without a build.

import { createStore, type StoreApi } from 'zustand/vanilla';

import { setSettings, type BuildPlan, type BuildResult, type EngineEvent, type EngineSession, type GraphDoc } from '../../../../core/runtime.ts';
import type { DocState } from '../../../state/doc-store.ts';
import type { EngineState } from '../../../state/engine-store.ts';
import { selectNodes } from '../../../state/ui-store.ts';
import type { CommandContext } from '../../../ui/types.ts';
import { folderWarning } from './folder.ts';
import { reduceBuildLog, reduceMeasurements, seedMeasurements, type BuildLog, type Measurements } from './log.ts';
import { parseManifest, parseReport, type ManifestView, type Read, type ReportView } from './manifest.ts';
import { joinPath } from './paths.ts';
import { exportNodes, knownProblems } from './plan.ts';
import { firstProblemNode } from './problems.ts';

/** The manifest and the report of one build, as files. A member is null while it is read, and when the build wrote none. */
export interface BuildFiles {
  readonly requestId: number;
  /** The folder that holds them: the output folder of a build that succeeded, else the staging folder beside it. */
  readonly folder: string | null;
  readonly manifestPath: string | null;
  readonly manifest: Read<ManifestView> | null;
  readonly reportPath: string | null;
  readonly report: Read<ReportView> | null;
  readonly reading: boolean;
}

export interface PanelState {
  /** The output folder of each project, by the path of its file; '' for a project that has none yet. */
  readonly folders: Readonly<Record<string, string>>;
  /** The sections of the panel that are folded away, by their id. */
  readonly folded: readonly string[];
  /** Counts the projects that were loaded: what a build made belongs to the project that was open then. */
  readonly project: number;
  readonly log: BuildLog | null;
  /** Of which project, and of which state of it, the build of `log` is. */
  readonly built: { readonly requestId: number; readonly project: number; readonly signature: string } | null;
  readonly measurements: Measurements;
  readonly files: BuildFiles | null;
  /** The plan of the project in the state `signature` names, made without a build; null where nothing plans (see above). */
  readonly draft: { readonly signature: string; readonly plan: BuildPlan } | null;
  readonly guideOpen: boolean;
}

export type ModelContext = Pick<CommandContext, 'doc' | 'engineState' | 'ui' | 'engine' | 'platform' | 'registry'>;

/** Where the panel keeps what outlives the application: the page's storage, or a stand-in. */
export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A plan of a document, made without building it. */
export type Planner = (doc: GraphDoc) => Promise<BuildPlan> | BuildPlan;

export interface ModelOptions {
  /** Milliseconds of a clock that only goes forward. Default `performance.now()`. */
  readonly clock?: () => number;
  /** Default: nothing is kept. The application passes the page's storage. */
  readonly storage?: PanelStorage | null;
  /** Default: the session's own `plan`, when it has one. */
  readonly planner?: Planner | null;
  /** Runs `run` after `ms` and returns what cancels it. Default: a timer. */
  readonly defer?: (run: () => void, ms: number) => () => void;
}

/** What is asked of a build as it stands in the two stores, for the project that is open. */
export interface BuildScope {
  readonly build: EngineState['build'];
  /** The build is of the project that is open: what it planned and wrote may be shown as this project's. */
  readonly mine: boolean;
  /** The project has changed since the build was started. */
  readonly changed: boolean;
  /** What the event stream said of this build; null when nobody listened. */
  readonly log: BuildLog | null;
}

export interface BuildModel {
  readonly state: StoreApi<PanelState>;
  /** The output folder of the project that is open; null: none was chosen. */
  folder(): string | null;
  setFolder(folder: string | null): void;
  /** Asks for a folder through the bridge. Resolves with the folder chosen, or null when the dialog was cancelled. */
  chooseFolder(): Promise<string | null>;
  /**
   * Starts a build into the project's folder. Without one, or with one the build is certain to refuse, it asks
   * for a folder first. Resolves when the build has ended, however it ended.
   */
  start(): Promise<void>;
  cancel(): void;
  setResolution(resolution: number): void;
  selectNode(nodeId: string): void;
  setFolded(section: string, folded: boolean): void;
  /** The last build as it stands for the project that is open. */
  scope(): BuildScope;
  /** The node of the first problem the panel shows that names one: of this project's build, else of the project as it stands; null: none does. */
  problemNode(): string | null;
  /** What `reveal` shows: the manifest of this project's last build, or the report of one that failed; null: nothing is on disk. */
  revealTarget(): string | null;
  reveal(): void;
  /** The manifest of this project's last build that succeeded, with the folder it lies in; null: there is none, or it is not read. */
  importSource(): { readonly manifest: ManifestView; readonly folder: string | null } | null;
  setGuideOpen(open: boolean): void;
  dispose(): void;
}

const projectKey = (path: string | null): string => path ?? '';

// ---- the signature of a document ---------------------------------------------------------------------------------------

type Signed = Pick<GraphDoc, 'settings' | 'nodes' | 'edges'>;

// A document is never written into (8.5): a node, a table of edges or the settings that are the same object say
// the same. One node changes per edit, so one node is written anew per edit, whatever the size of the graph.
const nodeTexts = new WeakMap<object, string>();
const partTexts = new WeakMap<object, string>();
let lastSignature: (Signed & { readonly text: string }) | null = null;

function textOf(part: object, write: () => string): string {
  let text = partTexts.get(part);
  if (text === undefined) partTexts.set(part, text = write());
  return text;
}

/**
 * What of a document a build reads, as text: the settings, the wiring, and of every node its type, version,
 * parameters and bypass. Two documents with one signature build to the same files. Where a node stands, what
 * it is called and what the viewport shows are not in it: selecting a node changes the view, and a build that
 * was made before is still the build of the project.
 */
export function buildSignature(doc: Signed): string {
  if (lastSignature && lastSignature.nodes === doc.nodes && lastSignature.edges === doc.edges && lastSignature.settings === doc.settings) return lastSignature.text;
  const nodes = textOf(doc.nodes, () => Object.keys(doc.nodes).sort().map((id) => {
    const node = doc.nodes[id]!;
    let text = nodeTexts.get(node);
    if (text === undefined) nodeTexts.set(node, text = JSON.stringify([id, node.type, node.version, node.params, node.bypass === true]));
    return text;
  }).join(','));
  const edges = textOf(doc.edges, () => JSON.stringify(Object.keys(doc.edges).sort().map((id) => {
    const edge = doc.edges[id]!;
    return [edge.from.node, edge.from.port, edge.to.node, edge.to.port];
  })));
  const text = `[${textOf(doc.settings, () => JSON.stringify(doc.settings))},[${nodes}],${edges}]`;
  lastSignature = { nodes: doc.nodes, edges: doc.edges, settings: doc.settings, text };
  return text;
}

/** What the model recorded of the build engineStore holds; null when nobody recorded its start. */
export function builtOf(build: EngineState['build'], held: Pick<PanelState, 'built'>): NonNullable<PanelState['built']> | null {
  return held.built !== null && held.built.requestId === build.requestId ? held.built : null;
}

/**
 * Pure: how the build of engineStore stands for the project that is open. `differs` says whether the document
 * of the moment builds to something else than the state the build was started with.
 */
export function scopeOf(build: EngineState['build'], held: Pick<PanelState, 'built' | 'project' | 'log'>, differs: boolean): BuildScope {
  const known = builtOf(build, held);
  // A build nobody recorded the start of is taken for this project's: there is nothing to tell it apart by.
  const mine = build.requestId !== null && (known === null || known.project === held.project);
  return {
    build,
    mine,
    changed: mine && !build.running && known !== null && differs,
    log: held.log !== null && held.log.requestId === build.requestId ? held.log : null,
  };
}

/**
 * Whether the document was replaced by another: `load` makes every member anew and empties the history, and
 * nothing else does both. A transaction that is not undoable touches the settings and the view alone, and an
 * undo or a redo leaves an entry on one side of the history.
 */
function isLoad(now: DocState, before: DocState): boolean {
  const a = now.doc, b = before.doc;
  return a !== b && a.nodes !== b.nodes && a.edges !== b.edges && a.settings !== b.settings && a.ui !== b.ui
    && now.past.length === 0 && now.future.length === 0 && !now.unsaved;
}

// ---- what outlives the application -------------------------------------------------------------------------------------

const STORAGE_KEY = 'orogen.build/1';
/** The projects whose folder is remembered: the last that were given one. */
const FOLDERS_KEPT = 64;
const SECTIONS_KEPT = 16;

interface Kept {
  readonly folders: Readonly<Record<string, string>>;
  readonly folded: readonly string[];
}

/** What the storage holds, as far as it is of the kind expected; a storage that cannot be read holds nothing. */
function readKept(storage: PanelStorage | null): Kept {
  const none: Kept = { folders: {}, folded: [] };
  if (!storage) return none;
  try {
    const held = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as { readonly folders?: unknown; readonly folded?: unknown } | null;
    if (typeof held !== 'object' || held === null) return none;
    const folders: Record<string, string> = {};
    if (typeof held.folders === 'object' && held.folders !== null && !Array.isArray(held.folders)) {
      for (const [project, folder] of Object.entries(held.folders).slice(-FOLDERS_KEPT)) {
        if (project !== '' && typeof folder === 'string' && folder !== '') folders[project] = folder;
      }
    }
    const folded = Array.isArray(held.folded) ? held.folded.filter((id): id is string => typeof id === 'string').slice(0, SECTIONS_KEPT) : [];
    return { folders, folded };
  } catch {
    return none;
  }
}

/** The folder of a project without a file is that of one session: the next project without a file chooses its own. */
function keptOf(state: Pick<PanelState, 'folders' | 'folded'>): Kept {
  const folders = Object.fromEntries(Object.entries(state.folders).filter(([project]) => project !== '').slice(-FOLDERS_KEPT));
  return { folders, folded: state.folded.slice(0, SECTIONS_KEPT) };
}

/** The session's own `plan`, when it has one (see the note at the head of this file). */
function plannerOf(engine: EngineSession): Planner | null {
  const plan = (engine as { readonly plan?: unknown }).plan;
  return typeof plan === 'function' ? (doc) => (plan as Planner).call(engine, doc) : null;
}

/** A plan follows the document this long after its last change: one request per pause, not one per step of a drag. */
const PLAN_DELAY_MS = 200;

const timer = (run: () => void, ms: number): (() => void) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

export function createBuildModel(ctx: ModelContext, options: ModelOptions = {}): BuildModel {
  const clock = options.clock ?? (() => performance.now());
  const storage = options.storage ?? null;
  const defer = options.defer ?? timer;
  const kept = readKept(storage);
  const state = createStore<PanelState>()(() => ({
    folders: kept.folders, folded: kept.folded, project: 0, log: null, built: null,
    measurements: seedMeasurements(ctx.engineState.getState()), files: null, draft: null, guideOpen: false,
  }));
  /** Set by `start` until the build's first event: what the build was started with. */
  let pending: { readonly project: number; readonly signature: string } | null = null;
  let starting = false;
  let disposed = false;
  let cancelPlan: (() => void) | null = null;

  const folder = (): string | null => {
    const { folders } = state.getState();
    const key = projectKey(ctx.doc.getState().path);
    return Object.hasOwn(folders, key) ? folders[key]! : null;
  };

  function setFolder(next: string | null): void {
    const key = projectKey(ctx.doc.getState().path);
    // Taken out and put in again: the project whose folder was set last is the last of the table.
    const { [key]: _before, ...others } = state.getState().folders;
    state.setState({ folders: next !== null && next !== '' ? { ...others, [key]: next } : others });
  }

  const scope = (): BuildScope => {
    const { build } = ctx.engineState.getState();
    const held = state.getState();
    return scopeOf(build, held, builtOf(build, held)?.signature !== buildSignature(ctx.doc.getState().doc));
  };

  /** The files a build left, read as text through the bridge (8.6): both are small JSON. */
  async function readFiles(result: BuildResult): Promise<void> {
    const dir = result.outDir;
    const manifestPath = dir !== null && result.manifest !== null ? joinPath(dir, result.manifest) : null;
    const reportPath = dir !== null && result.report !== null ? joinPath(dir, result.report) : null;
    const base: BuildFiles = { requestId: result.requestId, folder: dir, manifestPath, manifest: null, reportPath, report: null, reading: manifestPath !== null || reportPath !== null };
    state.setState({ files: base });
    if (!base.reading) return;
    const read = async <T>(path: string | null, parse: (text: string) => Read<T>): Promise<Read<T> | null> => {
      if (path === null) return null;
      try {
        return parse(await ctx.platform.readTextFile(path));
      } catch (thrown) {
        return { ok: false, reason: thrown instanceof Error ? thrown.message : String(thrown) };
      }
    };
    const [manifest, report] = await Promise.all([read(manifestPath, parseManifest), read(reportPath, parseReport)]);
    // Another build may have started meanwhile: its own result replaces these.
    if (disposed || state.getState().files?.requestId !== result.requestId) return;
    state.setState({ files: { ...base, manifest, report, reading: false } });
  }

  /** Asks for the plan of the document as it stands, once it has stood for a moment. Does nothing where nothing plans. */
  function schedulePlan(): void {
    const planner = options.planner !== undefined ? options.planner : plannerOf(ctx.engine);
    if (planner === null || disposed) return;
    cancelPlan?.();
    cancelPlan = defer(() => {
      cancelPlan = null;
      if (disposed || ctx.engineState.getState().build.running) return;
      const { doc } = ctx.doc.getState();
      const signature = buildSignature(doc);
      if (state.getState().draft?.signature === signature) return;
      void Promise.resolve().then(() => planner(doc)).then((plan) => {
        // The document may have changed meanwhile: its own plan is on the way.
        if (!disposed && buildSignature(ctx.doc.getState().doc) === signature) state.setState({ draft: { signature, plan } });
      }, () => {
        // A session that cannot plan now says so by rejecting: the export nodes are listed instead.
      });
    }, PLAN_DELAY_MS);
  }

  function onEvent(event: EngineEvent): void {
    const held = state.getState();
    const measurements = reduceMeasurements(held.measurements, event);
    const log = reduceBuildLog(held.log, event, clock());
    if (event.type === 'build-start') {
      const built = { requestId: event.requestId, project: pending?.project ?? held.project, signature: pending?.signature ?? buildSignature(ctx.doc.getState().doc) };
      pending = null;
      state.setState({ log, measurements, built, files: null });
      return;
    }
    if (log !== held.log || measurements !== held.measurements) state.setState({ log, measurements });
    if (event.type === 'build-result') void readFiles(event.result);
    if (event.type === 'build-end') schedulePlan();
  }

  const stops = [
    ctx.engine.subscribe(onEvent),
    ctx.doc.subscribe((now, before) => {
      const held = state.getState();
      if (now.doc.nodes !== before.doc.nodes || now.doc.edges !== before.doc.edges || now.doc.settings !== before.doc.settings) schedulePlan();
      if (isLoad(now, before)) {
        // The folder of a project without a file was that project's: the next one without a file chooses its own.
        const { '': _unsaved, ...folders } = held.folders;
        state.setState({ project: held.project + 1, folders, draft: null });
        return;
      }
      if (now.path === before.path) return;
      // Saved under a name, or another name: the folder goes with the project.
      const from = projectKey(before.path), to = projectKey(now.path);
      if (!Object.hasOwn(held.folders, from) || Object.hasOwn(held.folders, to)) return;
      const { [from]: moved, ...rest } = held.folders;
      state.setState({ folders: { ...(from === '' ? rest : held.folders), [to]: moved! } });
    }),
  ];
  if (storage) {
    stops.push(state.subscribe((now, before) => {
      if (now.folders === before.folders && now.folded === before.folded) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(keptOf(now)));
      } catch {
        // A full or forbidden storage: the panel works without remembering.
      }
    }));
  }

  // A build that ended before anybody listened: what it wrote is on disk all the same.
  const earlier = ctx.engineState.getState().build;
  if (!earlier.running && earlier.result) void readFiles(earlier.result);
  schedulePlan();

  const model: BuildModel = {
    state,
    folder,
    setFolder,
    scope,

    async chooseFolder() {
      const chosen = await ctx.platform.chooseFolder();
      if (chosen !== null && chosen !== '') setFolder(chosen);
      return chosen === '' ? null : chosen;
    },

    async start() {
      const engine = ctx.engineState.getState();
      if (starting || engine.build.running || engine.device.state !== 'ready') return;
      starting = true;
      try {
        let outDir = folder();
        if (outDir === null || folderWarning(outDir, ctx.doc.getState().path) !== null) {
          outDir = await model.chooseFolder();
          if (outDir === null) return;
        }
        const doc = ctx.doc.getState();
        pending = { project: state.getState().project, signature: buildSignature(doc.doc) };
        // A build that fails resolves as well (7.6): its result arrives with the events. What rejects is a defect.
        await ctx.engine.build({ doc: doc.doc, outDir });
      } finally {
        starting = false;
        pending = null;
      }
    },

    cancel: () => ctx.engine.cancelBuild(),

    setResolution(resolution) {
      if (!Number.isInteger(resolution) || resolution === ctx.doc.getState().doc.settings.buildResolution) return;
      // 8.5 rule 5: the build resolution is no undo step.
      ctx.doc.getState().transact('Build resolution', (draft) => setSettings(draft, { buildResolution: resolution }), { undoable: false });
    },

    selectNode(nodeId) {
      if (Object.hasOwn(ctx.doc.getState().doc.nodes, nodeId)) selectNodes(ctx, [nodeId]);
    },

    setFolded(section, folded) {
      const held = state.getState().folded;
      if (held.includes(section) === folded) return;
      state.setState({ folded: folded ? [...held, section] : held.filter((id) => id !== section) });
    },

    problemNode() {
      const { build, mine } = scope();
      const { doc } = ctx.doc.getState();
      // What the panel shows: the problems of this project's build, then those of the project as it stands.
      const built = mine ? firstProblemNode(build.result?.problems ?? [...(build.plan?.problems ?? []), ...build.problems], doc) : null;
      if (built !== null) return built;
      const { draft } = state.getState();
      const standing = draft !== null && draft.signature === buildSignature(doc) ? draft.plan.problems : knownProblems(exportNodes(doc, ctx.registry));
      return firstProblemNode(standing, doc);
    },

    revealTarget() {
      const { build, mine } = scope();
      const { result } = build;
      if (!mine || !result || result.outDir === null) return null;
      const file = result.manifest ?? result.report;
      return file === null ? result.outDir : joinPath(result.outDir, file);
    },

    reveal() {
      const target = model.revealTarget();
      if (target !== null) ctx.platform.showInFolder(target);
    },

    importSource() {
      const { build, mine } = scope();
      const { files } = state.getState();
      if (!mine || build.running || build.result?.status !== 'ok' || !files || files.requestId !== build.requestId || !files.manifest?.ok) return null;
      return { manifest: files.manifest.value, folder: files.folder };
    },

    setGuideOpen(open) {
      if (state.getState().guideOpen !== open) state.setState({ guideOpen: open });
    },

    dispose() {
      disposed = true;
      cancelPlan?.();
      cancelPlan = null;
      for (const stop of stops.splice(0)) stop();
    },
  };
  return model;
}

/**
 * The storage of the page; null where there is no page (a test without a window, where Node has a storage of
 * its own that is no user's) or the storage may not be used.
 */
function pageStorage(): PanelStorage | null {
  try {
    const page = globalThis as { readonly document?: unknown; readonly localStorage?: PanelStorage };
    return page.document === undefined ? null : page.localStorage ?? null;
  } catch {
    return null;
  }
}

const models = new WeakMap<object, BuildModel>();

/** The model of an application: made when the panel is first shown or one of its commands first asked for. */
export function buildModel(ctx: ModelContext): BuildModel {
  let model = models.get(ctx);
  if (!model) models.set(ctx, model = createBuildModel(ctx, { storage: pageStorage() }));
  return model;
}
