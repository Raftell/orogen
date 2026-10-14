import type { Engine } from '../engine.ts';
import type { FieldStats } from '../eval/context.ts';
import type { EvalEvent } from '../eval/events.ts';
import type { EvalTarget, EvaluateResult, TextureRef } from '../eval/evaluator.ts';
import { buildPlan, type EvalPlan } from '../eval/plan.ts';
import { nodeWeights } from '../eval/progress.ts';
import type { BuildEvent, BuildPlan, BuildResult } from '../export-decl.ts';
import { DeviceLostError, onUncapturedError, type GpuContext, type GpuLostInfo } from '../gpu/device.ts';
import type { AnyFieldHandle, FieldHandle } from '../gpu/pool.ts';
import { own, type GraphDoc, type PortRef } from '../graph/doc.ts';
import { normalizeParams } from '../graph/params.ts';
import { previewResolution } from '../graph/settings.ts';
import { outputKind } from '../graph/validate.ts';
import type { FileSource } from '../io/files.ts';
import { budgetBytes, budgetInForce } from './budget.ts';
import type { EngineEvent } from './events.ts';
import { createRecovery, type RecoveryOutcome } from './recovery.ts';
import { createScheduler, THUMBNAIL_NODE_LIMIT_MS, type ScheduledRequest } from './scheduler.ts';
import { createViewBinder, type LoanView, type ViewportHost, type ViewportRenderer } from './viewport.ts';

export interface EnginePreferences {
  readonly vramBytes: number | null;        // null: use caps.vramBytes, else 4 GiB (2.4)
  readonly budgetFraction: number;          // 0.3 .. 0.85
}

export interface BuildRequest {
  readonly doc: GraphDoc;                   // built at doc.settings.buildResolution
  readonly outDir: string;                  // absolute folder; created when missing. It belongs to the build: export-unreal.md 3.8
}

export interface EngineSession {
  setProject(project: { readonly path: string | null }): void;
  setDocument(doc: GraphDoc, revision: number): void;
  beginGesture(): void;
  endGesture(): void;
  setPaused(paused: boolean): void;
  requestThumbnails(nodeIds: readonly string[]): void;
  inspect(ref: PortRef): Promise<FieldStats | null>;
  build(request: BuildRequest): Promise<BuildResult>;
  cancelBuild(): void;
  plan(doc: GraphDoc): Promise<BuildPlan>;  // 7.6: what a build of `doc` would write, without building
  setPreferences(prefs: EnginePreferences): void;
  retryDevice(): void;
  subscribe(listener: (e: EngineEvent) => void): () => void;
  readonly viewport: ViewportHost;          // 7.5
  dispose(): Promise<void>;
}

/** What the session passes to the build function it was given (7.6). */
export interface SessionBuildOptions {
  readonly doc: GraphDoc;
  readonly outDir: string;
  readonly requestId: number;
  readonly signal: AbortSignal;
  readonly onEvent: (e: EvalEvent | BuildEvent) => void;
}

/** One evaluation the session has under way. */
interface Run {
  readonly request: ScheduledRequest;
  readonly requestId: number;
  readonly controller: AbortController;
  /** The generation of the document it evaluates (below). */
  readonly generation: number;
  /** The nodes that ended node-done and were used: the engine had their outputs[0] at hand for a thumbnail (5.12 rule 1). */
  readonly done: string[];
  /** The nodes the evaluation left unused (5.3 step 5): nothing of theirs was at hand. */
  readonly unused: Set<string>;
  /** The nodes whose evaluate() ran in this evaluation. */
  readonly ran: string[];
  /** The device it runs on. */
  readonly gpu: GpuContext;
}

/** The result the viewport shows. The handles themselves are the binder's. */
interface Shown {
  readonly doc: GraphDoc;
  readonly resolution: number;
  /** Made by a draft: its cache entries are transient (5.4). */
  readonly transient: boolean;
  readonly targets: readonly EvalTarget[];
  readonly height: { readonly ref: PortRef; readonly handle: AnyFieldHandle } | null;
  readonly overlay: { readonly ref: PortRef; readonly handle: AnyFieldHandle } | null;
}

interface Inspection {
  readonly ref: PortRef;
  resolve(stats: FieldStats | null): void;
}

/** Node ids whose last thumbnail key is remembered; beyond it the oldest are forgotten, which costs one idle evaluation each. */
const THUMBNAILS_REMEMBERED = 16384;
const STATUSES: readonly BuildResult['status'][] = ['ok', 'errors', 'aborted', 'device-lost'];
const DISPOSED = 'The engine session is disposed';

/** A view target of an evaluation under way: its place among the targets, for staged delivery (5.2). */
const partAt = (view: ScheduledRequest['view'], index: number): 'height' | 'overlay' | null =>
  (view?.height?.index === index ? 'height' : view?.overlay?.index === index ? 'overlay' : null);

const samePort = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.port === b.port;

