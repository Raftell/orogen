// The one place where the harness calls Engine.evaluate (testing.md section 2, rule 4): renderNode, traceNode,
// renderGraph and GraphSession.evaluate all end here. Not part of the harness's interface.

import type {
  Engine, EvalEvent, EvalTarget, EvaluateResult, FileSource, GraphDoc, NodeError,
} from '../../src/core/runtime.ts';
import { BUDGET_BYTES, exclusive, nextRequestId, obtainEngine, onEngineSlice, TEST_FILES, type EngineSlice, type Slices, type TestEngine } from './engine.ts';
import type { FieldData } from './field-data.ts';
import { checkLeaks } from './leaks.ts';

export type SliceListener = (s: { readonly nodeId: string | null; readonly kernels: readonly string[]; readonly measuredMs: number }) => void;

export interface NodeReport {
  readonly nodeId: string;
  readonly state: 'done' | 'cached' | 'bypassed' | 'error' | 'skipped';
  readonly error: NodeError | null;            // for 'error'
  readonly skipReason: 'upstream' | 'aborted' | 'device-lost' | null;   // for 'skipped'
  readonly upstream: string | null;            // for 'skipped' because of a failed node: that node's id
  readonly wallMs: number;                     // node-done.wallMs; 0 unless 'done'
  readonly peakBytes: number;                  // node-done.peakBytes; 0 unless 'done'
  readonly progress: readonly number[];        // the fraction of every node-progress event, in order
  readonly slices: number;                     // slices completed while the node ran
}
export interface EvalReport {
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly events: readonly EvalEvent[];       // everything the evaluation emitted, in order
  readonly nodes: Readonly<Record<string, NodeReport>>;
  readonly nodesRun: number;
  readonly nodesCached: number;
  readonly slices: number;
  readonly longestSliceMs: number;
}

/** The ids a caller uses for the nodes of a document: those of a GraphSpec, or the document's own. */
export interface IdMap {
  /** The document's id of a node the caller names; undefined when the document has no such node. */
  toDoc(id: string): string | undefined;
  /** The caller's name of a node of the document. */
  fromDoc(id: string): string;
}

export function identityIds(doc: GraphDoc): IdMap {
  return { toDoc: (id) => (Object.hasOwn(doc.nodes, id) ? id : undefined), fromDoc: (id) => id };
}

export interface Evaluation {
  readonly doc: GraphDoc;
  readonly ids: IdMap;
  /** As the caller wrote them: '<node>.<output port>' for an output, '<node>' to run a node. */
  readonly targets: readonly string[];
  readonly resolution: number;
  readonly mode: 'preview' | 'build';
  readonly outputs: 'all' | 'needed';
  readonly slices: Slices;
  readonly signal?: AbortSignal;
  readonly fieldBudgetBytes?: number;
  readonly files?: FileSource;
  readonly onSlice?: SliceListener;
  /** What happens to the cache before the evaluation: emptied, emptied when a build finds entries nobody holds open, or left. */
  readonly cache: 'empty' | 'empty-leftovers' | 'keep';
  /** After the evaluation the cache holds nothing (testing.md 2.8, a build). */
  readonly requireEmptyCache: boolean;
}

export interface Evaluated {
  readonly result: EvaluateResult;
  /** NodeErrors with the caller's ids. */
  readonly errors: readonly NodeError[];
  /** By target, for the targets that were produced. */
  readonly fields: Readonly<Record<string, FieldData>>;
  readonly report: EvalReport;
  readonly engine: TestEngine;
}

/** 2 .. 8192 texels per side, and a level of the ladder of some build resolution (engine.md 1.5). */
export function checkResolution(res: number, what: string): void {
  let legal = Number.isInteger(res) && res >= 33 && res <= 8192;
  if (legal) {
    // res is level k of B = (res − 1)·2^k + 1 when B is a build resolution: 129 .. 8192 with (B − 1) divisible by 16.
    legal = false;
    for (let k = 0, span = res - 1; span + 1 <= 8192; k++, span *= 2) {
      if (span + 1 >= 129 && span % 16 === 0) legal = true;
    }
  }
  if (!legal) throw new RangeError(`${what}: ${String(res)} is not a resolution of engine.md 1.5: a level of at least 33 of the ladder of a build resolution`);
}

