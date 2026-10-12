// What the tests of the shared operations (engine.md section 5) share: a node that calls the function a test
// registers, an engine made as the evaluator's tests make theirs, CPU references, and comparisons that report
// the worst texel instead of handing a field to an assertion. Not a test file.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { defineNode, hashCell, hashUnit, type AnyKernel, type EvalContext, type Field, type FieldKind, type NodeDef } from '../../../src/core/api.ts';
import fbmNode from '../../../src/core/nodes/ref/fbm.ts';
import type { EngineTestHooks, NodeError, ProjectSettings } from '../../../src/core/runtime.ts';
import { constantNode, rampNode, startEngine, tintNode, type NodeSpec, type RunOutcome, type TestEngine } from '../eval/rig.ts';

export { SETTINGS } from '../eval/rig.ts';

// ---- the node --------------------------------------------------------------------------------------------------

export type Script = (ctx: EvalContext) => void | Promise<void>;
const scripts = new Map<string, Script>();

/**
 * A node that calls the script a test registered, then gives a blank `out`. The kernels of the ops are the engine's
 * own; `kernels` are those a test file runs itself.
 */
function scriptNode(kernels: readonly AnyKernel[]): NodeDef {
  return defineNode({
    type: 'ref/ops',
    title: 'Shared Operations (Test)',
    category: 'ref',
    description: 'Calls the function a test registered.',
    inputs: [{ name: 'in', type: 'field', optional: true }, { name: 'tint', type: 'color', optional: true }],
    outputs: [{ name: 'out', type: 'field' }],
    params: [{ kind: 'text', name: 'script', default: '', help: 'The registered function to call.' }],
    kernels,
    async evaluate(ctx) {
      await scripts.get(ctx.params.script)!(ctx);
      ctx.output('out', ctx.alloc('field', { clear: 0 }));
    },
  });
}

export interface RunOptions {
  /** Evaluation resolution; default 65. */
  readonly res?: number;
  /** Nodes that feed the script node: their outputs are named in `inputs`. */
  readonly sources?: Readonly<Record<string, NodeSpec>>;
  /** input port of the script node → '<node id>.<output port>'. */
  readonly inputs?: Readonly<Record<string, string>>;
  readonly settings?: Partial<ProjectSettings>;
  readonly signal?: AbortSignal;
}

export interface OpsRig {
  readonly t: TestEngine;
  /** One evaluation of the script node, as a build so that it always runs. Fails unless it ends 'ok' and leaves nothing WORKING. */
  run(fn: Script, opts?: RunOptions): Promise<RunOutcome>;
  /** As run(), for a script that is expected to fail: the one error of the evaluation. */
  fail(fn: Script, opts?: RunOptions): Promise<NodeError>;
  dispose(): Promise<void>;
}

/** One engine per test process: the node definitions are made here, before createEngine seals them. */
export async function startOps(setup: { readonly hooks?: EngineTestHooks; readonly kernels?: readonly AnyKernel[]; readonly nodes?: readonly NodeDef[] } = {}): Promise<OpsRig> {
  const t = await startEngine([scriptNode(setup.kernels ?? []), constantNode, rampNode, tintNode, fbmNode, ...(setup.nodes ?? [])], { hooks: setup.hooks ?? {} });
  let serial = 0;
  const evaluate = async (fn: Script, opts: RunOptions): Promise<RunOutcome> => {
    const name = `s${++serial}`;
    scripts.set(name, fn);
    const doc = t.doc({ ...opts.sources, n: { type: 'ref/ops', params: { script: name }, ...(opts.inputs ? { inputs: opts.inputs } : {}) } }, opts.settings);
    try {
      return await t.run(doc, ['n.out'], { mode: 'build', resolution: opts.res ?? 65, ...(opts.signal ? { signal: opts.signal } : {}) });
    } finally {
      scripts.delete(name);
      t.noLeaks();
    }
  };
  return {
    t,
    async run(fn, opts = {}) {
      const outcome = await evaluate(fn, opts);
      assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result.errors.map((e) => `${e.kind}: ${e.message}`)));
      return outcome;
    },
    async fail(fn, opts = {}) {
      const outcome = await evaluate(fn, opts);
      assert.equal(outcome.result.status, 'errors');
      const failed = outcome.result.errors.filter((e) => e.nodeId === 'n');
      assert.equal(failed.length, 1, JSON.stringify(outcome.result.errors));
      return failed[0]!;
    },
    dispose: () => t.dispose(),
  };
}

/** A new field of the node holding `data`, in the layout of ctx.read. */
export function upload<K extends FieldKind>(ctx: EvalContext, kind: K, size: number | readonly [number, number], data: Float32Array): Field<K> {
  const field = ctx.alloc(kind, { size });
  ctx.write(field, data);
  return field;
}

// ---- data ------------------------------------------------------------------------------------------------------

