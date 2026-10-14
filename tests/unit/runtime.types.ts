// Type-level tests of the shapes runtime.md promises to code outside core: documents as immer drafts, the
// registry, the session and its injected build function, handles, events and transfer lists. `npm run check`
// is the test, as for inference.types.ts. This file is compiled and never run.

import { MessageChannel, parentPort, type Worker } from 'node:worker_threads';
import type { Draft } from 'immer';
import type { NodeDef } from '../../src/core/api.ts';
import { nodes } from '../../src/core/nodes/index.ts';
import {
  addNode, connect, createRegistry, createSession, serveCpuTasks, setParam, setView, viewAfterSelect,
  type AnyFieldHandle, type BuildEvent, type BuildPlan, type BuildResult, type CpuRunner, type CpuTaskReply, type CpuTaskRequest,
  type DocDraft, type Engine, type EngineEvent, type EvalEvent, type FieldHandle, type FileSink, type FileSource,
  type GpuContext, type GraphDoc, type NodeRegistry, type PortRef, type SessionBuildOptions, type ViewportRenderer,
} from '../../src/core/runtime.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectType<A, B>(...ok: Equal<A, B> extends true ? [] : ['types differ', A, B]): void;

// ---- 4.6: DocDraft and immer's Draft<GraphDoc> are the same type in both directions --------------------------
declare const immerDraft: Draft<GraphDoc>;
declare const coreDraft: DocDraft;
export const toCore: DocDraft = immerDraft;
export const toImmer: Draft<GraphDoc> = coreDraft;

declare const doc: GraphDoc;
declare const ref: PortRef;
export function recipe(d: Draft<GraphDoc>, registry: NodeRegistry): void {
  const a = addNode(d, registry, 'ref/fbm', { x: 0, y: 0 });
  const b = addNode(d, registry, 'ref/talus', { x: 200, y: 0 });
  connect(d, registry, { node: a, port: 'out' }, { node: b, port: 'in' });
  setParam(d, registry, b, 'reach', 0.05);
  setView(d, viewAfterSelect(doc, registry, ref) ?? null);
}

// ---- 5.1: one explicit registry, made from a list ---------------------------------------------------------------
expectType<typeof nodes, readonly NodeDef[]>();
export const registry: NodeRegistry = createRegistry(nodes);
expectType<ReturnType<NodeRegistry['get']>, NodeDef | undefined>();

// ---- 7.1: the session receives the build as a function ----------------------------------------------------------
// export-unreal.md 3.1, as printed there for src/export/.
interface BuildOptions {
  readonly doc: GraphDoc;
  readonly sink: FileSink;
  readonly requestId: number;
  readonly resolution?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (e: EvalEvent | BuildEvent) => void;
}
interface FolderBuildOptions extends Omit<BuildOptions, 'sink'> {
  readonly outDir: string;
  readonly createSink: (absDir: string) => FileSink;
}
declare function buildToFolder(engine: Engine, opts: FolderBuildOptions): Promise<BuildResult>;
declare function planBuild(doc: GraphDoc, registry: NodeRegistry, opts?: { resolution?: number }): BuildPlan;
declare function buildProject(engine: Engine, opts: BuildOptions): Promise<BuildResult>;
declare function NodeFileSink(rootFolder: string): FileSink;

declare const engine: Engine;
declare const reopenGpu: () => Promise<GpuContext>;
declare const createFiles: (projectPath: string | null) => FileSource;
declare const renderer: ViewportRenderer;

