// Documents, plans and a page without a window for the GPU-free tests of the build panel. Not a test file.
//
// A plan is made by the pipeline's own `planBuild`: the panel never plans (export-unreal.md 3.1), it shows the
// plan a build sent, and these tests show it the plans a build would send.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { nodes as ioNodes } from '../../../../src/core/nodes/io/index.ts';
import { nodes as refNodes } from '../../../../src/core/nodes/ref/index.ts';
import {
  createRegistry,
  type BuildPlan, type BuildResult, type EngineEvent, type EngineSession, type GraphDoc, type NodeRegistry, type ProjectSettings,
} from '../../../../src/core/runtime.ts';
import { planBuild } from '../../../../src/export/plan.ts';
import type { PlatformApi } from '../../../../src/app/platform.ts';
import { createDocStore } from '../../../../src/app/state/doc-store.ts';
import { applyEngineEvent, createEngineStore } from '../../../../src/app/state/engine-store.ts';
import { createUiStore } from '../../../../src/app/state/ui-store.ts';
import { createBuildModel, type BuildModel, type ModelContext, type ModelOptions } from '../../../../src/app/panels/build/model/store.ts';

export const ROOT = path.resolve(import.meta.dirname, '../../../..');
export const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

export const REGISTRY: NodeRegistry = createRegistry([...refNodes, ...ioNodes]);
export const SETTINGS: ProjectSettings = { terrainSize: 2000, heightRange: 500, seed: 7, buildResolution: 1009, previewLevel: 1, seaLevel: 0 };

export interface NodeSpec {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** The output that feeds the input `in`, as '<node>.<port>'. */
  readonly in?: string;
  readonly title?: string;
}

/** A document of the given nodes with the ids given, and an edge per `in`. */
export function docOf(nodes: Readonly<Record<string, NodeSpec>>, settings: Partial<ProjectSettings> = {}): GraphDoc {
  const doc = {
    format: 'orogen' as const, version: 1 as const, settings: { ...SETTINGS, ...settings },
    nodes: {} as Record<string, GraphDoc['nodes'][string]>, edges: {} as Record<string, GraphDoc['edges'][string]>, groups: {}, ui: {},
  };
  for (const [id, spec] of Object.entries(nodes)) {
    doc.nodes[id] = {
      id, type: spec.type, version: REGISTRY.get(spec.type)?.version ?? 1, position: { x: 0, y: 0 }, params: { ...spec.params },
      ...(spec.title !== undefined ? { title: spec.title } : {}),
    };
    if (spec.in === undefined) continue;
    const dot = spec.in.lastIndexOf('.');
    doc.edges[`e-${id}`] = { id: `e-${id}`, from: { node: spec.in.slice(0, dot), port: spec.in.slice(dot + 1) }, to: { node: id, port: 'in' } };
  }
  return doc;
}

/** A terrain, a mask of it and a coloring of it. */
export const SOURCES: Readonly<Record<string, NodeSpec>> = {
  land: { type: 'ref/fbm' },
  steep: { type: 'ref/slope-mask', in: 'land.out' },
  paint: { type: 'ref/colorize', in: 'land.out' },
};

/** The landscape with a weight-blended layer, an independent one, the three textures and an image. */
export const FULL: Readonly<Record<string, NodeSpec>> = {
  ...SOURCES,
  outland: { type: 'io/export-landscape', params: { name: 'Ridge' }, in: 'land.out' },
  outrock: { type: 'io/export-layer', params: { layer: 'Rock' }, in: 'steep.out', title: 'Rock Layer' },
  outflow: { type: 'io/export-layer', params: { layer: 'Flow', weightBlended: false }, in: 'steep.out' },
  outpaint: { type: 'io/export-color', in: 'paint.out' },
  outnormal: { type: 'io/export-normal', in: 'land.out' },
  outmask: { type: 'io/export-mask', params: { bits: '16' }, in: 'steep.out' },
  outexr: { type: 'io/export-field', params: { name: 'Heights' }, in: 'land.out' },
};

export const plan = (doc: GraphDoc, resolution?: number): BuildPlan => planBuild(doc, REGISTRY, resolution === undefined ? undefined : { resolution });

export function resultOf(status: BuildResult['status'], rest: Partial<BuildResult> = {}): BuildResult {
  return { requestId: 1, status, problems: [], files: [], manifest: null, report: null, outDir: null, peakPoolBytes: null, ...rest };
}

// ---- a page without a window -------------------------------------------------------------------------------------------

export interface Page {
  readonly ctx: ModelContext;
  readonly model: BuildModel;
  /** The clock the model reads; a test moves it. */
  now: number;
  /** Sends an event as the engine client does: to engineStore first, then to the subscribers. */
  emit(event: EngineEvent): void;
  /** The folders the next folder dialogs answer with. */
  readonly folders: (string | null)[];
  /** The text files the bridge reads, by path. */
  readonly files: Map<string, string>;
  readonly built: { readonly outDir: string; readonly doc: GraphDoc }[];
  readonly revealed: string[];
  cancelled: number;
  /** Settles the build the model started, as the session does when the build has ended. */
  endBuild(result: BuildResult): void;
  /** Rejects the build the model started, as the engine client does when its session is gone. */
  failBuild(reason: Error): void;
}

export function createPage(doc: GraphDoc = docOf(FULL), projectPath: string | null = null, options: Omit<ModelOptions, 'clock'> = {}): Page {
  const ui = createUiStore();
  const docStore = createDocStore({ ui });
  docStore.getState().load(doc, projectPath);
  const engineState = createEngineStore();
  const listeners = new Set<(event: EngineEvent) => void>();
  const pendingBuilds: { resolve(result: BuildResult): void; reject(reason: Error): void }[] = [];

  const page: Page = {
    ctx: undefined as unknown as ModelContext,
    model: undefined as unknown as BuildModel,
    now: 1000,
    emit(event) {
      applyEngineEvent(engineState, event);
      for (const listener of [...listeners]) listener(event);
    },
    folders: [],
    files: new Map(),
    built: [],
    revealed: [],
    cancelled: 0,
    endBuild(result) {
      pendingBuilds.shift()?.resolve(result);
    },
    failBuild(reason) {
      pendingBuilds.shift()?.reject(reason);
    },
  };
  const engine = {
    build: (request: { doc: GraphDoc; outDir: string }) => new Promise<BuildResult>((resolve, reject) => {
      page.built.push({ outDir: request.outDir, doc: request.doc });
      pendingBuilds.push({ resolve, reject });
    }),
    cancelBuild: () => { page.cancelled++; },
    subscribe(listener: (event: EngineEvent) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as EngineSession;
  const platform = {
    chooseFolder: async () => page.folders.shift() ?? null,
    readTextFile: async (file: string) => {
      const text = page.files.get(file);
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${file}'`);
      return text;
    },
    showInFolder: (file: string) => { page.revealed.push(file); },
  } as unknown as PlatformApi;
  const ctx: ModelContext = { doc: docStore, engineState, ui, engine, platform, registry: REGISTRY };
  (page as { ctx: ModelContext }).ctx = ctx;
  (page as { model: BuildModel }).model = createBuildModel(ctx, { clock: () => page.now, ...options });
  return page;
}

const CAPS = { software: false } as unknown as Extract<EngineEvent, { type: 'device-ready' }>['caps'];

/** The device is ready: what a build needs to start. */
export function ready(page: Page): void {
  page.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 2 ** 31 });
}

/** A turn of the event loop: what a promise that is already settled needs to reach its continuation. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
