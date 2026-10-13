// The acceptance pattern of export-unreal.md section 9: a complete build named `Marker`, made without a project
// and without a GPU, whose markers tell every way an import can mirror, turn, shift or rescale a landscape; and
// the check of a heightmap exported from Unreal against that pattern.
//
// What the pattern is expected to look like in Unreal rests on statements the contract marks unverified (its
// section 11): the pattern exists to settle them, and nothing here has been imported into Unreal Engine.

import type { BuildResult, FileSink, FileWriter } from '../core/runtime.ts';
import { createPngEncoder, type RowEncoder } from './encode/png.ts';
import { createRawEncoder } from './encode/raw.ts';
import {
  GENERATOR_VERSION, MANIFEST_SCHEMA_ID, manifestLayout, ORIENTATION, REPORT_SCHEMA_ID, serializeJson, TARGET_ENGINE,
  type BuildReport, type Manifest, type ManifestLandscape,
} from './manifest.ts';
import { heightFiles, layerFiles, manifestFile, reportFile } from './plan.ts';
import { landscapeLayout, quantiseWeights, Z_SCALE_FORMULA } from './unreal.ts';

export const MARKER_NAME = 'Marker';
/** The resolutions of the pattern and the step of its ramp at each: codes per column. */
export const MARKER_STEPS: Readonly<Record<number, number>> = { 1009: 16, 2017: 8, 4033: 4, 8129: 2 };
export const MARKER_DEFAULT_RES = 1009;
const TEXTURE_SIDE = 1024;
const TEXTURE_FILE = `T_${MARKER_NAME}_${TEXTURE_SIDE}.png`;
/** Rows per write: 512 rows of 8129 codes are 8.3 MB. */
const BAND_ROWS = 512;

export const isMarkerResolution = (res: number): boolean => Object.hasOwn(MARKER_STEPS, res);

/**
 * 9.1: the code at image column `x` and row `y`. The plain is 32768; the tower, 64 x 64 at the top left, 65535;
 * the pit, 64 wide and 32 rows deep at the top right, 0; the ramp, along the bottom 32 rows, rises with the column.
 */
export function markerCode(res: number, x: number, y: number): number {
  if (y >= res - 32) return 32768 + MARKER_STEPS[res]! * x;
  if (x < 64 && y < 64) return 65535;
  if (x >= res - 64 && y < 32) return 0;
  return 32768;
}

/** Rows `y0 <= y < y1` of the pattern's heightmap. */
export function markerRows(res: number, y0: number, y1: number): Uint16Array {
  const out = new Uint16Array((y1 - y0) * res);
  for (let y = y0, i = 0; y < y1; y++) {
    for (let x = 0; x < res; x++) out[i++] = markerCode(res, x, y);
  }
  return out;
}

/** The transform the manifest of the pattern states: vertex (0, 0) at the world origin, 100 cm per quad, code 32768 at Z = 0. */
export function markerTransform(res: number): ManifestLandscape['transform'] {
  return {
    scaleCm: { x: 100, y: 100, z: 100 },
    actorLocationCm: { x: 0, y: 0, z: 0 },
    uiLocationCm: { x: 50 * (res - 1), y: 50 * (res - 1), z: 0 },
    rotationDeg: { pitch: 0, yaw: 0, roll: 0 },
  };
}

/** The mapped range of the pattern: with an actor Z scale of 100, the 65535 steps span 511.9921875 m. */
const RANGE_M = 65535 / 128;

/**
 * Writes the pattern as a complete build into the sink: the heightmap as PNG and `.r16`, the layers `Base`,
 * `Left` and `Top`, the texture, the manifest and the report. The data files are closed together at the end and
 * the manifest is written after them, as a build of the pipeline does it.
 */
