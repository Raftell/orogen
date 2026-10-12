// What the session's tests share: a real engine on the process's device with a session on it, a renderer that
// records what the session tells it, a build function that evaluates through the engine, and one node that
// takes as long as its iteration count says, by running that many cheap passes. Not a test file.

import assert from 'node:assert/strict';
import { after } from 'node:test';

import { defineKernel, defineNode, type EvalContext, type Field } from '../../../src/core/api.ts';
import {
  createEngine, createRegistry, createSession,
  type BuildResult, type Engine, type EngineEvent, type EngineSession, type EngineTestHooks, type EvalTarget, type FileSource,
  type GpuContext, type GraphDoc, type MemoryReport, type NodeRegistry, type PickResult, type ProjectSettings,
  type SessionBuildOptions, type SliceOverrun, type ViewBinding, type ViewportContent, type ViewportRenderer, type ViewportSize,
} from '../../../src/core/runtime.ts';
import { constantNode, gainNode, makeDoc, memoryFiles, MIB, noCpu, tintNode, type MemoryFiles, type NodeSpec } from '../eval/rig.ts';
import { testGpu } from '../gpu/rig.ts';

export { MIB };

/** Preview at 257, drafts at 65 (d = 2) or 129 (d = 1), thumbnails at 129, builds at 513. */
export const SETTINGS: ProjectSettings = { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25 };
export const PREVIEW = 257;
export const THUMBNAIL = 129;
export const DRAFT = { 1: 129, 2: 65 } as const;

// ---- the slow node -------------------------------------------------------------------------------------------------

const stepKernel = defineKernel({
  name: 'test/session.step',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return h_at(px) + 1.0; }',
});

/** What the slow node calls while it runs. A test sets these, and clears them with resetSlow(). */
export const slow: {
  /** Before iteration `i` of the loop, with the context of the evaluation it runs in. */
  at?: (i: number, ctx: EvalContext) => void;
  /** evaluate() calls, by resolution. */
  readonly runs: Map<number, number>;
} = { runs: new Map() };

export function resetSlow(): void {
  delete slow.at;
  slow.runs.clear();
}

/** in + iterations, one cheap pass per iteration: its duration is real GPU work, and a test steps in at an iteration it names. */
export const slowNode = defineNode({
  type: 'ref/slow',
  title: 'Slow (Test)',
  category: 'ref',
  description: 'Adds 1 per iteration, one pass each.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'steps', type: 'field', role: 'data' }],
  params: [
    { kind: 'int', name: 'iterations', default: 64, min: 0, max: 1_000_000, help: 'How often to add 1.' },
    { kind: 'bool', name: 'lend', default: false, help: 'Lend the working state to the viewer.' },
  ],
  kernels: [stepKernel],
  async evaluate(ctx) {
    slow.runs.set(ctx.res, (slow.runs.get(ctx.res) ?? 0) + 1);
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    await ctx.loop(ctx.params.iterations, (i) => {
      slow.at?.(i, ctx);
      ctx.run(stepKernel, { in: { h: a }, out: { next: b } });
      [a, b] = [b, a];
    }, ctx.params.lend ? { preview: () => ({ out: a }) as { out: Field } } : {});
    ctx.output('out', a);
    if (ctx.wants('steps')) ctx.output('steps', ctx.alloc('field', { clear: ctx.params.iterations }));
  },
});

/** A field that holds the first byte of a file everywhere. */
export const fileNode = defineNode({
  type: 'ref/file-level',
  title: 'File Level (Test)',
  category: 'ref',
  description: 'Fills a field with the first byte of a file.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'file', name: 'file', default: '', filters: ['bin'], help: 'The file.' }],
  kernels: [],
  async evaluate(ctx) {
    const bytes = await ctx.readFile(ctx.params.file);
    ctx.output('out', ctx.alloc('field', { clear: bytes[0]! }));
  },
});

export const DEFS = [constantNode, gainNode, tintNode, slowNode, fileNode];
export const REGISTRY: NodeRegistry = createRegistry(DEFS);

export function doc(nodes: Readonly<Record<string, NodeSpec>>, view?: ViewBinding, settings: Partial<ProjectSettings> = {}): GraphDoc {
  const made = makeDoc(REGISTRY, nodes, { ...SETTINGS, ...settings });
  return view ? { ...made, ui: { view } } : made;
}

// ---- files that can be watched ---------------------------------------------------------------------------------------

