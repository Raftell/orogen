// The acceptance pattern of export-unreal.md section 9, at 1009: every file of the build `Marker` decoded again,
// the manifest against the schema, the numbers of the table of 9.2 from the manifest's transform, and the check
// of a heightmap against the pattern.
//
// What these tests hold is that the files are the pattern of 9.1. What Unreal Engine makes of them is what the
// pattern is for, and is unverified (export-unreal.md section 11).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { MANIFEST_SCHEMA, type BuildReport, type Manifest } from '../../../src/export/manifest.ts';
import { checkMarker, isMarkerResolution, markerCode, markerRows, markerTransform, MARKER_STEPS, writeMarkerBuild } from '../../../src/export/unreal-test.ts';
import { landscapeLayout, landscapeTransform, worldZOfCode } from '../../../src/export/unreal.ts';
import { assertSame, memoryFiles, readPng } from './_support.ts';

const N = 1009;
const sink = memoryFiles();
const result = await writeMarkerBuild(sink, N);
const file = (name: string): Uint8Array<ArrayBuffer> => {
  const bytes = sink.files.get(name);
  assert.ok(bytes, `the build holds ${name}`);
  return bytes;
};
const manifest = JSON.parse(new TextDecoder().decode(file('Marker.orogen.json'))) as Manifest;
const u16 = (bytes: Uint8Array): Uint16Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => view.getUint16(2 * i, true));
};

test('the pattern is a complete build named Marker: its files, the manifest last, and the report', () => {
  assert.deepEqual([result.status, result.problems, result.manifest, result.report], ['ok', [], 'Marker.orogen.json', 'Marker.report.json']);
  const names = [
    'MarkerHeight.png', 'MarkerHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerLeft.png', 'LayerLeft.r8', 'LayerTop.png', 'LayerTop.r8',
    'T_Marker_1024.png', 'Marker.orogen.json',
  ];
  assert.deepEqual(result.files.map((f) => f.path), names);
  assert.deepEqual([...sink.files.keys()].sort(), [...names, 'Marker.report.json'].sort());
  assert.deepEqual([sink.open.size, sink.aborts], [0, 0]);
  for (const f of result.files) assert.equal(f.bytes, file(f.path).length, `the size of ${f.path}`);
  assert.deepEqual(manifest.files, result.files.slice(0, -1), 'the manifest lists every file but itself and the report');
  assert.deepEqual([file('MarkerHeight.r16').length, file('LayerBase.r8').length], [2 * N * N, N * N]);

  const report = JSON.parse(new TextDecoder().decode(file('Marker.report.json'))) as BuildReport;
  assert.deepEqual([report.schema, report.status, report.resolution, report.files], ['orogen.build-report/1', 'ok', N, result.files]);
});

test('the heightmap is the table of 9.1, and the PNG and the .r16 hold the same codes', () => {
  const raw = u16(file('MarkerHeight.r16'));
  const png = readPng(file('MarkerHeight.png'));
  assert.deepEqual([png.width, png.height, png.channels, png.bits], [N, N, 1, 16]);
  assertSame(png.samples, raw, 'the PNG against the .r16');
  assertSame(raw, markerRows(N, 0, N), 'the .r16 against the pattern');

  const at = (x: number, y: number): number => raw[y * N + x]!;
  // The tower: 64 x 64 at the image's top left. The pit: 64 wide and 32 rows deep at the top right.
  assert.deepEqual([at(0, 0), at(63, 63), at(64, 0), at(0, 64), at(64, 64)], [65535, 65535, 32768, 32768, 32768]);
  assert.deepEqual([at(N - 1, 0), at(N - 64, 31), at(N - 65, 0), at(N - 1, 32)], [0, 0, 32768, 32768]);
  // The ramp: along the bottom 32 rows, rising by 16 codes a column.
  assert.deepEqual([at(0, N - 1), at(1, N - 1), at(800, N - 32), at(N - 1, N - 1), at(500, N - 33)], [32768, 32784, 32768 + 12800, 32768 + 16 * 1008, 32768]);
  let counts = { tower: 0, pit: 0, plain: 0, other: 0 };
  for (let y = 0; y < N - 32; y++) for (let x = 0; x < N; x++) counts[at(x, y) === 65535 ? 'tower' : at(x, y) === 0 ? 'pit' : at(x, y) === 32768 ? 'plain' : 'other']++;
  assert.deepEqual(counts, { tower: 64 * 64, pit: 64 * 32, plain: (N - 32) * N - 64 * 64 - 64 * 32, other: 0 });

  // At every resolution the ramp stays within 16 bits and ends at the same height.
  for (const [res, step] of Object.entries(MARKER_STEPS)) {
    assert.ok(isMarkerResolution(Number(res)) && landscapeLayout(Number(res)) !== null);
    assert.equal(markerCode(Number(res), Number(res) - 1, Number(res) - 1), 32768 + step * (Number(res) - 1));
    assert.ok(markerCode(Number(res), Number(res) - 1, Number(res) - 1) <= 65535);
  }
  assert.deepEqual(MARKER_STEPS, { 1009: 16, 2017: 8, 4033: 4, 8129: 2 });
});

