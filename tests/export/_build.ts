// What the GPU tests of the build pipeline share: the graph they build, direct calls of buildProject on the
// process's engine, and the decoding of what a build wrote, with readers that are not the encoders.

import assert from 'node:assert/strict';

import { decodeImage } from '../../src/core/api.ts';
import type { BuildEvent, BuildResult, Engine, EvalEvent, GraphDoc } from '../../src/core/runtime.ts';
import { buildProject } from '../../src/export/build.ts';
import type { BuildReport, Manifest } from '../../src/export/manifest.ts';
import { expectNoLeaks, getEngine, memorySink, type FieldData, type GraphSpec, type MemorySink } from '../helpers/index.ts';
import { readPng } from './unit/_support.ts';

/** The settings of the test builds: not those of the harness, so that every factor of the transform shows. */
export const SETTINGS = { terrainSize: 2000, heightRange: 600, seaLevel: 0.3, seed: 7, buildResolution: 241, previewLevel: 1 } as const;

/**
 * A terrain, two masks of it and a colouring, with every kind of export: the landscape, two weight-blended
 * layers and an independent one, the three textures, and images in a float and a whole-number format.
 */
export function fullGraph(landscape: Readonly<Record<string, string | number | boolean>> = {}): GraphSpec {
  return {
    settings: SETTINGS,
    nodes: {
      land: { type: 'ref/fbm', params: { octaves: 4 } },
      rock: { type: 'ref/slope-mask', params: { slopeMin: 10, slopeMax: 20 }, inputs: { in: 'land.out' } },
      scree: { type: 'ref/slope-mask', params: { slopeMin: 4, slopeMax: 12 }, inputs: { in: 'land.out' } },
      paint: { type: 'ref/colorize', inputs: { in: 'land.out' } },
      outland: { type: 'io/export-landscape', params: { name: 'Test Land 1', dither: false, ...landscape }, inputs: { in: 'land.out' } },
      outrock: { type: 'io/export-layer', params: { layer: 'Rock' }, inputs: { in: 'rock.out' } },
      outscree: { type: 'io/export-layer', params: { layer: 'Scree' }, inputs: { in: 'scree.out' } },
      outsteep: { type: 'io/export-layer', params: { layer: 'Steep', weightBlended: false }, inputs: { in: 'rock.out' } },
      outpaint: { type: 'io/export-color', inputs: { in: 'paint.out' } },
      outnormal: { type: 'io/export-normal', inputs: { in: 'land.out' } },
      outmask: { type: 'io/export-mask', params: { bits: '16' }, inputs: { in: 'scree.out' } },
      outexr: { type: 'io/export-field', params: { name: 'Heights' }, inputs: { in: 'land.out' } },
      outpng: { type: 'io/export-field', params: { name: 'Steepness', format: 'png16', rangeMode: 'measured' }, inputs: { in: 'land.out' } },
    },
  };
}

/** The files of fullGraph in the order of the plan, the manifest last. */
export const FULL_FILES: readonly string[] = [
  'TestLandHeight.png', 'TestLandHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerRock.png', 'LayerRock.r8', 'LayerScree.png', 'LayerScree.r8',
  'LayerSteep.png', 'LayerSteep.r8', 'T_Color_1024.png', 'T_Mask_1024.png', 'T_Normal_1024.png', 'Heights.exr', 'Steepness.png', 'TestLand.orogen.json',
];

export interface Built {
  readonly result: BuildResult;
  readonly sink: MemorySink;
  /** Everything the build emitted, the events of its evaluation among them, in order. */
  readonly events: readonly (EvalEvent | BuildEvent)[];
}

// Request ids of the direct builds: far above the harness's own, which follow each one used here (runtime.md 5.2).
let requestId = 1_000_000;

/**
 * buildProject on the process's engine, with what a test wants to see or to do meanwhile. `wrap` gives the
 * engine the pipeline is handed: the real one behind a spy.
 */
export async function direct(doc: GraphDoc, opts: {
  readonly resolution?: number;
  readonly signal?: AbortSignal;
  readonly sink?: MemorySink;
  readonly onEvent?: (event: EvalEvent | BuildEvent, engine: Engine) => void;
  readonly wrap?: (engine: Engine) => Engine;
} = {}): Promise<Built> {
  const { engine } = await getEngine();
  await engine.trim();
  const sink = opts.sink ?? memorySink();
  const events: (EvalEvent | BuildEvent)[] = [];
  requestId += 1000;
  const result = await buildProject(opts.wrap ? opts.wrap(engine) : engine, {
    doc, sink, requestId,
    ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onEvent(event) {
      events.push(event);
      opts.onEvent?.(event, engine);
    },
  });
  await expectNoLeaks();
  assert.equal(engine.memory().cacheBytes, 0, 'a build leaves nothing in the cache');
  return { result, sink, events };
}

/** The id the document gave the one node of a type (and, for a layer node, of a layer name). */
export function idOf(doc: GraphDoc, type: string, layer?: string): string {
  const found = Object.values(doc.nodes).filter((node) => node.type === type && (layer === undefined || node.params.layer === layer));
  assert.equal(found.length, 1, `one node of type ${type}`);
  return found[0]!.id;
}

