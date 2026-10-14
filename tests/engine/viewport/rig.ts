// What the renderer's tests in Node share: a real session on the process's device with the renderer of
// src/viewport/ as its viewport, drawing to a texture that stands in for the canvas. Not a test file.
//
// A canvas is to the renderer what gives it a WebGPU context, a width and a height (runtime.md 7.5); here the
// context hands out one ordinary texture, which the test reads back and writes as a picture for a person.

import fs from 'node:fs/promises';
import path from 'node:path';

import { nodes } from '../../../src/core/nodes/index.ts';
import {
  addNode, connect, createEngine, createRegistry, createSession, newDoc, setParam, setSettings,
  type CameraState, type DocDraft, type Engine, type EngineEvent, type EngineSession, type EngineTestHooks, type FileWriter, type GpuContext, type GraphDoc,
  type NodeRegistry, type ProjectSettings, type ViewBinding, type ViewportSize,
} from '../../../src/core/runtime.ts';
import { createPngEncoder } from '../../../src/export/encode/png.ts';
import { createNodeCpuRunner } from '../../../src/platform/node/cpu.ts';
import { NodeFileSource } from '../../../src/platform/node/files.ts';
import { createViewportRenderer, type DisplayOptions, type RendererOptions, type Viewport } from '../../../src/viewport/index.ts';
import { testGpu } from '../gpu/rig.ts';

export const REGISTRY: NodeRegistry = createRegistry(nodes);
export const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Where these tests write: <OROGEN_TEST_OUTPUT>/viewport-engine. */
export const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'), 'viewport-engine');
export const BACKSTOP_MS = 120_000;

export interface NodeSpec {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** input port → '<node id>.<output port>' */
  readonly inputs?: Readonly<Record<string, string>>;
}

/** A document of the product's nodes, made with the commands of runtime.md 4.6. The ids of `nodes` are the document's ids. */
export function makeDoc(nodesOf: Readonly<Record<string, NodeSpec>>, view: ViewBinding | undefined, settings: Partial<ProjectSettings> = {}): GraphDoc {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { terrainSize: 4032, heightRange: 1008, buildResolution: 1009, previewLevel: 1, seaLevel: 0, seed: 1, ...settings });
  const ids = new Map<string, string>();
  let row = 0;
  for (const [id, spec] of Object.entries(nodesOf)) {
    const made = addNode(draft, REGISTRY, spec.type, { x: 0, y: 160 * row++ });
    // The document's own ids are random; a test names its nodes.
    const instance = draft.nodes[made]!;
    delete draft.nodes[made];
    draft.nodes[id] = { ...instance, id };
    ids.set(id, id);
    for (const [name, value] of Object.entries(spec.params ?? {})) setParam(draft, REGISTRY, id, name, value);
  }
  for (const [id, spec] of Object.entries(nodesOf)) {
    for (const [port, from] of Object.entries(spec.inputs ?? {})) {
      const [node, output] = from.split('.') as [string, string];
      connect(draft, REGISTRY, { node, port: output }, { node: id, port });
    }
  }
  if (view) draft.ui.view = structuredClone(view) as DocDraft['ui']['view'];
  return draft as GraphDoc;
}

export interface Picture { readonly width: number; readonly height: number; readonly rgba: Uint8Array }

/** The texture the renderer takes for its canvas. */
export interface Canvas {
  /** What is handed to `attach`. */
  readonly element: OffscreenCanvas;
  /** The pixels of the last frame. */
  read(): Promise<Picture>;
  destroy(): void;
}