function parseTarget(text: string, doc: GraphDoc, ids: IdMap): EvalTarget {
  if (typeof text !== 'string' || text === '') throw new TypeError(`A target is '<node id>.<output port>' or '<node id>', not ${JSON.stringify(text)}`);
  const whole = ids.toDoc(text);
  if (whole !== undefined) return { node: whole };
  // A port name holds no dot, a node id of a project file may.
  const dot = text.lastIndexOf('.');
  const node = dot > 0 ? ids.toDoc(text.slice(0, dot)) : undefined;
  if (node === undefined) throw new TypeError(`The target "${text}" names no node of the graph`);
  return { ref: { node, port: text.slice(dot + 1) } };
}

/** The error with the caller's id for the node, also where the engine's texts name it. */
function mapError(error: NodeError, ids: IdMap): NodeError {
  const nodeId = ids.fromDoc(error.nodeId);
  if (nodeId === error.nodeId) return error;
  const renamed = (text: string): string => text.replaceAll(error.nodeId, nodeId);
  return { ...error, nodeId, message: renamed(error.message), ...(error.detail !== undefined ? { detail: renamed(error.detail) } : {}) };
}

function mapEvent(event: EvalEvent, ids: IdMap): EvalEvent {
  switch (event.type) {
    case 'eval-start': return { ...event, plan: event.plan.map((entry) => ({ ...entry, nodeId: ids.fromDoc(entry.nodeId) })) };
    case 'node-error': return { ...event, error: mapError(event.error, ids) };
    case 'node-skipped': return { ...event, nodeId: ids.fromDoc(event.nodeId), ...(event.upstream !== undefined ? { upstream: ids.fromDoc(event.upstream) } : {}) };
    case 'node-start': case 'node-progress': case 'node-preview': case 'node-done': return { ...event, nodeId: ids.fromDoc(event.nodeId) };
    default: return event;
  }
}

function buildReport(result: EvaluateResult, events: readonly EvalEvent[], slices: readonly EngineSlice[], ids: IdMap): EvalReport {
  const bypassed = new Set<string>();
  const progress = new Map<string, number[]>();
  const sliceCount = new Map<string, number>();
  for (const slice of slices) {
    if (slice.nodeId !== null) sliceCount.set(ids.fromDoc(slice.nodeId), (sliceCount.get(ids.fromDoc(slice.nodeId)) ?? 0) + 1);
  }
  const nodes: Record<string, NodeReport> = {};
  const report = (nodeId: string, rest: Omit<NodeReport, 'nodeId' | 'progress' | 'slices'>): void => {
    nodes[nodeId] = { nodeId, ...rest, progress: progress.get(nodeId) ?? [], slices: sliceCount.get(nodeId) ?? 0 };
  };
  const none = { error: null, skipReason: null, upstream: null, wallMs: 0, peakBytes: 0 } as const;
  for (const event of events) {
    switch (event.type) {
      case 'eval-start':
        for (const entry of event.plan) if (entry.state === 'bypassed') bypassed.add(entry.nodeId);
        break;
      case 'node-progress': {
        let fractions = progress.get(event.nodeId);
        if (!fractions) progress.set(event.nodeId, fractions = []);
        fractions.push(event.fraction);
        break;
      }
      case 'node-done':
        if (!event.cached) report(event.nodeId, { ...none, state: 'done', wallMs: event.wallMs, peakBytes: event.peakBytes });
        else report(event.nodeId, { ...none, state: bypassed.has(event.nodeId) ? 'bypassed' : 'cached' });
        break;
      case 'node-error':
        report(event.error.nodeId, { ...none, state: 'error', error: event.error });
        break;
      case 'node-skipped':
        report(event.nodeId, { ...none, state: 'skipped', skipReason: event.reason, upstream: event.upstream ?? null });
        break;
      default:
    }
  }
  let longestSliceMs = 0;
  // Only a measured duration (runtime.md 3.5): a slice that waited behind another reports its wait as well.
  for (const slice of slices) if (slice.resolved) longestSliceMs = Math.max(longestSliceMs, slice.measuredMs);
  return {
    status: result.status, events, nodes,
    nodesRun: result.timing.nodesRun, nodesCached: result.timing.nodesCached,
    slices: slices.length, longestSliceMs,
  };
}

