// What the evaluator's tests share: an engine made directly on the process's device (the harness of
// tests/helpers is a later stage), documents written as literals, and a few nodes. Not a test file.

import assert from 'node:assert/strict';

import { defineKernel, defineNode, MASK_INPUT, type NodeDef } from '../../../src/core/api.ts';
import type { GpuContext } from '../../../src/core/gpu/device.ts';
import type { SliceReport } from '../../../src/core/gpu/stream.ts';
import {
  createEngine, createRegistry, FileError,
  type AnyFieldHandle, type CpuRunner, type Engine, type EngineTestHooks, type EvalEvent, type EvalTarget, type EvaluateOptions,
  type EvaluateResult, type FileSource, type GraphDoc, type NodeRegistry, type ProjectSettings,
} from '../../../src/core/runtime.ts';
import { testGpu } from '../gpu/rig.ts';

export const SETTINGS: ProjectSettings = { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25 };
export const MIB = 1048576;

// ---- documents -------------------------------------------------------------------------------------------------

export interface NodeSpec {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** input port → '<node id>.<output port>'. */
  readonly inputs?: Readonly<Record<string, string>>;
  readonly bypass?: boolean;
  readonly version?: number;
}

const portRef = (text: string): { node: string; port: string } => {
  const dot = text.indexOf('.');
  return { node: text.slice(0, dot), port: text.slice(dot + 1) };
};

/** A document as a file would hold it: the ids are the keys of `nodes`, the edges are numbered in order. */
export function makeDoc(registry: NodeRegistry, nodes: Readonly<Record<string, NodeSpec>>, settings: Partial<ProjectSettings> = {}): GraphDoc {
  const doc = {
    format: 'orogen' as const, version: 1 as const, settings: { ...SETTINGS, ...settings },
    nodes: {} as Record<string, GraphDoc['nodes'][string]>, edges: {} as Record<string, GraphDoc['edges'][string]>, groups: {}, ui: {},
  };
  let edge = 0;
  for (const [id, spec] of Object.entries(nodes)) {
    doc.nodes[id] = {
      id, type: spec.type, version: spec.version ?? registry.get(spec.type)?.version ?? 1, position: { x: 0, y: 0 },
      params: { ...spec.params }, ...(spec.bypass ? { bypass: true } : {}),
    };
    for (const [port, from] of Object.entries(spec.inputs ?? {})) {
      const edgeId = `e${++edge}`;
      doc.edges[edgeId] = { id: edgeId, from: portRef(from), to: { node: id, port } };
    }
  }
  return doc;
}

/** '<node>.<port>' is an output, '<node>.<port>:color' that output delivered as a colour, '<node>' the node itself. */
export function target(text: string): EvalTarget {
  if (!text.includes('.')) return { node: text };
  const [ref, as] = text.split(':');
  return as === undefined ? { ref: portRef(ref!) } : { ref: portRef(ref!), as: as as 'field' | 'color' };
}

// ---- files and CPU -----------------------------------------------------------------------------------------------

export interface MemoryFiles extends FileSource {
  put(path: string, bytes: Uint8Array, mtimeMs?: number): void;
  remove(path: string): void;
  /** Every path that was read, in order. */
  readonly reads: string[];
}

/** A FileSource over a table, for file identity (runtime.md 6.1): every path is absolute under /mem/. */
export function memoryFiles(): MemoryFiles {
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  let clock = 1;
  const resolve = (path: string): string => {
    if (path === '') throw new FileError('invalid-path', path, 'The file path is empty');
    return path.startsWith('/') ? path : `/mem/${path}`;
  };
  const reads: string[] = [];
  return {
    reads,
    resolve,
    async stat(path) {
      const file = files.get(resolve(path));
      return file ? { size: file.bytes.length, mtimeMs: file.mtimeMs } : null;
    },
    async read(path) {
      const file = files.get(resolve(path));
      if (!file) throw new FileError('not-found', resolve(path), `File not found: ${resolve(path)}`);
      reads.push(resolve(path));
      return new Uint8Array(file.bytes);
    },
    put(path, bytes, mtimeMs) {
      files.set(resolve(path), { bytes, mtimeMs: mtimeMs ?? clock++ });
    },
    remove(path) {
      files.delete(resolve(path));
    },
  };
}

/** For the engines whose nodes start no CPU task. */
export const noCpu: CpuRunner = {
  run: () => Promise.reject(new Error('This test engine has no CPU worker')),
  dispose: async () => undefined,
};

// ---- the engine ----------------------------------------------------------------------------------------------------

export interface RunOutcome {
  readonly result: EvaluateResult;
  readonly events: readonly EvalEvent[];
  /** The contents of each delivered target, read back; null where no field was delivered. */
  readonly data: readonly (Float32Array | null)[];
}