export async function writeMarkerBuild(sink: FileSink, res: number, requestId = 0): Promise<BuildResult> {
  if (!isMarkerResolution(res)) throw new RangeError(`The acceptance pattern exists at ${Object.keys(MARKER_STEPS).join(', ')}, not at ${String(res)}`);
  const layout = landscapeLayout(res)!;
  const started = new Date();
  const startedMs = performance.now();

  const order: string[] = [];
  const open = new Map<string, { readonly writer: FileWriter; bytes: number }>();
  const create = async (path: string): Promise<FileWriter> => {
    const writer = await sink.create(path);
    const file = { writer, bytes: 0 };
    open.set(path, file);
    order.push(path);
    return {
      write(chunk) {
        file.bytes += chunk.byteLength;
        return writer.write(chunk);
      },
      close: () => Promise.reject(new Error('An encoder does not close its file')),
      abort: () => Promise.reject(new Error('An encoder does not abort its file')),
    };
  };
  const pairOf = async <S extends Uint8Array | Uint16Array>(png: string, raw: string, bits: 8 | 16): Promise<readonly RowEncoder<S>[]> => [
    createPngEncoder(await create(png), { width: res, height: res, channels: 1, bits }) as RowEncoder<S>,
    createRawEncoder(await create(raw), { width: res, height: res, sample: bits === 8 ? 'u8' : 'u16' }) as RowEncoder<S>,
  ];

  try {
    const heights = heightFiles(MARKER_NAME);
    const height = await pairOf<Uint16Array>(heights.png, heights.r16, 16);
    // The layers in the order of the manifest: the base, the weight-blended `Left`, the independent `Top`.
    const names = ['Base', 'Left', 'Top'] as const;
    const layers: (readonly RowEncoder<Uint8Array>[])[] = [];
    for (const name of names) layers.push(await pairOf<Uint8Array>(layerFiles(name).png, layerFiles(name).r8, 8));
    const sums = [0, 0, 0];
    const half = (res - 1) / 2;

    for (let y0 = 0; y0 < res; y0 += BAND_ROWS) {
      const y1 = Math.min(res, y0 + BAND_ROWS);
      const count = (y1 - y0) * res;
      const codes = markerRows(res, y0, y1);
      for (const encoder of height) await encoder.write(codes);

      // `Left` as the 16-bit codes of a weight-blended layer; the base is what it leaves, by the joint rule of 5.8.
      const left = new Uint16Array(count);
      const top = new Uint8Array(count);
      for (let y = y0, i = 0; y < y1; y++) {
        for (let x = 0; x < res; x++, i++) {
          left[i] = x < half ? 65535 : 0;
          top[i] = y < half ? 255 : 0;
        }
      }
      const blended = [new Uint8Array(count), new Uint8Array(count)];
      quantiseWeights([left], blended, { offset: 0, count, floorCode: 0, limit: 0 });
      for (const [j, bytes] of [blended[0]!, blended[1]!, top].entries()) {
        for (let i = 0; i < count; i++) sums[j]! += bytes[i]!;
        for (const encoder of layers[j]!) await encoder.write(bytes);
      }
    }
    for (const encoder of [...height, ...layers.flat()]) await encoder.end();

    // The texture: red in the quarter of the tower, green in that of the pit, blue at the bottom left, white at the bottom right.
    const texture = createPngEncoder(await create(TEXTURE_FILE), { width: TEXTURE_SIDE, height: TEXTURE_SIDE, channels: 3, bits: 8 });
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]] as const;
    for (let j0 = 0; j0 < TEXTURE_SIDE; j0 += BAND_ROWS) {
      const rows = new Uint8Array(BAND_ROWS * TEXTURE_SIDE * 3);
      for (let j = j0, w = 0; j < j0 + BAND_ROWS; j++) {
        for (let i = 0; i < TEXTURE_SIDE; i++, w += 3) rows.set(colors[(j < TEXTURE_SIDE / 2 ? 0 : 2) + (i < TEXTURE_SIDE / 2 ? 0 : 1)]!, w);
      }
      await texture.write(rows);
    }
    await texture.end();

    // The commit: every data file, then the manifest.
    const files: { path: string; bytes: number }[] = [];
    for (const path of order) {
      const file = open.get(path)!;
      const closed = await file.writer.close();
      if (closed.bytes !== file.bytes) throw new Error(`Cannot write ${path}: ${file.bytes} bytes were handed to the file and it reports ${closed.bytes}`);
      files.push({ path, bytes: file.bytes });
    }
    const seaLevel = 32768 / 65535;
    const manifest: Manifest = {
      schema: MANIFEST_SCHEMA_ID,
      status: 'complete',
      generator: { name: 'Orogen', version: GENERATOR_VERSION },
      targetEngine: TARGET_ENGINE,
      project: { seed: 0 },
      // The pattern's project: N − 1 metres wide, the 65535 steps as its height range, the sea at code 32768.
      terrain: { sizeM: res - 1, heightRangeM: RANGE_M, seaLevel },
      resolution: { x: res, y: res },
      landscape: {
        layout: manifestLayout(layout),
        heightmap: {
          r16: heights.r16, png: heights.png, rangeMode: 'fixed', valueMin: 0, valueMax: 1,
          heightMinM: -256, heightMaxM: 65535 / 128 - 256, measuredMin: 0, measuredMax: 1,
          clippedSamples: 0, zScaleFormula: Z_SCALE_FORMULA, dither: 'none',
        },
        transform: markerTransform(res),
        orientation: { ...ORIENTATION },
        seaLevelZCm: 0,
        worldPartition: { enabled: true, gridSize: 4, regionSize: 32 },
        alphamapType: 'Additive',
        layers: names.map((name, j) => ({
          name, r8: layerFiles(name).r8, png: layerFiles(name).png, blend: name === 'Top' ? 'none' : 'advanced', base: name === 'Base',
          meanWeight: sums[j]! / (res * res * 255),
        })),
      },
      textures: [{
        content: 'color', file: TEXTURE_FILE, size: TEXTURE_SIDE, channels: 3, bits: 8, srgb: true, covers: 'landscapeExtent', sampling: 'texel-center',
      }],
      images: [],
      splines: null,
      files: files.map((file) => ({ ...file })),
    };
    const text = new TextEncoder().encode(serializeJson(manifest));
    const manifestPath = manifestFile(MARKER_NAME);
    await sink.write(manifestPath, text);
    files.push({ path: manifestPath, bytes: text.byteLength });

    const report: BuildReport = {
      schema: REPORT_SCHEMA_ID,
      status: 'ok',
      generator: { name: 'Orogen', version: GENERATOR_VERSION },
      startedUtc: started.toISOString(),
      endedUtc: new Date().toISOString(),
      durationMs: performance.now() - startedMs,
      resolution: res,
      problems: [],
      targets: [],
      weightsMs: null,
      commitMs: null,
      height: { measuredMin: 0, measuredMax: 1, valueMin: 0, valueMax: 1, clippedSamples: 0 },
      layers: manifest.landscape!.layers.map(({ name, base, blend, meanWeight }) => ({ name, base, blend, meanWeight })),
      files,
    };
    const reportPath = reportFile(MARKER_NAME);
    await sink.write(reportPath, serializeJson(report));
    return { requestId, status: 'ok', problems: [], files, manifest: manifestPath, report: reportPath, outDir: null };
  } catch (thrown) {
    await sink.abortAll().catch(() => {});
    const message = `Cannot write the acceptance pattern: ${thrown instanceof Error ? thrown.message : String(thrown)}.`;
    return { requestId, status: 'errors', problems: [{ severity: 'error', code: 'E_WRITE_FAILED', message }], files: [], manifest: null, report: null, outDir: null };
  }
}

export interface MarkerCheck {
  /** Samples that differ from the pattern. */
  readonly differing: number;
  /** The largest difference, in codes. */
  readonly largest: number;
  /** The first sample that differs: its column, its row, the code found and the code of the pattern. */
  readonly first: { readonly x: number; readonly y: number; readonly found: number; readonly expected: number } | null;
}

/** 9.3: compares `res * res` codes, row-major with row 0 first, with the pattern. */
export function checkMarker(codes: ArrayLike<number>, res: number): MarkerCheck {
  if (!isMarkerResolution(res)) throw new RangeError(`The acceptance pattern exists at ${Object.keys(MARKER_STEPS).join(', ')}, not at ${String(res)}`);
  if (codes.length !== res * res) throw new RangeError(`${codes.length} samples are not a heightmap of ${res} x ${res}`);
  let differing = 0, largest = 0;
  let first: MarkerCheck['first'] = null;
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i++) {
      const found = codes[i]!, expected = markerCode(res, x, y);
      if (found === expected) continue;
      differing++;
      largest = Math.max(largest, Math.abs(found - expected));
      first ??= { x, y, found, expected };
    }
  }
  return { differing, largest, first };
}
