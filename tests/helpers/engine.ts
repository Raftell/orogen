import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { NodeDef } from '../../src/core/api.ts';
import { nodes as refNodes } from '../../src/core/nodes/ref/index.ts';
import {
  createEngine, createRegistry,
  type Engine, type EngineTestHooks, type FileSource, type GpuContext, type NodeRegistry, type ProjectSettings,
} from '../../src/core/runtime.ts';
import { createNodeCpuRunner } from '../../src/platform/node/cpu.ts';
import { NodeFileSource } from '../../src/platform/node/files.ts';
import { createNodeGpu } from '../../src/platform/node/gpu.ts';
import { harnessSources } from './source-node.ts';

export type Slices = 'auto' | 'small' | 'one';

export interface TestEngine {
  readonly gpu: GpuContext;        // gpu.profile; gpu.caps.software, .compactFormats, .adapter
  readonly engine: Engine;         // for tests/engine, tests/export and tests/graphs
}

export const TEST_SETTINGS: ProjectSettings = {
  terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25,
};

export const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TESTS_FOLDER = path.join(REPOSITORY, 'tests');
/** The budget of every engine the harness creates (testing.md 2.1). */
export const BUDGET_BYTES = 1_073_741_824;

// The process environment selects the device and the output folder. It is read once, here.
const ENVIRONMENT = {
  profile: process.env.OROGEN_GPU_PROFILE || 'core',
  adapter: process.env.OROGEN_GPU_ADAPTER || undefined,
  output: path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(REPOSITORY, 'test-output')),
};

/** OROGEN_TEST_OUTPUT, else `test-output`, as an absolute path. */
export function outputFolder(): string {
  return ENVIRONMENT.output;
}

/** The files a harness engine reads from unless a call says otherwise: those under tests/. */
export const TEST_FILES: FileSource = NodeFileSource(TESTS_FOLDER);

// ---- the registry ----------------------------------------------------------------------------------------------

const defs = new Map<string, NodeDef>();
/** Grows with every definition added: an engine made from an earlier registry is replaced. */
let revision = 0;
let registry: { readonly revision: number; readonly value: NodeRegistry } | null = null;

function add(list: readonly NodeDef[]): void {
  for (const def of list) {
    const known = defs.get(def?.type);
    if (known === def) continue;
    if (typeof def?.type !== 'string' || typeof def.evaluate !== 'function') throw new TypeError('The harness was handed something that is no NodeDef');
    if (known) throw new Error(`Two definitions of the node type "${def.type}" were handed to the harness; a type has one definition per process`);
    defs.set(def.type, def);
    revision++;
  }
}
add(refNodes);
add(harnessSources());

/**
 * Adds definitions to the registry of this process's engine. For a test whose graph names nodes by type
 * (a GraphSpec, a document, a project file): called at module scope with the definitions the file imports.
 */
export function useNodes(list: readonly NodeDef[]): void {
  if (!Array.isArray(list)) throw new TypeError('useNodes takes a list of node definitions');
  add(list);
}

/** The registry of the definitions handed over so far: what the next engine is created with. */
export function currentRegistry(): NodeRegistry {
  if (registry?.revision !== revision) registry = { revision, value: createRegistry([...defs.values()]) };
  return registry.value;
}

// ---- slices ------------------------------------------------------------------------------------------------------

export type EngineSlice = Parameters<NonNullable<EngineTestHooks['onSlice']>>[0];
const sliceListeners = new Set<(slice: EngineSlice) => void>();

/** What a harness call registers to receive the slices of the evaluation it makes (testing.md 2.1). Returns the function that removes it. */
export function onEngineSlice(listener: (slice: EngineSlice) => void): () => void {
  sliceListeners.add(listener);
  return () => void sliceListeners.delete(listener);
}

/** The one onSlice hook of every engine the harness creates. A listener never throws into the engine. */
function onSlice(slice: EngineSlice): void {
  for (const listener of [...sliceListeners]) listener(slice);
}

const HOOKS: Readonly<Record<Slices, EngineTestHooks>> = {
  auto: { poisonRecycled: true, onSlice },
  small: { poisonRecycled: true, onSlice, sliceTargetMs: 1e-6 },
  one: { poisonRecycled: true, onSlice, sliceTargetMs: 1e9 },
};

// ---- the engine: one device per process, one engine at a time ----------------------------------------------------

let gpu: Promise<GpuContext> | null = null;
let live: { readonly engine: Engine; readonly slices: Slices; readonly revision: number } | null = null;
let requestId = 0;

/** Request ids grow over the life of the process, so they grow on every engine (runtime.md 5.2). */
export function nextRequestId(): number {
  return ++requestId;
}

/** The engine that is alive now, if any; it is not created. */
export function liveEngine(): Engine | null {
  return live?.engine ?? null;
}

// Harness calls run one after another: each owns the engine, its budget, its files and the slice listeners
// from its first step to its leak check. A call made while another runs waits for it.
let turn: Promise<unknown> = Promise.resolve();
export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = turn.then(work, work);
  turn = next.catch(() => {});
  return next;
}

/** The engine with the given slicing and the current registry. Called inside exclusive() only. */
export async function obtainEngine(slices: Slices = 'auto'): Promise<TestEngine> {
  if (!Object.hasOwn(HOOKS, slices)) throw new TypeError(`slices is "auto", "small" or "one", not "${String(slices)}"`);
  if (!gpu) {
    const { profile, adapter } = ENVIRONMENT;
    if (profile !== 'core' && profile !== 'max') throw new TypeError(`OROGEN_GPU_PROFILE is "${profile}"; it is "core" or "max"`);
    // The profile is passed explicitly: the factory's own default is "max". A failure is kept, so that every
    // later call fails the same way: nothing falls back to another adapter.
    gpu = createNodeGpu({ profile, ...(adapter !== undefined ? { adapter } : {}) });
  }
  const context = await gpu;
  if (live && live.slices === slices && live.revision === revision) return { gpu: context, engine: live.engine };
  if (live) {
    const old = live.engine;
    live = null;
    await old.dispose();
  }
  const made = revision;
  const real = await createEngine({
    gpu: context,
    registry: currentRegistry(),
    files: TEST_FILES,
    cpu: createNodeCpuRunner(),
    budgetBytes: BUDGET_BYTES,
    test: HOOKS[slices],
  });
  // The real engine, with one thing added: a test that calls evaluate() itself moves the harness's own request
  // ids past the one it used, so that the next harness evaluation on this engine is not refused for its id.
  const engine: Engine = Object.create(real, {
    evaluate: {
      value: ((doc, targets, opts) => {
        if (Number.isInteger(opts?.requestId)) requestId = Math.max(requestId, opts.requestId);
        return real.evaluate(doc, targets, opts);
      }) satisfies Engine['evaluate'],
    },
  });
  live = { engine, slices, revision: made };
  return { gpu: context, engine };
}

/** The process's engine with the given slicing. Created on first use; disposed by a root-level after() hook the harness registers. */
export function getEngine(slices: Slices = 'auto'): Promise<TestEngine> {       // default 'auto'
  return exclusive(() => obtainEngine(slices));
}

// runtime.md 1.5 rule 5: the engine first, then the device.
after(() => exclusive(async () => {
  const engine = live?.engine;
  live = null;
  await engine?.dispose();
  const context = await gpu?.catch(() => null);
  context?.destroy();
}));