export interface TestEngine {
  readonly engine: Engine;
  readonly gpu: GpuContext;
  readonly registry: NodeRegistry;
  /** Every slice that has completed, in order. */
  readonly slices: SliceReport[];
  doc(nodes: Readonly<Record<string, NodeSpec>>, settings?: Partial<ProjectSettings>): GraphDoc;
  /** One evaluation. Targets are read back and their handles released. Defaults: resolution 65, preview, thumbnails off. */
  run(doc: GraphDoc, targets: readonly string[], opts?: Partial<EvaluateOptions>): Promise<RunOutcome>;
  /** As run(), with the handles left to the caller. */
  evaluate(doc: GraphDoc, targets: readonly string[], opts?: Partial<EvaluateOptions>): Promise<{ result: EvaluateResult; events: EvalEvent[] }>;
  nextRequestId(): number;
  /** testing.md 2.8: nothing is WORKING and nothing is pinned. */
  noLeaks(): void;
  dispose(): Promise<void>;
}

export interface EngineSetup {
  readonly hooks?: EngineTestHooks;
  readonly budgetBytes?: number;
  readonly files?: FileSource;
  readonly cpu?: CpuRunner;
  readonly gpu?: GpuContext;
}

export async function startEngine(defs: readonly NodeDef[], setup: EngineSetup = {}): Promise<TestEngine> {
  const gpu = setup.gpu ?? await testGpu();
  const registry = createRegistry(defs);
  const slices: SliceReport[] = [];
  const engine = await createEngine({
    gpu, registry,
    files: setup.files ?? memoryFiles(),
    cpu: setup.cpu ?? noCpu,
    budgetBytes: setup.budgetBytes ?? 256 * MIB,
    test: { poisonRecycled: true, ...setup.hooks, onSlice: (s) => { slices.push(s); setup.hooks?.onSlice?.(s); } },
  });
  let requestId = 0;

  const evaluate: TestEngine['evaluate'] = async (doc, targets, opts = {}) => {
    const events: EvalEvent[] = [];
    const result = await engine.evaluate(doc, targets.map(target), {
      resolution: 65, mode: 'preview', thumbnails: false, requestId: ++requestId, ...opts,
      onEvent: (e) => { events.push(e); opts.onEvent?.(e); },
    });
    return { result, events };
  };

  return {
    engine, gpu, registry, slices, evaluate,
    doc: (nodes, settings) => makeDoc(registry, nodes, settings),
    nextRequestId: () => ++requestId,
    async run(doc, targets, opts) {
      const { result, events } = await evaluate(doc, targets, opts);
      const data: (Float32Array | null)[] = [];
      for (const field of result.fields) {
        data.push(field ? await engine.read(field) : null);
        field?.release();
      }
      return { result, events, data };
    },
    noLeaks() {
      const memory = engine.memory();
      assert.equal(memory.workingBytes, 0, `nothing is WORKING: ${JSON.stringify(memory)}`);
      assert.equal(memory.pinnedBytes, 0, `nothing is pinned: ${JSON.stringify(memory)}`);
    },
    dispose: () => engine.dispose(),
  };
}

// ---- reading results ---------------------------------------------------------------------------------------------

type EventOf<T extends EvalEvent['type']> = Extract<EvalEvent, { type: T }>;
export function eventsOf<T extends EvalEvent['type']>(events: readonly EvalEvent[], type: T): EventOf<T>[] {
  return events.filter((e): e is EventOf<T> => e.type === type);
}

/** How each node of the evaluation ended: 'run', 'cached', 'error:<kind>' or 'skipped:<reason>'. */
export function endings(events: readonly EvalEvent[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'node-done') out[e.nodeId] = e.cached ? 'cached' : 'run';
    else if (e.type === 'node-error') out[e.error.nodeId] = `error:${e.error.kind}`;
    else if (e.type === 'node-skipped') out[e.nodeId] = `skipped:${e.reason}`;
  }
  return out;
}

/** The value every float of `data` has, when they are all equal within `tolerance`; else a description of the first that differs. */
export function uniform(data: Float32Array | null | undefined, tolerance = 0): number | string {
  if (!data || data.length === 0) return 'no data';
  const first = data[0]!;
  for (let i = 1; i < data.length; i++) {
    if (!(Math.abs(data[i]! - first) <= tolerance)) return `float ${i} is ${data[i]}, the first is ${first}`;
  }
  return first;
}

/** Asserts that every float of `data` is `value` within `tolerance`, without handing the data to an assertion. */
export function assertUniform(data: Float32Array | null | undefined, value: number, message: string, tolerance = 1e-6): void {
  const found = uniform(data, 0);
  if (typeof found === 'string') assert.fail(`${message}: ${found}`);
  assert.ok(Math.abs(found - value) <= tolerance, `${message}: every float is ${found}, expected ${value}`);
}

/** Largest absolute difference between `data` and `expected(index)`, and where; lists are never compared as a whole. */
export function worst(data: Float32Array, expected: (index: number) => number): { readonly difference: number; readonly index: number } {
  let difference = 0, index = -1;
  for (let i = 0; i < data.length; i++) {
    const d = Math.abs(data[i]! - expected(i));
    if (!(d <= difference)) {
      difference = d;
      index = i;
    }
  }
  return { difference, index };
}

