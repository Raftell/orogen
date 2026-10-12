import { DeviceLostError, deviceLostError } from '../gpu/device.ts';
import { BudgetExceededError, BYTES_PER_TEXEL, type AnyFieldHandle, type PoolTexture } from '../gpu/pool.ts';
import { GpuOutOfMemoryError } from '../gpu/stream.ts';
import type { GraphDoc, PortRef } from '../graph/doc.ts';
import type { NodeRegistry } from '../graph/registry.ts';
import type { EntryTextures, ResultCache } from './cache.ts';
import { createInvocation, type Invocation } from './context.ts';
import { constant, convert, maskBlend } from './convert.ts';
import { budgetMessage, InternalError, nodeErrorFrom, outOfMemoryMessage, type NodeError } from './errors.ts';
import type { EvalEvent } from './events.ts';
import { createFieldHandle } from './handles.ts';
import { computeKeys, createTokenTable, edgeContent, type Content, type NodeKeys } from './keys.ts';
import { deviceAlive, type EngineParts } from './parts.ts';
import { buildPlan, outputPeak, type EvalPlan, type Lifetime, type PlanNode } from './plan.ts';
import { etaMs, nodeWeights, type NodeTiming } from './progress.ts';
import type { Thumbnails } from './thumbnails.ts';

export type EvalTarget =
  | { readonly ref: PortRef; readonly as?: 'field' | 'color' }   // an output port, optionally converted (5.6)
  | { readonly node: string };                                   // run this node; no field is returned

export interface EvaluateOptions {
  readonly resolution: number;
  readonly mode: 'preview' | 'build';
  readonly requestId: number;
  readonly signal?: AbortSignal;
  readonly outputs?: 'all' | 'needed';
  readonly cache?: 'keep' | 'transient';
  readonly thumbnails?: boolean;
  readonly onEvent?: (e: EvalEvent) => void;                     // 5.10
  readonly onTarget?: (index: number, field: AnyFieldHandle | null) => Promise<void>;
  readonly onLoans?: (nodeId: string, loans: Readonly<Record<string, TextureRef>> | null) => void;   // 5.11
}

/** A texture as a viewer binds it: a loan (5.11) or published content (7.5). */
export interface TextureRef { readonly view: GPUTextureView; readonly width: number; readonly height: number; readonly kind: 'field' | 'color' }

export interface EvaluateResult {
  readonly requestId: number;
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly fields: readonly (AnyFieldHandle | null)[];           // fields[i] belongs to targets[i]
  readonly errors: readonly NodeError[];                         // 5.8; one per failed node, in plan order
  readonly timing: { readonly wallMs: number; readonly nodesRun: number; readonly nodesCached: number };
}

/** What the engine gives its evaluator. `parts()` is read at the start of every evaluation; nothing replaces them while one runs. */
export interface EvaluatorDeps {
  readonly registry: NodeRegistry;
  parts(): EngineParts;
  readonly cache: ResultCache;
  readonly thumbnails: Thumbnails;
  /** An evaluation found the device lost, or lost it: the engine forgets what lived on it (5.9 rule 3). */
  onDeviceLost(): void;
}

/** runtime.md 5.2 to 5.13: one evaluation at a time; a call made while another runs starts when that one has settled. */
export interface Evaluator {
  evaluate(doc: GraphDoc, targets: readonly EvalTarget[], opts: EvaluateOptions): Promise<EvaluateResult>;
  keys(doc: GraphDoc): Promise<ReadonlyMap<string, string>>;
  lastTiming(nodeId: string): NodeTiming | null;
  /** Runs `work` in the evaluations' turn: at once when nothing runs or waits, else when what was asked before has settled. */
  exclusive<T>(work: () => T | Promise<T>): Promise<T>;
  /** Resolves when no evaluation runs or waits. */
  idle(): Promise<void>;
  /** 5.9 rule 6: the node that was running when the device was lost, and its key; null when none was, and once that node has completed. */
  readonly lostAt: { readonly nodeId: string; readonly key: string } | null;
  /** The device was lost while no evaluation ran: no node was running at this loss. */
  lostWhileIdle(): void;
}

/** node-progress at most 10 times per second per node, eval-progress at most 4 times per second (5.10 rule 3). */
const NODE_PROGRESS_MS = 100;
const EVAL_PROGRESS_MS = 250;
/** node-preview at most this often (5.11 rule 2). */
const NODE_PREVIEW_MS = 100;
/** Node ids whose last timing is remembered. */
const TIMINGS_KEPT = 16384;
/**
 * The longest the plan is walked without a completed GPU wait. Hits, bypassed nodes, pass-throughs and failures
 * await nothing that takes a turn of the event loop, and an abort, like every message, arrives through it (3.7).
 */
const TURN_MS = 4;

const noop = (): void => undefined;
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

/** One content of an evaluation: what the plan will read, held by the evaluation while a reader is still to come (2.2). */
interface Slot {
  readonly content: Content;
  /** Published, with one reference that is the evaluation's. */
  texture: PoolTexture | null;
  /** Readers that have not settled. */
  readers: number;
  /** What producing the content reads; null for a node output and once it is produced. */
  deps: Slot[] | null;
  failed: Error | null;
  /** The steps from which and until which the content is alive, for the memory check of a build (5.3 step 6). */
  born: number;
  last: number;
}

