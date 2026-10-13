// A build, end to end on the GPU (export-unreal.md 10.3): every file a build writes is decoded again and compared
// texel for texel with the engine's own output put through the quantisation of section 5, computed here; the
// manifest validates against its schema and its transform is that of 5.5; two builds are byte-identical; the
// events arrive as 3.9 says.
//
// Sizes: 241 x 241 (a landscape of 8 x 8 components of 30 quads), with textures of 1024. No list is handed to an
// assertion; data is compared by loops that report a count and the largest difference.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { nodes as ioNodes } from '../../src/core/nodes/io/index.ts';
import type { BuildEvent, BuildPlan } from '../../src/core/runtime.ts';
import { MANIFEST_SCHEMA } from '../../src/export/manifest.ts';
import { planBuild } from '../../src/export/plan.ts';
import { heightMapping, landscapeLayout, landscapeTransform, quantiseHeights, quantiseWeights, SRGB8, weightFloorCode } from '../../src/export/unreal.ts';
import { buildGraph, channelOf, fieldOf, getEngine, makeDoc, renderGraph, stats, useNodes, type FieldData } from '../helpers/index.ts';
import {
  codeDifference, expectTexture, file, floats, fullGraph, FULL_FILES, manifestOf, normalPlanes, onTexels, pngSamples, reportOf, SETTINGS, text, u16, unitCode,
} from './_build.ts';
import { assertSame } from './unit/_support.ts';

useNodes(ioNodes);

const N = 241;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(MANIFEST_SCHEMA);

// One build of the full graph, and the engine's own output of what was exported, from an evaluation of its own.
const built = await buildGraph(fullGraph());
const source = (await renderGraph(fullGraph(), ['land.out', 'rock.out', 'scree.out', 'paint.out'], { mode: 'build', res: N })).fields;
const land = source['land.out']!, rock = source['rock.out']!, scree = source['scree.out']!, paint = source['paint.out']!;
const manifest = manifestOf(built.sink, 'TestLand');
const planOf = (events: readonly BuildEvent[]): BuildPlan => (events[0] as Extract<BuildEvent, { type: 'build-plan' }>).plan;
const { registry } = (await getEngine()).engine;

test('a build ends ok and makes its files visible together: those of the plan, the manifest last, and the report', () => {
  const { result, sink } = built;
  assert.deepEqual([result.status, result.problems, result.manifest, result.report, result.outDir], ['ok', [], 'TestLand.orogen.json', 'TestLand.report.json', null]);
  assert.deepEqual(result.files.map((f) => f.path), FULL_FILES);
  assert.deepEqual([...sink.files.keys()].sort(), [...FULL_FILES, 'TestLand.report.json'].sort(), 'the sink holds exactly the files of the result, and the report');
  assert.deepEqual(sink.open, [], 'no writer is left open');
  for (const f of result.files) assert.equal(f.bytes, file(sink, f.path).length, `the size of ${f.path}`);

  // The plan said which files, and how large those of a known size would be.
  const plan = planOf(built.events);
  assert.deepEqual(plan.files.map((f) => f.path), FULL_FILES);
  for (const planned of plan.files) {
    if (planned.bytes !== null) assert.equal(file(sink, planned.path).length, planned.bytes, `the planned size of ${planned.path}`);
  }
  assert.deepEqual(plan.problems, []);
  // planBuild alone, with the registry of the engine, gives the plan the build announced.
  const alone = planBuild(makeDoc(fullGraph()), registry);
  assert.deepEqual([alone.ok, alone.problems, alone.files.map((f) => f.path)], [true, [], FULL_FILES]);
});