// ---- nodes ---------------------------------------------------------------------------------------------------------

/** evaluate() calls, by node type. A test reads and resets it. */
export const calls = new Map<string, number>();
const called = (type: string): void => void calls.set(type, (calls.get(type) ?? 0) + 1);

const constantKernel = defineKernel({
  name: 'test/constant',
  outputs: { out: 'field' },
  params: { value: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return P.value; }',
});

/** A field that holds `value` everywhere. */
export const constantNode = defineNode({
  type: 'ref/constant',
  title: 'Constant (Test)',
  category: 'ref',
  description: 'Fills a field with one value.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'float', name: 'value', unit: 'none', default: 0.5, min: -100, max: 100, help: 'The value of every texel.' }],
  kernels: [constantKernel],
  evaluate(ctx) {
    called('ref/constant');
    const out = ctx.alloc('field');
    ctx.run(constantKernel, { out: { out }, params: { value: ctx.params.value } });
    ctx.output('out', out);
  },
});

const rampKernel = defineKernel({
  name: 'test/ramp',
  outputs: { out: 'field' },
  params: { gain: 'vec2f', base: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return dot(uv, P.gain) + P.base; }',
});

/** u * gainX + v * gainY + base. */
export const rampNode = defineNode({
  type: 'ref/ramp',
  title: 'Ramp (Test)',
  category: 'ref',
  description: 'A plane over the terrain.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'float', name: 'gainX', unit: 'none', default: 1, min: -100, max: 100, help: 'Slope along X.' },
    { kind: 'float', name: 'gainY', unit: 'none', default: 0, min: -100, max: 100, help: 'Slope along Y.' },
    { kind: 'float', name: 'base', unit: 'none', default: 0, min: -100, max: 100, help: 'Value at the origin.' },
  ],
  kernels: [rampKernel],
  evaluate(ctx) {
    called('ref/ramp');
    const out = ctx.alloc('field');
    ctx.run(rampKernel, { out: { out }, params: { gain: [ctx.params.gainX, ctx.params.gainY], base: ctx.params.base } });
    ctx.output('out', out);
  },
});

const tintKernel = defineKernel({
  name: 'test/tint',
  outputs: { out: 'color' },
  params: { rgba: 'vec4f' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return P.rgba; }',
});

/** A colour field that holds one colour everywhere. */
export const tintNode = defineNode({
  type: 'ref/tint',
  title: 'Tint (Test)',
  category: 'ref',
  description: 'Fills a colour field with one colour.',
  inputs: [],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    { kind: 'color', name: 'tint', default: [0.25, 0.5, 0.75], help: 'The colour of every texel.' },
    { kind: 'float', name: 'alpha', unit: 'ratio', default: 1, min: 0, max: 1, help: 'The alpha of every texel.' },
  ],
  kernels: [tintKernel],
  evaluate(ctx) {
    called('ref/tint');
    const out = ctx.alloc('color');
    ctx.run(tintKernel, { out: { out }, params: { rgba: [...ctx.params.tint, ctx.params.alpha] } });
    ctx.output('out', out);
  },
});

const gainKernel = defineKernel({
  name: 'test/gain',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { gain: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px) * P.gain; }',
});

/** in * gain. Maskable. */
export const gainNode = defineNode({
  type: 'ref/gain',
  title: 'Gain (Test)',
  category: 'ref',
  description: 'Multiplies a field by a factor.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'float', name: 'gain', unit: 'none', default: 2, min: -100, max: 100, help: 'The factor.' }],
  kernels: [gainKernel],
  maskable: true,
  evaluate(ctx) {
    called('ref/gain');
    const out = ctx.alloc('field');
    ctx.run(gainKernel, { in: { src: ctx.input('in') }, out: { out }, params: { gain: ctx.params.gain } });
    ctx.output('out', out);
  },
});

const sumKernel = defineKernel({
  name: 'test/sum',
  inputs: { a: 'field', b: { kind: 'field', default: 0 }, mask: MASK_INPUT },
  outputs: { out: 'field' },
  cost: 3,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return (a_at(px) + b_at(px)) * mask_at(px); }',
});

/** a + b; b is optional and counts as 0. */
export const sumNode = defineNode({
  type: 'ref/sum',
  title: 'Sum (Test)',
  category: 'ref',
  description: 'Adds two fields.',
  inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [sumKernel],
  evaluate(ctx) {
    called('ref/sum');
    const out = ctx.alloc('field');
    ctx.run(sumKernel, { in: { a: ctx.input('a'), b: ctx.input('b') }, out: { out } });
    ctx.output('out', out);
  },
});

/** Delivered handles of a result, for tests that keep them. */
export function handles(result: EvaluateResult): AnyFieldHandle[] {
  return result.fields.filter((f): f is AnyFieldHandle => f !== null);
}