test('the layers: Left covers the columns below the middle, Top the rows below it, and Base and Left total 255 everywhere', () => {
  const layer = (name: string): Uint8Array => {
    const raw = file(`Layer${name}.r8`);
    const png = readPng(file(`Layer${name}.png`));
    assert.deepEqual([png.width, png.height, png.channels, png.bits], [N, N, 1, 8]);
    assertSame(png.samples, raw, `Layer${name}: the PNG against the .r8`);
    return raw;
  };
  const base = layer('Base'), left = layer('Left'), top = layer('Top');
  const half = (N - 1) / 2;
  let wrong = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (left[i] !== (x < half ? 255 : 0) || top[i] !== (y < half ? 255 : 0) || base[i]! + left[i]! !== 255) wrong++;
    }
  }
  assert.equal(wrong, 0);
  assert.deepEqual(manifest.landscape!.layers, [
    { name: 'Base', r8: 'LayerBase.r8', png: 'LayerBase.png', blend: 'advanced', base: true, meanWeight: 505 / 1009 },
    { name: 'Left', r8: 'LayerLeft.r8', png: 'LayerLeft.png', blend: 'advanced', base: false, meanWeight: 504 / 1009 },
    { name: 'Top', r8: 'LayerTop.r8', png: 'LayerTop.png', blend: 'none', base: false, meanWeight: 504 / 1009 },
  ]);
});

test('the texture: red on the quarter of the tower, green on that of the pit, blue at the bottom left, white at the bottom right', () => {
  const png = readPng(file('T_Marker_1024.png'));
  assert.deepEqual([png.width, png.height, png.channels, png.bits], [1024, 1024, 3, 8]);
  const at = (i: number, j: number): number[] => [...png.samples.subarray((j * 1024 + i) * 3, (j * 1024 + i) * 3 + 3)];
  assert.deepEqual([at(0, 0), at(511, 511), at(512, 0), at(1023, 511), at(0, 512), at(511, 1023), at(512, 512), at(1023, 1023)],
    [[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255], [255, 255, 255], [255, 255, 255]]);
  assert.deepEqual(manifest.textures, [{ content: 'color', file: 'T_Marker_1024.png', size: 1024, channels: 3, bits: 8, srgb: true, covers: 'landscapeExtent', sampling: 'texel-center' }]);
});