export interface WatchedFiles extends MemoryFiles {
  /** The resolved paths that are being watched, sorted. */
  watching(): string[];
  /** Replaces the file and tells its watchers, as the platform's source does after a file changed on disk. */
  change(path: string, bytes: Uint8Array): void;
}

/** One clock for every source: a file's identity is its path, size and time (6.1 rule 5), and two sources of a test hold the same paths. */
let stamp = 1000;

export function watchedFiles(): WatchedFiles {
  const files = memoryFiles();
  const put = files.put.bind(files);
  const watchers = new Map<string, Set<() => void>>();
  return Object.assign(files, {
    put: (path: string, bytes: Uint8Array, mtimeMs?: number): void => put(path, bytes, mtimeMs ?? ++stamp),
    watch(path: string, onChange: () => void): () => void {
      const resolved = files.resolve(path);
      let set = watchers.get(resolved);
      if (!set) watchers.set(resolved, set = new Set());
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) watchers.delete(resolved);
      };
    },
    watching: () => [...watchers.keys()].sort(),
    change(path: string, bytes: Uint8Array): void {
      files.put(path, bytes);
      for (const onChange of [...(watchers.get(files.resolve(path)) ?? [])]) onChange();
    },
  });
}

// ---- the recording renderer ----------------------------------------------------------------------------------------

export type RendererCall =
  | { readonly call: 'init'; readonly gpu: GpuContext }
  | { readonly call: 'setContent'; readonly content: ViewportContent | null }
  | { readonly call: 'attach'; readonly canvas: unknown; readonly size: ViewportSize }
  | { readonly call: 'detach' | 'dispose' }
  | { readonly call: 'resize' | 'setCamera' | 'setDisplay'; readonly value: unknown }
  | { readonly call: 'pick'; readonly x: number; readonly y: number };

export interface RecordingRenderer extends ViewportRenderer {
  readonly calls: RendererCall[];
  /** What the session last told it to draw. */
  readonly content: ViewportContent | null;
  /** How often setContent was called. */
  readonly switches: number;
}

/** Bytes the renderer registers with the ledger at every init, as a real one registers its own textures (7.5 rule 4). */
export const RENDERER_BYTES = 4096;

export function recordingRenderer(): RecordingRenderer {
  const calls: RendererCall[] = [];
  let content: ViewportContent | null = null;
  let switches = 0;
  let reservation: { release(): void } | null = null;
  let gpuOfReservation: GpuContext | null = null;
  return {
    calls,
    get content() { return content; },
    get switches() { return switches; },
    init(gpu, ledger) {
      calls.push({ call: 'init', gpu });
      // What was registered on a lost device went with its ledger.
      if (reservation && gpuOfReservation && !gpuOfReservation.lost) reservation.release();
      reservation = ledger.reserve(RENDERER_BYTES, 'recording renderer');
      gpuOfReservation = gpu;
    },
    setContent(next) {
      // A real renderer binds the views at once (7.5 rule 2); a view of a released handle would throw here as it would there.
      for (const ref of [next?.height, next?.overlay?.texture]) {
        if (ref) assert.ok(ref.view && ref.width > 0 && ref.height > 0, 'a bound texture has a view and a size');
      }
      content = next;
      switches++;
      calls.push({ call: 'setContent', content: next });
    },
    attach(canvas, size) { calls.push({ call: 'attach', canvas, size }); },
    detach() { calls.push({ call: 'detach' }); },
    resize(size) { calls.push({ call: 'resize', value: size }); },
    setCamera(camera) { calls.push({ call: 'setCamera', value: camera }); },
    setDisplay(display) { calls.push({ call: 'setDisplay', value: display }); },
    async pick(x, y): Promise<PickResult | null> {
      calls.push({ call: 'pick', x, y });
      return x < 0 ? null : { uv: [x / 100, y / 100], height: 0.5, position: [x, y, 512] };
    },
    dispose() {
      calls.push({ call: 'dispose' });
      if (reservation && gpuOfReservation && !gpuOfReservation.lost) reservation.release();
      reservation = null;
    },
  };
}

// ---- the build function ----------------------------------------------------------------------------------------------

export interface BuildLog {
  /** Every call the session made, with what each delivered target held. */
  readonly calls: { readonly requestId: number; readonly outDir: string; readonly resolution: number; readonly means: (number | null)[] }[];
  /** Called when a target has been delivered, before the evaluation goes on. */
  onTarget?: (index: number) => void | Promise<void>;
  /** What the next call does instead of building. */
  rejectWith?: unknown;
}