/** Row-major texels of a width x height grid with one or more channels: `value(x, y)` is a number or the texel's channels. */
export function grid(width: number, height: number, value: (x: number, y: number) => number | readonly number[]): Float32Array {
  const first = value(0, 0);
  const count = typeof first === 'number' ? 1 : first.length;
  const out = new Float32Array(width * height * count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = value(x, y);
      if (typeof v === 'number') out[y * width + x] = v;
      else out.set(v, (y * width + x) * count);
    }
  }
  return out;
}

/** A value in [0, 1) per texel that has nothing in common with its neighbours'. */
export const speckle = (x: number, y: number, seed = 7): number => hashUnit(hashCell(x, y, seed));

/** A smooth height over the terrain, 0.1 .. 0.9, as a function of uv: every grid samples the same surface. */
export function hills(u: number, v: number): number {
  return 0.5 + 0.2 * Math.sin(2 * Math.PI * 1.5 * u) * Math.cos(2 * Math.PI * v)
    + 0.12 * Math.sin(2 * Math.PI * (2.5 * u + 1.5 * v) + 0.7) + 0.08 * Math.cos(2 * Math.PI * 3.5 * v + 0.3);
}

/** `fn(u, v)` sampled on the vertices of an n x n grid: uv = px / (n - 1). */
export const sampled = (n: number, fn: (u: number, v: number) => number): Float32Array =>
  grid(n, n, (x, y) => fn(x / Math.max(n - 1, 1), y / Math.max(n - 1, 1)));

// ---- comparisons -----------------------------------------------------------------------------------------------

export interface Worst { readonly difference: number; readonly index: number; readonly count: number }

/** Largest absolute difference between `actual` and `expected`, where it is, and how many floats differ by more than `tolerance`. */
export function worstOf(actual: Float32Array, expected: ArrayLike<number> | ((index: number) => number), tolerance = 0): Worst {
  const at = typeof expected === 'function' ? expected : (i: number): number => expected[i]!;
  let difference = 0, index = -1, count = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i]! - at(i));
    if (!(d <= tolerance)) count++;
    if (!(d <= difference)) {
      difference = d;
      index = i;
    }
  }
  return { difference, index, count };
}

/** Fails unless every float of `actual` is within `tolerance` of `expected`; names the worst and the count. */
export function assertClose(
  actual: Float32Array, expected: ArrayLike<number> | ((index: number) => number), tolerance: number, message: string,
): Worst {
  if (typeof expected !== 'function') assert.equal(actual.length, expected.length, `${message}: the number of floats`);
  const at = typeof expected === 'function' ? expected : (i: number): number => expected[i]!;
  const worst = worstOf(actual, at, tolerance);
  if (worst.count > 0) {
    assert.fail(`${message}: ${worst.count} of ${actual.length} floats differ by more than ${tolerance}; the worst is float ${worst.index}: ${actual[worst.index]} against ${at(worst.index)}`);
  }
  return worst;
}

/** Fails unless the two readbacks are bit-identical; names the first float that differs and the count. */
export function assertIdentical(a: Float32Array, b: Float32Array, message: string): void {
  assert.equal(a.length, b.length, `${message}: the number of floats`);
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  let differing = 0, first = -1;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    differing++;
    if (first < 0) first = i;
  }
  if (differing > 0) assert.fail(`${message}: ${differing} of ${a.length} floats differ; the first is float ${first}: ${a[first]} against ${b[first]}`);
}

/** One channel of a readback with `channels` floats per texel. */
export function channel(data: Float32Array, channels: number, index: number): Float32Array {
  const out = new Float32Array(data.length / channels);
  for (let i = 0; i < out.length; i++) out[i] = data[i * channels + index]!;
  return out;
}

export function rangeOf(data: ArrayLike<number>): { readonly min: number; readonly max: number; readonly nonFinite: number } {
  let min = Infinity, max = -Infinity, nonFinite = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) nonFinite++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max, nonFinite };
}

// ---- CPU references, in float64 --------------------------------------------------------------------------------

const clampIndex = (i: number, n: number): number => Math.min(Math.max(i, 0), n - 1);

/**
 * engine.md section 5, blur: per axis the weights exp(-d^2 / 2 sigma^2) for |d| <= 3 sigma, renormalised; reads
 * clamp to the border. `sigma` is in texels of the n x n grid; `channels` floats per texel.
 */
export function gaussianReference(data: Float32Array, n: number, channels: number, sigma: number): Float64Array {
  const radius = Math.floor(3 * sigma);
  const weights: number[] = [];
  let norm = 0;
  for (let d = -radius; d <= radius; d++) {
    const w = Math.exp(-(d * d) / (2 * sigma * sigma));
    weights.push(w);
    norm += w;
  }
  const axis = (src: ArrayLike<number>, dx: number, dy: number): Float64Array => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        for (let c = 0; c < channels; c++) {
          let sum = 0;
          for (let d = -radius; d <= radius; d++) {
            sum += weights[d + radius]! * src[(clampIndex(y + d * dy, n) * n + clampIndex(x + d * dx, n)) * channels + c]!;
          }
          out[(y * n + x) * channels + c] = sum / norm;
        }
      }
    }
    return out;
  };
  return axis(axis(data, 1, 0), 0, 1);
}