test('the manifest validates, states the transform of 9.1 directly, and that transform is what 5.5 gives for its terrain', () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(MANIFEST_SCHEMA);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  const landscape = manifest.landscape!;
  assert.deepEqual(landscape.transform, {
    scaleCm: { x: 100, y: 100, z: 100 }, actorLocationCm: { x: 0, y: 0, z: 0 }, uiLocationCm: { x: 50400, y: 50400, z: 0 }, rotationDeg: { pitch: 0, yaw: 0, roll: 0 },
  });
  assert.deepEqual(landscape.transform, markerTransform(N));
  assert.deepEqual(landscape.layout, { quadsPerSection: 63, sectionsPerComponent: 2, components: { x: 8, y: 8 } });
  assert.deepEqual([manifest.resolution, manifest.terrain.sizeM, manifest.terrain.heightRangeM], [{ x: N, y: N }, 1008, 511.9921875]);
  assert.deepEqual([landscape.heightmap.dither, landscape.heightmap.rangeMode, landscape.heightmap.valueMin, landscape.heightmap.valueMax, landscape.heightmap.clippedSamples], ['none', 'fixed', 0, 1, 0]);
  assert.deepEqual([landscape.heightmap.heightMinM, landscape.heightmap.heightMaxM, landscape.seaLevelZCm], [-256, 255.9921875, 0]);

  // The terrain the manifest describes, put through the formulas of 5.5, lands on the transform it states.
  const derived = landscapeTransform({
    resolution: N, terrainSize: manifest.terrain.sizeM, heightRange: manifest.terrain.heightRangeM, seaLevel: manifest.terrain.seaLevel,
    a: 0, b: 1, zeroAt: 'seaLevel', origin: 'corner',
  });
  const close = (found: number, expected: number, what: string): void => assert.ok(Math.abs(found - expected) <= 1e-9, `${what}: ${found} against ${expected}`);
  close(derived.scaleCm.x, 100, 'scale x');
  close(derived.scaleCm.z, 100, 'scale z');
  close(derived.actorLocationCm.z, 0, 'actor z');
  close(derived.uiLocationCm.x, 50400, 'location x of the panel');
  close(derived.heightMinM, -256, 'the lowest height');
  close(derived.heightMaxM, 255.9921875, 'the highest height');
});

test('the heights the table of 9.2 expects in Unreal follow from the transform and the formula of 5.3', () => {
  const transform = manifest.landscape!.transform;
  // Check 6: the plain at Z = 0. Check 7: the tower's top. Check 8: the pit's floor. Check 9: the ramp at column 800.
  assert.equal(worldZOfCode(markerCode(N, 500, 500), transform), 0);
  assert.equal(worldZOfCode(markerCode(N, 10, 10), transform).toFixed(2), '25599.22');
  assert.equal(worldZOfCode(markerCode(N, N - 10, 10), transform), -25600);
  assert.equal(worldZOfCode(markerCode(N, 800, N - 1), transform), 10000);
  assert.equal(800 * transform.scaleCm.x, 80000);
  for (const column of [0, 1, 37, 1008]) assert.equal(worldZOfCode(markerCode(N, column, N - 1), transform), 0.78125 * 16 * column);
  // Check 2: the extent. Check 3 and 4: the tower's top spans 0..6300 cm both ways; the pit is 6300 by 3100.
  assert.deepEqual([(N - 1) * transform.scaleCm.x, 63 * transform.scaleCm.x, 31 * transform.scaleCm.y], [100800, 6300, 3100]);
});

test('checkMarker accepts the pattern and reports a planted difference: how many samples, how far, and the first', () => {
  const codes = u16(file('MarkerHeight.r16'));
  assert.deepEqual(checkMarker(codes, N), { differing: 0, largest: 0, first: null });
  codes[5 * N + 7] = 65000;      // inside the tower: 535 below
  codes[900 * N + 20] = 32769;   // on the plain: 1 above
  codes[N * N - 1]! -= 3;        // the last sample of the ramp
  assert.deepEqual(checkMarker(codes, N), { differing: 3, largest: 535, first: { x: 7, y: 5, found: 65000, expected: 65535 } });
  // A mirrored or transposed heightmap is no match at all.
  const mirrored = markerRows(N, 0, N);
  for (let y = 0; y < N; y++) mirrored.subarray(y * N, (y + 1) * N).reverse();
  assert.ok(checkMarker(mirrored, N).differing > 64 * 64);
  assert.throws(() => checkMarker(codes.subarray(1), N), RangeError);
  assert.throws(() => checkMarker(codes, 1010), RangeError);
});

test('the pattern exists at the four landscape sizes only, and a sink that fails gives a failed build without a manifest', async () => {
  await assert.rejects(writeMarkerBuild(memoryFiles(), 513), RangeError);
  const failing = memoryFiles();
  const create = failing.create;
  let created = 0;
  failing.create = async (relPath) => {
    if (++created === 4) throw new Error('disk full');
    return create(relPath);
  };
  const failed = await writeMarkerBuild(failing, N);
  assert.deepEqual([failed.status, failed.files, failed.manifest, failed.report], ['errors', [], null, null]);
  assert.match(failed.problems[0]!.message, /^Cannot write the acceptance pattern: disk full\.$/);
  assert.deepEqual([failing.files.size, failing.open.size, failing.aborts], [0, 0, 1]);
});
