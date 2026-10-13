// Acceptance graph 05 (testing.md 10.2): an image in, a build out. A file is read at its own size and resampled
// on the GPU; a build writes the landscape, a layer and a texture; what it wrote decodes to what the engine made,
// with the numbers the manifest states.
//
// The graph has an Unreal landscape size: 1009, with previews at 505. The image is the `terrain` fixture at 253,
// a level of the same ladder, so every vertex of the image is a vertex of the preview and of the build.
//
// Sizes: fields and files of 1009 x 1009 (a megabyte to four); every one is compared by a loop that counts, and
// no field, file or list of samples is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decode } from 'fast-png';

import exportColor from '../../src/core/nodes/io/export-color.ts';
import exportLandscape from '../../src/core/nodes/io/export-landscape.ts';
import exportLayer from '../../src/core/nodes/io/export-layer.ts';
import { parseDoc, type FileSource } from '../../src/core/runtime.ts';
import type { BuildReport, Manifest } from '../../src/export/manifest.ts';
import { planBuild } from '../../src/export/plan.ts';
import {
  at, buildGraph, expectIdentical, fixtures, getEngine, memorySource, openGraph, renderGraph, stats, useNodes, type FieldData, type MemorySink,
} from '../helpers/index.ts';
import { expectTargets, graphFile } from './_graphs.ts';

// The three export nodes of the graph are product nodes: the harness is handed them (testing.md 2.1).
useNodes([exportLandscape, exportLayer, exportColor]);

const GRAPH = graphFile('05-roundtrip');
const IMAGE = path.join(path.dirname(GRAPH), 'assets', 'heights-253.png');
const N = 1009;
/** One step of a 16-bit sample, as a height. */
const STEP16 = 1.6e-5;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
function fileOf(sink: MemorySink, name: string): Uint8Array {
  const bytes = sink.files.get(name);
  assert.ok(bytes, `the build wrote ${name}; it wrote ${[...sink.files.keys()].join(', ')}`);
  return bytes;
}
interface Png { readonly width: number; readonly height: number; readonly channels: number; readonly depth: number; readonly data: ArrayLike<number> }
const png = (bytes: Uint8Array): Png => decode(bytes) as Png;

/** The largest difference between the image and the field at the vertices they share: every `stride`-th of the field. */
function againstImage(field: FieldData, image: Png, stride: number): number {
  assert.equal(field.width, (image.width - 1) * stride + 1);
  let worst = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) worst = Math.max(worst, Math.abs(at(field, x * stride, y * stride) - image.data[y * image.width + x]! / 65535));
  }
  return worst;
}

test('05-roundtrip: the statistics at 505 are those of the expectation file', async () => {
  const { fields, report } = await renderGraph(GRAPH, ['image.out', 'fbm.out', 'land.out', 'rock.out', 'paint.out']);
  assert.equal(report.status, 'ok');
  expectTargets('05-roundtrip', fields);
});

test('05-roundtrip: the image is uploaded at its own size and resampled vertex-centred: its samples are the vertices it shares with the grid', async () => {
  const image = png(fs.readFileSync(IMAGE));
  assert.deepEqual([image.width, image.height, image.channels, image.depth], [253, 253, 1, 16]);
  // The file is the terrain fixture, round(h * 65535).
  const fixture = fixtures.terrain(253);
  let wrong = 0;
  for (let i = 0; i < 253 * 253; i++) if (image.data[i] !== Math.round(fixture.data[i]! * 65535)) wrong++;
  assert.equal(wrong, 0, 'samples of the asset that are not the fixture');

  const preview = await renderGraph(GRAPH, ['image.out']);
  assert.equal(preview.fields['image.out']!.width, 505);
  const every2 = againstImage(preview.fields['image.out']!, image, 2);
  assert.ok(every2 <= STEP16, `at 505 the largest difference at every second vertex is ${every2}; allowed ${STEP16}`);

  const build = await renderGraph(GRAPH, ['image.out'], { mode: 'build' });
  assert.equal(build.fields['image.out']!.width, N);
  const every4 = againstImage(build.fields['image.out']!, image, 4);
  assert.ok(every4 <= STEP16, `at 1009 the largest difference at every fourth vertex is ${every4}; allowed ${STEP16}`);
  // Between the shared vertices the field is interpolated, not repeated: a vertex beside one differs from it.
  assert.ok(Math.abs(at(build.fields['image.out']!, 401, 400) - at(build.fields['image.out']!, 400, 400)) > 1e-5);
});

