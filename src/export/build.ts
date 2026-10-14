// The build pipeline (export-unreal.md section 3): runs a plan through the engine with staged delivery, converts
// each delivered target on the CPU in row bands, and writes through a FileSink. It evaluates nothing itself, runs
// no kernel and allocates no GPU memory. No data file is closed before the commit phase, and the manifest is
// written last.

import type { ExportItem, ImageItem, LandscapeItem, LayerItem, TextureItem } from '../core/api.ts';
import {
  DeviceLostError,
  type AnyFieldHandle, type BuildEvent, type BuildPlan, type BuildProblem, type BuildProblemCode, type BuildResult, type Engine,
  type EvalEvent, type EvalTarget, type EvaluateResult, type FieldHandle, type FileSink, type FileWriter, type GraphDoc, type NodeError,
} from '../core/runtime.ts';
import { colorToSrgb8, countNonFinite, createNormalRows, createTexelGridResampler, normalsToRgb8, quantiseUnit } from './convert.ts';
import { createExrEncoder } from './encode/exr.ts';
import { createPngEncoder, type RowEncoder } from './encode/png.ts';
import { createRawEncoder } from './encode/raw.ts';
import { createTiffEncoder } from './encode/tiff.ts';
import {
  GENERATOR_VERSION, MANIFEST_SCHEMA_ID, manifestLayout, manifestTransform, ORIENTATION, REPORT_SCHEMA_ID, serializeJson, TARGET_ENGINE,
  type BuildReport, type Manifest, type ManifestImage, type ManifestLandscape, type ManifestTexture,
} from './manifest.ts';
import { edgeInto, heightFiles, imageFile, layerFiles, manifestFile, planBuild, reportFile, textureFile } from './plan.ts';
import { heightMapping, landscapeTransform, quantiseHeights, quantiseWeights, textureSide, weightFloorCode, Z_SCALE_FORMULA } from './unreal.ts';

export interface BuildOptions {
  readonly doc: GraphDoc;
  readonly sink: FileSink;
  readonly requestId: number;                    // for Engine.evaluate; echoed in every BuildEvent
  readonly resolution?: number;                  // default: doc.settings.buildResolution
  readonly signal?: AbortSignal;
  readonly onEvent?: (e: EvalEvent | BuildEvent) => void;
}

/** Rows per band for a field of the given width and channel count (1 or 4). */
export function bandRows(width: number, channels: number): number {
  const rows = Math.floor((32 * 1024 * 1024) / (width * channels * 4) / 16) * 16;
  return Math.max(16, Math.min(512, rows));
}

/** 'build-progress' at most 10 times per second, the one that begins the commit included (3.9). */
const PROGRESS_MS = 125;

/** A problem that ends the build: what a stage, the weights or the commit throws. */
class BuildFailure extends Error {
  readonly code: BuildProblemCode;
  readonly nodeId: string | undefined;

  constructor(code: BuildProblemCode, message: string, nodeId?: string) {
    super(message);
    this.code = code;
    this.nodeId = nodeId;
  }
}

const reasonOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** A data file of the build: open under its temporary name until the commit. */
interface OpenFile {
  readonly path: string;
  readonly writer: FileWriter;
  /** The bytes handed to the writer, which close() must report (3.4). */
  bytes: number;
}

type Samples = Uint8Array | Uint16Array | Float32Array;

/** What the landscape stage measured and mapped: the manifest and the report state it. */
interface HeightInfo { readonly measuredMin: number; readonly measuredMax: number; readonly a: number; readonly b: number; readonly clipped: number }

