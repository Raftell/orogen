// What the event stream says of a build that engineStore does not keep (runtime.md 8.5): when each stage began
// and ended, what each node took and held, and the folder the build was asked to write to. A pure reduction of
// EngineEvents with the time each arrived, like engineStore's; and from it, the progress of a running build and
// an estimate of what is left. No DOM and no React.

import type { BuildPlan, EngineEvent } from '../../../../core/runtime.ts';
import type { Measurement } from './sizes.ts';

type EndStatus = 'ok' | 'errors' | 'aborted' | 'device-lost';

export interface StageTiming {
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** False for a stage that the end of the build cut short. */
  readonly complete: boolean;
}

export interface BuildLog {
  readonly requestId: number;
  /** The output folder as `build-start` named it: where a build that fails leaves everything as it was. */
  readonly outDir: string;
  readonly resolution: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: EndStatus | null;
  /** `build-plan` arrived: the folder was accepted and the plan made. */
  readonly plannedAt: number | null;
  readonly evalStartedAt: number | null;
  readonly evalEndedAt: number | null;
  readonly evalStatus: EndStatus | null;
  /** How far the build's evaluation has come, as its last `eval-progress` said (runtime.md 5.10). */
  readonly computeFraction: number;
  /** The most the outputs of the build's nodes hold together, as the evaluator computed it before the first node (5.3 step 6). */
  readonly outputPeakBytes: number | null;
  /** How many nodes the evaluation set out to run (`eval-start`); null before it began. */
  readonly nodesToRun: number | null;
  /** The nodes that ran, with what each took and the most it held as working memory. */
  readonly nodes: Readonly<Record<string, { readonly wallMs: number; readonly peakBytes: number }>>;
  /** The sum of `wallMs` over `nodes`. */
  readonly nodeMs: number;
  readonly runningNode: { readonly nodeId: string; readonly since: number } | null;
  /** The stage of each export target, by the target's index in the plan. */
  readonly targets: Readonly<Record<number, StageTiming>>;
  /** The targets in the order their stages began, which is the order the evaluator delivered them in. */
  readonly order: readonly number[];
  /** The joint quantisation of the layer weights (export-unreal.md 3.4, phase 3). */
  readonly weights: StageTiming | null;
  /** The stage under way: the conversion of one target, or the weights. */
  readonly stage: number | 'weights' | null;
  readonly commitAt: number | null;
}

/** Ends the stage under way. `complete`: what follows it could only follow a stage that did all its work. */
function endStage(log: BuildLog, now: number, complete: boolean): BuildLog {
  const { stage } = log;
  if (stage === null) return log;
  if (stage === 'weights') return { ...log, stage: null, weights: log.weights ? { ...log.weights, endedAt: now, complete } : null };
  const timing = log.targets[stage];
  return { ...log, stage: null, targets: timing ? { ...log.targets, [stage]: { ...timing, endedAt: now, complete } } : log.targets };
}

/** Pure: the log after `event`, which arrived at `now` (milliseconds of any clock that only goes forward). */
export function reduceBuildLog(log: BuildLog | null, event: EngineEvent, now: number): BuildLog | null {
  if (event.type === 'build-start') {
    return {
      requestId: event.requestId, outDir: event.outDir, resolution: event.resolution, startedAt: now, endedAt: null, status: null,
      plannedAt: null, evalStartedAt: null, evalEndedAt: null, evalStatus: null, computeFraction: 0, outputPeakBytes: null, nodesToRun: null, nodes: {}, nodeMs: 0,
      runningNode: null,
      targets: {}, order: [], weights: null, stage: null, commitAt: null,
    };
  }
  if (!log || !('requestId' in event) || event.requestId !== log.requestId || log.endedAt !== null) return log;
  switch (event.type) {
    case 'build-plan':
      return { ...log, plannedAt: now };
    case 'eval-start':
      return { ...log, evalStartedAt: now, outputPeakBytes: event.outputPeakBytes, nodesToRun: event.plan.filter((node) => node.state === 'run').length };
    case 'eval-progress':
      return event.fraction > log.computeFraction ? { ...log, computeFraction: Math.min(1, event.fraction) } : log;
    case 'node-start':
      // The evaluator runs no node while a stage is pending (export-unreal.md 3.2): a node that starts ends the stage.
      return { ...endStage(log, now, true), runningNode: { nodeId: event.nodeId, since: now } };
    case 'node-done': {
      const idle = log.runningNode?.nodeId === event.nodeId ? null : log.runningNode;
      if (event.cached) return idle === log.runningNode ? log : { ...log, runningNode: idle };
      return {
        ...log, runningNode: idle, nodeMs: log.nodeMs + event.wallMs,
        nodes: { ...log.nodes, [event.nodeId]: { wallMs: event.wallMs, peakBytes: event.peakBytes } },
      };
    }
    case 'node-error':
      return log.runningNode?.nodeId === event.error.nodeId ? { ...log, runningNode: null } : log;
    case 'node-skipped':
      return log.runningNode?.nodeId === event.nodeId ? { ...log, runningNode: null } : log;
    case 'build-target': {
      const before = endStage(log, now, true);
      return {
        ...before, runningNode: null, stage: event.index,
        targets: { ...before.targets, [event.index]: { startedAt: now, endedAt: null, complete: false } },
        order: before.order.includes(event.index) ? before.order : [...before.order, event.index],
      };
    }
    case 'build-progress':
      if (event.phase === 'weights') {
        if (log.stage === 'weights') return log;
        return { ...endStage(log, now, true), stage: 'weights', weights: { startedAt: now, endedAt: null, complete: false } };
      }
      if (event.phase === 'commit') return log.commitAt !== null ? log : { ...endStage(log, now, true), commitAt: now };
      return log;
    case 'eval-end':
      // The last target's stage ends with the evaluation: it did its work when the evaluation ended well.
      return { ...endStage(log, now, event.status === 'ok'), evalEndedAt: now, evalStatus: event.status, runningNode: null };
    case 'build-result':
      // A stage still open now was cut short: one that completes is followed by a node, a stage or a phase.
      return endStage(log, now, false);
    case 'build-end':
      return { ...endStage(log, now, false), endedAt: now, status: event.status, runningNode: null };
    default:
      return log;
  }
}