test('the manifest is complete, validates against its schema, and lists every file but itself and the report', () => {
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.deepEqual([manifest.schema, manifest.status, manifest.targetEngine, manifest.generator.name], ['orogen.unreal.landscape/1', 'complete', '5.8', 'Orogen']);
  assert.deepEqual(manifest.project, { seed: SETTINGS.seed });
  assert.deepEqual(manifest.terrain, { sizeM: SETTINGS.terrainSize, heightRangeM: SETTINGS.heightRange, seaLevel: SETTINGS.seaLevel });
  assert.deepEqual(manifest.resolution, { x: N, y: N });
  assert.deepEqual(manifest.files, built.result.files.slice(0, -1));
  assert.deepEqual([manifest.images.length, manifest.textures.length, manifest.splines], [2, 3, null]);
  // The text is what section 6 prescribes, and holds no time: the bytes the sink holds are its serialisation.
  const written = text(file(built.sink, 'TestLand.orogen.json'));
  assert.equal(written, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(Object.keys(manifest), ['schema', 'status', 'generator', 'targetEngine', 'project', 'terrain', 'resolution', 'landscape', 'textures', 'images', 'splines', 'files']);
});

test('the heightmap: the PNG and the .r16 hold the same codes, which are the engine\'s heights quantised over the measured range', () => {
  const raw = u16(file(built.sink, 'TestLandHeight.r16'));
  assertSame(pngSamples(built.sink, 'TestLandHeight.png', { size: N, channels: 1, bits: 16 }), raw, 'the PNG against the .r16');

  const measured = stats(land);
  const height = manifest.landscape!.heightmap;
  assert.deepEqual([height.measuredMin, height.measuredMax, height.valueMin, height.valueMax], [measured.min, measured.max, measured.min, measured.max], 'measured on the GPU, and mapped without headroom');
  assert.deepEqual([height.rangeMode, height.dither, height.clippedSamples, height.zScaleFormula, height.r16, height.png],
    ['measured', 'none', 0, 'range_cm*128/65535', 'TestLandHeight.r16', 'TestLandHeight.png']);

  // Without dither the code is round((v - a) / (b - a) * 65535), in float64 on the float32 heights.
  const a = height.valueMin, b = height.valueMax, k = 65535 / (b - a);
  let wrong = 0, worst = 0, lowest = 65535, highest = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = land.data[i]!;
    const q = (v - a) * k + 0.5;
    if (raw[i] !== (q <= 0 ? 0 : q >= 65535 ? 65535 : Math.floor(q))) wrong++;
    // A code decodes to a + q (b - a) / 65535: within half a code of the height.
    worst = Math.max(worst, Math.abs(a + raw[i]! * (b - a) / 65535 - v));
    lowest = Math.min(lowest, raw[i]!);
    highest = Math.max(highest, raw[i]!);
  }
  assert.equal(wrong, 0, 'codes that are not the quantised height');
  assert.ok(worst <= 0.5 * (b - a) / 65535 * (1 + 1e-9), `the largest decoding error is ${worst / ((b - a) / 65535)} codes`);
  assert.deepEqual([lowest, highest], [0, 65535], 'the measured range uses every level: its ends are the first and the last code');
});

test('the transform of the manifest is that of 5.5, computed here from the settings and the mapped range', () => {
  const landscape = manifest.landscape!;
  const { valueMin: a, valueMax: b } = landscape.heightmap;
  // The formulas of 5.5, written out once more.
  const extentCm = SETTINGS.terrainSize * 100;
  const scaleXY = extentCm / (N - 1);
  const rangeCm = (b - a) * SETTINGS.heightRange * 100;
  const scaleZ = rangeCm * 128 / 65535;
  const hMinCm = (a - SETTINGS.seaLevel) * SETTINGS.heightRange * 100;
  const actorZ = hMinCm + 256 * scaleZ;
  assert.deepEqual(landscape.transform, {
    scaleCm: { x: scaleXY, y: scaleXY, z: scaleZ },
    actorLocationCm: { x: -extentCm / 2, y: -extentCm / 2, z: actorZ },
    uiLocationCm: { x: 0, y: 0, z: actorZ },
    rotationDeg: { pitch: 0, yaw: 0, roll: 0 },
  });
  assert.deepEqual([landscape.heightmap.heightMinM, landscape.heightmap.heightMaxM, landscape.seaLevelZCm], [hMinCm / 100, (hMinCm + rangeCm) / 100, 0]);
  const viaFunction = landscapeTransform({ resolution: N, terrainSize: SETTINGS.terrainSize, heightRange: SETTINGS.heightRange, seaLevel: SETTINGS.seaLevel, a, b, zeroAt: 'seaLevel', origin: 'center' });
  assert.deepEqual(viaFunction.scaleCm, landscape.transform.scaleCm);
  // A normalised height h lies at (h - seaLevel) * heightRange * 100 cm, whatever the mapped range: code 0 and 65535 at its ends.
  const worldZ = (code: number): number => actorZ + (code - 32768) / 128 * scaleZ;
  assert.ok(Math.abs(worldZ(0) - hMinCm) < 1e-6 && Math.abs(worldZ(65535) - (hMinCm + rangeCm)) < 1e-6);
  assert.equal(scaleXY, 200000 / 240);

  const layout = landscapeLayout(N)!;
  assert.deepEqual(landscape.layout, { quadsPerSection: 15, sectionsPerComponent: 2, components: { x: 8, y: 8 } });
  assert.equal(layout.components * layout.quadsPerSection * layout.sectionsPerComponent + 1, N);
  assert.deepEqual(landscape.orientation, { pixel00: 'minX_minY', imageX: '+X', imageY: '+Y', flipYAxis: false });
  assert.deepEqual([landscape.worldPartition, landscape.alphamapType], [{ enabled: true, gridSize: 4, regionSize: 32 }, 'Additive']);
});