test('05-roundtrip: the build writes the landscape, the layers and the texture, and they decode to what the engine made', async () => {
  const { registry } = (await getEngine()).engine;
  const { doc, problems } = parseDoc(fs.readFileSync(GRAPH, 'utf8'), registry);
  assert.deepEqual(problems, []);
  const plan = planBuild(doc, registry);
  assert.deepEqual([plan.ok, plan.problems, plan.resolution, plan.name], [true, [], N, 'Orogen']);

  const { result, sink, events } = await buildGraph(GRAPH);
  assert.deepEqual([result.status, result.problems], ['ok', []]);
  assert.deepEqual(result.files.map((file) => file.path), [
    'OrogenHeight.png', 'OrogenHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerRock.png', 'LayerRock.r8', 'T_Color_1024.png', 'Orogen.orogen.json',
  ]);
  assert.deepEqual([result.manifest, result.report], ['Orogen.orogen.json', 'Orogen.report.json']);
  assert.deepEqual([...sink.files.keys()].sort(), [...result.files.map((file) => file.path), 'Orogen.report.json'].sort(), 'the sink holds the files of the result, and the report');
  assert.deepEqual(sink.open, []);
  assert.equal(events.at(-1)!.type, 'build-result');
  const manifest = JSON.parse(text(fileOf(sink, 'Orogen.orogen.json'))) as Manifest;
  const report = JSON.parse(text(fileOf(sink, 'Orogen.report.json'))) as BuildReport;
  assert.deepEqual([manifest.status, manifest.resolution, report.status], ['complete', { x: N, y: N }, 'ok']);
  assert.ok(report.commitMs !== null && report.commitMs >= 0, 'the report says how long the commit took');

  // What the engine made of the graph at the build resolution.
  const { fields } = await renderGraph(GRAPH, ['land.out'], { mode: 'build' });
  const land = fields['land.out']!;

  // The height: the PNG and the .r16 hold the same codes, which decode with the range of the manifest to the terrain.
  const heightPng = png(fileOf(sink, 'OrogenHeight.png'));
  assert.deepEqual([heightPng.width, heightPng.height, heightPng.channels, heightPng.depth], [N, N, 1, 16]);
  const raw = fileOf(sink, 'OrogenHeight.r16');
  assert.equal(raw.length, 2 * N * N);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const height = manifest.landscape!.heightmap;
  const a = height.valueMin, b = height.valueMax, code = (b - a) / 65535;
  let unlike = 0, worst = 0;
  for (let i = 0; i < N * N; i++) {
    const q = view.getUint16(2 * i, true);
    if (heightPng.data[i] !== q) unlike++;
    worst = Math.max(worst, Math.abs(a + q * code - land.data[i]!));
  }
  assert.equal(unlike, 0, 'samples of the PNG that are not those of the .r16');
  // export-unreal.md 5.4: without dither a sample decodes to within half a code of the height.
  assert.ok(worst <= 0.5 * code * (1 + 1e-9), `the largest decoding error is ${worst / code} codes; allowed 0.5`);
  const measured = stats(land);
  assert.deepEqual([height.rangeMode, height.dither, height.measuredMin, height.measuredMax, height.clippedSamples], ['measured', 'none', measured.min, measured.max, 0]);

  // The layers: 8 bits at the landscape resolution; the weight-blended layer and the base total 255 on every texel.
  const rock = png(fileOf(sink, 'LayerRock.png')), base = png(fileOf(sink, 'LayerBase.png'));
  for (const layer of [rock, base]) assert.deepEqual([layer.width, layer.height, layer.channels, layer.depth], [N, N, 1, 8]);
  let off = 0, rockSum = 0;
  for (let i = 0; i < N * N; i++) {
    if (rock.data[i]! + base.data[i]! !== 255) off++;
    rockSum += rock.data[i]!;
  }
  assert.equal(off, 0, 'texels whose two layers do not total 255');
  assert.ok(rockSum > 0 && rockSum < 255 * N * N, 'the rock layer covers part of the terrain');
  assert.deepEqual(manifest.landscape!.layers.map((layer) => `${layer.name}${layer.base ? ' (base)' : ''}: ${layer.png}`), ['Base (base): LayerBase.png', 'Rock: LayerRock.png']);

  // The colour texture: a power of two, whatever the landscape resolution.
  const color = png(fileOf(sink, 'T_Color_1024.png'));
  assert.deepEqual([color.width, color.height, color.channels, color.depth], [1024, 1024, 3, 8]);
  assert.equal(Math.log2(color.width) % 1, 0);
  assert.deepEqual(manifest.textures.map((texture) => [texture.content, texture.file, texture.size, texture.srgb]), [['color', 'T_Color_1024.png', 1024, true]]);

  // The transform: the formulas of export-unreal.md 5.5, written out once more with the settings of the graph.
  const terrainSize = 4096, heightRange = 1024, seaLevel = 0.25;
  const extentCm = terrainSize * 100;
  const scaleXY = extentCm / (N - 1);
  const rangeCm = (b - a) * heightRange * 100;
  const scaleZ = rangeCm * 128 / 65535;
  const hMinCm = (a - seaLevel) * heightRange * 100;          // zeroAt 'seaLevel'
  const actorZ = hMinCm + 256 * scaleZ;
  const actorXY = -extentCm / 2;                              // origin 'center'
  const transform = manifest.landscape!.transform;
  const near = (found: number, wanted: number, what: string): void => assert.ok(Math.abs(found - wanted) <= 1e-9 * Math.max(1, Math.abs(wanted)), `${what} is ${found}; the formula gives ${wanted}`);
  near(transform.scaleCm.x, scaleXY, 'scaleCm.x');
  near(transform.scaleCm.y, scaleXY, 'scaleCm.y');
  near(transform.scaleCm.z, scaleZ, 'scaleCm.z');
  near(transform.actorLocationCm.x, actorXY, 'actorLocationCm.x');
  near(transform.actorLocationCm.y, actorXY, 'actorLocationCm.y');
  near(transform.actorLocationCm.z, actorZ, 'actorLocationCm.z');
  near(transform.uiLocationCm.x, actorXY + extentCm / 2, 'uiLocationCm.x');
  near(transform.uiLocationCm.z, actorZ, 'uiLocationCm.z');
  near(height.heightMinM, hMinCm / 100, 'heightMinM');
  near(height.heightMaxM, (hMinCm + rangeCm) / 100, 'heightMaxM');
  near(manifest.landscape!.seaLevelZCm, 0, 'seaLevelZCm');
});