/** Runs a plan: evaluates through the engine, converts on the CPU, writes through the sink. Rejects only for a malformed call. */
export async function buildProject(engine: Engine, opts: BuildOptions): Promise<BuildResult> {
  if (typeof engine?.evaluate !== 'function' || typeof engine.read !== 'function' || typeof engine.memory !== 'function') throw new TypeError('buildProject: the first argument is the Engine');
  if (typeof opts !== 'object' || opts === null) throw new TypeError('buildProject: the options are an object');
  const { doc, sink, requestId } = opts;
  if (typeof doc !== 'object' || doc === null || typeof doc.nodes !== 'object' || typeof doc.settings !== 'object') throw new TypeError('buildProject: doc is a GraphDoc');
  if (typeof sink?.create !== 'function' || typeof sink.write !== 'function' || typeof sink.abortAll !== 'function') throw new TypeError('buildProject: sink is a FileSink');
  if (!Number.isInteger(requestId)) throw new TypeError(`buildProject: requestId ${String(requestId)} is not an integer`);

  const emit = (event: BuildEvent): void => opts.onEvent?.(event);
  const registry = engine.registry;

  // ---- phase 1: the plan -----------------------------------------------------------------------------------------
  const plan: BuildPlan = planBuild(doc, registry, opts.resolution !== undefined ? { resolution: opts.resolution } : undefined);
  emit({ type: 'build-plan', requestId, plan });
  if (!plan.ok) {
    const result: BuildResult = { requestId, status: 'errors', problems: plan.problems, files: [], manifest: null, report: null, outDir: null, peakPoolBytes: null };
    emit({ type: 'build-result', requestId, result });
    return result;
  }

  const startedAt = new Date();
  const startedMs = performance.now();
  const res = plan.resolution;
  const { settings } = doc;
  const problems: BuildProblem[] = [...plan.problems];
  const found = (problem: BuildProblem): void => {
    problems.push(problem);
    emit({ type: 'build-problem', requestId, problem });
  };
  const warn = (code: BuildProblemCode, message: string, nodeId?: string): void => {
    found({ severity: 'warning', code, message, ...(nodeId !== undefined ? { nodeId } : {}) });
  };

  const titleOf = (nodeId: string): string => {
    const instance = Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
    if (!instance) return nodeId;
    return typeof instance.title === 'string' && instance.title !== '' ? instance.title : registry.get(instance.type)?.title ?? instance.type;
  };
  const items = plan.items.map(({ nodeId, item }) => ({ nodeId, item, title: titleOf(nodeId) }));
  const landscape = items.find((entry): entry is typeof entry & { item: LandscapeItem } => entry.item.kind === 'landscape') ?? null;
  const blended = items.filter((entry): entry is typeof entry & { item: LayerItem } => entry.item.kind === 'layer' && entry.item.weightBlended);

  // The pipeline's own controller: it follows the caller's signal and aborts at the first node error (3.2 rule 4).
  const controller = new AbortController();
  const follow = (): void => controller.abort(opts.signal!.reason);
  if (opts.signal?.aborted) follow();
  else opts.signal?.addEventListener('abort', follow, { once: true });
  const checkSignal = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };

  // ---- files -------------------------------------------------------------------------------------------------------
  const open = new Map<string, OpenFile>();
  /** A step of writing: what it rejects with is E_WRITE_FAILED, with the cause and the path. */
  const filing = async <T>(path: string, step: Promise<T>, nodeId?: string): Promise<T> => {
    try {
      return await step;
    } catch (thrown) {
      throw new BuildFailure('E_WRITE_FAILED', `Cannot write ${path}: ${reasonOf(thrown)}.`, nodeId);
    }
  };
  /** Creates a data file. The writer it returns counts what it is given and is closed in the commit phase alone. */
  const create = async (path: string, nodeId?: string): Promise<FileWriter> => {
    const writer = await filing(path, sink.create(path), nodeId);
    const file: OpenFile = { path, writer, bytes: 0 };
    open.set(path, file);
    return {
      write(chunk) {
        file.bytes += chunk.byteLength;
        return writer.write(chunk);
      },
      close: () => Promise.reject(new Error('An encoder does not close its file')),
      abort: () => Promise.reject(new Error('An encoder does not abort its file')),
    };
  };
  /** Several encoders that receive the same rows: the PNG and the raw file of a heightmap or a layer. */
  const pair = <S extends Samples>(nodeId: string | undefined, encoders: readonly { readonly path: string; readonly encoder: RowEncoder<S> }[]) => ({
    write: (rows: S): Promise<void[]> => Promise.all(encoders.map(({ path, encoder }) => filing(path, encoder.write(rows), nodeId))),
    end: (): Promise<void[]> => Promise.all(encoders.map(({ path, encoder }) => filing(path, encoder.end(), nodeId))),
  });

  // ---- memory (3.10) ----------------------------------------------------------------------------------------------
  // What the engine held at its height: the pool's ledger, read at every event and every band. A node's own peak
  // lies between two events: it is what the node held as WORKING at the most, on top of what was published and
  // reserved when it started, all of which stays until the node has run (runtime.md 2.8).
  const pool = { peak: 0, heldAtNodeStart: 0 };
  const sample = (event?: EvalEvent): void => {
    const memory = engine.memory();
    pool.peak = Math.max(pool.peak, memory.workingBytes + memory.cacheBytes + memory.pinnedBytes + memory.freeBytes + memory.reservedBytes);
    if (event?.type === 'node-start') pool.heldAtNodeStart = memory.cacheBytes + memory.pinnedBytes + memory.reservedBytes;
    if (event?.type === 'node-done' && !event.cached) pool.peak = Math.max(pool.peak, pool.heldAtNodeStart + event.peakBytes);
  };

  // ---- progress ----------------------------------------------------------------------------------------------------
  const outputRows = (item: ExportItem): number => (item.kind === 'texture' ? textureSide(item.size, res) : res);
  const totalRows = items.reduce((sum, { item }) => sum + outputRows(item), 0) + (blended.length > 0 ? res : 0);
  let doneRows = 0;
  let lastProgress = -Infinity;
  const advance = (rows: number, phase: 'targets' | 'weights'): void => {
    doneRows += rows;
    if (phase === 'targets') sample();
    const now = performance.now();
    if (now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    emit({ type: 'build-progress', requestId, phase, fraction: Math.min(1, doneRows / totalRows) });
  };

  // ---- what the stages leave for the weights, the manifest and the report ------------------------------------------
  const report: BuildReport['targets'] = items.map(({ nodeId, item, title }) => ({
    nodeId, nodeType: doc.nodes[nodeId].type, title, kind: item.kind, evaluateMs: null, exportMs: null, min: null, max: null,
  }));
  // Members of one object, read through it everywhere: they change inside the functions below, behind the type checker's back.
  const state: {
    status: BuildResult['status'];
    height: HeightInfo | null;
    /** What a stage threw: the evaluation rejects with the same value (runtime.md 5.2). */
    stageFailure: { readonly thrown: unknown } | null;
  } = { status: 'ok', height: null, stageFailure: null };
  /** The 16-bit codes of each weight-blended layer, by item index, kept until phase 3 (3.4). */
  const planes = new Map<number, Uint16Array>();
  /** The sum of the bytes of each layer, by layer name. */
  const layerSums = new Map<string, number>();
  const imageRanges = new Map<number, { readonly min: number | null; readonly max: number | null }>();
  const delivered = new Set<number>();

  const nonFinite = (title: string, nodeId: string, count: number): BuildFailure =>
    new BuildFailure('E_NON_FINITE', `${title}: its input holds ${count} ${count === 1 ? 'value that is' : 'values that are'} not a number or infinite, in the rows read so far.`, nodeId);

  /** The rows [y0, y1) of every band of a field `res` high, top first, with the signal checked before each (3.5). */
  const bands = function* (channels: 1 | 4): Generator<readonly [number, number]> {
    const rows = bandRows(res, channels);
    for (let y0 = 0; y0 < res; y0 += rows) {
      checkSignal();
      yield [y0, Math.min(res, y0 + rows)];
    }
  };

  async function landscapeStage(index: number, nodeId: string, title: string, item: LandscapeItem, handle: FieldHandle<'field'>): Promise<void> {
    const stats = await engine.stats(handle);
    if (stats.nonFinite > 0) throw nonFinite(title, nodeId, stats.nonFinite);
    report[index].min = stats.min;
    report[index].max = stats.max;
    const { a, b, widened } = heightMapping(item.range, stats.min, stats.max, settings.heightRange);
    if (widened) {
      warn('W_FLAT', `${title}: the height range to store is under 1 m, so it was widened to 1 m about its middle; the terrain is all but flat.`, nodeId);
    }
    const paths = heightFiles(plan.name);
    let files: ReturnType<typeof pair<Uint16Array>> | null = null;
    const codes = new Uint16Array(bandRows(res, 1) * res);
    let clipped = 0;
    for (const [y0, y1] of bands(1)) {
      const src = await engine.read(handle, [y0, y1]);
      const dst = codes.subarray(0, (y1 - y0) * res);
      clipped += quantiseHeights(src, dst, { width: res, y0, a, b, dither: item.dither });
      files ??= pair(nodeId, [
        { path: paths.png, encoder: createPngEncoder(await create(paths.png, nodeId), { width: res, height: res, channels: 1, bits: 16 }) },
        { path: paths.r16, encoder: createRawEncoder(await create(paths.r16, nodeId), { width: res, height: res, sample: 'u16' }) },
      ]);
      await files.write(dst);
      advance(y1 - y0, 'targets');
    }
    await files!.end();
    if (item.range.mode === 'fixed' && clipped > 0) {
      warn('W_HEIGHT_CLIPPED', `${title}: ${clipped} ${clipped === 1 ? 'sample lies' : 'samples lie'} outside the fixed height range ${item.range.min} to ${item.range.max} and ${clipped === 1 ? 'was' : 'were'} clipped to it.`, nodeId);
    }
    state.height = { measuredMin: stats.min, measuredMax: stats.max, a, b, clipped };
  }

  async function blendedLayerStage(index: number, nodeId: string, title: string, handle: FieldHandle<'field'>): Promise<void> {
    const plane = new Uint16Array(res * res);
    for (const [y0, y1] of bands(1)) {
      const src = await engine.read(handle, [y0, y1]);
      const converted = quantiseUnit(src, plane.subarray(y0 * res, y1 * res), { max: 65535, lo: 0, hi: 1 });
      if (converted.nonFinite > 0) throw nonFinite(title, nodeId, converted.nonFinite);
      advance(y1 - y0, 'targets');
    }
    planes.set(index, plane);
  }

  async function maskLayerStage(nodeId: string, title: string, item: LayerItem, handle: FieldHandle<'field'>): Promise<void> {
    const paths = layerFiles(item.layer);
    let files: ReturnType<typeof pair<Uint8Array>> | null = null;
    const bytes = new Uint8Array(bandRows(res, 1) * res);
    let sum = 0;
    for (const [y0, y1] of bands(1)) {
      const src = await engine.read(handle, [y0, y1]);
      const dst = bytes.subarray(0, (y1 - y0) * res);
      const converted = quantiseUnit(src, dst, { max: 255, lo: 0, hi: 1 });
      if (converted.nonFinite > 0) throw nonFinite(title, nodeId, converted.nonFinite);
      sum += converted.sum;
      files ??= pair(nodeId, [
        { path: paths.png, encoder: createPngEncoder(await create(paths.png, nodeId), { width: res, height: res, channels: 1, bits: 8 }) },
        { path: paths.r8, encoder: createRawEncoder(await create(paths.r8, nodeId), { width: res, height: res, sample: 'u8' }) },
      ]);
      await files.write(dst);
      advance(y1 - y0, 'targets');
    }
    await files!.end();
    layerSums.set(item.layer, sum);
    if (sum === 0) warn('W_LAYER_EMPTY', `${title}: the layer ${item.layer} is 0 everywhere.`, nodeId);
  }

  async function textureStage(nodeId: string, title: string, item: TextureItem, handle: AnyFieldHandle): Promise<void> {
    const side = textureSide(item.size, res);
    const path = textureFile(item, res);
    // A data texture is read as a colour texture is, four floats a texel of which three are kept, and converted as a mask is.
    const color = item.content === 'color' || item.content === 'data';
    const channels = item.content === 'mask' ? 1 : 3;
    const resampler = createTexelGridResampler({ srcSize: res, dstSize: side, channels, stride: color ? 4 : channels });
    const normals = item.content === 'normal' ? createNormalRows({ size: res, heightRange: settings.heightRange, terrainSize: settings.terrainSize }) : null;
    let encoder: RowEncoder<Uint8Array | Uint16Array> | null = null;
    /** Converts the output rows the resampler has completed, and writes them. */
    const write = async (rows: Float32Array): Promise<void> => {
      if (rows.length === 0) return;
      const samples = item.content === 'mask' && item.bits === 16 ? new Uint16Array(rows.length) : new Uint8Array(rows.length);
      const bad = item.content === 'color' ? colorToSrgb8(rows, samples as Uint8Array)
        : item.content === 'normal' ? normalsToRgb8(rows, samples as Uint8Array)
        : quantiseUnit(rows, samples, { max: item.bits === 16 ? 65535 : 255, lo: 0, hi: 1 }).nonFinite;
      if (bad > 0) throw nonFinite(title, nodeId, bad);
      encoder ??= createPngEncoder(await create(path, nodeId), { width: side, height: side, channels, bits: item.bits });
      await filing(path, encoder.write(samples), nodeId);
      advance(rows.length / (side * channels), 'targets');
    };
    for (const [y0, y1] of bands(color ? 4 : 1)) {
      const src = await engine.read(handle, [y0, y1]);
      await write(resampler.push(normals ? normals.push(src) : src));
    }
    normals?.finish();
    await write(resampler.finish());
    if (!encoder) throw new BuildFailure('E_INTERNAL', `${title}: the texture ${path} received no rows.`, nodeId);
    await filing(path, (encoder as RowEncoder<Uint8Array | Uint16Array>).end(), nodeId);
  }

  async function imageStage(index: number, nodeId: string, title: string, item: ImageItem, handle: FieldHandle<'field'>): Promise<void> {
    const path = imageFile(item);
    const integer = item.format === 'png8' || item.format === 'png16' || item.format === 'r16' || item.format === 'tiff16';
    let lo = 0, hi = 1;
    if (integer && item.map === 'measured') {
      const stats = await engine.stats(handle);
      if (stats.nonFinite > 0) throw nonFinite(title, nodeId, stats.nonFinite);
      lo = stats.min;
      hi = stats.max;
      report[index].min = stats.min;
      report[index].max = stats.max;
    }
    imageRanges.set(index, integer ? { min: lo, max: hi } : { min: null, max: null });
    const shape = { width: res, height: res };
    const make = (writer: FileWriter): RowEncoder<Samples> => {
      switch (item.format) {
        case 'png8': return createPngEncoder(writer, { ...shape, channels: 1, bits: 8 }) as RowEncoder<Samples>;
        case 'png16': return createPngEncoder(writer, { ...shape, channels: 1, bits: 16 }) as RowEncoder<Samples>;
        case 'r16': return createRawEncoder(writer, { ...shape, sample: 'u16' });
        case 'tiff16': return createTiffEncoder(writer, { ...shape, sample: 'u16' }) as RowEncoder<Samples>;
        case 'r32': return createRawEncoder(writer, { ...shape, sample: 'f32' });
        case 'exr': return createExrEncoder(writer, shape) as RowEncoder<Samples>;
        case 'tiff32': return createTiffEncoder(writer, { ...shape, sample: 'f32' }) as RowEncoder<Samples>;
      }
    };
    const max = item.format === 'png8' ? 255 : 65535;
    const codes = !integer ? null : max === 255 ? new Uint8Array(bandRows(res, 1) * res) : new Uint16Array(bandRows(res, 1) * res);
    let encoder: RowEncoder<Samples> | null = null;
    for (const [y0, y1] of bands(1)) {
      const src = await engine.read(handle, [y0, y1]);
      let rows: Samples = src;
      let bad: number;
      if (codes) {
        rows = codes.subarray(0, (y1 - y0) * res);
        bad = quantiseUnit(src, rows as Uint8Array | Uint16Array, { max, lo, hi }).nonFinite;
      } else bad = countNonFinite(src);
      if (bad > 0) throw nonFinite(title, nodeId, bad);
      encoder ??= make(await create(path, nodeId));
      await filing(path, encoder.write(rows), nodeId);
      advance(y1 - y0, 'targets');
    }
    await filing(path, encoder!.end(), nodeId);
  }

  // ---- phase 2: the targets ----------------------------------------------------------------------------------------
  const targets: EvalTarget[] = plan.targets.map((source) => {
    const edge = edgeInto(doc, registry, source.node, source.input)!;
    const type = registry.get(doc.nodes[source.node]!.type)!.inputs.find((port) => port.name === source.input)!.type;
    return { ref: edge.from, as: type === 'color' ? 'color' : 'field' };
  });

  const nodeErrors: NodeError[] = [];
  let stageEnded = performance.now();

  async function stage(index: number, handle: AnyFieldHandle | null): Promise<void> {
    const began = performance.now();
    const { nodeId, item, title } = items[index];
    report[index].evaluateMs = began - stageEnded;
    try {
      checkSignal();
      const first = item.kind === 'landscape' ? heightFiles(plan.name).png : item.kind === 'layer' ? layerFiles(item.layer).png
        : item.kind === 'texture' ? textureFile(item, res) : imageFile(item);
      emit({ type: 'build-target', requestId, index, count: items.length, nodeId, label: `${title}: ${first}` });
      if (!handle) throw new BuildFailure('E_INTERNAL', `${title}: the evaluation delivered no field for its input.`, nodeId);
      const wantsColor = item.kind === 'texture' && (item.content === 'color' || item.content === 'data');
      if (wantsColor ? handle.kind !== 'color' : handle.kind !== 'field') {
        throw new BuildFailure('E_INTERNAL', `${title}: the evaluation delivered a ${handle.kind} where a ${wantsColor ? 'color' : 'field'} was asked for.`, nodeId);
      }
      if (item.kind === 'texture') await textureStage(nodeId, title, item, handle);
      else {
        const field = handle as FieldHandle<'field'>;
        if (item.kind === 'landscape') await landscapeStage(index, nodeId, title, item, field);
        else if (item.kind === 'image') await imageStage(index, nodeId, title, item, field);
        else if (item.weightBlended) await blendedLayerStage(index, nodeId, title, field);
        else await maskLayerStage(nodeId, title, item, field);
      }
      delivered.add(index);
    } catch (thrown) {
      state.stageFailure ??= { thrown };
      throw thrown;
    } finally {
      stageEnded = performance.now();
      report[index].exportMs = stageEnded - began;
    }
  }

  let evaluated: EvaluateResult | null = null;
  let rejected: { readonly thrown: unknown } | null = null;
  try {
    evaluated = await engine.evaluate(doc, targets, {
      resolution: res,
      mode: 'build',
      requestId,
      signal: controller.signal,
      onEvent(event) {
        sample(event);
        if (event.type === 'node-error') {
          nodeErrors.push(event.error);
          controller.abort(new DOMException('A node failed', 'AbortError'));
        }
        opts.onEvent?.(event);
      },
      onTarget: stage,
    });
  } catch (thrown) {
    rejected = { thrown };
  }
  // A TypeError that no stage threw is the engine refusing the call itself: a malformed call (3.1, runtime.md 5.2).
  // Whatever else it rejects with ends the build as any other exception does, with E_INTERNAL and the report.
  if (rejected && rejected.thrown instanceof TypeError && state.stageFailure?.thrown !== rejected.thrown) {
    opts.signal?.removeEventListener('abort', follow);
    await sink.abortAll().catch(() => {});
    throw rejected.thrown;
  }

  const fatal = (failure: BuildFailure | { readonly code: BuildProblemCode; readonly message: string; readonly nodeId?: string }): void => {
    found({ severity: 'error', code: failure.code, message: failure.message, ...(failure.nodeId !== undefined ? { nodeId: failure.nodeId } : {}) });
  };
  /** The status and the problem of whatever ended a phase. */
  const failed = (thrown: unknown): void => {
    if (thrown instanceof DeviceLostError) {
      state.status = 'device-lost';
      fatal({ code: 'E_DEVICE_LOST', message: 'The GPU device was lost during the build; the build is not resumed.' });
    } else if (opts.signal?.aborted) state.status = 'aborted';
    else {
      state.status = 'errors';
      fatal(thrown instanceof BuildFailure ? thrown : { code: 'E_INTERNAL', message: reasonOf(thrown) });
    }
  };

  if (evaluated?.status === 'device-lost' || rejected?.thrown instanceof DeviceLostError) failed(new DeviceLostError('The GPU device was lost'));
  else if (opts.signal?.aborted) state.status = 'aborted';
  else if (nodeErrors.length > 0 || (evaluated?.status === 'errors' && evaluated.errors.length > 0)) {
    state.status = 'errors';
    const errors = nodeErrors.length > 0 ? nodeErrors : evaluated!.errors;
    for (const error of errors) fatal({ code: 'E_NODE_FAILED', message: `${titleOf(error.nodeId)}: ${error.message}.`, nodeId: error.nodeId });
  } else if (rejected) failed(rejected.thrown);
  else if (evaluated?.status !== 'ok' || delivered.size !== items.length) {
    state.status = 'errors';
    fatal({ code: 'E_INTERNAL', message: `The evaluation ended "${evaluated?.status ?? 'unknown'}" with ${delivered.size} of ${items.length} export targets delivered.` });
  }

  // ---- phase 3: the weights ----------------------------------------------------------------------------------------
  let weightsMs: number | null = null;
  if (state.status === 'ok' && blended.length > 0 && landscape) {
    const began = performance.now();
    try {
      const names = [landscape.item.baseLayer, ...blended.map(({ item }) => item.layer)];
      const owners = [undefined, ...blended.map(({ nodeId }) => nodeId)];
      const source = blended.map((entry) => planes.get(items.indexOf(entry))!);
      const rows = bandRows(res, 1);
      const out = names.map(() => new Uint8Array(rows * res));
      const sums = names.map(() => 0);
      const files: ReturnType<typeof pair<Uint8Array>>[] = [];
      for (const [j, name] of names.entries()) {
        const paths = layerFiles(name);
        files.push(pair(owners[j], [
          { path: paths.png, encoder: createPngEncoder(await create(paths.png, owners[j]), { width: res, height: res, channels: 1, bits: 8 }) },
          { path: paths.r8, encoder: createRawEncoder(await create(paths.r8, owners[j]), { width: res, height: res, sample: 'u8' }) },
        ]));
      }
      const floorCode = weightFloorCode(landscape.item.layerFloor);
      for (let y0 = 0; y0 < res; y0 += rows) {
        checkSignal();
        const count = (Math.min(res, y0 + rows) - y0) * res;
        const band = out.map((bytes) => bytes.subarray(0, count));
        quantiseWeights(source, band, { offset: y0 * res, count, floorCode, limit: landscape.item.layerLimit });
        for (const [j, bytes] of band.entries()) {
          let sum = 0;
          for (let i = 0; i < count; i++) sum += bytes[i];
          sums[j] += sum;
        }
        // Every layer has buffers and files of its own: their encoders run side by side.
        await Promise.all(band.map((bytes, j) => files[j].write(bytes)));
        advance(count / res, 'weights');
      }
      for (const file of files) await file.end();
      for (const [j, name] of names.entries()) {
        layerSums.set(name, sums[j]);
        if (j > 0 && sums[j] === 0) warn('W_LAYER_EMPTY', `${blended[j - 1].title}: the layer ${name} is 0 everywhere.`, owners[j]);
      }
      if (opts.signal?.aborted) state.status = 'aborted';
    } catch (thrown) {
      failed(thrown);
    }
    weightsMs = performance.now() - began;
  }
  // Dropped whatever the outcome: nothing reads them after phase 3.
  planes.clear();

  // ---- phase 4: the commit -----------------------------------------------------------------------------------------
  const visible: { path: string; bytes: number }[] = [];
  const meanWeight = (name: string): number => (layerSums.get(name) ?? 0) / (res * res * 255);
  let manifestPath: string | null = null;
  let commitMs: number | null = null;
  if (state.status === 'ok') {
    const began = performance.now();
    lastProgress = began;
    emit({ type: 'build-progress', requestId, phase: 'commit', fraction: 1 });
    const dataFiles = plan.files.filter((file) => file.encoding !== 'json');
    try {
      for (const planned of dataFiles) {
        const file = open.get(planned.path);
        if (!file) throw new BuildFailure('E_INTERNAL', `The planned file ${planned.path} was never written.`);
        let closed: { readonly bytes: number };
        try {
          closed = await file.writer.close();
        } catch (thrown) {
          throw new BuildFailure('E_COMMIT_FAILED', `Cannot put ${planned.path} in place: ${reasonOf(thrown)}; files of this build that were already in place stay, and an earlier manifest in the folder may no longer describe them, so build again.`);
        }
        open.delete(planned.path);
        if (closed.bytes !== file.bytes) {
          throw new BuildFailure('E_WRITE_FAILED', `Cannot write ${planned.path}: ${file.bytes} bytes were handed to the file and it reports ${closed.bytes}.`);
        }
        visible.push({ path: planned.path, bytes: file.bytes });
      }

      const manifest: Manifest = {
        schema: MANIFEST_SCHEMA_ID,
        status: 'complete',
        generator: { name: 'Orogen', version: GENERATOR_VERSION },
        targetEngine: TARGET_ENGINE,
        project: { seed: settings.seed },
        terrain: { sizeM: settings.terrainSize, heightRangeM: settings.heightRange, seaLevel: settings.seaLevel },
        resolution: { x: res, y: res },
        landscape: landscape && state.height && plan.layout ? landscapeMember(landscape.item, state.height) : null,
        textures: items.flatMap(({ item }): ManifestTexture[] => (item.kind !== 'texture' ? [] : [{
          content: item.content, file: textureFile(item, res), size: textureSide(item.size, res), channels: item.content === 'mask' ? 1 : 3, bits: item.bits,
          srgb: item.content === 'color', covers: 'landscapeExtent', sampling: 'texel-center',
          ...(item.content === 'normal' ? { normalEncoding: 'xyz-landscape-axes' as const } : {}),
        }])),
        images: items.flatMap(({ item }, index): ManifestImage[] => (item.kind !== 'image' ? [] : [{
          file: imageFile(item), format: item.format, width: res, height: res,
          valueMin: imageRanges.get(index)?.min ?? null, valueMax: imageRanges.get(index)?.max ?? null,
        }])),
        splines: null,
        files: visible.map((file) => ({ ...file })),
      };
      const text = new TextEncoder().encode(serializeJson(manifest));
      const path = manifestFile(plan.name);
      try {
        await sink.write(path, text);
      } catch (thrown) {
        throw new BuildFailure('E_COMMIT_FAILED', `Cannot write the manifest ${path}: ${reasonOf(thrown)}; the data files of this build are in place without it, so build again.`);
      }
      manifestPath = path;
      visible.push({ path, bytes: text.byteLength });
    } catch (thrown) {
      state.status = 'errors';
      fatal(thrown instanceof BuildFailure ? thrown : { code: 'E_COMMIT_FAILED', message: reasonOf(thrown) });
    }
    // Closing a file is what flushes its compressor and puts it in place: at 8129 a fifth of a build's time.
    commitMs = performance.now() - began;
  }

  function landscapeMember(item: LandscapeItem, h: HeightInfo): ManifestLandscape {
    const transform = landscapeTransform({
      resolution: res, terrainSize: settings.terrainSize, heightRange: settings.heightRange, seaLevel: settings.seaLevel,
      a: h.a, b: h.b, zeroAt: item.zeroAt, origin: item.origin,
    });
    const paths = heightFiles(plan.name);
    return {
      layout: manifestLayout(plan.layout!),
      heightmap: {
        r16: paths.r16, png: paths.png, rangeMode: item.range.mode, valueMin: h.a, valueMax: h.b,
        heightMinM: transform.heightMinM, heightMaxM: transform.heightMaxM, measuredMin: h.measuredMin, measuredMax: h.measuredMax,
        clippedSamples: h.clipped, zScaleFormula: Z_SCALE_FORMULA, dither: item.dither ? 'tpdf-1lsb' : 'none',
      },
      transform: manifestTransform(transform),
      orientation: { ...ORIENTATION },
      seaLevelZCm: transform.seaLevelZCm,
      worldPartition: { enabled: item.worldPartition.enabled, gridSize: item.worldPartition.gridSize, regionSize: item.worldPartition.regionSize },
      alphamapType: 'Additive',
      layers: plan.layers.map((layer) => {
        const paths8 = layerFiles(layer.name);
        return { name: layer.name, r8: paths8.r8, png: paths8.png, blend: layer.blend, base: layer.base, meanWeight: meanWeight(layer.name) };
      }),
    };
  }

  // A build that did not succeed changes no file under a final name: every writer still open is aborted (3.4).
  opts.signal?.removeEventListener('abort', follow);
  const { status } = state;
  if (status !== 'ok') await sink.abortAll().catch(() => {});

  // ---- phase 5: the report -----------------------------------------------------------------------------------------
  const ended = performance.now();
  const reportPath = reportFile(plan.name);
  const h = state.height;
  const body: BuildReport = {
    schema: REPORT_SCHEMA_ID,
    status,
    generator: { name: 'Orogen', version: GENERATOR_VERSION },
    startedUtc: startedAt.toISOString(),
    endedUtc: new Date().toISOString(),
    durationMs: ended - startedMs,
    resolution: res,
    problems,
    targets: report,
    weightsMs,
    commitMs,
    peakPoolBytes: pool.peak,
    height: h === null ? null : { measuredMin: h.measuredMin, measuredMax: h.measuredMax, valueMin: h.a, valueMax: h.b, clippedSamples: h.clipped },
    // The layers whose bytes were written: all of them in a build that succeeded.
    layers: plan.layers.filter((layer) => layerSums.has(layer.name)).map((layer) => ({ name: layer.name, base: layer.base, blend: layer.blend, meanWeight: meanWeight(layer.name) })),
    files: visible,
  };
  let reportWritten: string | null = reportPath;
  try {
    await sink.write(reportPath, serializeJson(body));
  } catch (thrown) {
    reportWritten = null;
    // The build's files are what they are; that its report could not be written does not change its status.
    found({ severity: 'warning', code: 'E_WRITE_FAILED', message: `Cannot write the report ${reportPath}: ${reasonOf(thrown)}.` });
  }

  const result: BuildResult = {
    requestId, status, problems,
    files: status === 'ok' ? visible : [],
    manifest: status === 'ok' ? manifestPath : null,
    report: reportWritten,
    outDir: null,
    peakPoolBytes: pool.peak,
  };
  emit({ type: 'build-result', requestId, result });
  return result;
}