test('the layers: 8 bits at the landscape resolution, the weight-blended ones and the base total exactly 255 on every texel, the others are their mask', () => {
  const layer = (name: string): Uint8Array => {
    const raw = file(built.sink, `Layer${name}.r8`);
    assert.equal(raw.length, N * N, `Layer${name}.r8 has one byte per vertex`);
    assertSame(pngSamples(built.sink, `Layer${name}.png`, { size: N, channels: 1, bits: 8 }), raw, `Layer${name}: the PNG against the .r8`);
    return raw;
  };
  const base = layer('Base'), rockBytes = layer('Rock'), screeBytes = layer('Scree'), steep = layer('Steep');

  // The group: the joint rule of 5.8 on the 16-bit codes of the masks, in plan order (Rock before Scree).
  const p = [rock, scree].map((mask) => Uint16Array.from(mask.data, (v) => unitCode(v, 65535)));
  const floorCode = weightFloorCode(0.008);
  let offTotal = 0, offShare = 0, scaled = 0, kept = 0;
  for (let i = 0; i < N * N; i++) {
    const bytes = [base[i]!, rockBytes[i]!, screeBytes[i]!];
    if (bytes[0]! + bytes[1]! + bytes[2]! !== 255) offTotal++;
    // The weights after the floor; the base takes what is left of a full weight; each byte is within 1 of its share.
    const e = [0, ...p.map((plane) => (plane[i]! >= floorCode ? plane[i]! : 0))];
    e[0] = Math.max(0, 65535 - e[1]! - e[2]!);
    const total = e[0] + e[1]! + e[2]!;
    if (e.some((weight, j) => Math.abs(bytes[j]! - 255 * weight / total) >= 1)) offShare++;
    if (e[1]! + e[2]! > 65535) scaled++;
    else kept++;
  }
  assert.equal(offTotal, 0, 'texels whose weight-blended bytes do not total 255');
  assert.equal(offShare, 0, 'bytes that are not within 1 of their exact share');
  assert.ok(scaled > 100 && kept > 100, `the masks overlap on ${scaled} texels and leave weight to the base on ${kept}`);
  // And byte for byte what the rule gives.
  const expected = [new Uint8Array(N * N), new Uint8Array(N * N), new Uint8Array(N * N)];
  quantiseWeights(p, expected, { offset: 0, count: N * N, floorCode, limit: 0 });
  assertSame(base, expected[0]!, 'the base layer');
  assertSame(rockBytes, expected[1]!, 'Rock');
  assertSame(screeBytes, expected[2]!, 'Scree');

  // An independent mask: floor(saturate(v) * 255 + 0.5).
  let wrong = 0;
  for (let i = 0; i < N * N; i++) if (steep[i] !== unitCode(rock.data[i]!, 255)) wrong++;
  assert.equal(wrong, 0, 'bytes of the independent layer that are not its mask');

  const mean = (bytes: Uint8Array): number => bytes.reduce((sum, v) => sum + v, 0) / (N * N * 255);
  assert.deepEqual(manifest.landscape!.layers, [
    { name: 'Base', r8: 'LayerBase.r8', png: 'LayerBase.png', blend: 'advanced', base: true, meanWeight: mean(base) },
    { name: 'Rock', r8: 'LayerRock.r8', png: 'LayerRock.png', blend: 'advanced', base: false, meanWeight: mean(rockBytes) },
    { name: 'Scree', r8: 'LayerScree.r8', png: 'LayerScree.png', blend: 'advanced', base: false, meanWeight: mean(screeBytes) },
    { name: 'Steep', r8: 'LayerSteep.r8', png: 'LayerSteep.png', blend: 'none', base: false, meanWeight: mean(steep) },
  ]);
});