// ---- what nodes hold, measured ------------------------------------------------------------------------------------------

export interface Measurements {
  /** The resolution of the newest evaluations, by request id. */
  readonly resolutions: Readonly<Record<number, number>>;
  /** What each node held the last time it ran, and at which resolution. */
  readonly peaks: Readonly<Record<string, Measurement>>;
}

export const NO_MEASUREMENTS: Measurements = { resolutions: {}, peaks: {} };
const REQUESTS_KEPT = 8;

/** Pure. A node that did not run reports no memory of its own, and an evaluation whose resolution is not known measures nothing. */
export function reduceMeasurements(measured: Measurements, event: EngineEvent): Measurements {
  if (event.type === 'eval-start') {
    const ids = [...new Set([...Object.keys(measured.resolutions).map(Number), event.requestId])].sort((a, b) => a - b).slice(-REQUESTS_KEPT);
    const resolutions: Record<number, number> = {};
    for (const id of ids) resolutions[id] = id === event.requestId ? event.resolution : measured.resolutions[id]!;
    return { ...measured, resolutions };
  }
  if (event.type === 'node-done' && !event.cached && event.peakBytes > 0) {
    const resolution = Object.hasOwn(measured.resolutions, event.requestId) ? measured.resolutions[event.requestId] : undefined;
    if (resolution === undefined) return measured;
    return { ...measured, peaks: { ...measured.peaks, [event.nodeId]: { bytes: event.peakBytes, resolution } } };
  }
  return measured;
}

/**
 * What engineStore knows when the panel begins to listen: the nodes that ran in the evaluation whose result is
 * shown, which ran at the resolution shown. Nothing when that is not certain (a draft, an evaluation under way,
 * a build): a measurement scaled from the wrong resolution would be wrong by a power of four.
 */
export function seedMeasurements(state: {
  readonly evaluation: unknown;
  readonly view: { readonly resolution: number; readonly draft: boolean } | null;
  readonly viewRequestId: number | null;
  readonly build: { readonly requestId: number | null };
  readonly nodes: Readonly<Record<string, { readonly requestId: number; readonly state: string; readonly cached: boolean; readonly peakBytes: number | null }>>;
}): Measurements {
  const { view, viewRequestId } = state;
  if (state.evaluation !== null || !view || view.draft || viewRequestId === null || state.build.requestId === viewRequestId) return NO_MEASUREMENTS;
  const peaks: Record<string, Measurement> = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.requestId !== viewRequestId || node.state !== 'done' || node.cached || !(node.peakBytes !== null && node.peakBytes > 0)) continue;
    peaks[nodeId] = { bytes: node.peakBytes, resolution: view.resolution };
  }
  return { resolutions: { [viewRequestId]: view.resolution }, peaks };
}

// ---- progress ----------------------------------------------------------------------------------------------------------

