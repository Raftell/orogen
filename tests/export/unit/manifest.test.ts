// The manifest (export-unreal.md section 6): MANIFEST_SCHEMA is the schema the contract prints, the example of
// 6.2 validates against it and carries the numbers of the worked example of 5.6, and the text a manifest becomes
// is what section 6 prescribes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { GENERATOR_VERSION, MANIFEST_SCHEMA, manifestLayout, manifestTransform, serializeJson, type Manifest } from '../../../src/export/manifest.ts';
import { heightMapping, landscapeLayout, landscapeTransform } from '../../../src/export/unreal.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CONTRACT = fs.readFileSync(path.join(ROOT, 'docs', 'contract', 'export-unreal.md'), 'utf8');

/** The first ```json block after a heading of the contract. */
function jsonBlock(heading: string): unknown {
  const from = CONTRACT.indexOf(heading);
  assert.ok(from >= 0, `the contract has the heading "${heading}"`);
  const start = CONTRACT.indexOf('```json\n', from) + '```json\n'.length;
  return JSON.parse(CONTRACT.slice(start, CONTRACT.indexOf('\n```', start)));
}

const EXAMPLE = jsonBlock('### 6.2 Example') as Manifest;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(MANIFEST_SCHEMA);
const errors = (value: unknown): string[] => (validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`));

test('MANIFEST_SCHEMA is the schema of 6.1, member for member', () => {
  assert.deepEqual(MANIFEST_SCHEMA, jsonBlock('### 6.1 Schema'));
});

test('the generator version is the version of the package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(GENERATOR_VERSION, pkg.version);
});

test('the example of 6.2 validates, and so does the plugin\'s fixture where the checkout holds it', () => {
  assert.deepEqual(errors(EXAMPLE), []);
  const fixture = path.join(ROOT, 'unreal', 'OrogenBridge', 'Fixtures', 'example.orogen.json');
  if (fs.existsSync(fixture)) {
    const held = JSON.parse(fs.readFileSync(fixture, 'utf8')) as unknown;
    assert.deepEqual(errors(held), []);
    assert.deepEqual(held, EXAMPLE, 'the fixture of the plugin is the manifest of 6.2');
  }
});

test('a manifest that breaks the schema is refused, with the member named', () => {
  const broken = (change: (m: any) => void): string[] => {
    const copy = structuredClone(EXAMPLE);
    change(copy);
    return errors(copy);
  };
  assert.match(broken((m) => { m.schema = 'orogen.unreal.landscape/2'; }).join(), /\/schema must be equal to constant/);
  assert.match(broken((m) => { m.status = 'partial'; }).join(), /\/status must be equal to constant/);
  assert.match(broken((m) => { delete m.splines; }).join(), /must have required property 'splines'/);
  assert.match(broken((m) => { m.project.seed = 2 ** 32; }).join(), /\/project\/seed must be <= 4294967295/);
  assert.match(broken((m) => { m.terrain.sizeM = 0; }).join(), /\/terrain\/sizeM must be > 0/);
  assert.match(broken((m) => { m.resolution.x = 0; }).join(), /\/resolution\/x must be >= 1/);
  assert.match(broken((m) => { m.landscape.layout.quadsPerSection = 64; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.landscape.worldPartition.gridSize = 17; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.landscape.layers[1].name = '1st'; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.landscape.layers[0].meanWeight = 1.5; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.landscape.heightmap.zScaleFormula = 'range_cm/512'; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.landscape.orientation.flipYAxis = true; }).join(), /\/landscape/);
  assert.match(broken((m) => { delete m.landscape.transform.rotationDeg; }).join(), /\/landscape/);
  assert.match(broken((m) => { m.textures[0].size = 512; }).join(), /\/textures\/0\/size must be equal to one of the allowed values/);
  assert.match(broken((m) => { m.files[0].bytes = -1; }).join(), /\/files\/0\/bytes must be >= 0/);
  assert.match(broken((m) => { m.splines = {}; }).join(), /\/splines must be null/);
  // A build without a landscape has `null` there, and an image entry of a float format has no value range.
  assert.deepEqual(broken((m) => {
    m.landscape = null;
    m.images = [{ file: 'Depth.exr', format: 'exr', width: 8129, height: 8129, valueMin: null, valueMax: null }];
  }), []);
});

test('the example of 6.2 carries the numbers of the worked example of 5.6, as the arithmetic gives them', () => {
  const { a, b } = heightMapping({ mode: 'measured', headroom: 0 }, 0.05, 0.85, EXAMPLE.terrain.heightRangeM);
  const transform = landscapeTransform({
    resolution: EXAMPLE.resolution.x, terrainSize: EXAMPLE.terrain.sizeM, heightRange: EXAMPLE.terrain.heightRangeM, seaLevel: EXAMPLE.terrain.seaLevel,
    a, b, zeroAt: 'seaLevel', origin: 'center',
  });
  const landscape = EXAMPLE.landscape!;
  assert.deepEqual(manifestTransform(transform), landscape.transform);
  assert.deepEqual(manifestLayout(landscapeLayout(EXAMPLE.resolution.x)!), landscape.layout);
  assert.deepEqual([a, b, transform.heightMinM, transform.heightMaxM, transform.seaLevelZCm],
    [landscape.heightmap.valueMin, landscape.heightmap.valueMax, landscape.heightmap.heightMinM, landscape.heightmap.heightMaxM, landscape.seaLevelZCm]);
});

test('a manifest is written as section 6 says: two-space indentation, a final newline, keys in order, numbers that read back', () => {
  const text = serializeJson(EXAMPLE);
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'), 'one final newline');
  assert.ok(text.startsWith('{\n  "schema": "orogen.unreal.landscape/1",\n  "status": "complete",\n  "generator": {\n    "name": "Orogen",'));
  assert.ok(!text.includes('\t') && !text.includes('\r') && text.charCodeAt(0) !== 0xfeff, 'no tab, no carriage return, no byte order mark');
  assert.deepEqual(JSON.parse(text), EXAMPLE);
  // The shortest digits that read back to the same float64: no number is rounded for display.
  assert.ok(text.includes('"x": 98.4251968503937,') && text.includes('"z": 468.75715266651406') && text.includes('"z": 105001.8310826276'));
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ['schema', 'status', 'generator', 'targetEngine', 'project', 'terrain', 'resolution', 'landscape', 'textures', 'images', 'splines', 'files']);
  // The same value gives the same bytes: a manifest holds no time.
  assert.equal(serializeJson(structuredClone(EXAMPLE)), text);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no time stamp');
});
