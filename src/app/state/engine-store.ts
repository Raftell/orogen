// engineStore (runtime.md 8.5): everything the engine reports, as a pure reduction of the EngineEvent stream.
// Nothing but `reduceEngineEvent` produces a state, so a recorded list of events gives the state it gave before.
// Thumbnail pixels are not state: src/app/engine/thumbnails.ts keeps them.

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { BuildPlan, BuildProblem, BuildResult, EngineEvent, GpuCaps, MemoryReport, NodeError } from '../../core/runtime.ts';

export interface NodeRuntime {
  readonly requestId: number;                      // the request that last reported on this node
  readonly state: 'idle' | 'running' | 'done' | 'error' | 'skipped';
  readonly cached: boolean;
  readonly fraction: number;                       // 0 .. 1 while running
  readonly label: string | null;
  readonly etaMs: number | null;
  readonly wallMs: number | null;
  readonly peakBytes: number | null;
  readonly error: NodeError | null;                // for 'error'
  readonly upstream: string | null;                // for 'skipped' because of a failed node: that node's id
}

export interface EngineState {
  readonly device: { readonly state: 'starting' | 'ready' | 'lost' | 'failed'; readonly caps: GpuCaps | null; readonly message: string | null };
  readonly nodes: Readonly<Record<string, NodeRuntime>>;
  readonly keys: Readonly<Record<string, string>>;             // node id → contentKey of the latest document sent
  readonly thumbnailKeys: Readonly<Record<string, string>>;    // node id → contentKey of the thumbnail last received
  readonly view: { readonly revision: number; readonly resolution: number; readonly draft: boolean } | null;
  readonly viewRequestId: number | null;                        // the newest request made for the view, a draft or a build
  readonly evaluation: { readonly requestId: number; readonly purpose: 'view' | 'draft' | 'thumbnails' | 'build';
                         readonly fraction: number; readonly etaMs: number | null } | null;
  readonly build: {
    readonly running: boolean;                                       // build-start .. build-end
    readonly requestId: number | null;                               // build-start
    readonly plan: BuildPlan | null;                                 // build-plan
    readonly target: { readonly index: number; readonly count: number;
                       readonly nodeId: string; readonly label: string } | null;   // build-target
    readonly phase: 'targets' | 'weights' | 'commit' | null;         // build-progress
    readonly fraction: number;                                       // build-progress; 0 before the first
    readonly problems: readonly BuildProblem[];                      // build-problem, in order
    readonly result: BuildResult | null;                             // build-result
    readonly lastStatus: 'ok' | 'errors' | 'aborted' | 'device-lost' | null;   // build-end
  };
  readonly memory: MemoryReport | null;
}

const NO_BUILD: EngineState['build'] = {
  running: false, requestId: null, plan: null, target: null, phase: null, fraction: 0, problems: [], result: null, lastStatus: null,
};

/** The state before the first event: of a new store, and of a store whose session was replaced. */
export const INITIAL_ENGINE_STATE: EngineState = {
  device: { state: 'starting', caps: null, message: null },
  nodes: {},
  keys: {},
  thumbnailKeys: {},
  view: null,
  viewRequestId: null,
  evaluation: null,
  build: NO_BUILD,
  memory: null,
};

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const PENDING = { cached: false, fraction: 0, label: null, etaMs: null, wallMs: null, peakBytes: null, error: null, upstream: null } as const;

/**
 * Whether an event of this request says anything of the node, given what is known of it.
 * 1. The rule of 7.7: an event of a request older than the newest request that has reported on the node is ignored.
 * 2. A request made for thumbnails says nothing of a node the newest request for the view, a draft or a build
 *    reported on. It evaluates at another resolution, and the session aborts it before its first node when one
 *    is too slow (7.3 rule 9): neither is news of the result the view shows.
 */
function reports(state: EngineState, requestId: number, known: NodeRuntime | undefined): boolean {
  if (!known) return true;
  if (known.requestId > requestId) return false;
  const forThumbnails = state.evaluation?.requestId === requestId && state.evaluation.purpose === 'thumbnails';
  return !(forThumbnails && known.requestId === state.viewRequestId);
}

/** `make` gets what is known of the node, from this request or an earlier one. */
function onNode(
  state: EngineState, requestId: number, nodeId: string, make: (known: NodeRuntime | undefined) => NodeRuntime,
): EngineState {
  const known = own(state.nodes, nodeId);
  if (!reports(state, requestId, known)) return state;
  return { ...state, nodes: { ...state.nodes, [nodeId]: make(known) } };
}

/** The request the build members belong to: events of an earlier build that arrive late change nothing. */
function onBuild(state: EngineState, requestId: number, change: (build: EngineState['build']) => Partial<EngineState['build']>): EngineState {
  if (state.build.requestId !== requestId) return state;
  return { ...state, build: { ...state.build, ...change(state.build) } };
}