/** How many GraphSessions are open: their entries are the cache, and a build evaluation leaves them alone. */
let openSessions = 0;
export function sessionOpened(): void {
  openSessions++;
}
export function sessionClosed(): void {
  openSessions = Math.max(0, openSessions - 1);
}
export function sessionsOpen(): number {
  return openSessions;
}

async function readField(engine: Engine, handle: NonNullable<EvaluateResult['fields'][number]>): Promise<FieldData> {
  const data = await engine.read(handle);
  return { kind: handle.kind, width: handle.width, height: handle.height, channels: handle.kind === 'color' ? 4 : 1, data };
}

/**
 * One Engine.evaluate with everything a harness call owes around it: the engine of the wanted slicing, the
 * budget and the files for this evaluation, the slices, the targets read back, their handles released and the
 * leak check, also after a failure or an abort. Resolves whatever the status; rejects for a malformed call,
 * for a leak and with what an `onSlice` callback threw.
 */
export function evaluate(e: Evaluation): Promise<Evaluated> {
  checkResolution(e.resolution, 'The evaluation');
  if (e.mode !== 'preview' && e.mode !== 'build') throw new TypeError(`mode is "preview" or "build", not "${String(e.mode)}"`);
  if (e.outputs !== 'all' && e.outputs !== 'needed') throw new TypeError(`outputs is "all" or "needed", not "${String(e.outputs)}"`);
  if (e.fieldBudgetBytes !== undefined && !(Number.isFinite(e.fieldBudgetBytes) && e.fieldBudgetBytes >= 0)) {
    throw new RangeError(`fieldBudgetBytes ${String(e.fieldBudgetBytes)} is not a byte count`);
  }
  const keys = [...new Set(e.targets)];
  const targets = keys.map((text) => parseTarget(text, e.doc, e.ids));

  return exclusive(async () => {
    const testEngine = await obtainEngine(e.slices);
    const { engine } = testEngine;
    if (e.cache === 'empty' || (e.cache === 'empty-leftovers' && openSessions === 0 && engine.memory().cacheBytes > 0)) await engine.trim();
    const cacheBefore = engine.memory().cacheBytes;

    const events: EvalEvent[] = [];
    const slices: EngineSlice[] = [];
    // What an onSlice callback threw. Never into the engine: the call rejects with it once the evaluation has settled.
    const callback: { failure: { readonly thrown: unknown } | null } = { failure: null };
    const stopListening = onEngineSlice((slice) => {
      slices.push(slice);
      if (!e.onSlice || callback.failure) return;
      try {
        e.onSlice({ nodeId: slice.nodeId === null ? null : e.ids.fromDoc(slice.nodeId), kernels: slice.kernels, measuredMs: slice.measuredMs });
      } catch (thrown) {
        callback.failure = { thrown };
      }
    });
    if (e.fieldBudgetBytes !== undefined) engine.setBudget(engine.memory().reservedBytes + e.fieldBudgetBytes);
    if (e.files) engine.setFiles(e.files);

    let result: EvaluateResult;
    try {
      result = await engine.evaluate(e.doc, targets, {
        resolution: e.resolution, mode: e.mode, requestId: nextRequestId(), outputs: e.outputs, thumbnails: false,
        ...(e.signal ? { signal: e.signal } : {}),
        onEvent: (event) => { events.push(event); },
      });
    } finally {
      stopListening();
      if (e.fieldBudgetBytes !== undefined) engine.setBudget(BUDGET_BYTES);
      if (e.files) engine.setFiles(TEST_FILES);
    }

    const fields: Record<string, FieldData> = {};
    let readFailure: { readonly thrown: unknown } | null = null;
    for (const [i, handle] of result.fields.entries()) {
      if (!handle) continue;
      try {
        if (!readFailure) fields[keys[i]!] = await readField(engine, handle);
      } catch (thrown) {
        readFailure = { thrown };
      } finally {
        handle.release();
      }
    }
    if (readFailure) throw readFailure.thrown;

    // While a GraphSession is open its entries are the cache; a build evaluation then has to leave it as it found it.
    checkLeaks(engine, e.requireEmptyCache && (openSessions === 0 || engine.memory().cacheBytes > cacheBefore));
    if (callback.failure) throw callback.failure.thrown;

    const mapped = events.map((event) => mapEvent(event, e.ids));
    return {
      result, fields, engine: testEngine,
      errors: result.errors.map((error) => mapError(error, e.ids)),
      report: buildReport(result, mapped, slices, e.ids),
    };
  });
}