/** The rows each target converts, and those of the joint quantisation: what `build-progress.fraction` counts (3.9). */
export function progressRows(plan: BuildPlan): { readonly targets: readonly number[]; readonly weights: number; readonly total: number } {
  const targets = plan.items.map(({ nodeId, item }) => {
    if (item.kind !== 'texture') return plan.resolution;
    return plan.files.find((file) => file.nodeId === nodeId)?.height ?? plan.resolution;
  });
  const weights = plan.items.some(({ item }) => item.kind === 'layer' && item.weightBlended) ? plan.resolution : 0;
  return { targets, weights, total: targets.reduce((sum, rows) => sum + rows, 0) + weights };
}

/** `stopped`: under way when the build ended without success. `skipped`: never reached. */
export type StageState = 'waiting' | 'running' | 'done' | 'stopped' | 'skipped';

export interface StageView {
  readonly id: 'plan' | 'compute' | 'export' | 'weights' | 'commit';
  readonly label: string;
  readonly state: StageState;
  /** 0 .. 1 for a stage that knows how far it is; null for one that does not. */
  readonly fraction: number | null;
  /** The time spent in the stage so far; null before it began. */
  readonly ms: number | null;
}

export interface TargetProgress {
  readonly index: number;
  readonly nodeId: string;
  /** `waiting`: its input is not computed yet, or another target is being converted. */
  readonly state: StageState;
  readonly fraction: number;
  readonly ms: number | null;
}

export interface Remaining {
  readonly ms: number;
  /** `about`: computing and converting are both measured. `at-least`: one of them is not yet, and is left out. */
  readonly bound: 'about' | 'at-least';
}