interface Group {
  readonly key: string;
  readonly members: Step[];
  /** The outputs that the members this evaluation needs want. */
  readonly wanted: Set<string>;
  /** A member is needed (5.3 step 5): a target names it, or content this evaluation makes reads its result. */
  needed: boolean;
  /** The cache holds every wanted output of a needed node. */
  hit: boolean;
  /** The entry in use: the one that holds every wanted output, or whatever the cache holds of a node nothing needs; null when the node runs. */
  entry: EntryTextures | null;
  /**
   * The member that runs for all of them: planned as the first needed one in plan order, and in the end the
   * first needed one whose turn comes with nothing it reads failed. A member skipped for a source of its own
   * (its mask, which is not in the key) leaves the run to the next one.
   */
  runner: Step | null;
  /** What ctx.wants() answers for whichever member runs (5.4 rule 2). */
  runWanted: ReadonlySet<string>;
  /** The runner has published: every other member is a hit. */
  published: boolean;
  /** The failure of the runner, which every node of the same key shares. */
  failed: NodeError | null;
}

interface Step {
  readonly node: PlanNode;
  readonly index: number;
  keys: NodeKeys | null;
  state: 'cached' | 'run' | 'bypassed' | 'blocked' | 'unused';
  /** A target names the node, or content this evaluation makes reads one of its outputs. Only such a node runs. */
  needed: boolean;
  /** A failure known before the node's turn: a check of 5.3, its externalKey, a kernel, a second device loss. */
  error: NodeError | null;
  group: Group | null;
  /** The outputs of this node that the evaluation wants. */
  wanted: ReadonlySet<string>;
  /**
   * What evaluate() would read. Every needed member of a group that runs holds these until one of them has
   * published or failed: any of them may have to run.
   */
  inputs: Slot[];
  /** What else the step reads; released when it has settled. */
  reqs: Slot[];
  /** The targets that name this node, by index, with the content each delivers; null for a node target. */
  readonly targets: Map<number, Slot | null>;
}