test('the textures: a power of two, texel-centred over the landscape, each converted as 5.9 says', () => {
  const S = 1024;
  assert.deepEqual(manifest.textures, [
    { content: 'color', file: 'T_Color_1024.png', size: S, channels: 3, bits: 8, srgb: true, covers: 'landscapeExtent', sampling: 'texel-center' },
    { content: 'mask', file: 'T_Mask_1024.png', size: S, channels: 1, bits: 16, srgb: false, covers: 'landscapeExtent', sampling: 'texel-center' },
    { content: 'normal', file: 'T_Normal_1024.png', size: S, channels: 3, bits: 8, srgb: false, covers: 'landscapeExtent', sampling: 'texel-center', normalEncoding: 'xyz-landscape-axes' },
  ]);
  assert.equal(Math.log2(S) % 1, 0);

  // The color: linear RGB resampled, alpha dropped, each channel through the sRGB table.
  const color = pngSamples(built.sink, 'T_Color_1024.png', { size: S, channels: 3, bits: 8 });
  const expectedColor = new Uint8Array(S * S * 3);
  for (const c of [0, 1, 2]) {
    const plane = onTexels(paint, S, c);
    for (let i = 0; i < S * S; i++) expectedColor[3 * i + c] = SRGB8[unitCode(plane[i]!, 65535)]!;
  }
  expectTexture(color, expectedColor, 'the color texture');

  // The mask, 16 bits.
  const mask = pngSamples(built.sink, 'T_Mask_1024.png', { size: S, channels: 1, bits: 16 });
  const maskPlane = onTexels(scree, S);
  expectTexture(mask, Uint16Array.from(maskPlane, (v) => unitCode(v, 65535)), 'the mask texture');

  // The normals: the vertex normals of the engine resampled component by component, normalised, and mapped from -1..1 to 0..255.
  const normal = pngSamples(built.sink, 'T_Normal_1024.png', { size: S, channels: 3, bits: 8 });
  const planes = normalPlanes(land, SETTINGS.heightRange, SETTINGS.terrainSize).map((plane) => onTexels(plane, S));
  const expectedNormal = new Uint8Array(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    const length = Math.hypot(planes[0]![i]!, planes[1]![i]!, planes[2]![i]!);
    for (const c of [0, 1, 2]) expectedNormal[3 * i + c] = Math.floor((planes[c]![i]! / length * 0.5 + 0.5) * 255 + 0.5);
  }
  expectTexture(normal, expectedNormal, 'the normal texture');
  // Blue is the up component: no normal of a terrain points down, and level ground would be (128, 128, 255).
  let down = 0;
  for (let i = 2; i < normal.length; i += 3) if (normal[i]! < 128) down++;
  assert.equal(down, 0);
});

test('the images: a float file holds the field\'s values unchanged, a whole-number one the measured range over its codes', async () => {
  // OpenEXR: every float as the engine has it.
  const exr = await floats(built.sink, 'Heights.exr', N);
  assertSame(exr, land.data, 'Heights.exr');
  assert.equal(file(built.sink, 'Heights.exr').length, 277 + N * (16 + 4 * N));

  // 16-bit PNG over the measured range: t = (v - min) / (max - min), code = floor(saturate(t) * 65535 + 0.5).
  const png = pngSamples(built.sink, 'Steepness.png', { size: N, channels: 1, bits: 16 });
  const { min, max } = stats(land);
  let wrong = 0;
  for (let i = 0; i < png.length; i++) if (png[i] !== unitCode((land.data[i]! - min) / (max - min), 65535)) wrong++;
  assert.equal(wrong, 0);
  assert.deepEqual(manifest.images, [
    { file: 'Heights.exr', format: 'exr', width: N, height: N, valueMin: null, valueMax: null },
    { file: 'Steepness.png', format: 'png16', width: N, height: N, valueMin: min, valueMax: max },
  ]);
});

test('the report says what the build did: its status, its targets with their times and measured values, the height, the layers, the files', () => {
  const report = reportOf(built.sink, 'TestLand');
  assert.deepEqual([report.schema, report.status, report.resolution, report.problems, report.generator.name], ['orogen.build-report/1', 'ok', N, [], 'Orogen']);
  assert.deepEqual(report.files, built.result.files, 'the files made visible, in the order of the plan');
  assert.deepEqual(report.targets.map((t) => [t.nodeType, t.title, t.kind]), [
    ['io/export-landscape', 'Unreal Landscape', 'landscape'], ['io/export-layer', 'Landscape Layer', 'layer'], ['io/export-layer', 'Landscape Layer', 'layer'],
    ['io/export-layer', 'Landscape Layer', 'layer'], ['io/export-color', 'Color Texture', 'texture'], ['io/export-mask', 'Mask Texture', 'texture'],
    ['io/export-normal', 'Normal Texture', 'texture'], ['io/export-field', 'Image File', 'image'], ['io/export-field', 'Image File', 'image'],
  ]);
  for (const target of report.targets) {
    assert.ok(typeof target.evaluateMs === 'number' && target.evaluateMs >= 0 && typeof target.exportMs === 'number' && target.exportMs >= 0, 'every target was reached');
  }
  const { min, max } = stats(land);
  assert.deepEqual([report.targets[0]!.min, report.targets[0]!.max, report.targets[8]!.min, report.targets[8]!.max], [min, max, min, max], 'where a stage measured, it says what');
  assert.deepEqual([report.targets[1]!.min, report.targets[7]!.min], [null, null]);
  assert.deepEqual(report.height, { measuredMin: min, measuredMax: max, valueMin: min, valueMax: max, clippedSamples: 0 });
  assert.deepEqual(report.layers, manifest.landscape!.layers.map(({ name, base, blend, meanWeight }) => ({ name, base, blend, meanWeight })));
  assert.ok(report.weightsMs !== null && report.weightsMs >= 0 && report.durationMs >= report.weightsMs);
  assert.ok(Date.parse(report.endedUtc) >= Date.parse(report.startedUtc));
  assert.ok(text(file(built.sink, 'TestLand.report.json')).endsWith('}\n'));
});