/**
 * The build the session is handed in these tests: one evaluation in build mode with staged delivery, as
 * buildProject makes it (export-unreal.md 3.2), that measures each target where the real one would write a file.
 */
export function buildFunction(log: BuildLog, targets: (doc: GraphDoc) => EvalTarget[]) {
  return async (engine: Engine, o: SessionBuildOptions): Promise<BuildResult> => {
    if (log.rejectWith !== undefined) {
      const reason = log.rejectWith;
      delete log.rejectWith;
      throw reason;
    }
    const resolution = o.doc.settings.buildResolution;
    const call = { requestId: o.requestId, outDir: o.outDir, resolution, means: [] as (number | null)[] };
    log.calls.push(call);
    const wanted = targets(o.doc);
    const result = await engine.evaluate(o.doc, wanted, {
      resolution, mode: 'build', requestId: o.requestId, signal: o.signal, onEvent: o.onEvent,
      onTarget: async (index, field) => {
        call.means[index] = field?.kind === 'field' ? (await engine.stats(field)).mean : null;
        o.onEvent({ type: 'build-progress', requestId: o.requestId, phase: 'targets', fraction: (index + 1) / wanted.length });
        await log.onTarget?.(index);
      },
    });
    const built: BuildResult = {
      requestId: o.requestId, status: result.status, problems: [], files: [], manifest: null, report: null, outDir: o.outDir,
    };
    o.onEvent({ type: 'build-result', requestId: o.requestId, result: built });
    return built;
  };
}

// ---- the session -----------------------------------------------------------------------------------------------------

type EventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export interface SessionRig {
  readonly engine: Engine;
  readonly session: EngineSession;
  readonly renderer: RecordingRenderer;
  readonly builds: BuildLog;
  /** Every event the session emitted, in order. */
  readonly events: EngineEvent[];
  /** The next event of this type, from where the last call of next() or mark() left off, that `match` accepts. */
  next<T extends EngineEvent['type']>(type: T, match?: (e: EventOf<T>) => boolean): Promise<EventOf<T>>;
  /** Forgets everything recorded so far for next(): it waits for events from now on. */
  mark(): number;
  /** The events of this type, from index `from` of `events`. */
  of<T extends EngineEvent['type']>(type: T, from?: number): EventOf<T>[];
  /** Resolves when the session has asked nothing of the engine that is not answered, and a turn of the event loop passed without an event. */
  idle(): Promise<void>;
  memory(): MemoryReport;
  dispose(): Promise<void>;
  /** The ledger just before the engine was disposed, with the cache and the free lists emptied: what was still held. */
  readonly atDispose: MemoryReport | null;
  /** Tells the session what the engine tells it when a slice measures above the hard ceiling (runtime.md 3.5). */
  overrun(slice: SliceOverrun): void;
}

export interface SessionSetup {
  readonly gpu?: GpuContext;
  readonly hooks?: EngineTestHooks;
  readonly budgetBytes?: number;
  readonly renderer?: RecordingRenderer | null;
  readonly reopenGpu?: () => Promise<GpuContext>;
  readonly files?: FileSource;
  readonly createFiles?: (path: string | null) => FileSource;
  /** The targets of a build; default: the output `out` of the node `out`. */
  readonly buildTargets?: (doc: GraphDoc) => EvalTarget[];
  /** Called with the session before anything else subscribes to it. */
  readonly first?: (session: EngineSession) => void;
}

/** What a session of this file left in the pool when it was disposed (testing.md 2.8). A leak fails the file, whichever test made it. */
const leaks: string[] = [];
after(() => {
  assert.deepEqual(leaks, [], 'every session left its pool empty at dispose');
});

/** A wait that no event ends is a failure to describe, not to sit through until the runner's own limit. */
const BACKSTOP_MS = 120_000;