function remember(map: Map<string, string>, nodeId: string, key: string): void {
  map.delete(nodeId);
  map.set(nodeId, key);
  if (map.size > THUMBNAILS_REMEMBERED) map.delete(map.keys().next().value!);
}

function releaseAll(fields: readonly (AnyFieldHandle | null)[]): void {
  for (const field of fields) {
    try {
      field?.release();
    } catch (thrown) {
      console.error('[orogen] a field handle could not be released', thrown);
    }
  }
}

export function createSession(opts: {
  readonly engine: Engine;
  readonly reopenGpu: () => Promise<GpuContext>;                         // a new openGpu call, for recovery (7.8)
  readonly createFiles: (projectPath: string | null) => FileSource;
  readonly build: (engine: Engine, opts: SessionBuildOptions) => Promise<BuildResult>;   // 7.6; never rejects for a failed build
  readonly plan: (engine: Engine, doc: GraphDoc) => BuildPlan;           // 7.6: planBuild of src/export/, which core code may not import
  readonly renderer: ViewportRenderer | null;                            // null: no viewport; `viewport` then ignores calls and `pick` resolves null
}): EngineSession {
  const { engine } = opts;
  const registry = engine.registry;
  const scheduler = createScheduler(registry);
  const recovery = createRecovery(opts.reopenGpu);
  const binder = createViewBinder(opts.renderer);
  const listeners = new Set<(e: EngineEvent) => void>();

  let disposed = false;
  let disposal: Promise<void> | null = null;
  /** The session's sequence of request ids: every evaluation it makes, and every build, takes the next one. */
  let requestId = 0;
  /**
   * Counts every change of what content keys are made from: a document, a watched file, the project's folder.
   * A revision alone would not do: a file changes without one.
   */
  let generation = 0;

  // ---- what the engine is doing for the session ---------------------------------------------------------------------
  let running: Run | null = null;
  /** The node whose evaluate() is under way, in a preview or in a build, for `device-lost`. */
  let runningNode: string | null = null;
  /** That node, when the evaluation noticed the loss before the session was told of it. */
  let lostNode: string | null = null;
  /** The evaluation, trim or inspection under way. One at a time: what comes next is chosen when it has ended. */
  let active: Promise<void> | null = null;
  let building: { readonly controller: AbortController } | null = null;
  const inspections: Inspection[] = [];

  // ---- the document's surroundings ------------------------------------------------------------------------------------
  let previewRes: number | null = null;
  /** The preview resolution changed: Engine.trim comes before the next evaluation (2.8). */
  let trimDue: number | null = null;
  let files: FileSource | null = null;
  const watched = new Map<string, () => void>();
  let prefs: EnginePreferences | null = null;
  let shown: Shown | null = null;

  // ---- keys and thumbnails (7.3 rules 8 and 9) -----------------------------------------------------------------------
  let keys: ReadonlyMap<string, string> | null = null;
  let keysGeneration = -1;
  let keysWanted = false;
  let keysBusy = false;
  /** Keys were asked for while the engine still read through the previous FileSource. */
  let keysAfterTurn = false;
  let requested: readonly string[] = [];
  /** Node id → the contentKey of the last thumbnail delivered. */
  const delivered = new Map<string, string>();
  /**
   * Node id → the contentKey for which an idle evaluation would add nothing: the engine had the node's output at
   * hand and made the thumbnail it wanted, or the node failed, or it is too slow to run for a thumbnail alone.
   */
  const offered = new Map<string, string>();
  /** Nodes to enter in `offered` once the keys of their generation are known. */
  let offersWaiting: { readonly generation: number; readonly ids: string[] } | null = null;
  /**
   * Node id → the contentKey with which the node was left out of the idle evaluation at the thumbnail resolution,
   * as too slow to run there or as a reader of such a node (7.3 rule 9). It is tried at the preview resolution (rule 10).
   */
  const deferred = new Map<string, string>();
  /**
   * Node id → the contentKey with which it was left out at the preview resolution as well: a slow node it
   * reads is not cached there. Forgotten when a view evaluation has run a slow node, since the cache holds it then.
   */
  const leftOut = new Map<string, string>();
  /** The renderer's reservation changed in this task: one `memory` event follows it (7.7). */
  let memoryDue = false;
  /** The renderer is being handed a device: what it registers then is in the `memory` event that follows `device-ready`. */
  let initialising = false;

  // ---- the device (7.8) -----------------------------------------------------------------------------------------------
  let current: GpuContext = engine.gpu;
  /** No usable device: lost, and not yet replaced. */
  let lost = false;
  /** Automatic recovery has ended; retryDevice() starts it again. */
  let fatal = false;
  const reported = new WeakSet<GpuContext>();

  function emit(event: EngineEvent): void {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (thrown) {
        console.error('[orogen] an engine event listener threw', thrown);
      }
    }
  }

  function emitMemory(): void {
    if (disposed) return;
    emit({ type: 'memory', ...engine.memory() });
  }

  function initRenderer(gpu: GpuContext): void {
    initialising = true;
    try {
      binder.init(gpu, ledger);
    } finally {
      initialising = false;
    }
  }

  /**
   * What the renderer registers with (7.5 rule 4): Engine.reserve, watched. The renderer reserves in the frames
   * it draws, long after the evaluation whose `memory` event was the last, so the session says when it did.
   */
  const ledger = {
    reserve(bytes: number, label: string): { release(): void } {
      const reservation = engine.reserve(bytes, label);
      reservedChanged();
      return {
        release(): void {
          reservation.release();
          reservedChanged();
        },
      };
    },
  };

  function reservedChanged(): void {
    if (memoryDue || initialising || disposed) return;
    memoryDue = true;
    // In a microtask: a frame that drops one set of textures and makes another is one change.
    queueMicrotask(() => {
      memoryDue = false;
      guarded(emitMemory);
    });
  }

  /** For what runs in a continuation or a callback, where a throw would reach nobody: it is logged instead. */
  function guarded(work: () => void): void {
    try {
      work();
    } catch (thrown) {
      if (!disposed) console.error('[orogen] the engine session failed', thrown);
    }
  }

  /** Which node is running, from the events of whichever evaluation is under way. */
  function track(e: EvalEvent | BuildEvent): void {
    if (e.type === 'node-start') runningNode = e.nodeId;
    else if (e.type === 'node-done') { if (runningNode === e.nodeId) runningNode = null; }
    else if (e.type === 'node-error') { if (runningNode === e.error.nodeId) runningNode = null; }
    else if (e.type === 'node-skipped') {
      if (runningNode !== e.nodeId) return;
      if (e.reason === 'device-lost') lostNode = e.nodeId;
      runningNode = null;
    } else if (e.type === 'eval-end') runningNode = null;
  }

  // ---- the budget (2.4) ------------------------------------------------------------------------------------------------
  /**
   * Gives the engine the budget of the preferences, and never one below what it has reserved plus room for
   * fields. What is reserved grows with the session (the staging buffer, the atlas, the renderer's textures), so
   * this is asked again before every piece of work. Without preferences the engine keeps the budget it was made with.
   */
  function applyBudget(): void {
    if (!prefs || lost || disposed) return;
    const memory = engine.memory();
    const next = budgetInForce(budgetBytes(current.caps, prefs), memory.reservedBytes);
    if (next !== memory.budgetBytes) engine.setBudget(next);
  }

  // ---- Engine.trim -----------------------------------------------------------------------------------------------------
  async function trim(keepResolution: number | undefined): Promise<void> {
    try {
      await engine.trim(keepResolution === undefined ? undefined : { keepResolution });
    } catch (thrown) {
      // A lost device has nothing to trim, and neither has a disposed engine.
      if (!(thrown instanceof DeviceLostError) && !disposed) console.error('[orogen] Engine.trim failed', thrown);
      return;
    }
    emitMemory();
  }

  // ---- files (6.1 rule 6) ----------------------------------------------------------------------------------------------
  function fileChanged(): void {
    if (disposed || !scheduler.latest) return;
    generation++;
    refreshKeys();
    scheduler.requestFull();
    guarded(kick);
  }

  function watchFiles(doc: GraphDoc | null): void {
    const source = files;
    const wanted = new Set<string>();
    if (doc && source?.watch) {
      for (const node of Object.values(doc.nodes)) {
        const def = registry.get(node.type);
        if (!def || !def.params.some((param) => param.kind === 'file')) continue;
        const values = normalizeParams(def, node.params).values;
        for (const param of def.params) {
          const path = param.kind === 'file' ? values[param.name] : '';
          if (typeof path !== 'string' || path === '') continue;
          try {
            wanted.add(source.resolve(path));
          } catch {
            // A relative path of a project that was never saved names no file (6.1 rule 2): there is nothing to watch.
          }
        }
      }
    }
    for (const [path, stop] of [...watched]) {
      if (wanted.has(path)) continue;
      watched.delete(path);
      stop();
    }
    for (const path of wanted) {
      if (watched.has(path)) continue;
      try {
        watched.set(path, source!.watch!(path, fileChanged));
      } catch {
        // A file that cannot be watched is still compared at every evaluation (6.1 rule 5).
      }
    }
  }

  function unwatchFiles(): void {
    for (const stop of watched.values()) stop();
    watched.clear();
  }

  // ---- keys ------------------------------------------------------------------------------------------------------------
  function offer(of: number, ids: Iterable<string>): void {
    if (of !== generation) return;
    if (keys && keysGeneration === of) {
      for (const id of ids) {
        const key = keys.get(id);
        if (key !== undefined) remember(offered, id, key);
      }
    } else {
      offersWaiting = { generation: of, ids: [...(offersWaiting?.generation === of ? offersWaiting.ids : []), ...ids] };
    }
  }

  /** Computes the keys of the latest document and emits them. Latest wins: a document that is replaced meanwhile gets none. */
  function refreshKeys(): void {
    keysWanted = true;
    if (keysBusy) return;
    keysBusy = true;
    void (async () => {
      try {
        // Each round answers one request made from outside, so the loop ends when the requests do.
        while (keysWanted && !disposed) {
          keysWanted = false;
          const latest = scheduler.latest;
          if (!latest) break;
          const of = generation;
          let map: ReadonlyMap<string, string> | null = null;
          try {
            map = await engine.keys(latest.doc);
          } catch (thrown) {
            if (!disposed) console.error('[orogen] Engine.keys failed', thrown);
          }
          if (disposed) break;
          if (of !== generation) {
            keysWanted = true;
            continue;
          }
          if (!map) continue;
          keys = map;
          keysGeneration = of;
          const waiting = offersWaiting;
          offersWaiting = null;
          if (waiting?.generation === of) offer(of, waiting.ids);
          emit({ type: 'keys', revision: latest.revision, keys: Object.fromEntries(map) });
        }
      } finally {
        keysBusy = false;
      }
      guarded(kick);
    })();
  }

  /**
   * 7.3 rules 9 and 10: the requested nodes whose last delivered thumbnail is stale and that an idle evaluation
   * can help, at the thumbnail resolution and, for those left out there, at the preview resolution.
   */
  function staleThumbnails(): { readonly stale: string[]; readonly atPreview: string[] } {
    const stale: string[] = [];
    const atPreview: string[] = [];
    if (!keys || keysGeneration !== generation) return { stale, atPreview };
    for (const id of requested) {
      const key = keys.get(id);
      if (key === undefined || delivered.get(id) === key || offered.get(id) === key || leftOut.get(id) === key) continue;
      (deferred.get(id) === key ? atPreview : stale).push(id);
    }
    return { stale, atPreview };
  }

  /** Whether a node that has run is one rule 9 would not run for a thumbnail alone at `resolution`: its last timing, scaled by the texels (5.10). */
  function slowAt(nodeId: string, resolution: number): boolean {
    const timing = engine.lastTiming(nodeId);
    return timing !== null && timing.resolution > 0 && timing.wallMs * (resolution / timing.resolution) ** 2 > THUMBNAIL_NODE_LIMIT_MS;
  }

  /** Enters the nodes in `map` with the keys they have, when those are the keys of generation `of`. */
  function note(map: Map<string, string>, of: number, ids: Iterable<string>): void {
    if (of !== generation || !keys || keysGeneration !== of) return;
    for (const id of ids) {
      const key = keys.get(id);
      if (key !== undefined) remember(map, id, key);
    }
  }

  /**
   * 7.3 rule 9, for a thumbnail evaluation that is about to run its first node: a node predicted above the limit
   * that is not cached is left out, and with it every node that reads it, because evaluating those would run it.
   * The evaluation is aborted before anything has run; the next one is made without them. What is left out at
   * the thumbnail resolution is tried at the preview resolution, where a view evaluation has cached the slow node.
   */
  function leaveOutSlow(run: Run, start: Extract<EvalEvent, { type: 'eval-start' }>): void {
    const { request } = run;
    let plan: EvalPlan;
    try {
      plan = buildPlan(request.doc, registry, request.targets);
    } catch {
      return;
    }
    const settled = new Set(start.plan.filter((node) => node.state !== 'run').map((node) => node.nodeId));
    const weights = nodeWeights(plan, settled, request.resolution, (id) => engine.lastTiming(id));
    // The plan is in post-order: what a node reads comes before it.
    const left = new Set<string>();
    for (const node of plan.nodes) {
      const slow = (weights.get(node.nodeId) ?? 0) > THUMBNAIL_NODE_LIMIT_MS;
      if (slow || node.inputs.some((input) => input.from !== null && left.has(input.from.node))) left.add(node.nodeId);
    }
    if (left.size === 0) return;
    const last = request.at === 'preview' || request.resolution === previewResolution(request.doc.settings);
    note(last ? leftOut : deferred, run.generation, left);
    run.controller.abort();
  }

  // ---- showing a result (7.3 rule 6, 7.4) -----------------------------------------------------------------------------
  function show(run: Run, fields: readonly AnyFieldHandle[]): boolean {
    const { request } = run;
    const view = request.view!;
    const height = view.height ? fields[view.height.index]! : null;
    const overlay = view.overlay ? fields[view.overlay.index]! : null;
    const held = binder.show({
      height,
      overlay: overlay ? { handle: overlay, as: view.overlay!.as, opacity: view.overlay!.opacity } : null,
      settings: request.doc.settings,
    });
    if (!held) return false;
    shown = {
      doc: request.doc, resolution: request.resolution, transient: request.cache === 'transient', targets: request.targets,
      height: height ? { ref: view.height!.ref, handle: height } : null,
      overlay: overlay ? { ref: view.overlay!.ref, handle: overlay } : null,
    };
    emit({
      type: 'view-updated', requestId: run.requestId, revision: request.revision, resolution: request.resolution,
      draft: request.resolution < previewResolution(request.doc.settings), height: height !== null, overlay: overlay !== null,
    });
    return true;
  }

  /** 7.4 rule 5: a document whose view names nothing that exists shows nothing, and no evaluation is made for it. */
  function showNothing(request: ScheduledRequest): void {
    if (shown) {
      shown = null;
      binder.show(null);
    }
    emit({
      type: 'view-updated', requestId: ++requestId, revision: request.revision, resolution: request.resolution,
      draft: request.resolution < previewResolution(request.doc.settings), height: false, overlay: false,
    });
    scheduler.settled(request, { tookMs: 0, completed: true });
  }

  // ---- one evaluation (7.3) --------------------------------------------------------------------------------------------
  async function evaluate(request: ScheduledRequest): Promise<void> {
    const thumbnails = request.purpose === 'thumbnails';
    if (!thumbnails && request.targets.length === 0) {
      showNothing(request);
      return;
    }
    applyBudget();
    const run: Run = { request, requestId: ++requestId, controller: new AbortController(), generation, done: [], unused: new Set(), ran: [], gpu: current };
    running = run;
    lostNode = null;
    emit({ type: 'request-start', requestId: run.requestId, revision: request.revision, purpose: request.purpose });

    const view = request.view;
    const loanView: LoanView | null = view ? {
      height: view.height?.ref ?? null,
      overlay: view.overlay ? { ref: view.overlay.ref, as: view.overlay.as, opacity: view.overlay.opacity } : null,
      settings: request.doc.settings,
    } : null;
    // The view targets are delivered as they are published (5.2, staged delivery), and the session takes a handle
    // of its own on each: the result of a node whose loans were on screen is drawn from then on (7.5 rule 2).
    const held: (AnyFieldHandle | null)[] = request.targets.map(() => null);
    let result: EvaluateResult | null = null;
    try {
      result = await engine.evaluate(request.doc, request.targets, {
        resolution: request.resolution, mode: 'preview', requestId: run.requestId, signal: run.controller.signal,
        outputs: request.outputs, cache: request.cache, thumbnails: true,
        onEvent: (e) => {
          track(e);
          if (e.type === 'eval-start') for (const node of e.plan) if (node.state === 'unused') run.unused.add(node.nodeId);
          if (e.type === 'node-done' && !run.unused.has(e.nodeId)) run.done.push(e.nodeId);
          if (e.type === 'node-done' && !e.cached) run.ran.push(e.nodeId);
          emit(e);
          if (thumbnails && e.type === 'eval-start' && !run.controller.signal.aborted) leaveOutSlow(run, e);
        },
        ...(loanView ? {
          onLoans: (nodeId: string, loans: Readonly<Record<string, TextureRef>> | null) => {
            if (!lost && !disposed) binder.lend(loanView, nodeId, loans);
          },
          // It must not reject: that would stop the evaluation (5.2).
          onTarget: async (index: number, field: AnyFieldHandle | null) => {
            if (!field || lost || disposed) return;
            try {
              held[index] = field.retain();
              const part = partAt(view, index);
              if (part) binder.deliver(loanView, part, field);
            } catch (thrown) {
              if (!(thrown instanceof DeviceLostError)) console.error('[orogen] a view target could not be held', thrown);
            }
          },
        } : {}),
      });
    } catch (thrown) {
      // Engine.evaluate rejects for a malformed call only (5.2): a document the session should not have been given.
      if (!disposed) console.error('[orogen] an evaluation was refused', thrown);
    }
    running = null;
    runningNode = null;

    const completed = result !== null && (result.status === 'ok' || result.status === 'errors');
    const fields = loanView ? held : result?.fields ?? [];
    const delivers = !thumbnails && completed && !disposed && !lost && fields.length > 0 && fields.every((field) => field !== null);
    if (!delivers || !show(run, fields as AnyFieldHandle[])) {
      releaseAll(fields);
      // 5.11 rule 5: without a result the viewport shows what it showed before.
      if (loanView && !lost && !disposed) guarded(() => binder.revert());
    }
    // A slow node the view evaluation ran is cached at the preview resolution now: a thumbnail that waited for
    // it can be made (7.3 rule 10). After any other evaluation the try would end as the last one did.
    if (request.purpose === 'view' && leftOut.size > 0 && run.ran.some((id) => slowAt(id, request.resolution))) leftOut.clear();

    offer(run.generation, run.done);
    // A node that failed for its thumbnail fails the same way next time, and a call that was refused is refused again.
    if (thumbnails && (completed || result === null)) {
      offer(run.generation, request.targets.flatMap((target) => ('ref' in target ? [target.ref.node] : [])));
    }
    scheduler.settled(request, { tookMs: result?.timing.wallMs ?? 0, completed });
    emitMemory();
    // The evaluation saw the loss before the device reported it. A device that was replaced meanwhile is not this one.
    if (result?.status === 'device-lost') deviceLost(run.gpu, run.gpu.lostInfo ?? { reason: 'unknown', message: 'The GPU device stopped answering' });
  }

  // ---- inspect (7.1) ---------------------------------------------------------------------------------------------------
  async function inspectPort(ref: PortRef): Promise<FieldStats | null> {
    const view = shown;
    if (!view || lost || building || disposed) return null;
    if (typeof ref?.node !== 'string' || typeof ref.port !== 'string') return null;
    applyBudget();
    if (outputKind(view.doc, registry, ref) !== 'field') return null;
    const held = view.height && samePort(view.height.ref, ref) ? view.height.handle
      : view.overlay && samePort(view.overlay.ref, ref) ? view.overlay.handle : null;
    // A view target of a field port is that port's content itself: the handle on screen is what is asked for.
    if (held?.kind === 'field') return engine.stats(held);

    // Any other port is found through the cache, by an evaluation that stops before it would run a node. Only the
    // port's own node has to be cached: a node it reads is unused by this evaluation, evicted or not (5.3 step 5).
    const controller = new AbortController();
    const result = await engine.evaluate(view.doc, view.transient ? [{ ref }, ...view.targets] : [{ ref }], {
      resolution: view.resolution, mode: 'preview', requestId: ++requestId, signal: controller.signal, thumbnails: false,
      // Asked the way the shown result was, so that looking at a draft neither keeps its entries nor drops them (5.4).
      outputs: view.transient ? 'all' : 'needed', cache: view.transient ? 'transient' : 'keep',
      onEvent: (e) => {
        if (e.type === 'eval-start' && e.plan.some((node) => node.state === 'run')) controller.abort();
      },
    });
    try {
      const field = result.fields[0];
      return field?.kind === 'field' ? await engine.stats(field as FieldHandle<'field'>) : null;
    } finally {
      releaseAll(result.fields);
    }
  }

  async function inspectNow(job: Inspection): Promise<void> {
    let stats: FieldStats | null = null;
    try {
      stats = await inspectPort(job.ref);
    } catch (thrown) {
      if (!(thrown instanceof DeviceLostError) && !disposed) console.error('[orogen] inspect failed', thrown);
    }
    job.resolve(stats);
  }

  // ---- what runs next ----------------------------------------------------------------------------------------------------
  function nextWork(): (() => Promise<void>) | null {
    const job = inspections.shift();
    if (job) return () => inspectNow(job);
    if (trimDue !== null) {
      const keep = trimDue;
      trimDue = null;
      return () => trim(keep);
    }
    const { stale, atPreview } = staleThumbnails();
    scheduler.setThumbnails(stale, atPreview);
    const request = scheduler.next();
    return request ? () => evaluate(request) : null;
  }

  /** Called after every change: aborts what the change makes obsolete and, when nothing is under way, starts what is due, in this same task (7.3 rule 1). */
  function kick(): void {
    if (disposed) return;
    if (running && scheduler.shouldAbort()) running.controller.abort();
    if (active || building || lost) return;
    const work = nextWork();
    if (!work) return;
    // Set before the work starts: what the work emits may call back into the session in this same task.
    let ended!: () => void;
    active = new Promise<void>((resolve) => { ended = resolve; });
    void (async () => {
      try {
        await work();
      } catch (thrown) {
        if (!disposed) console.error('[orogen] the engine session failed', thrown);
      }
      active = null;
      ended();
      if (keysAfterTurn) {
        keysAfterTurn = false;
        refreshKeys();
      }
      guarded(kick);
    })();
  }

  // ---- builds (7.6) ----------------------------------------------------------------------------------------------------
  async function runBuild(request: BuildRequest, controller: AbortController): Promise<BuildResult> {
    let outcome: { readonly ok: true; readonly result: BuildResult } | { readonly ok: false; readonly reason: unknown };
    let id = 0;
    try {
      // The preview that was running is aborted; what it leaves is settled before the cache is emptied.
      while (active) await active;
      await trim(undefined);
      if (disposed) throw new Error(DISPOSED);
      applyBudget();
      id = ++requestId;
      lostNode = null;
      emit({ type: 'request-start', requestId: id, revision: scheduler.latest?.revision ?? 0, purpose: 'build' });
      emit({ type: 'build-start', requestId: id, resolution: request.doc.settings.buildResolution, outDir: request.outDir });
      const result = await opts.build(engine, {
        doc: request.doc, outDir: request.outDir, requestId: id, signal: controller.signal,
        onEvent: (e) => {
          track(e);
          emit(e);
          if (e.type === 'eval-end') emitMemory();
        },
      });
      outcome = { ok: true, result };
    } catch (reason) {
      outcome = { ok: false, reason };
    }
    runningNode = null;
    if (id === 0) id = ++requestId;
    const status = outcome.ok && STATUSES.includes(outcome.result?.status) ? outcome.result.status : 'errors';
    emit({ type: 'build-end', requestId: id, status });
    trimDue = null;
    if (!disposed) await trim(previewRes ?? undefined);
    building = null;
    scheduler.setBuilding(false);
    if (keysAfterTurn) {
      keysAfterTurn = false;
      refreshKeys();
    }
    guarded(kick);
    if (!outcome.ok) throw outcome.reason;
    return outcome.result;
  }

  // ---- the device (7.8) ------------------------------------------------------------------------------------------------
  function watchGpu(gpu: GpuContext): () => void {
    const offLost = gpu.onLost((info) => deviceLost(gpu, info));
    const offError = onUncapturedError(gpu, (error) => emit({ type: 'engine-error', message: error.message, fatal: false }));
    return () => {
      offLost();
      offError();
    };
  }

  function deviceLost(gpu: GpuContext, info: GpuLostInfo): void {
    if (disposed || gpu !== current || reported.has(gpu)) return;
    reported.add(gpu);
    lost = true;
    const nodeId = runningNode ?? lostNode;
    lostNode = null;
    emit({ type: 'device-lost', reason: info.reason, message: info.message, ...(nodeId !== null ? { nodeId } : {}) });
    // Rule 1: the renderer draws nothing, and the handles of the lost device are dropped, not released.
    guarded(() => binder.lost());
    shown = null;
    // A thumbnail that was made and not yet read back went with the device, and so did the cache.
    offered.clear();
    offersWaiting = null;
    deferred.clear();
    leftOut.clear();
    scheduler.setDeviceLost(true);
    for (const job of inspections.splice(0)) job.resolve(null);
    void recover(recovery.lost());
  }

  function giveUp(message: string): void {
    fatal = true;
    emit({ type: 'engine-error', message, fatal: true });
  }

  async function recover(attempt: Promise<RecoveryOutcome>): Promise<void> {
    const outcome = await attempt;
    if (disposed) {
      // Nobody else knows a context that was opened for a session that is gone.
      if (outcome.ok) outcome.gpu.destroy();
      return;
    }
    if (!outcome.ok) {
      giveUp(outcome.message);
      return;
    }
    const gpu = outcome.gpu;
    unwatchGpu();
    current = gpu;
    unwatchGpu = watchGpu(gpu);
    try {
      await engine.replaceDevice(gpu);
      if (disposed) return;
      if (!gpu.lost) initRenderer(gpu);
    } catch (thrown) {
      if (disposed) return;
      if (!gpu.lost) {
        giveUp(`The new GPU device could not be used: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
        return;
      }
    }
    if (gpu.lost) {
      // Lost while the engine moved onto it: one more loss, counted like any other.
      deviceLost(gpu, gpu.lostInfo ?? { reason: 'unknown', message: 'The new GPU device was lost at once' });
      return;
    }
    lost = false;
    scheduler.setDeviceLost(false);
    guarded(() => {
      applyBudget();
      emit({ type: 'device-ready', epoch: engine.epoch, caps: gpu.caps, budgetBytes: engine.memory().budgetBytes });
      scheduler.requestFull();
      kick();
    });
  }

  // ---- start ---------------------------------------------------------------------------------------------------------------
  initRenderer(engine.gpu);
  let unwatchGpu = watchGpu(current);
  // 7.7: a slice over the hard ceiling is an engine-error that is not fatal (3.5).
  const offOverrun = engine.onOverrun((slice) => emit({
    type: 'engine-error', fatal: false,
    message: `A slice of ${slice.nodeId !== null ? `node "${slice.nodeId}"` : `the engine's ${slice.service} service`} took ${Math.round(slice.measuredMs)} ms, `
      + `above the hard ceiling of ${Math.round(slice.ceilingMs)} ms (kernels: ${slice.kernels.join(', ')})`,
  }));
  const offThumbnail = engine.onThumbnail((thumbnail) => {
    if (disposed) return;
    remember(delivered, thumbnail.nodeId, thumbnail.contentKey);
    emit({
      type: 'thumbnail', nodeId: thumbnail.nodeId, contentKey: thumbnail.contentKey, resolution: thumbnail.resolution, rgba: thumbnail.rgba,
    });
  });
  // A context that was lost before the session had it: its loss was reported to nobody.
  if (current.lost) queueMicrotask(() => deviceLost(current, current.lostInfo ?? { reason: 'unknown', message: 'The GPU device was lost' }));
  /** The session's first subscriber is told of the device it starts with. */
  let announced = false;

  return {
    setProject(project) {
      if (disposed) return;
      const path = typeof project?.path === 'string' ? project.path : null;
      files = opts.createFiles(path);
      engine.setFiles(files);
      unwatchFiles();
      const latest = scheduler.latest;
      if (!latest) return;
      // The same paths may now name other files: the keys are made again and so is the result.
      watchFiles(latest.doc);
      generation++;
      // Engine.setFiles takes effect when the evaluation under way has settled; keys asked for before would read the old files.
      if (active || building) keysAfterTurn = true;
      else refreshKeys();
      scheduler.requestFull();
      kick();
    },

    setDocument(doc, revision) {
      if (disposed) return;
      const latest = scheduler.latest;
      if (!Number.isInteger(revision) || (latest !== null && revision <= latest.revision)) {
        throw new RangeError(`setDocument: revision ${String(revision)} is not an integer greater than ${latest ? latest.revision : 'any earlier one'}`);
      }
      if (typeof doc !== 'object' || doc === null || typeof doc.settings !== 'object' || typeof doc.nodes !== 'object') {
        throw new TypeError('setDocument: the first argument is a GraphDoc');
      }
      generation++;
      const resolution = previewResolution(doc.settings);
      if (previewRes !== null && resolution !== previewRes) trimDue = resolution;
      previewRes = resolution;
      scheduler.setDocument(doc, revision);
      watchFiles(doc);
      refreshKeys();
      kick();
    },

    beginGesture() {
      if (disposed) return;
      scheduler.beginGesture();
    },

    endGesture() {
      if (disposed) return;
      scheduler.endGesture();
      kick();
    },

    setPaused(paused) {
      if (disposed) return;
      scheduler.setPaused(paused === true);
      kick();
    },

    requestThumbnails(nodeIds) {
      if (disposed) return;
      requested = [...new Set(nodeIds.filter((id) => typeof id === 'string'))];
      kick();
    },

    inspect(ref) {
      if (disposed || lost || building) return Promise.resolve(null);
      return new Promise<FieldStats | null>((resolve) => {
        inspections.push({ ref, resolve });
        kick();
      });
    },

    build(request) {
      if (disposed) return Promise.reject(new Error(DISPOSED));
      if (building) return Promise.reject(new Error('A build is already running'));
      if (typeof request?.outDir !== 'string' || typeof request.doc?.settings !== 'object' || request.doc.settings === null) {
        return Promise.reject(new TypeError('build: the request is { doc, outDir }'));
      }
      building = { controller: new AbortController() };
      scheduler.setBuilding(true);
      // Rule 2: the running preview is aborted. Nothing reads the shown result while a build runs.
      kick();
      for (const job of inspections.splice(0)) job.resolve(null);
      return runBuild(request, building.controller);
    },

    cancelBuild() {
      building?.controller.abort();
    },

    plan(doc) {
      if (disposed) return Promise.reject(new Error(DISPOSED));
      if (typeof doc !== 'object' || doc === null || typeof doc.settings !== 'object' || doc.settings === null || typeof doc.nodes !== 'object' || doc.nodes === null) {
        return Promise.reject(new TypeError('plan: the argument is a GraphDoc'));
      }
      if (typeof opts.plan !== 'function') return Promise.reject(new Error('This session was given no planner'));
      // Pure and synchronous (export-unreal.md 3.1): it waits for nothing, and nothing waits for it.
      try {
        return Promise.resolve(opts.plan(engine, doc));
      } catch (thrown) {
        return Promise.reject(thrown);
      }
    },

    setPreferences(next) {
      if (disposed) return;
      prefs = { vramBytes: next?.vramBytes ?? null, budgetFraction: next?.budgetFraction ?? Number.NaN };
      applyBudget();
      emitMemory();
    },

    retryDevice() {
      if (disposed || !fatal) return;
      fatal = false;
      void recover(recovery.retry());
    },

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      if (!announced) {
        announced = true;
        // In a microtask: the subscriber has its unsubscribe function before its first event.
        queueMicrotask(() => {
          if (disposed || lost) return;
          emit({ type: 'device-ready', epoch: engine.epoch, caps: current.caps, budgetBytes: engine.memory().budgetBytes });
        });
      }
      return () => void listeners.delete(listener);
    },

    viewport: binder.host,

    dispose() {
      if (disposal) return disposal;
      if (disposed) return Promise.resolve();
      disposed = true;
      running?.controller.abort();
      building?.controller.abort();
      recovery.dispose();
      unwatchFiles();
      unwatchGpu();
      offThumbnail();
      for (const job of inspections.splice(0)) job.resolve(null);
      offOverrun();
      shown = null;
      listeners.clear();
      disposal = (async () => {
        try {
          binder.dispose();
          // What is under way ends first: an inspection holds a handle between its evaluation and its statistics,
          // and the engine is disposed with nothing held.
          while (active) await active;
        } finally {
          // Waits until the evaluation that was aborted has settled.
          await engine.dispose();
        }
      })();
      return disposal;
    },
  };
}