test('the events of a build: the plan first, a target for every stage, progress that rises to 1 at the commit, the result last', () => {
  const { events, result } = built;
  assert.equal(events[0]!.type, 'build-plan');
  assert.equal(events.at(-1)!.type, 'build-result');
  assert.deepEqual((events.at(-1) as Extract<BuildEvent, { type: 'build-result' }>).result, result);
  assert.equal(events.filter((e) => e.type === 'build-plan' || e.type === 'build-result').length, 2, 'each of them once');
  assert.ok(events.every((e) => e.requestId === result.requestId), 'every event carries the request id');
  assert.deepEqual(structuredClone(events), events, 'every event is plain data');

  const targets = events.filter((e): e is Extract<BuildEvent, { type: 'build-target' }> => e.type === 'build-target');
  assert.deepEqual(targets.map((t) => t.index).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'every target has its stage');
  assert.ok(targets.every((t) => t.count === 9));
  assert.deepEqual(targets.find((t) => t.index === 0)!.label, 'Unreal Landscape: TestLandHeight.png');
  assert.deepEqual(targets.find((t) => t.index === 4)!.label, 'Color Texture: T_Color_1024.png');
  assert.deepEqual(targets.find((t) => t.index === 0)!.nodeId, 'outland', 'with the id the graph gave the node');

  const progress = events.filter((e): e is Extract<BuildEvent, { type: 'build-progress' }> => e.type === 'build-progress');
  assert.ok(progress.length >= 1);
  for (const [i, p] of progress.entries()) {
    assert.ok(p.fraction >= 0 && p.fraction <= 1 && (i === 0 || p.fraction >= progress[i - 1]!.fraction), 'fractions are within 0..1 and do not fall');
  }
  assert.deepEqual([progress.at(-1)!.phase, progress.at(-1)!.fraction], ['commit', 1]);
  assert.deepEqual(events.filter((e) => e.type === 'build-problem'), []);
});

test('two builds of one document write byte-identical data files and manifests', async () => {
  const again = await buildGraph(fullGraph());
  for (const path of FULL_FILES) assertSame(file(again.sink, path), file(built.sink, path), path);
  // The report differs: it holds the times.
  assert.notEqual(text(file(again.sink, 'TestLand.report.json')), text(file(built.sink, 'TestLand.report.json')));
});

test('dither: every code within 1.5 steps of its height, the same file from every build, and what the unit rule gives', async () => {
  const dithered = await buildGraph(fullGraph({ dither: true }));
  assert.equal(dithered.result.status, 'ok');
  const raw = u16(file(dithered.sink, 'TestLandHeight.r16'));
  assertSame(pngSamples(dithered.sink, 'TestLandHeight.png', { size: N, channels: 1, bits: 16 }), raw, 'the PNG against the .r16');
  const { valueMin: a, valueMax: b, dither } = manifestOf(dithered.sink, 'TestLand').landscape!.heightmap;
  assert.equal(dither, 'tpdf-1lsb');
  const expected = new Uint16Array(N * N);
  quantiseHeights(land.data, expected, { width: N, y0: 0, a, b, dither: true });
  assertSame(raw, expected, 'the dithered codes');
  let worst = 0;
  for (let i = 0; i < raw.length; i++) worst = Math.max(worst, Math.abs(a + raw[i]! * (b - a) / 65535 - land.data[i]!));
  assert.ok(worst < 1.5 * (b - a) / 65535, `the largest decoding error is ${worst / ((b - a) / 65535)} codes`);
  assert.ok(codeDifference(raw, u16(file(built.sink, 'TestLandHeight.r16'))).differing > N * N / 10, 'the dither changes the codes');
  // Nothing else of the build changes with it.
  for (const path of FULL_FILES.slice(2, -1)) assertSame(file(dithered.sink, path), file(built.sink, path), path);
});