export function createCanvas(gpu: GpuContext, format: GPUTextureFormat = 'rgba8unorm'): Canvas {
  const { device } = gpu;
  let texture: GPUTexture | null = null;
  const element = {
    width: 1,
    height: 1,
    getContext(kind: string) {
      if (kind !== 'webgpu') return null;
      return {
        configure() {},
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (!texture || texture.width !== element.width || texture.height !== element.height) {
            texture?.destroy();
            texture = device.createTexture({ size: [element.width, element.height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
          }
          return texture;
        },
      };
    },
  };
  return {
    element: element as unknown as OffscreenCanvas,
    async read() {
      if (!texture) throw new Error('No frame was drawn to the canvas');
      const { width, height } = texture;
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) rgba.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      buffer.unmap();
      buffer.destroy();
      return { width, height, rgba };
    },
    destroy() {
      texture?.destroy();
      texture = null;
    },
  };
}

/** Writes <OUTPUT>/<name>.png and returns its path. */
export async function writePicture(name: string, picture: Picture): Promise<string> {
  const rgb = new Uint8Array(picture.width * picture.height * 3);
  for (let i = 0, o = 0; i < picture.rgba.length; i += 4) {
    rgb[o++] = picture.rgba[i]!;
    rgb[o++] = picture.rgba[i + 1]!;
    rgb[o++] = picture.rgba[i + 2]!;
  }
  const chunks: Uint8Array[] = [];
  const memory: FileWriter = {
    async write(chunk) { chunks.push(chunk.slice()); },
    async close() { return { bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) }; },
    async abort() { chunks.length = 0; },
  };
  const encoder = createPngEncoder(memory, { width: picture.width, height: picture.height, channels: 3, bits: 8 });
  await encoder.write(rgb);
  await encoder.end();
  const file = path.join(OUTPUT, `${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat(chunks));
  return file;
}

export interface ViewRig {
  readonly gpu: GpuContext;
  readonly engine: Engine;
  readonly session: EngineSession;
  readonly renderer: Viewport;
  readonly canvas: Canvas;
  readonly events: EngineEvent[];
  /** Sets the document and waits until its view is shown and the picture is final. */
  show(doc: GraphDoc): Promise<void>;
  /** Waits until `test` holds of the events so far. */
  until(test: () => boolean, what: string): Promise<void>;
  /** A new canvas on a device, attached in place of the one before: what the panel does after a device was replaced (7.8 rule 6). */
  attach(gpu: GpuContext, size?: ViewportSize): void;
  /** Waits until the picture is final and returns it. */
  picture(): Promise<Picture>;
  /** `picture()`, written as <OUTPUT>/<name>.png. Returns the path. */
  capture(name: string): Promise<string>;
  setCamera(camera: CameraState): void;
  setDisplay(display: DisplayOptions): void;
  resize(size: ViewportSize): void;
  dispose(): Promise<void>;
}

export const SIZE: ViewportSize = { width: 1600, height: 1000, dpr: 1 };

export function within<T>(work: Promise<T>, what: string, ms: number = BACKSTOP_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Not within ${ms / 1000} s: ${what}`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function startView(opts: { readonly size?: ViewportSize; readonly renderer?: RendererOptions; readonly budgetBytes?: number; readonly gpu?: GpuContext;
  readonly reopenGpu?: () => Promise<GpuContext>; readonly hooks?: EngineTestHooks;
  /** Another renderer than the one of src/viewport/, made with the same options: what a comparison is made against. */
  readonly create?: (options: RendererOptions) => Viewport } = {}): Promise<ViewRig> {
  const gpu = opts.gpu ?? await testGpu();
  const engine = await createEngine({
    gpu, registry: REGISTRY, cpu: createNodeCpuRunner(), files: NodeFileSource(null), budgetBytes: opts.budgetBytes ?? 2 * 2 ** 30,
    ...(opts.hooks ? { test: opts.hooks } : {}),
  });
  // The light maps of a small card whatever the adapter is, so that a test says the same of every adapter (lightCapFor).
  const renderer = (opts.create ?? createViewportRenderer)({ canvasFormat: 'rgba8unorm', lightSize: 2048, ...opts.renderer });
  const session = createSession({
    engine, renderer,
    reopenGpu: opts.reopenGpu ?? (() => Promise.reject(new Error('This test has no second device'))),
    createFiles: () => NodeFileSource(null),
    build: () => Promise.reject(new Error('This test builds nothing')),
    plan: () => { throw new Error('This test plans nothing'); },
  });
  const events: EngineEvent[] = [];
  let waiter: (() => void) | null = null;
  session.subscribe((e) => {
    events.push(e);
    waiter?.();
  });
  let canvas = createCanvas(gpu);
  session.viewport.attach(canvas.element, opts.size ?? SIZE);
  let revision = 0;

  const until = (test: () => boolean, what: string): Promise<void> => within(new Promise<void>((resolve) => {
    const look = (): void => {
      if (!test()) return;
      waiter = null;
      resolve();
    };
    waiter = look;
    look();
  }), what);

  const rig: ViewRig = {
    gpu, engine, session, renderer, events, until,
    get canvas() { return canvas; },
    attach(on, size) {
      canvas = createCanvas(on);
      session.viewport.attach(canvas.element, size ?? opts.size ?? SIZE);
    },
    async show(doc) {
      const mine = ++revision;
      session.setDocument(doc, mine);
      await until(() => events.some((e) => e.type === 'view-updated' && e.revision === mine && !e.draft), `the view of revision ${mine}`);
      await within(renderer.whenIdle(), 'the picture of the view');
    },
    async picture() {
      await within(renderer.whenIdle(), 'the final picture');
      return canvas.read();
    },
    async capture(name) {
      return writePicture(name, await rig.picture());
    },
    setCamera: (camera) => session.viewport.setCamera(camera),
    setDisplay: (display) => session.viewport.setDisplay(display),
    resize: (size) => session.viewport.resize(size),
    async dispose() {
      await session.dispose();
      canvas.destroy();
    },
  };
  return rig;
}

/** One mountain range at the preview resolution `resolution` (a build resolution of the ladder, shown at level 0). */
export function rangeDoc(resolution = 1009, settings: Partial<ProjectSettings> = {}): GraphDoc {
  return makeDoc({ range: { type: 'generate/mountain-range' } }, { height: { node: 'range', port: 'out' } }, { buildResolution: resolution, previewLevel: 0, terrainSize: resolution - 1, heightRange: (resolution - 1) / 4, ...settings });
}

/** Mean and spread of a picture's channels over a rectangle given as fractions of the picture. */
export function region(picture: Picture, x0: number, y0: number, x1: number, y1: number): { readonly mean: readonly [number, number, number]; readonly spread: number } {
  const sum = [0, 0, 0];
  let n = 0, lo = 255, hi = 0;
  for (let y = Math.floor(y0 * picture.height); y < Math.ceil(y1 * picture.height); y++) {
    for (let x = Math.floor(x0 * picture.width); x < Math.ceil(x1 * picture.width); x++) {
      const at = (y * picture.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c]! += picture.rgba[at + c]!;
      const grey = (picture.rgba[at]! + picture.rgba[at + 1]! + picture.rgba[at + 2]!) / 3;
      if (grey < lo) lo = grey;
      if (grey > hi) hi = grey;
      n++;
    }
  }
  return { mean: [sum[0]! / n, sum[1]! / n, sum[2]! / n], spread: hi - lo };
}

/** A field of a document as numbers: evaluated by an engine of its own on the same device, beside the session's. */
export async function readField(gpu: GpuContext, doc: GraphDoc, ref: { node: string; port: string }, resolution: number): Promise<{ readonly size: number; readonly data: Float32Array }> {
  const engine = await createEngine({ gpu, registry: REGISTRY, cpu: createNodeCpuRunner(), files: NodeFileSource(null), budgetBytes: 2 ** 30 });
  try {
    const result = await engine.evaluate(doc, [{ ref, as: 'field' }], { resolution, mode: 'preview', requestId: 1, thumbnails: false });
    const handle = result.fields[0];
    if (!handle || handle.kind !== 'field') throw new Error(`The field ${ref.node}.${ref.port} was not evaluated: ${result.status} ${JSON.stringify(result.errors)}`);
    try {
      return { size: handle.width, data: await engine.read(handle) };
    } finally {
      handle.release();
    }
  } finally {
    await engine.dispose();
  }
}

/** The value of a field at a uv, interpolated as the renderer interpolates it (runtime.md 7.5 rule 3). */
export function sample(field: { readonly size: number; readonly data: Float32Array }, u: number, v: number): number {
  const last = field.size - 1;
  const x = Math.min(last, Math.max(0, u * last)), y = Math.min(last, Math.max(0, v * last));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(last, x0 + 1), y1 = Math.min(last, y0 + 1);
  const at = (px: number, py: number): number => field.data[py * field.size + px]!;
  const top = at(x0, y0) + (x - x0) * (at(x1, y0) - at(x0, y0)), bottom = at(x0, y1) + (x - x0) * (at(x1, y1) - at(x0, y1));
  return top + (y - y0) * (bottom - top);
}

/** The mean absolute difference of two pictures of one size, per channel, in steps of 255. */
export function difference(a: Picture, b: Picture): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.rgba.length; i += 4) sum += Math.abs(a.rgba[i]! - b.rgba[i]!) + Math.abs(a.rgba[i + 1]! - b.rgba[i + 1]!) + Math.abs(a.rgba[i + 2]! - b.rgba[i + 2]!);
  return sum / (a.width * a.height * 3);
}

/** The colour at a pixel given as fractions of the picture. */
export function pixel(picture: Picture, fx: number, fy: number): readonly [number, number, number] {
  const x = Math.min(picture.width - 1, Math.floor(fx * picture.width)), y = Math.min(picture.height - 1, Math.floor(fy * picture.height));
  const at = (y * picture.width + x) * 4;
  return [picture.rgba[at]!, picture.rgba[at + 1]!, picture.rgba[at + 2]!];
}