export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
export const manifestOf = (sink: MemorySink, name: string): Manifest => JSON.parse(text(sink.files.get(`${name}.orogen.json`)!)) as Manifest;
export const reportOf = (sink: MemorySink, name: string): BuildReport => JSON.parse(text(sink.files.get(`${name}.report.json`)!)) as BuildReport;

export function file(sink: MemorySink, path: string): Uint8Array {
  const bytes = sink.files.get(path);
  assert.ok(bytes, `the build holds ${path}; it holds ${[...sink.files.keys()].join(', ')}`);
  return bytes;
}

/** The samples of a little-endian `.r16` file. */
export function u16(bytes: Uint8Array): Uint16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => view.getUint16(2 * i, true));
}

/** The samples of a PNG the build wrote, read with the reader of the tests, and its shape checked. */
export function pngSamples(sink: MemorySink, path: string, shape: { readonly size: number; readonly channels: 1 | 3; readonly bits: 8 | 16 }): Uint8Array | Uint16Array {
  const png = readPng(file(sink, path));
  assert.deepEqual([png.width, png.height, png.channels, png.bits], [shape.size, shape.size, shape.channels, shape.bits], path);
  return png.samples;
}

/** The floats of an OpenEXR or float TIFF file, through the project's decoder. */
export async function floats(sink: MemorySink, path: string, size: number): Promise<Float32Array> {
  const image = await decodeImage.run({ bytes: file(sink, path).slice() }, { progress() { /* not shown */ } });
  assert.deepEqual([image.width, image.height, image.channels], [size, size, 1], path);
  return image.data;
}

/** How two lists of codes differ: how many elements, and by how much at the most. */
export function codeDifference(a: ArrayLike<number>, b: ArrayLike<number>): { readonly differing: number; readonly largest: number } {
  assert.equal(a.length, b.length, 'the lists have one length');
  let differing = 0, largest = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d !== 0) differing++;
    if (d > largest) largest = d;
  }
  return { differing, largest };
}

/** A texture against what 5.9 gives for it, computed in float64: equal but for texels on a rounding boundary, which are 1 apart. */
export function expectTexture(found: ArrayLike<number>, expected: ArrayLike<number>, what: string): void {
  const { differing, largest } = codeDifference(found, expected);
  assert.ok(largest <= 1, `${what}: the largest difference is ${largest} codes`);
  assert.ok(differing <= 0.0002 * found.length, `${what}: ${differing} of ${found.length} samples differ by a code`);
}

const saturate = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Channel `c` of a field on the texel grid of a texture of `side` texels, by the rule of 5.9 for a texture at
 * least as large as the field has cells: bilinear between the four vertices around each texel centre, in float64.
 */
export function onTexels(f: FieldData, side: number, c = 0): Float64Array {
  const n = f.width;
  assert.ok(side >= n - 1, 'the bilinear rule holds for a texture of at least resolution − 1 texels');
  const out = new Float64Array(side * side);
  const at = (x: number, y: number): number => f.data[(y * n + x) * f.channels + c]!;
  for (let j = 0; j < side; j++) {
    const cy = (j + 0.5) * (n - 1) / side, y0 = Math.min(Math.floor(cy), n - 2), fy = cy - y0;
    for (let i = 0; i < side; i++) {
      const cx = (i + 0.5) * (n - 1) / side, x0 = Math.min(Math.floor(cx), n - 2), fx = cx - x0;
      out[j * side + i] = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
    }
  }
  return out;
}

/** `floor(saturate(v) * max + 0.5)`: the code of a mask or of a unit image (5.8, 5.9, 4.6). */
export const unitCode = (v: number, max: number): number => Math.floor(saturate(v) * max + 0.5);

/** The vertex normals of a height field, as normalAt of engine.md 3.8, one FieldData-like plane per component. */
export function normalPlanes(h: FieldData, heightRange: number, terrainSize: number): readonly [FieldData, FieldData, FieldData] {
  const n = h.width;
  const at = (x: number, y: number): number => h.data[y * n + x]!;
  const oneSided = (a: number, b: number, c: number): number => 0.5 * (4 * b - 3 * a - c);
  const planes = [new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n)] as const;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x === 0 ? oneSided(at(0, y), at(1, y), at(2, y)) : x === n - 1 ? -oneSided(at(x, y), at(x - 1, y), at(x - 2, y)) : 0.5 * (at(x + 1, y) - at(x - 1, y));
      const dy = y === 0 ? oneSided(at(x, 0), at(x, 1), at(x, 2)) : y === n - 1 ? -oneSided(at(x, y), at(x, y - 1), at(x, y - 2)) : 0.5 * (at(x, y + 1) - at(x, y - 1));
      const sx = dx * heightRange * (n - 1) / terrainSize, sy = dy * heightRange * (n - 1) / terrainSize;
      const length = Math.hypot(sx, sy, 1);
      planes[0][y * n + x] = -sx / length;
      planes[1][y * n + x] = -sy / length;
      planes[2][y * n + x] = 1 / length;
    }
  }
  const plane = (data: Float32Array): FieldData => ({ kind: 'field', width: n, height: n, channels: 1, data });
  return [plane(planes[0]), plane(planes[1]), plane(planes[2])];
}