test('the range of the heights: headroom, a fixed range with clipping, zero at the bottom, the origin at the corner', async () => {
  const measured = stats(land);
  const wide = await buildGraph(fullGraph({ headroom: 0.5 }));
  const h = manifestOf(wide.sink, 'TestLand').landscape!.heightmap;
  const mapped = heightMapping({ mode: 'measured', headroom: 0.5 }, measured.min, measured.max, SETTINGS.heightRange);
  assert.deepEqual([h.valueMin, h.valueMax, h.measuredMin, h.measuredMax], [mapped.a, mapped.b, measured.min, measured.max]);
  // Half the range above and below: the terrain takes the middle half of the codes.
  const codes = u16(file(wide.sink, 'TestLandHeight.r16'));
  let lowest = 65535, highest = 0;
  for (const c of codes) { lowest = Math.min(lowest, c); highest = Math.max(highest, c); }
  assert.deepEqual([lowest, highest], [16384, 49151]);

  // A fixed range that the terrain exceeds at both ends: clipped, counted and warned about.
  const lo = measured.min + 0.25 * (measured.max - measured.min), hi = measured.max - 0.25 * (measured.max - measured.min);
  const fixed = await buildGraph(fullGraph({ rangeMode: 'fixed', heightMin: lo, heightMax: hi, zeroAt: 'bottom', origin: 'corner' }));
  assert.equal(fixed.result.status, 'ok');
  const landscape = manifestOf(fixed.sink, 'TestLand').landscape!;
  let outside = 0;
  for (const v of land.data) if (v < lo || v > hi) outside++;
  assert.ok(outside > 0);
  assert.deepEqual([landscape.heightmap.rangeMode, landscape.heightmap.valueMin, landscape.heightmap.valueMax, landscape.heightmap.clippedSamples], ['fixed', lo, hi, outside]);
  assert.deepEqual(fixed.result.problems.map((p) => [p.severity, p.code, p.nodeId]), [['warning', 'W_HEIGHT_CLIPPED', 'outland']]);
  assert.match(fixed.result.problems[0]!.message, new RegExp(`^Unreal Landscape: ${outside} samples lie outside the fixed height range`));
  assert.deepEqual(fixed.events.filter((e) => e.type === 'build-problem').length, 1, 'a problem found after the plan is announced');
  const clippedCodes = u16(file(fixed.sink, 'TestLandHeight.r16'));
  let atEnds = 0;
  for (let i = 0; i < clippedCodes.length; i++) {
    const v = land.data[i]!;
    if ((v < lo && clippedCodes[i] === 0) || (v > hi && clippedCodes[i] === 65535)) atEnds++;
  }
  assert.equal(atEnds, outside, 'clipped samples lie at the end codes');
  // Zero at the bottom and the origin at the corner, by the formulas of 5.5.
  const expected = landscapeTransform({ resolution: N, terrainSize: SETTINGS.terrainSize, heightRange: SETTINGS.heightRange, seaLevel: SETTINGS.seaLevel, a: lo, b: hi, zeroAt: 'bottom', origin: 'corner' });
  assert.deepEqual([landscape.transform.actorLocationCm, landscape.transform.uiLocationCm, landscape.seaLevelZCm, landscape.heightmap.heightMinM],
    [expected.actorLocationCm, expected.uiLocationCm, expected.seaLevelZCm, expected.heightMinM]);
  assert.deepEqual([landscape.transform.actorLocationCm.x, landscape.transform.uiLocationCm.x, landscape.seaLevelZCm], [0, 100000, 0.3 * 600 * 100]);
});