export const session = createSession({
  engine, reopenGpu, createFiles, renderer,
  build: (e, o) => buildToFolder(e, { ...o, createSink: NodeFileSink }),      // runtime.md 7.1, as the engine worker writes it
  plan: (e, d) => planBuild(d, e.registry),
});
export const headless = createSession({
  engine, reopenGpu, createFiles, renderer: null,
  build: (e, o: SessionBuildOptions) => buildProject(e, { doc: o.doc, requestId: o.requestId, signal: o.signal, onEvent: o.onEvent, sink: NodeFileSink(o.outDir) }),
  plan: (e, d) => planBuild(d, e.registry),
});
// @ts-expect-error  the build function is required
createSession({ engine, reopenGpu, createFiles, renderer, plan: (e, d) => planBuild(d, e.registry) });
// @ts-expect-error  and so is the planner: the session imports neither from src/export/
createSession({ engine, reopenGpu, createFiles, renderer, build: (e, o) => buildToFolder(e, { ...o, createSink: NodeFileSink }) });
// A plan crosses the session as the plain data it is, and is asked for with a document alone.
export const planned: Promise<BuildPlan> = session.plan(doc);
// @ts-expect-error  a plan is of a document, not of a build request
void session.plan({ doc, outDir: '/out' });
// @ts-expect-error  the session takes no sink factory
createSession({ engine, reopenGpu, createFiles, renderer, build: buildToFolder as never, createSink: NodeFileSink });
// @ts-expect-error  a build function has no registry of its own: it reads engine.registry
export const withRegistry: BuildOptions = { doc, sink: NodeFileSink(''), requestId: 1, registry };
expectType<Engine['registry'], NodeRegistry>();

// ---- 2.2, 5.2: delivered handles narrow by kind (export-unreal.md 3.4) ------------------------------------------
export async function stage(handle: AnyFieldHandle): Promise<void> {
  // @ts-expect-error  statistics need a field: test `kind` first
  await engine.stats(handle);
  if (handle.kind !== 'field') throw new Error('expected a field');
  expectType<typeof handle, FieldHandle<'field'>>();
  const s = await engine.stats(handle);
  const band = await engine.read(handle, [0, 16]);
  // 6.3: what the engine hands out is typed over ArrayBuffer, so `[band.buffer]` is a transfer list
  structuredClone({ band }, { transfer: [band.buffer] });
  void s.nonFinite;
}

// ---- 6.3: the worker side and a runner on the real Node types ---------------------------------------------------
serveCpuTasks(parentPort!);
serveCpuTasks(new MessageChannel().port1);
declare const worker: Worker;
export const runner: Pick<CpuRunner, 'run'> = {
  async run(task, args, transfer, opts) {
    const request: CpuTaskRequest = { id: 1, task, args };
    worker.postMessage(request, [...transfer]);
    worker.on('message', (reply: CpuTaskReply) => {
      if (reply.type === 'progress') opts.onProgress(reply.fraction);
    });
    opts.signal.addEventListener('abort', () => void worker.terminate());
    return undefined;
  },
};

// ---- 7.7: every event narrows by `type`, and the union is closed -------------------------------------------------
export function describe(e: EngineEvent): string {
  switch (e.type) {
    case 'eval-start': return e.plan.map((p) => p.nodeId).join();
    case 'node-start': return e.nodeId;
    case 'node-progress': return `${e.nodeId} ${e.fraction}`;
    case 'node-preview': return e.ports.join();
    case 'node-done': return `${e.wallMs} at ${e.resolution}`;
    case 'node-error': return e.error.message;
    case 'node-skipped': return e.reason;
    case 'eval-progress': return `${e.fraction}`;
    case 'eval-end': return e.status;
    case 'build-plan': return e.plan.name;
    case 'build-target': return e.label;
    case 'build-progress': return e.phase;
    case 'build-problem': return e.problem.code;
    case 'build-result': return `${e.result.status} ${e.result.peakPoolBytes ?? 'nothing evaluated'}`;
    case 'request-start': return e.purpose;
    case 'keys': return Object.keys(e.keys).join();
    case 'view-updated': return `${e.revision}`;
    case 'thumbnail': return e.contentKey;
    case 'memory': return `${e.budgetBytes}`;
    case 'build-start': return e.outDir;
    case 'build-end': return e.status;
    case 'device-ready': return `${e.epoch}`;
    case 'device-lost': return e.reason;
    case 'engine-error': return e.message;
    default: { const never: never = e; return never; }
  }
}