export interface ProgressView {
  readonly stages: readonly StageView[];
  readonly targets: readonly TargetProgress[];
  readonly elapsedMs: number;
  readonly remaining: Remaining | null;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Below these a rate is not yet a measurement (the rule of runtime.md 5.10, with a shorter time for the stages). */
const FRACTION_MIN = 0.05;
const NODE_MS_MIN = 1000;
const STAGE_MS_MIN = 250;

/**
 * What is left, from what the finished part took: the nodes by the evaluation's own fraction, the files by the
 * rows converted. Each is scaled only once enough of it is done to measure a rate. Closing the files (the
 * commit) is not in it: nothing says how long that takes before it has happened.
 */
export function estimateRemaining(input: {
  readonly computeMs: number; readonly computeFraction: number; readonly computeDone: boolean;
  readonly exportMs: number; readonly exportFraction: number;
}): Remaining | null {
  const compute = input.computeDone || input.computeFraction >= 1 ? 0
    : input.computeFraction >= FRACTION_MIN && input.computeMs >= NODE_MS_MIN ? input.computeMs * (1 - input.computeFraction) / input.computeFraction
      : null;
  const exported = input.exportFraction >= 1 ? 0
    : input.exportFraction >= FRACTION_MIN && input.exportMs >= STAGE_MS_MIN ? input.exportMs * (1 - input.exportFraction) / input.exportFraction
      : null;
  if (compute === null && exported === null) return null;
  if (compute === null || exported === null) return { ms: (compute ?? 0) + (exported ?? 0), bound: 'at-least' };
  return { ms: compute + exported, bound: 'about' };
}

const spent = (timing: StageTiming | null | undefined, now: number): number => (timing ? Math.max(0, (timing.endedAt ?? now) - timing.startedAt) : 0);

function stageState(timing: { readonly began: boolean; readonly over: boolean; readonly well: boolean }, ended: boolean): StageState {
  if (!timing.began) return ended ? 'skipped' : 'waiting';
  if (timing.over) return timing.well ? 'done' : 'stopped';
  return ended ? 'stopped' : 'running';
}

/** The stages and targets of a build, while it runs and after. `fraction` is `build-progress.fraction` (export-unreal.md 3.9). */
export function viewProgress(input: {
  readonly log: BuildLog;
  readonly plan: BuildPlan | null;
  readonly fraction: number;
  readonly now: number;
}): ProgressView {
  const { log, plan } = input;
  const now = log.endedAt ?? input.now;
  const ended = log.endedAt !== null;
  const ok = log.status === 'ok';
  const rows = plan ? progressRows(plan) : { targets: [] as number[], weights: 0, total: 0 };
  const targetRows = rows.total - rows.weights;
  // Progress is reported ten times a second at the most (3.9), so the fraction can lag behind a target that is
  // already written: the rows of the targets that are done are done, whatever was last reported.
  const writtenRows = log.order.reduce((sum, index) => sum + (log.targets[index]?.complete ? rows.targets[index] ?? 0 : 0), 0)
    + (log.weights?.complete || log.commitAt !== null ? rows.weights : 0);
  const doneRows = Math.max(clamp01(input.fraction) * rows.total, writtenRows);

  const computeMs = log.nodeMs + (log.runningNode ? Math.max(0, now - log.runningNode.since) : 0);
  const convertMs = log.order.reduce((sum, index) => sum + spent(log.targets[index], now), 0);
  const weightsMs = spent(log.weights, now);
  const evaluated = log.evalEndedAt !== null;
  // The evaluation ends only when its last target is written, long after its last node: the nodes are done when
  // as many have run as it set out to run. Its own fraction is reported a few times a second and can lag behind
  // a node that has just finished, so the share of the nodes that have run is the least that is shown.
  const ran = Object.keys(log.nodes).length;
  const computed = (evaluated && log.evalStatus === 'ok') || (log.nodesToRun !== null && ran >= log.nodesToRun && log.runningNode === null && log.evalStartedAt !== null);
  const reported = clamp01(log.computeFraction);
  const computeFraction = computed ? 1 : Math.max(reported, log.nodesToRun ? Math.min(1, ran / log.nodesToRun) : 0);

  const stages: StageView[] = [
    {
      id: 'plan', label: 'Plan',
      // A plan with an error ends the build; so does a folder that was refused, before any plan.
      state: stageState({ began: true, over: log.plannedAt !== null, well: plan?.ok !== false }, ended),
      fraction: null, ms: Math.max(0, (log.plannedAt ?? now) - log.startedAt),
    },
    {
      id: 'compute', label: 'Compute the nodes',
      state: stageState({ began: log.evalStartedAt !== null, over: evaluated || computed, well: computed }, ended),
      fraction: log.evalStartedAt !== null ? computeFraction : null, ms: log.evalStartedAt !== null ? computeMs : null,
    },
    {
      id: 'export', label: 'Convert and encode',
      // The last target is delivered before the evaluation ends: the stages are over when it is.
      state: stageState({ began: log.order.length > 0, over: evaluated, well: log.evalStatus === 'ok' }, ended),
      fraction: log.order.length > 0 && targetRows > 0 ? clamp01(doneRows / targetRows) : null, ms: log.order.length > 0 ? convertMs : null,
    },
  ];
  if (rows.weights > 0) {
    // Progress is reported ten times a second at the most (3.9): the weights of a small build are over before
    // they are ever named. A build that came to its commit has done them, heard of or not.
    const committed = log.commitAt !== null;
    stages.push({
      id: 'weights', label: 'Layer weights',
      state: stageState({ began: log.weights !== null || committed, over: log.weights?.endedAt != null || committed, well: log.weights?.complete === true || committed }, ended),
      fraction: committed ? 1 : log.weights !== null ? clamp01((doneRows - targetRows) / rows.weights) : null,
      ms: log.weights !== null ? weightsMs : null,
    });
  }
  stages.push({
    id: 'commit', label: 'Finish the files',
    state: stageState({ began: log.commitAt !== null, over: ended, well: ok }, ended),
    fraction: null, ms: log.commitAt !== null ? Math.max(0, now - log.commitAt) : null,
  });

  let rowsBefore = 0;
  const delivered = new Set(log.order);
  const waiting = plan ? plan.items.map((_, index) => index).filter((index) => !delivered.has(index)) : [];
  const targets: TargetProgress[] = [...log.order, ...waiting].map((index) => {
    const timing = Object.hasOwn(log.targets, index) ? log.targets[index] : undefined;
    const count = rows.targets[index] ?? 0;
    const state = stageState({ began: timing !== undefined, over: timing?.endedAt != null, well: timing?.complete === true }, ended);
    const fraction = state === 'done' ? 1 : timing && count > 0 ? clamp01((doneRows - rowsBefore) / count) : 0;
    if (timing) rowsBefore += count;
    return { index, nodeId: plan?.items[index]?.nodeId ?? '', state, fraction, ms: timing ? spent(timing, now) : null };
  });

  // The estimate takes the evaluation's own fraction, which weighs each node by the time it is expected to take:
  // the count of nodes would call a build half done whose slow half is still to come.
  const remaining = ended || log.commitAt !== null ? null : estimateRemaining({
    computeMs, computeFraction: reported, computeDone: computed,
    exportMs: convertMs + weightsMs, exportFraction: rows.total > 0 ? clamp01(doneRows / rows.total) : 0,
  });
  return { stages, targets, elapsedMs: Math.max(0, now - log.startedAt), remaining };
}

/** What the build held at its height, as far as its events say: the outputs alive together, and the node that needed the most beside them. */
export function peakMemory(log: BuildLog): { readonly outputBytes: number | null; readonly node: { readonly nodeId: string; readonly bytes: number } | null } {
  let node: { nodeId: string; bytes: number } | null = null;
  for (const [nodeId, ran] of Object.entries(log.nodes)) {
    if (node === null || ran.peakBytes > node.bytes) node = { nodeId, bytes: ran.peakBytes };
  }
  return { outputBytes: log.outputPeakBytes, node };
}