test('a flat terrain is widened to 1 m, an empty layer is warned about, and a field that is no number stops the build', async () => {
  const flat = await buildGraph({
    settings: SETTINGS,
    sources: { level: fieldOf(N, () => 0.4), nothing: 'zero' },
    nodes: {
      outland: { type: 'io/export-landscape', params: { dither: false }, inputs: { in: 'level.out' } },
      outnone: { type: 'io/export-layer', params: { layer: 'Snow' }, inputs: { in: 'nothing.out' } },
      outzero: { type: 'io/export-layer', params: { layer: 'Flow', weightBlended: false }, inputs: { in: 'nothing.out' } },
    },
  });
  assert.equal(flat.result.status, 'ok');
  assert.deepEqual(flat.result.problems.map((p) => [p.severity, p.code, p.nodeId]).sort(), [
    ['warning', 'W_FLAT', 'outland'], ['warning', 'W_LAYER_EMPTY', 'outnone'], ['warning', 'W_LAYER_EMPTY', 'outzero'],
  ]);
  const landscape = manifestOf(flat.sink, 'Orogen').landscape!;
  const level = Math.fround(0.4);
  // 1 m of 600 m about the level: every vertex at the middle code.
  assert.ok(Math.abs(landscape.heightmap.valueMin - (level - 0.5 / 600)) < 1e-12 && Math.abs(landscape.heightmap.valueMax - (level + 0.5 / 600)) < 1e-12);
  assert.ok(Math.abs(landscape.heightmap.heightMaxM - landscape.heightmap.heightMinM - 1) < 1e-9);
  // The level is the middle of the range, half a code from the two middle codes: every vertex has the same one of them.
  const codes = u16(file(flat.sink, 'OrogenHeight.r16'));
  assert.ok((codes[0] === 32767 || codes[0] === 32768) && codes.every((c) => c === codes[0]), `a level terrain is one code, ${codes[0]}`);
  // The base layer takes the whole weight where the only other layer is empty.
  assert.ok(file(flat.sink, 'LayerBase.r8').every((b) => b === 255) && file(flat.sink, 'LayerSnow.r8').every((b) => b === 0));
  assert.deepEqual(landscape.layers.map((l) => [l.name, l.meanWeight]), [['Base', 1], ['Snow', 0], ['Flow', 0]]);

  // One texel that is no number, in each kind of target.
  const holed = fieldOf(N, (u, v) => 0.2 + 0.5 * u * v);
  holed.data[100 * N + 17] = NaN;
  const targets: readonly (readonly [string, Readonly<Record<string, string | boolean>>])[] = [
    ['io/export-landscape', {}], ['io/export-layer', { layer: 'A' }], ['io/export-layer', { layer: 'A', weightBlended: false }],
    ['io/export-mask', {}], ['io/export-normal', {}], ['io/export-field', {}], ['io/export-field', { format: 'png8' }], ['io/export-field', { format: 'tiff16', rangeMode: 'measured' }],
  ];
  for (const [type, params] of targets) {
    const nodes: Record<string, { type: string; params?: Readonly<Record<string, string | boolean>>; inputs: Record<string, string> }> = { out: { type, params, inputs: { in: 'holed.out' } } };
    if (type === 'io/export-layer') nodes.terrain = { type: 'io/export-landscape', inputs: { in: 'fine.out' } };
    const failed = await buildGraph({ settings: SETTINGS, sources: { holed, fine: 'rampX' }, nodes });
    const what = `${type} ${JSON.stringify(params)}`;
    assert.equal(failed.result.status, 'errors', what);
    assert.deepEqual(failed.result.problems.map((p) => [p.severity, p.code, p.nodeId]), [['error', 'E_NON_FINITE', 'out']], what);
    assert.deepEqual([[...failed.sink.files.keys()], failed.sink.open, failed.result.files, failed.result.manifest], [[failed.result.report], [], [], null], `${what}: the report and no other file`);
  }
  const color = await buildGraph({
    settings: SETTINGS,
    sources: { paint: { kind: 'color', width: N, height: N, channels: 4, data: new Float32Array(N * N * 4).fill(0.5).map((v, i) => (i === 4001 ? Infinity : v)) } },
    nodes: { out: { type: 'io/export-color', inputs: { in: 'paint.out' } } },
  });
  assert.deepEqual(color.result.problems.map((p) => p.code), ['E_NON_FINITE']);
});

test('a plan with an error ends the build before anything is evaluated or written, without a report', async () => {
  const none = await buildGraph({ settings: SETTINGS, nodes: { land: { type: 'ref/fbm' } } });
  assert.deepEqual([none.result.status, none.result.files, none.result.manifest, none.result.report], ['errors', [], null, null]);
  assert.deepEqual(none.result.problems.map((p) => p.code), ['E_NOTHING_TO_EXPORT']);
  assert.deepEqual(none.events.map((e) => e.type), ['build-plan', 'build-result'], 'the plan is followed by the result only');
  assert.deepEqual([[...none.sink.files.keys()], none.sink.open], [[], []]);

  // 513 is no landscape size.
  const square = await buildGraph(fullGraph(), { resolution: 513 });
  assert.deepEqual(square.result.problems.map((p) => [p.code, p.nodeId]), [['E_SIZE_NOT_LANDSCAPE', 'outland']]);
  assert.deepEqual([square.result.status, square.sink.files.size], ['errors', 0]);
});