/** Pure: the state after `event`. The same object when the event changes nothing. */
export function reduceEngineEvent(state: EngineState, event: EngineEvent): EngineState {
  switch (event.type) {
    // ---- the device (7.7, 7.8) ----
    case 'device-ready':
      return { ...state, device: { state: 'ready', caps: event.caps, message: null } };
    case 'device-lost':
      // What was shown went with the device (7.8 rule 1). The nodes that were running are told by their own events.
      return { ...state, device: { state: 'lost', caps: state.device.caps, message: event.message }, view: null };
    case 'engine-error':
      // An error that is not fatal is no state: the session goes on. Whoever shows it subscribes to the client.
      if (!event.fatal) return state;
      return { ...state, device: { state: 'failed', caps: state.device.caps, message: event.message } };

    // ---- requests and evaluations (5.10, 7.7) ----
    case 'request-start':
      return {
        ...state,
        evaluation: { requestId: event.requestId, purpose: event.purpose, fraction: 0, etaMs: null },
        viewRequestId: event.purpose === 'thumbnails' ? state.viewRequestId : event.requestId,
      };
    case 'eval-start': {
      let next = state;
      if (state.evaluation?.requestId !== event.requestId) {
        // A stream that begins inside a request: the mode says as much as is known of its purpose.
        next = { ...state, evaluation: { requestId: event.requestId, purpose: event.mode === 'build' ? 'build' : 'view', fraction: 0, etaMs: null } };
      }
      // A node that will run, and one that will fail or be skipped, has no result under this request yet.
      // A node the plan calls cached, bypassed or unused keeps what is known of it until its node-done.
      const nodes: Record<string, NodeRuntime> = { ...next.nodes };
      let changed = false;
      for (const planned of event.plan) {
        if (planned.state !== 'run' && planned.state !== 'blocked') continue;
        if (!reports(next, event.requestId, own(nodes, planned.nodeId))) continue;
        nodes[planned.nodeId] = { requestId: event.requestId, state: 'idle', ...PENDING };
        changed = true;
      }
      return changed ? { ...next, nodes } : next;
    }
    case 'node-start':
      return onNode(state, event.requestId, event.nodeId, () => ({ requestId: event.requestId, state: 'running', ...PENDING }));
    case 'node-progress':
      return onNode(state, event.requestId, event.nodeId, () => ({
        requestId: event.requestId, state: 'running', ...PENDING, fraction: event.fraction, label: event.label ?? null, etaMs: event.etaMs,
      }));
    case 'node-preview':
      return state;
    case 'node-done':
      return onNode(state, event.requestId, event.nodeId, (known) => ({
        requestId: event.requestId, state: 'done', ...PENDING, cached: event.cached, fraction: 1,
        // A node that did not run now reports no time of its own: what its last run took stays.
        wallMs: event.cached ? (known?.state === 'done' ? known.wallMs : null) : event.wallMs,
        peakBytes: event.cached ? (known?.state === 'done' ? known.peakBytes : null) : event.peakBytes,
      }));
    case 'node-error':
      return onNode(state, event.requestId, event.error.nodeId, () => ({ requestId: event.requestId, state: 'error', ...PENDING, error: event.error }));
    case 'node-skipped':
      return onNode(state, event.requestId, event.nodeId, () => (event.reason === 'upstream'
        ? { requestId: event.requestId, state: 'skipped', ...PENDING, upstream: event.upstream ?? null }
        : { requestId: event.requestId, state: 'idle', ...PENDING }));
    case 'eval-progress':
      if (state.evaluation?.requestId !== event.requestId) return state;
      return { ...state, evaluation: { ...state.evaluation, fraction: event.fraction, etaMs: event.etaMs } };
    case 'eval-end':
      if (state.evaluation?.requestId !== event.requestId) return state;
      // A build goes on after its evaluation, converting and writing: its request ends with build-end, so that
      // `evaluation === null` never reads "nothing is running" in the middle of a build.
      if (state.build.running && state.build.requestId === event.requestId) return { ...state, evaluation: { ...state.evaluation, etaMs: null } };
      return { ...state, evaluation: null };

    // ---- what the session knows of the document (7.3 rule 8, 7.4) ----
    case 'keys':
      return { ...state, keys: event.keys };
    case 'view-updated':
      return {
        ...state,
        view: { revision: event.revision, resolution: event.resolution, draft: event.draft },
        // A view that names nothing is shown without an evaluation, under a request id of its own (7.4 rule 5):
        // from then on no node is one the view reported on.
        viewRequestId: Math.max(state.viewRequestId ?? 0, event.requestId),
      };
    case 'thumbnail':
      return { ...state, thumbnailKeys: { ...state.thumbnailKeys, [event.nodeId]: event.contentKey } };
    case 'memory': {
      const { type: _type, ...memory } = event;
      return { ...state, memory };
    }

    // ---- the build (7.6, export-unreal.md 3.9) ----
    case 'build-start':
      return { ...state, build: { ...NO_BUILD, running: true, requestId: event.requestId } };
    case 'build-plan':
      return onBuild(state, event.requestId, () => ({ plan: event.plan }));
    case 'build-target':
      return onBuild(state, event.requestId, () => ({ target: { index: event.index, count: event.count, nodeId: event.nodeId, label: event.label } }));
    case 'build-progress':
      return onBuild(state, event.requestId, () => ({ phase: event.phase, fraction: event.fraction }));
    case 'build-problem':
      return onBuild(state, event.requestId, (build) => ({ problems: [...build.problems, event.problem] }));
    case 'build-result':
      return onBuild(state, event.requestId, () => ({ result: event.result }));
    case 'build-end': {
      const ended = onBuild(state, event.requestId, () => ({ running: false, lastStatus: event.status }));
      return ended.evaluation?.requestId === event.requestId ? { ...ended, evaluation: null } : ended;
    }
    default:
      // An event of a newer engine than this interface knows: it is no state.
      return state;
  }
}

export function createEngineStore(): StoreApi<EngineState> {
  return createStore<EngineState>()(() => INITIAL_ENGINE_STATE);
}

/** The one way the store changes. */
export function applyEngineEvent(store: StoreApi<EngineState>, event: EngineEvent): void {
  const state = store.getState();
  const next = reduceEngineEvent(state, event);
  if (next !== state) store.setState(next, true);
}

/** The state a recorded list of events leads to. */
export function reduceEngineEvents(events: Iterable<EngineEvent>, from: EngineState = INITIAL_ENGINE_STATE): EngineState {
  let state = from;
  for (const event of events) state = reduceEngineEvent(state, event);
  return state;
}

export const engineStore: StoreApi<EngineState> = createEngineStore();