export async function startSession(setup: SessionSetup = {}): Promise<SessionRig> {
  const gpu = setup.gpu ?? await testGpu();
  const real = await createEngine({
    gpu, registry: REGISTRY, cpu: noCpu,
    files: setup.files ?? memoryFiles(),
    budgetBytes: setup.budgetBytes ?? 512 * MIB,
    ...(setup.hooks ? { test: setup.hooks } : {}),
  });

  let atDispose: MemoryReport | null = null;
  const overrunListeners = new Set<(slice: SliceOverrun) => void>();
  // What the session has asked of the engine and not yet got back, for idle().
  let inFlight = 0;
  let settled: (() => void)[] = [];
  const counted = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    inFlight++;
    return call(...args).finally(() => {
      inFlight--;
      for (const wake of settled.splice(0)) wake();
    });
  };
  // The session's engine is the real one seen through its calls. It disposes its engine; the ledger is read
  // just before, with the cache and the free lists emptied, for the leak check (testing.md 2.8).
  const engine: Engine = Object.create(real, {
    evaluate: { value: counted(real.evaluate.bind(real)) },
    keys: { value: counted(real.keys.bind(real)) },
    stats: { value: counted(real.stats.bind(real)) },
    onOverrun: {
      value: (listener: (slice: SliceOverrun) => void): (() => void) => {
        overrunListeners.add(listener);
        const off = real.onOverrun(listener);
        return () => {
          overrunListeners.delete(listener);
          off();
        };
      },
    },
    trim: { value: counted(real.trim.bind(real)) },
    replaceDevice: { value: counted(real.replaceDevice.bind(real)) },
    dispose: {
      value: counted(async (): Promise<void> => {
        if (!real.gpu.lost) {
          await real.trim();
          atDispose = real.memory();
        }
        await real.dispose();
      }),
    },
  }) as Engine;

  const renderer = setup.renderer === undefined ? recordingRenderer() : setup.renderer;
  const builds: BuildLog = { calls: [] };
  const session = createSession({
    engine,
    reopenGpu: setup.reopenGpu ?? (() => Promise.reject(new Error('This test has no second device'))),
    createFiles: setup.createFiles ?? (() => memoryFiles()),
    build: buildFunction(builds, setup.buildTargets ?? (() => [{ ref: { node: 'out', port: 'out' } }])),
    renderer,
  });

  setup.first?.(session);
  const events: EngineEvent[] = [];
  let cursor = 0;
  let waiter: (() => void) | null = null;
  session.subscribe((e) => {
    events.push(e);
    waiter?.();
  });

  const next: SessionRig['next'] = (type, match) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiter = null;
      reject(new Error(`No "${type}" event arrived. The last events: ${events.slice(-12).map((e) => e.type).join(', ')}`));
    }, BACKSTOP_MS);
    const look = (): void => {
      while (cursor < events.length) {
        const e = events[cursor++]!;
        if (e.type === type && (!match || match(e as EventOf<typeof type>))) {
          clearTimeout(timer);
          waiter = null;
          resolve(e as EventOf<typeof type>);
          return;
        }
      }
      waiter = look;
    };
    look();
  });

  let disposed = false;
  return {
    engine: real, session, renderer: renderer as RecordingRenderer, builds, events, next,
    mark: () => (cursor = events.length),
    of: (type, from = 0) => events.slice(from).filter((e): e is EventOf<typeof type> => e.type === type),
    async idle() {
      // Bounded: a session that never rests fails the test instead of hanging it.
      for (let turn = 0; turn < 100_000; turn++) {
        if (inFlight > 0) {
          await new Promise<void>((resolve) => settled.push(resolve));
          continue;
        }
        // What a settled call leads to is started in its continuation, which has run when the event loop comes round.
        const before = events.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (inFlight === 0 && events.length === before) return;
      }
      assert.fail('the session did not come to rest');
    },
    memory: () => real.memory(),
    get atDispose() { return atDispose; },
    overrun: (slice) => { for (const listener of [...overrunListeners]) listener(slice); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await session.dispose();
      const left = atDispose as MemoryReport | null;
      if (left && left.workingBytes + left.pinnedBytes + left.cacheBytes + left.freeBytes !== 0) leaks.push(JSON.stringify(left));
    },
  };
}

/** The node-level story of one request: how each node ended, in the order of the events. */
export function endings(events: readonly EngineEvent[], requestId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of events) {
    if (!('requestId' in e) || e.requestId !== requestId) continue;
    if (e.type === 'node-done') out[e.nodeId] = e.cached ? 'cached' : 'run';
    else if (e.type === 'node-error') out[e.error.nodeId] = `error:${e.error.kind}`;
    else if (e.type === 'node-skipped') out[e.nodeId] = `skipped:${e.reason}`;
  }
  return out;
}

/** The types of the events of one request, in order, without the progress events, whose number depends on the clock. */
export function story(events: readonly EngineEvent[], requestId: number): string[] {
  return events
    .filter((e) => 'requestId' in e && e.requestId === requestId && e.type !== 'node-progress' && e.type !== 'eval-progress' && e.type !== 'node-preview')
    .map((e) => ('nodeId' in e ? `${e.type} ${e.nodeId}` : e.type === 'node-error' ? `${e.type} ${e.error.nodeId}` : e.type));
}