test('the resolution option overrides the project\'s: the same graph at 337, and a field at any build resolution', async () => {
  const larger = await buildGraph(fullGraph(), { resolution: 337 });
  assert.equal(larger.result.status, 'ok');
  const m = manifestOf(larger.sink, 'TestLand');
  assert.deepEqual([m.resolution, m.landscape!.layout], [{ x: 337, y: 337 }, { quadsPerSection: 7, sectionsPerComponent: 2, components: { x: 24, y: 24 } }]);
  assert.deepEqual([file(larger.sink, 'TestLandHeight.r16').length, file(larger.sink, 'LayerBase.r8').length], [2 * 337 * 337, 337 * 337]);
  assert.equal(validate(m), true, JSON.stringify(validate.errors));

  // Every image format, at a resolution that is no landscape size: without a landscape the build is named Export.
  const formats = ['png8', 'png16', 'r16', 'r32', 'exr', 'tiff16', 'tiff32'] as const;
  const spec = {
    settings: SETTINGS,
    sources: { land: 'terrain' as const },
    nodes: Object.fromEntries(formats.map((format, i) => [`out${i}`, { type: 'io/export-field', params: { name: `F${format}`, format }, inputs: { in: 'land.out' } }])),
  };
  const R = 129;
  const images = await buildGraph(spec, { resolution: R });
  assert.equal(images.result.status, 'ok');
  assert.equal(images.result.manifest, 'Export.orogen.json');
  const terrain = (await renderGraph(spec, ['land.out'], { mode: 'build', res: R })).fields['land.out']!;
  const unit16 = Uint16Array.from(terrain.data, (v) => unitCode(v, 65535));
  assertSame(pngSamples(images.sink, 'Fpng8.png', { size: R, channels: 1, bits: 8 }), Uint8Array.from(terrain.data, (v) => unitCode(v, 255)), 'png8');
  assertSame(pngSamples(images.sink, 'Fpng16.png', { size: R, channels: 1, bits: 16 }), unit16, 'png16');
  assertSame(u16(file(images.sink, 'Fr16.r16')), unit16, 'r16');
  assertSame(new Float32Array(file(images.sink, 'Fr32.r32').slice().buffer), terrain.data, 'r32');
  assertSame(await floats(images.sink, 'Fexr.exr', R), terrain.data, 'exr');
  assertSame(await floats(images.sink, 'Ftiff32.tif', R), terrain.data, 'tiff32');
  assertSame((await floats(images.sink, 'Ftiff16.tif', R)).map((v) => Math.round(v * 65535)), unit16, 'tiff16');
  const manifestImages = manifestOf(images.sink, 'Export');
  assert.deepEqual([manifestImages.landscape, manifestImages.images.length], [null, 7]);
  assert.deepEqual(manifestImages.images.map((i) => [i.format, i.valueMin, i.valueMax]), [
    ['exr', null, null], ['png16', 0, 1], ['png8', 0, 1], ['r16', 0, 1], ['r32', null, null], ['tiff16', 0, 1], ['tiff32', null, null],
  ]);
  assert.equal(validate(manifestImages), true, JSON.stringify(validate.errors));
});

test('a color connected to a field input is exported as its luma, and a field connected to a color input as gray', async () => {
  // The source of a target stands for what the node's own input would receive, with the port conversion applied (2.1).
  const spec = {
    settings: SETTINGS,
    sources: { tint: 'color' as const, level: 'rampX' as const },
    nodes: {
      asfield: { type: 'io/export-field', params: { name: 'Luma', format: 'r32' }, inputs: { in: 'tint.out' } },
      ascolor: { type: 'io/export-color', inputs: { in: 'level.out' } },
    },
  };
  const R = 129;
  const { result, sink } = await buildGraph(spec, { resolution: R });
  assert.equal(result.status, 'ok');
  const tint = (await renderGraph(spec, ['tint.out'], { mode: 'build', res: R })).fields['tint.out']!;
  const luma = new Float32Array(file(sink, 'Luma.r32').slice().buffer);
  let worst = 0;
  for (let i = 0; i < R * R; i++) {
    worst = Math.max(worst, Math.abs(luma[i]! - (0.2126 * tint.data[4 * i]! + 0.7152 * tint.data[4 * i + 1]! + 0.0722 * tint.data[4 * i + 2]!)));
  }
  assert.ok(worst <= 1e-6, `the largest difference from the luma is ${worst}`);
  const gray = pngSamples(sink, 'T_Color_1024.png', { size: 1024, channels: 3, bits: 8 });
  let colored = 0;
  for (let i = 0; i < gray.length; i += 3) if (gray[i] !== gray[i + 1] || gray[i] !== gray[i + 2]) colored++;
  assert.equal(colored, 0);
  // A ramp along x: the first texel column is nearly black, the last nearly white, and rows are alike.
  assert.ok(gray[0]! < 12 && gray[3 * 1023]! > 250 && gray[3 * (1024 * 500)] === gray[0]);
  assert.ok(channelOf(tint, 0).data.length === R * R);
});