test('05-roundtrip: the same bytes put again with a newer time re-evaluate the image node; an untouched file leaves it cached', async () => {
  const bytes = new Uint8Array(fs.readFileSync(IMAGE));
  const files = memorySource({ 'assets/heights-253.png': bytes });
  const session = await openGraph(GRAPH);
  try {
    const first = await session.evaluate(['image.out'], { files });
    assert.equal(first.report.nodes.image!.state, 'done');
    const untouched = await session.evaluate(['image.out'], { files });
    assert.equal(untouched.report.nodes.image!.state, 'cached');
    // The identity of a file is its path, its size and its time (engine.md 4.12): the bytes are not compared.
    files.put('assets/heights-253.png', bytes, (await files.stat('assets/heights-253.png'))!.mtimeMs + 1000);
    const touched = await session.evaluate(['image.out'], { files });
    assert.equal(touched.report.nodes.image!.state, 'done');
    expectIdentical(touched.fields['image.out']!, first.fields['image.out']!);
  } finally {
    await session.close();
  }
});

test('05-roundtrip: a build aborted during its first target leaves its report and no other file', async () => {
  // The first target is the landscape, and what it is made of begins with the image: the build is cancelled when
  // the image node reads its file.
  const bytes = new Uint8Array(fs.readFileSync(IMAGE));
  const inner = memorySource({ 'assets/heights-253.png': bytes });
  const controller = new AbortController();
  let reads = 0;
  const files: FileSource = {
    resolve: (file) => inner.resolve(file),
    stat: (file) => inner.stat(file),
    read(file, range) {
      reads++;
      controller.abort(new Error('cancelled by the test'));
      return inner.read(file, range);
    },
  };
  const { result, sink, events } = await buildGraph(GRAPH, { files, signal: controller.signal });
  assert.ok(reads >= 1, 'the build reached the image');
  assert.deepEqual([result.status, result.files, result.manifest, result.report], ['aborted', [], null, 'Orogen.report.json']);
  assert.deepEqual([...sink.files.keys()], ['Orogen.report.json'], 'the report, and no data file and no manifest');
  assert.deepEqual(sink.open, []);
  const report = JSON.parse(text(fileOf(sink, 'Orogen.report.json'))) as BuildReport;
  assert.deepEqual([report.status, report.files, report.commitMs], ['aborted', [], null]);
  assert.ok(events.filter((event) => event.type === 'build-target').length <= 1, 'no second target was begun');
});