export type ReferenceFilter = 'nearest' | 'bilinear' | 'tent' | 'bspline';

/** The weight of a source texel at distance `d` from the mapped position, for a filter of scale `w` source texels. */
function filterWeight(filter: 'tent' | 'bspline', d: number, w: number): number {
  const x = Math.abs(d) / w;
  if (filter === 'tent') return Math.max(1 - x, 0);
  if (x >= 2) return 0;
  return x >= 1 ? (2 - x) ** 3 / 6 : 2 / 3 - x * x * (1 - x / 2);
}

/**
 * engine.md section 5, resample, as one filter applied at the mapped position t = p * (source - 1) / (size - 1):
 * 'nearest' the nearest source texel (a tie goes up), 'bilinear' the triangle of half-width one source texel,
 * 'tent' the triangle as wide as the reduction and never narrower than a source texel, 'bspline' the cubic
 * B-spline of that scale. Weights are renormalised and reads clamp to the border.
 *
 * `rings` is for one pass of a large reduction: with `src` the data has one texel more on every side than its
 * grid has vertices, with `out` the result gets one (width and height count the texels of the data as given).
 */
export function resampleReference(
  data: ArrayLike<number>, width: number, height: number, channels: number, size: number, filter: ReferenceFilter,
  rings: { readonly src?: 0 | 1; readonly out?: 0 | 1 } = {},
): Float64Array {
  const ringIn = rings.src ?? 0, ringOut = rings.out ?? 0;
  const side = size + 2 * ringOut;
  const out = new Float64Array(side * side * channels);
  const span = Math.max(size - 1, 1);
  const taps = (texel: number, texels: number): { readonly index: number; readonly weight: number }[] => {
    const vertices = texels - 2 * ringIn;
    const t = ((texel - ringOut) * (vertices - 1)) / span + ringIn;
    if (filter === 'nearest') return [{ index: clampIndex(Math.floor(t + 0.5), texels), weight: 1 }];
    const scale = filter === 'bilinear' ? 1 : Math.max((vertices - 1) / span, 1);
    const shape = filter === 'bspline' ? 'bspline' : 'tent';
    const reach = shape === 'bspline' ? 2 * scale : scale;
    const list: { index: number; weight: number }[] = [];
    for (let i = Math.floor(t - reach); i <= Math.ceil(t + reach); i++) {
      const weight = filterWeight(shape, i - t, scale);
      if (weight > 0) list.push({ index: clampIndex(i, texels), weight });
    }
    return list;
  };
  for (let y = 0; y < side; y++) {
    const rows = taps(y, height);
    for (let x = 0; x < side; x++) {
      const columns = taps(x, width);
      for (let c = 0; c < channels; c++) {
        let sum = 0, norm = 0;
        for (const row of rows) {
          for (const column of columns) {
            const w = row.weight * column.weight;
            sum += w * data[(row.index * width + column.index) * channels + c]!;
            norm += w;
          }
        }
        out[(y * side + x) * channels + c] = sum / norm;
      }
    }
  }
  return out;
}

/** engine.md 3.8, slopeAt: the gradient in metres per metre, central and one-sided on the border, of an n x n height grid. */
export function slopeReference(heights: ArrayLike<number>, n: number, terrainSize: number, heightRange: number): { readonly dx: Float64Array; readonly dy: Float64Array } {
  const dx = new Float64Array(n * n), dy = new Float64Array(n * n);
  const cell = terrainSize / Math.max(n - 1, 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(x - 1, 0), x1 = Math.min(x + 1, n - 1), y0 = Math.max(y - 1, 0), y1 = Math.min(y + 1, n - 1);
      dx[y * n + x] = ((heights[y * n + x1]! - heights[y * n + x0]!) * heightRange) / (Math.max(x1 - x0, 1) * cell);
      dy[y * n + x] = ((heights[y1 * n + x]! - heights[y0 * n + x]!) * heightRange) / (Math.max(y1 - y0, 1) * cell);
    }
  }
  return { dx, dy };
}

// ---- pictures --------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT = process.env.OROGEN_TEST_OUTPUT ? path.resolve(process.env.OROGEN_TEST_OUTPUT) : path.join(ROOT, 'test-output');

/**
 * An 8-bit RGB PNG under test-output/ of a readback with `channels` floats per texel: `range` maps to 0..255 per
 * channel; texel (0, 0) is the top left pixel. For a person to look at; the bytes are never compared.
 */
export function writeRgb(name: string, data: Float32Array, width: number, channels: number, range: readonly [number, number]): string {
  const height = data.length / channels / width;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);   // every row begins with filter type 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const v = (data[(y * width + x) * channels + c]! - range[0]) / (range[1] - range[0]);
        raw[y * stride + 1 + x * 3 + c] = Number.isFinite(v) ? Math.round(Math.min(Math.max(v, 0), 1) * 255) : c === 1 ? 0 : 255;
      }
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([length, typed, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bits per channel
  header[9] = 2;   // colour type: RGB
  const file = path.join(OUTPUT, `${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}