export function createEvaluator(deps: EvaluatorDeps): Evaluator {
  const tokens = createTokenTable();
  const timings = new Map<string, NodeTiming>();
  /** 5.9 rule 6: nodes that were running at two losses in a row, with the key they had. */
  const banned = new Map<string, string>();
  let lostAt: { readonly nodeId: string; readonly key: string } | null = null;
  let lastRequestId = -Infinity;
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  function exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await work();
      } finally {
        waiting--;
      }
    };
    const result = waiting++ === 0 ? run() : tail.then(run);
    tail = result.then(noop, noop);
    return result;
  }

  async function run(doc: GraphDoc, targets: readonly EvalTarget[], opts: EvaluateOptions, plan: EvalPlan): Promise<EvaluateResult> {
    const parts = deps.parts();
    const { pool, stream } = parts;
    const { resolution, mode, requestId } = opts;
    const preview = mode === 'preview';
    const signal = opts.signal ?? new AbortController().signal;
    const transient = preview && opts.cache === 'transient' ? requestId : null;
    const withThumbnails = opts.thumbnails ?? preview;
    const staged = opts.onTarget !== undefined;
    const started = performance.now();
    const aliveAtStart = deviceAlive(parts);
    const emit = (event: EvalEvent): void => opts.onEvent?.(event);

    const steps: Step[] = plan.nodes.map((node, index) => ({
      node, index, keys: null, state: 'blocked', needed: false, error: node.error, group: null, wanted: new Set<string>(), inputs: [], reqs: [], targets: new Map(),
    }));
    const stepOf = new Map(steps.map((step) => [step.node.nodeId, step]));
    const slots = new Map<string, Slot>();
    const groups = new Map<string, Group>();
    const errors: NodeError[] = [];
    /** Node id → the failed node it goes back to, for every node that did not finish. */
    const failed = new Map<string, string>();
    const fields: (AnyFieldHandle | null)[] = targets.map(() => null);
    // Members of one object, read through it everywhere: these change inside the functions below, behind the type checker's back.
    const flow: {
      /** Why no further node runs. */
      stop: 'aborted' | 'device-lost' | null;
      /** What onTarget rejected with: the evaluation stops as if aborted and rejects with it (5.2). */
      rejection: { readonly reason: unknown } | null;
      /** The node whose evaluate() is under way. */
      running: { readonly nodeId: string; readonly key: string } | null;
    } = { stop: null, rejection: null, running: null };
    let nodesRun = 0, nodesCached = 0;
    let outputPeakBytes: number | null = null;

    /** 3.7: the device, then the signal. Returns why the evaluation has stopped, or null. */
    const halted = (): 'aborted' | 'device-lost' | null => {
      if (flow.stop === null) {
        if (!deviceAlive(parts)) flow.stop = 'device-lost';
        else if (signal.aborted) flow.stop = 'aborted';
      }
      return flow.stop;
    };
    /** What a call that finds the evaluation stopped throws. */
    const haltError = (why: 'aborted' | 'device-lost'): unknown => (why === 'device-lost' ? deviceLostError(parts.gpu) : signal.reason);

    // ---- contents and the evaluation's references (2.2) ------------------------------------------------------------
    const bytesOf = (kind: 'field' | 'color'): number =>
      resolution * resolution * BYTES_PER_TEXEL[parts.gpu.caps.formats[kind] as keyof typeof BYTES_PER_TEXEL];

    function hold(slot: Slot, texture: PoolTexture): void {
      pool.retain(texture);
      slot.texture = texture;
    }

    /** What producing the content of a new slot will read, unless the content is at hand. */
    function sourcesOf(slot: Slot): readonly Content[] {
      const c = slot.content;
      if (c.type === 'node') {
        const group = groups.get(c.nodeKey);
        const cached = group?.entry?.get(c.port);
        if (cached) hold(slot, cached);
        else if (group?.runner) slot.born = group.runner.index;
        return [];
      }
      if (preview) {
        const cached = deps.cache.get(c.id, resolution, transient)?.get('out');
        if (cached) {
          hold(slot, cached);
          return [];
        }
      }
      if (c.type === 'convert') return [c.source];
      if (c.type === 'mask') return [c.raw, c.mask, c.base];
      return [];
    }

    /** One more reader of the content, at step `step`, which needs it until step `until`. */
    function require(content: Content, step: number, until: number = step): Slot {
      const known = slots.get(content.id);
      if (known) {
        known.readers++;
        known.last = Math.max(known.last, until);
        return known;
      }
      const make = (c: Content, last: number): Slot => {
        const slot: Slot = { content: c, texture: null, readers: 0, deps: null, failed: null, born: step, last };
        slots.set(c.id, slot);
        return slot;
      };
      const root = make(content, until);
      root.readers = 1;
      // Without recursion: a slot is made once, so the walk ends after one round per content.
      const fresh: Slot[] = [root];
      for (let slot = fresh.pop(); slot !== undefined; slot = fresh.pop()) {
        const sources = sourcesOf(slot);
        if (sources.length === 0) continue;
        slot.deps = [];
        for (const source of sources) {
          let dep = slots.get(source.id);
          if (!dep) {
            dep = make(source, step);
            fresh.push(dep);
          }
          dep.readers++;
          dep.last = Math.max(dep.last, step);
          slot.deps.push(dep);
        }
      }
      return root;
    }

    /** A reader has settled. Content without a reader left is no longer the evaluation's. */
    function unrequire(first: Slot): void {
      const work: Slot[] = [first];
      for (let slot = work.pop(); slot !== undefined; slot = work.pop()) {
        if (--slot.readers > 0) continue;
        if (slot.texture) {
          if (deviceAlive(parts)) pool.drop(slot.texture);
          slot.texture = null;
        }
        if (slot.deps) {
          work.push(...slot.deps);
          slot.deps = null;
        }
        if (slots.get(slot.content.id) === slot) slots.delete(slot.content.id);
      }
    }

    function releaseInputs(step: Step): void {
      const read = step.inputs;
      step.inputs = [];
      for (const slot of read) unrequire(slot);
    }

    /** The group's runner has published or failed: no other member will run, and none needs what evaluate() reads. */
    function runnerSettled(runner: Step): void {
      for (const member of runner.group?.members ?? []) {
        if (member !== runner) releaseInputs(member);
      }
    }

    function stored(slot: Slot, texture: PoolTexture): void {
      if (preview) deps.cache.set(slot.content.id, resolution, new Map([['out', texture]]), transient);
    }

    /** Makes a conversion, a mask blend or a constant whose sources are at hand. The texture's one reference is the slot's. */
    async function produce(slot: Slot): Promise<void> {
      const c = slot.content;
      const sources = (slot.deps ?? []).map((dep) => dep.texture);
      if (c.type === 'node' || sources.some((texture) => texture === null)) {
        throw new InternalError(`The content ${c.id} is not available`);
      }
      try {
        if (c.type === 'mask' && sources[0] === sources[2]) {
          // 5.6: outputs[0] passes inputs[0] through, and mix(x, x, m) is x.
          hold(slot, sources[0]!);
        } else {
          const make = (): Promise<PoolTexture> => (
            c.type === 'convert' ? convert(parts, sources[0]!, c.conversion, mode, signal)
              : c.type === 'mask' ? maskBlend(parts, sources[2]!, sources[0]!, sources[1]!, mode, signal)
                : constant(parts, c.kind, resolution, mode, signal));
          let texture: PoolTexture;
          try {
            texture = await make();
          } catch (thrown) {
            // 5.8 Memory rule 4: as for a node, one more attempt after everything reclaimable is gone.
            if (!(thrown instanceof GpuOutOfMemoryError) || !deviceAlive(parts) || signal.aborted) throw thrown;
            await reclaim();
            if (!deviceAlive(parts) || signal.aborted) throw thrown;
            texture = await make();
          }
          pool.publish(texture);
          slot.texture = texture;
        }
      } catch (thrown) {
        if (!deviceAlive(parts) || signal.aborted) throw thrown;
        slot.failed = new InternalError(thrown instanceof Error ? thrown.message : String(thrown));
        throw slot.failed;
      }
      stored(slot, slot.texture!);
      const used = slot.deps;
      slot.deps = null;
      for (const dep of used ?? []) unrequire(dep);
    }

    /** The published texture of the content, produced now when it is not at hand. */
    async function obtain(slot: Slot): Promise<PoolTexture> {
      if (slot.texture) return slot.texture;
      // What has to be produced, sources first; each slot is entered once.
      const order: Slot[] = [];
      const entered = new Set<Slot>([slot]);
      const path: { readonly slot: Slot; at: number }[] = [{ slot, at: 0 }];
      for (let frame = path.at(-1); frame !== undefined; frame = path.at(-1)) {
        const sources = frame.slot.deps ?? [];
        if (frame.at < sources.length) {
          const source = sources[frame.at++]!;
          if (!source.texture && !entered.has(source)) {
            entered.add(source);
            path.push({ slot: source, at: 0 });
          }
          continue;
        }
        path.pop();
        order.push(frame.slot);
      }
      for (const next of order) {
        if (next.texture) continue;
        if (next.failed) throw next.failed;
        await produce(next);
      }
      return slot.texture!;
    }

    // ---- events ------------------------------------------------------------------------------------------------------
    let weights: ReadonlyMap<string, number> = new Map();
    let totalWeight = 0, doneWeight = 0;
    let lastEvalProgress = -Infinity, evalFraction = 0;
    function evalProgress(runningWeight: number): void {
      if (!(totalWeight > 0)) return;
      const now = performance.now();
      const fraction = Math.min(1, Math.max(evalFraction, (doneWeight + runningWeight) / totalWeight));
      if (now - lastEvalProgress < EVAL_PROGRESS_MS || fraction === evalFraction) return;
      evalFraction = fraction;
      lastEvalProgress = now;
      emit({ type: 'eval-progress', requestId, fraction, etaMs: etaMs(now - started, fraction, 1000) });
    }

    function fail(step: Step, error: NodeError): void {
      errors.push(error);
      failed.set(step.node.nodeId, step.node.nodeId);
      if (step.group?.runner === step) {
        step.group.failed = error;
        runnerSettled(step);
      }
      emit({ type: 'node-error', requestId, error });
    }
    function skip(step: Step, reason: 'upstream' | 'aborted' | 'device-lost', upstream?: string): void {
      failed.set(step.node.nodeId, upstream ?? step.node.nodeId);
      emit({ type: 'node-skipped', requestId, nodeId: step.node.nodeId, reason, ...(upstream !== undefined ? { upstream } : {}) });
    }
    /** The step ends for a reason that is not the node's: the device, the signal, or a failure of its own. */
    function settleFailure(step: Step, thrown: unknown): void {
      const why = halted();
      if (why) skip(step, why);
      else if (thrown instanceof DeviceLostError) {
        flow.stop = 'device-lost';
        skip(step, 'device-lost');
      } else fail(step, nodeErrorFrom(thrown, { id: step.node.nodeId, type: step.node.instance.type }, resolution, pool.report().budgetBytes));
    }

    // ---- one node ----------------------------------------------------------------------------------------------------
    /** 5.5 step 4: the fields given to ctx.output() become PUBLISHED, everything else the node allocated FREE. */
    function publish(step: Step, invocation: Invocation, given: ReadonlyMap<string, { readonly texture: PoolTexture; readonly alias: boolean }>): void {
      const published = new Map<string, PoolTexture>();
      const keep = new Set<PoolTexture>();
      for (const [port, { texture, alias }] of given) {
        // One reference per output: an alias takes one more on the input's texture, a field given twice is published once.
        if (alias || keep.has(texture)) pool.retain(texture);
        else {
          pool.publish(texture);
          keep.add(texture);
        }
        published.set(port, texture);
      }
      invocation.end(keep);
      if (preview) deps.cache.set(step.keys!.key!, resolution, published, transient);
      for (const [port, texture] of published) {
        const slot = slots.get(step.keys!.raw[port]!.id);
        if (slot && slot.readers > 0 && !slot.texture) hold(slot, texture);
        // The reference taken above was the evaluator's; the entry and the readers now have their own.
        pool.drop(texture);
      }
      step.group!.published = true;
      runnerSettled(step);
    }

    /** One call of evaluate(), from the inputs to publication. Resolves with what the call threw when it failed. */
    async function invoke(step: Step, onProgress: (fraction: number, label?: string) => void): Promise<
      { readonly ok: true; readonly gpuMs: number | null; readonly peakBytes: number } | { readonly ok: false; readonly thrown: unknown }
    > {
      const { node } = step;
      const def = node.def!;
      const keys = step.keys!;
      const nodeId = node.nodeId;
      const scaled = lostAt !== null && lostAt.nodeId === nodeId && lostAt.key === keys.key;
      const owner = stream.open({ nodeId, service: null, mode, signal, ...(scaled ? { limitScale: 0.5 } : {}) });
      let invocation: Invocation | null = null;
      let lastPreview = -Infinity;
      try {
        const inputs: Record<string, PoolTexture | null> = {};
        for (const port of def.inputs) {
          const content = keys.inputs[port.name];
          inputs[port.name] = content ? await obtain(slots.get(content.id)!) : null;
        }
        let why = halted();
        if (why) throw haltError(why);
        stream.use(owner);
        invocation = createInvocation(parts, {
          nodeId, def, resolution, settings: doc.settings, params: node.params!, inputs, wanted: step.group!.runWanted, signal, owner, onProgress,
          onLoans: (loans) => {
            if (!loans) {
              opts.onLoans?.(nodeId, null);
              return;
            }
            const refs: Record<string, TextureRef> = {};
            for (const [port, texture] of Object.entries(loans)) {
              refs[port] = { view: texture.view, width: texture.width, height: texture.height, kind: texture.kind === 'color' ? 'color' : 'field' };
            }
            opts.onLoans?.(nodeId, refs);
            const now = performance.now();
            if (now - lastPreview >= NODE_PREVIEW_MS) {
              lastPreview = now;
              emit({ type: 'node-preview', requestId, nodeId, ports: Object.keys(refs) });
            }
          },
        });
        const returned: unknown = def.evaluate(invocation.ctx);
        if (isThenable(returned)) await returned;
        why = halted();
        if (why) throw haltError(why);
        stream.use(owner);
        const given = invocation.outputs();
        const settled = await owner.settle();
        why = halted();
        if (why) throw haltError(why);
        publish(step, invocation, given);
        return { ok: true, gpuMs: settled.gpuMs, peakBytes: invocation.peakBytes };
      } catch (thrown) {
        // 5.5 step 5: nothing is published and every field the node allocated returns to FREE.
        invocation?.end();
        owner.close();
        return { ok: false, thrown };
      }
    }

    /** 5.8 Memory rule 2. */
    async function reclaim(): Promise<void> {
      await pool.trim();
      deps.cache.evictEvictable();
      await pool.trim();
      await pool.drained();
    }

    /** The content readers of outputs[0] receive, the content of the targets, the final event, the thumbnail, the delivery. */
    async function finish(step: Step, done: { readonly cached: boolean; readonly wallMs: () => number; readonly gpuMs: number | null; readonly peakBytes: number }): Promise<void> {
      const { node } = step;
      const nodeId = node.nodeId;
      const primary = node.def!.outputs[0];
      try {
        // The slots of this step's own reads: outputs[0] first, where a mask blend is made (5.5 step 3).
        for (const slot of step.reqs) {
          if (slot.content.id === (primary ? step.keys!.outputs[primary.name]!.content.id : null)) await obtain(slot);
        }
        for (const slot of step.targets.values()) if (slot) await obtain(slot);
      } catch (thrown) {
        settleFailure(step, thrown);
        return;
      }
      const why = halted();
      if (why) {
        skip(step, why);
        return;
      }
      if (done.cached) {
        if (step.state === 'cached') nodesCached++;
      } else {
        nodesRun++;
      }
      emit({ type: 'node-done', requestId, nodeId, cached: done.cached, wallMs: done.wallMs(), gpuMs: done.gpuMs, peakBytes: done.peakBytes });

      if (withThumbnails && primary) {
        const shown = slots.get(step.keys!.outputs[primary.name]!.content.id)?.texture;
        try {
          if (shown && deps.thumbnails.wanted(nodeId, step.keys!.contentKey, resolution)) {
            deps.thumbnails.add(shown, {
              nodeId, contentKey: step.keys!.contentKey, resolution, settings: doc.settings,
              role: shown.kind === 'color' ? null : primary.role ?? 'height',
            });
          }
          deps.thumbnails.poll(false);
        } catch {
          // A thumbnail is a by-product (5.12 rule 1): it never fails an evaluation.
        }
      }

      if (!staged) return;
      for (const [index, slot] of [...step.targets]) {
        if (halted()) return;
        const target = targets[index]!;
        const handle = slot?.texture && 'ref' in target
          ? createFieldHandle(parts, slot.texture, target.as ?? slot.content.kind) as AnyFieldHandle
          : null;
        try {
          await opts.onTarget!(index, handle);
        } catch (reason) {
          flow.stop = 'aborted';
          flow.rejection = { reason };
        } finally {
          try {
            handle?.release();
          } catch {
            // The consumer released a handle that was the evaluator's to release.
          }
          step.targets.delete(index);
          if (slot) unrequire(slot);
        }
      }
    }

    async function runNode(step: Step): Promise<void> {
      const { node } = step;
      const nodeId = node.nodeId;
      const key = step.keys!.key!;
      const t0 = performance.now();
      let fraction = 0, lastProgress = -Infinity;
      const weight = weights.get(nodeId) ?? 0;
      const onProgress = (f: number, label?: string): void => {
        if (f < fraction) return;
        fraction = f;
        const now = performance.now();
        if (now - lastProgress < NODE_PROGRESS_MS) return;
        lastProgress = now;
        emit({ type: 'node-progress', requestId, nodeId, fraction, ...(label !== undefined ? { label } : {}), etaMs: etaMs(now - t0, fraction, 500) });
        evalProgress(weight * fraction);
      };
      emit({ type: 'node-start', requestId, nodeId });
      flow.running = { nodeId, key };
      let outcome = await invoke(step, onProgress);
      if (!outcome.ok && outcome.thrown instanceof GpuOutOfMemoryError && !halted()) {
        let second: Awaited<ReturnType<typeof invoke>>;
        try {
          await reclaim();
          second = halted() ? outcome : await invoke(step, onProgress);
        } catch (thrown) {
          second = { ok: false, thrown };
        }
        // 5.8 Memory rule 3.
        if (!second.ok && !halted() && (second.thrown instanceof GpuOutOfMemoryError || second.thrown instanceof BudgetExceededError)) {
          const budgetBytes = pool.report().budgetBytes;
          fail(step, {
            nodeId, nodeType: node.instance.type, kind: 'out-of-memory',
            message: outOfMemoryMessage(resolution, budgetBytes), detail: second.thrown.message,
          });
          flow.running = null;
          return;
        }
        outcome = second;
      }
      if (!outcome.ok) {
        settleFailure(step, outcome.thrown);
        if (flow.stop !== 'device-lost') flow.running = null;
        return;
      }
      flow.running = null;
      // 5.9 rule 6: the record of a loss ends when its node completes. A node that ran through is not the one
      // that loses the device, however often a later loss finds it running.
      if (lostAt !== null && lostAt.nodeId === nodeId && lostAt.key === key) lostAt = null;
      const { gpuMs, peakBytes } = outcome;
      await finish(step, {
        cached: false, gpuMs, peakBytes,
        wallMs: () => {
          const wallMs = performance.now() - t0;
          // Most recently measured last; beyond the limit the oldest go, and their nodes weigh the median again (5.10).
          timings.delete(nodeId);
          timings.set(nodeId, { resolution, wallMs });
          if (timings.size > TIMINGS_KEPT) timings.delete(timings.keys().next().value!);
          return wallMs;
        },
      });
      doneWeight += weight;
      evalProgress(0);
    }

    // ---- the evaluation (5.3) ------------------------------------------------------------------------------------------
    try {
      halted();
      // Step 3: keys.
      let keyErrors: ReadonlyMap<string, unknown> = new Map();
      if (!flow.stop) {
        try {
          const computed = await computeKeys(plan, doc, parts.files, tokens, signal);
          keyErrors = computed.errors;
          for (const step of steps) step.keys = computed.keys.get(step.node.nodeId) ?? null;
        } catch (thrown) {
          if (!halted()) throw thrown;
        }
        halted();
      }

      if (!flow.stop) {
        // Step 4, and the failures known before any node runs.
        const allOutputs = (opts.outputs ?? (preview ? 'all' : 'needed')) === 'all';
        for (const step of steps) {
          const { node } = step;
          const nodeId = node.nodeId;
          if (keyErrors.has(nodeId)) {
            step.error ??= nodeErrorFrom(keyErrors.get(nodeId), { id: nodeId, type: node.instance.type }, resolution, pool.report().budgetBytes);
          }
          const key = step.keys?.key ?? null;
          if (key !== null && banned.has(nodeId)) {
            if (banned.get(nodeId) === key) {
              step.error ??= { nodeId, nodeType: node.instance.type, kind: 'device-lost', message: 'The GPU was reset twice while this node was running' };
            } else {
              banned.delete(nodeId);
            }
          }
          if (step.error || !step.keys) continue;
          if (node.bypassed) {
            step.state = 'bypassed';
            continue;
          }
          let group = groups.get(key!);
          if (!group) {
            groups.set(key!, group = {
              key: key!, members: [], wanted: new Set(), needed: false, hit: false, entry: null, runner: null, runWanted: new Set(), published: false, failed: null,
            });
          }
          group.members.push(step);
          step.group = group;
        }

        /** What each target delivers, by index: the output, converted where the target asks for the other kind. */
        const targetContents = new Map<number, Content>();
        targets.forEach((target, index) => {
          const step = stepOf.get('ref' in target ? target.ref.node : target.node)!;
          step.targets.set(index, null);
          if (step.state === 'blocked' && !step.group) return;
          if (!('ref' in target)) return;
          const output = step.keys!.outputs[target.ref.port]!;
          const conversion = target.as === undefined || target.as === output.content.kind ? '' : target.as === 'color' ? 'grey' : 'luma';
          targetContents.set(index, edgeContent(tokens, output, conversion).content);
        });

        // Step 5, from the targets back. A node is needed when a target names it, when content this evaluation
        // makes reads one of its outputs, or when a blocked node reads one. Only a needed node is looked up for a
        // hit, and only one without a hit runs. A node that is not needed has readers that are all cache hits,
        // or not needed themselves: an entry of it that was evicted is not made again for them.
        const neededIds = new Set<string>();
        /** The evaluation must have this content: so it must have what making it reads, unless the cache holds it. */
        const need = (first: Content): void => {
          // Each content is entered once, so the walk ends after one round per content.
          const work: Content[] = [first];
          for (let c = work.pop(); c !== undefined; c = work.pop()) {
            if (neededIds.has(c.id)) continue;
            neededIds.add(c.id);
            // A node's output is decided with its node, below.
            if (c.type === 'node' || (preview && deps.cache.peek(c.id, resolution) !== undefined)) continue;
            if (c.type === 'convert') work.push(c.source);
            else if (c.type === 'mask') work.push(c.raw, c.mask, c.base);
          }
        };
        for (const content of targetContents.values()) need(content);
        /** The outputs a blocked node reads: a reader that will not run is a reader still, and its sources are evaluated. */
        const readByBlocked = new Set<string>();
        const portKey = (nodeId: string, port: string): string => JSON.stringify([nodeId, port]);
        /** Whether the cache holds what readers would receive at outputs[0] of a node this evaluation does not need. */
        const atHand = (step: Step, entry: EntryTextures | undefined): boolean => {
          const primary = step.node.def!.outputs[0];
          if (!primary) return entry !== undefined;
          const content = step.keys!.outputs[primary.name]!.content;
          return content.type === 'node' ? entry?.has(content.port) === true : preview && deps.cache.peek(content.id, resolution) !== undefined;
        };

        // In reverse plan order every reader of a node comes before the node, and every reader of a key before
        // the first node of that key, where the key is decided.
        for (let at = steps.length - 1; at >= 0; at--) {
          const step = steps[at]!;
          const { node } = step;
          const group = step.group;
          if (!group) {
            if (step.state === 'bypassed') {
              // The outputs of a bypassed node are its input's content, or a constant.
              for (const port of node.def!.outputs) {
                if (readByBlocked.has(portKey(node.nodeId, port.name))) need(step.keys!.outputs[port.name]!.content);
              }
            } else {
              for (const input of node.inputs) if (input.from) readByBlocked.add(portKey(input.from.node, input.from.port));
            }
            continue;
          }
          const keys = step.keys!;
          const outputs = node.def!.outputs;
          const named = new Set<string>();
          for (const t of step.targets.keys()) {
            const target = targets[t]!;
            if ('ref' in target) named.add(target.ref.port);
          }
          const read = outputs.filter((port) => named.has(port.name) || readByBlocked.has(portKey(node.nodeId, port.name))
            || neededIds.has(keys.outputs[port.name]!.content.id) || neededIds.has(keys.raw[port.name]!.id));
          step.needed = step.targets.size > 0 || read.length > 0;
          step.wanted = new Set((!step.needed ? [] : allOutputs ? outputs : read).map((port) => port.name));
          const primary = outputs[0];
          // What readers receive at outputs[0], a mask blend, is made at the node's turn when it is wanted (5.5 step 4).
          if (primary && step.wanted.has(primary.name)) need(keys.outputs[primary.name]!.content);
          if (group.members[0] !== step) continue;

          const needed = group.members.filter((member) => member.needed);
          group.needed = needed.length > 0;
          for (const member of group.members) for (const port of member.wanted) group.wanted.add(port);
          const entry = preview ? deps.cache.peek(group.key, resolution) : undefined;
          group.hit = group.needed && entry !== undefined && [...group.wanted].every((port) => entry.has(port));
          if (group.needed && !group.hit) {
            // Of several needed nodes with one key the first runs.
            const runner = needed[0]!;
            group.runner = runner;
            // 5.4 rule 2: every output this evaluation wants or the old entry held.
            group.runWanted = runner.wanted = new Set([...group.wanted, ...(entry?.keys() ?? [])]);
            const first = runner.node.def!.outputs[0];
            if (first && runner.wanted.has(first.name)) need(runner.keys!.outputs[first.name]!.content);
            for (const port of runner.node.def!.inputs) {
              const content = runner.keys!.inputs[port.name];
              if (content) need(content);
            }
          }
          for (const member of group.members) {
            member.state = member === group.runner ? 'run' : member.needed || atHand(member, entry) ? 'cached' : 'unused';
          }
        }

        // The entries are used in plan order, sources before their readers: under the budget a source is then
        // evicted before the result that was made from it (2.7). What the cache holds of a node that is not
        // needed is used all the same, so that entries upstream of an edit keep their place and survive a gesture (5.4).
        for (const group of groups.values()) {
          if (preview && (group.hit || !group.needed)) group.entry = deps.cache.get(group.key, resolution, transient) ?? null;
        }

        // The references of the evaluation (2.2), taken in the same synchronous section as the lookup, in plan order.
        const end = steps.length - 1;
        for (const step of steps) {
          const { node, index } = step;
          if (step.state === 'blocked') continue;
          const keys = step.keys!;
          if (step.group?.runner && step.needed) {
            for (const port of node.def!.inputs) {
              const content = keys.inputs[port.name];
              if (!content) continue;
              // The planned runner fixes how long the content lives (step 6). The other members read the same
              // content and only keep it from being let go before one of them has run.
              const held = step.state === 'run' ? undefined : slots.get(content.id);
              if (held) held.readers++;
              step.inputs.push(held ?? require(content, index));
            }
          }
          const primary = node.def!.outputs[0];
          // outputs[0] as readers receive it: of a needed node when it is wanted, and of a node nothing needs
          // when the cache still holds it, for its thumbnail (5.12 rule 1).
          if (step.state !== 'bypassed' && primary && (step.wanted.has(primary.name) || (!step.needed && step.state === 'cached'))) {
            step.reqs.push(require(keys.outputs[primary.name]!.content, index));
          }
          for (const t of step.targets.keys()) {
            const content = targetContents.get(t);
            if (content) step.targets.set(t, require(content, index, staged ? index : end));
          }
        }

        // Step 6: the memory check of a build.
        if (!preview) {
          const lifetimes: Lifetime[] = [];
          const counted = new Set<string>();
          for (const slot of slots.values()) {
            if (slot.texture) continue;
            counted.add(slot.content.id);
            lifetimes.push({ bytes: bytesOf(slot.content.kind), from: slot.born, to: slot.last });
          }
          for (const step of steps) {
            if (step.state !== 'run') continue;
            for (const port of step.group!.runWanted) {
              const own = step.keys!.raw[port];
              if (own && !counted.has(own.id)) lifetimes.push({ bytes: bytesOf(own.kind), from: step.index, to: step.index });
            }
          }
          const peak = outputPeak(lifetimes, steps.length);
          outputPeakBytes = peak.bytes;
          const report = pool.report();
          const lacking = peak.bytes + report.reservedBytes + report.pinnedBytes - report.budgetBytes;
          // The node at whose step the peak occurs; when that one cannot run anyway, the next that can.
          const at = lacking > 0 ? [...steps.slice(peak.step), ...steps.slice(0, peak.step)].find((step) => step.state !== 'blocked') : undefined;
          if (at) {
            for (const step of steps) {
              if (step.state === 'blocked') continue;
              step.state = 'blocked';
              if (step === at) {
                step.error = {
                  nodeId: at.node.nodeId, nodeType: at.node.instance.type, kind: 'budget',
                  message: budgetMessage(lacking, resolution, report.budgetBytes, 0, report.pinnedBytes),
                };
              } else {
                failed.set(step.node.nodeId, at.node.nodeId);
              }
            }
          }
        }

        // Step 7: the kernels of the nodes that will run, each once per device.
        const runners = steps.filter((step) => step.state === 'run');
        const compiled = await Promise.all(runners.map((step) =>
          Promise.all(step.node.def!.kernels.map((kernel) => parts.pipelines.compile(kernel))).then(() => null, (thrown: unknown) => ({ thrown }))));
        if (!halted()) {
          runners.forEach((step, i) => {
            const failure = compiled[i];
            if (!failure) return;
            step.state = 'blocked';
            step.error = nodeErrorFrom(failure.thrown, { id: step.node.nodeId, type: step.node.instance.type }, resolution, pool.report().budgetBytes);
          });
        }
      }

      // For eval-start: a node that reads one that will not run will not run either.
      const blocked = new Set<string>();
      for (const step of steps) {
        const { node } = step;
        if (step.state !== 'blocked' && node.inputs.some((input) => input.from !== null && blocked.has(input.from.node))) step.state = 'blocked';
        if (step.state === 'blocked') blocked.add(node.nodeId);
      }
      // A runner that will not run for a source of its own leaves the run to the next node of its key.
      for (const group of groups.values()) {
        if (group.entry || !group.runner || group.runner.state !== 'blocked' || group.runner.error) continue;
        const next = group.members.find((member) => member.state === 'cached' && member.needed);
        if (!next) continue;
        group.runner = next;
        next.state = 'run';
      }
      weights = nodeWeights(plan, new Set(steps.filter((s) => s.state !== 'run').map((s) => s.node.nodeId)), resolution, (id) => timings.get(id) ?? null);
      for (const weight of weights.values()) totalWeight += weight;

      // Step 8.
      emit({
        type: 'eval-start', requestId, resolution, mode, outputPeakBytes,
        plan: steps.map((step) => ({ nodeId: step.node.nodeId, state: step.state })),
      });

      let turned = performance.now();
      for (const step of steps) {
        const { node } = step;
        try {
          // 3.6 rule 5: the wait is a completed submission, never a timer.
          if (performance.now() - Math.max(turned, stream.observed) >= TURN_MS && deviceAlive(parts)) {
            await stream.barrier();
            turned = performance.now();
          }
          const why = halted();
          if (step.error) {
            fail(step, step.error);
            continue;
          }
          if (why) {
            skip(step, why);
            continue;
          }
          const forced = failed.get(node.nodeId);
          const source = node.inputs.find((input) => input.from !== null && failed.has(input.from.node));
          const upstream = node.upstream ?? forced ?? (source ? failed.get(source.from!.node)! : undefined);
          if (upstream !== undefined || !step.keys) {
            skip(step, 'upstream', upstream ?? node.nodeId);
            continue;
          }
          const group = step.group;
          if (group?.failed) {
            // The node of the same key that ran for this one failed, and this one would fail the same way.
            fail(step, { ...group.failed, nodeId: node.nodeId });
          } else if (group && step.needed && !group.entry && !group.published) {
            // 5.13: the first needed node of a key whose turn comes runs. That is the planned runner unless it
            // was skipped for a source the others do not read.
            group.runner = step;
            await runNode(step);
          } else {
            // A hit, a node whose key another node ran for, a bypassed node, or one that nothing needs.
            await finish(step, { cached: true, wallMs: () => 0, gpuMs: null, peakBytes: 0 });
          }
        } finally {
          releaseInputs(step);
          const read = step.reqs;
          step.reqs = [];
          for (const slot of read) unrequire(slot);
        }
      }

      // The result (5.2).
      if (!halted() && !staged) {
        targets.forEach((target, index) => {
          const step = stepOf.get('ref' in target ? target.ref.node : target.node)!;
          const slot = step.targets.get(index);
          if (slot?.texture && 'ref' in target && !failed.has(step.node.nodeId)) {
            fields[index] = createFieldHandle(parts, slot.texture, target.as ?? slot.content.kind) as AnyFieldHandle;
          }
        });
      }
    } finally {
      // 2.2: the evaluation's references end when it settles.
      for (const slot of [...slots.values()]) {
        if (slot.texture && deviceAlive(parts)) pool.drop(slot.texture);
        slot.texture = null;
      }
      slots.clear();
    }

    const status: EvaluateResult['status'] = flow.stop ?? (errors.length > 0 ? 'errors' : 'ok');
    if (transient !== null && !flow.stop) deps.cache.dropTransientBelow(requestId);
    if (withThumbnails && !flow.stop) {
      try {
        deps.thumbnails.poll(true);
      } catch {
        // As above: thumbnails never fail an evaluation.
      }
    }
    const wallMs = performance.now() - started;
    emit({ type: 'eval-end', requestId, status, wallMs });

    if (status === 'device-lost') {
      // 5.9 rule 6. An evaluation that found the device already lost says nothing about who was running when it went.
      if (aliveAtStart) {
        const was = flow.running;
        if (was && lostAt !== null && lostAt.nodeId === was.nodeId && lostAt.key === was.key) banned.set(was.nodeId, was.key);
        lostAt = was;
      }
      deps.onDeviceLost();
    }
    if (flow.rejection) throw flow.rejection.reason;
    return { requestId, status, fields, errors, timing: { wallMs, nodesRun, nodesCached } };
  }

  return {
    get lostAt() { return lostAt; },

    evaluate(doc, targets, opts) {
      let plan: EvalPlan;
      try {
        const { resolution, mode, requestId } = opts;
        if (!Number.isInteger(resolution) || resolution < 2 || resolution > 8192) {
          throw new TypeError(`evaluate(): the resolution is an integer 2 .. 8192, not ${String(resolution)}`);
        }
        if (mode !== 'preview' && mode !== 'build') throw new TypeError(`evaluate(): the mode is "preview" or "build", not "${String(mode)}"`);
        if (!Number.isInteger(requestId) || requestId <= lastRequestId) {
          throw new TypeError(`evaluate(): requestId ${String(requestId)} is not an integer greater than ${lastRequestId}, the last one used`);
        }
        if (!Array.isArray(targets)) throw new TypeError('evaluate(): the targets are a list');
        plan = buildPlan(doc, deps.registry, targets);
        lastRequestId = requestId;
      } catch (thrown) {
        return Promise.reject(thrown);
      }
      return exclusive(() => run(doc, targets, opts, plan));
    },

    async keys(doc) {
      const plan = buildPlan(doc, deps.registry, Object.keys(doc.nodes).map((node) => ({ node })));
      const { keys } = await computeKeys(plan, doc, deps.parts().files, tokens);
      const result = new Map<string, string>();
      for (const [nodeId, nodeKeys] of keys) result.set(nodeId, nodeKeys.contentKey);
      return result;
    },

    lastTiming: (nodeId) => timings.get(nodeId) ?? null,
    lostWhileIdle() {
      lostAt = null;
    },
    exclusive,
    idle: () => exclusive(noop),
  };
}
