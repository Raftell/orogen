// The six export nodes (export-unreal.md 2.4, 10.1), without a GPU: what each declares at its defaults, which
// item member every option of every parameter sets, that a hook is pure, and what a disabled or an unconnected
// node contributes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExportContext, ExportItem, NodeDef, ParamValue } from '../../../src/core/api.ts';
import { nodes as ioNodes } from '../../../src/core/nodes/io/index.ts';
import { normalizeParams, type GraphDoc } from '../../../src/core/runtime.ts';
import { checkExportNode, planBuild } from '../../../src/export/plan.ts';
import { docOf, REGISTRY, SOURCES, type NodeSpec } from './_docs.ts';

const exportNodes = ioNodes.filter((def) => def.export !== undefined);
const byType = (type: string): NodeDef => exportNodes.find((def) => def.type === type)!;

/** What feeds `in` of each node, by its type: a terrain, a mask or a colour. */
const FEED: Readonly<Record<string, string>> = {
  'io/export-landscape': 'land.out', 'io/export-layer': 'steep.out', 'io/export-color': 'paint.out',
  'io/export-mask': 'steep.out', 'io/export-normal': 'land.out', 'io/export-field': 'land.out',
};

/** A document with one instance of the node, `out`, fed as FEED says; a layer comes with the landscape it belongs to. */
function docWith(type: string, params: Readonly<Record<string, unknown>> = {}, connected = true): GraphDoc {
  const nodes: Record<string, NodeSpec> = { ...SOURCES, out: { type, params, ...(connected ? { in: FEED[type]! } : {}) } };
  if (type === 'io/export-layer') nodes.terrain = { type: 'io/export-landscape', in: 'land.out' };
  return docOf(nodes);
}

/** The item the node `out` declares in a plan without errors. */
function itemOf(type: string, params: Readonly<Record<string, unknown>> = {}): ExportItem {
  const plan = planBuild(docWith(type, params), REGISTRY);
  assert.deepEqual(plan.problems.filter((problem) => problem.severity === 'error'), [], `${type} with ${JSON.stringify(params)}`);
  const items = plan.items.filter((entry) => entry.nodeId === 'out');
  assert.equal(items.length, 1, `${type} returns one item`);
  return items[0]!.item;
}

test('the six export nodes are the ones 2.4 lists, and each keeps the rules of 2.3', () => {
  assert.deepEqual(exportNodes.map((def) => [def.type, def.title]), [
    ['io/export-color', 'Color Texture'], ['io/export-field', 'Image File'], ['io/export-landscape', 'Unreal Landscape'],
    ['io/export-layer', 'Landscape Layer'], ['io/export-mask', 'Mask Texture'], ['io/export-normal', 'Normal Texture'],
  ]);
  for (const def of exportNodes) assert.deepEqual(checkExportNode(def), [], def.type);
  const input = (type: string): unknown => [byType(type).inputs[0]!.type, byType(type).inputs[0]!.role ?? 'height'];
  assert.deepEqual(input('io/export-landscape'), ['field', 'height']);
  assert.deepEqual(input('io/export-layer'), ['field', 'mask']);
  assert.deepEqual(input('io/export-mask'), ['field', 'mask']);
  assert.deepEqual(input('io/export-normal'), ['field', 'height']);
  assert.deepEqual(input('io/export-field'), ['field', 'height']);
  assert.equal(byType('io/export-color').inputs[0]!.type, 'color');
});

test('the parameters of every export node are those of 2.4: names, kinds, defaults, ranges, options and visibility', () => {
  const shape = (def: NodeDef): unknown => def.params.slice(1).map((p) => {
    const range = p.kind === 'float' || p.kind === 'int' ? [p.min, p.max] : p.kind === 'enum' ? p.options.map((o) => o.value) : p.kind === 'text' ? [p.maxLength] : [];
    return [p.name, p.kind === 'float' ? `${p.kind}, ${p.unit}${p.soft ? ', soft' : ''}` : p.kind, p.default, range, p.visibleWhen ?? null];
  });
  assert.deepEqual(shape(byType('io/export-landscape')), [
    ['name', 'text', 'Orogen', [64], null],
    ['rangeMode', 'enum', 'measured', ['measured', 'fixed'], null],
    ['headroom', 'float, ratio', 0, [0, 1], { param: 'rangeMode', equals: 'measured' }],
    ['heightMin', 'float, height, soft', 0, [0, 1], { param: 'rangeMode', equals: 'fixed' }],
    ['heightMax', 'float, height, soft', 1, [0, 1], { param: 'rangeMode', equals: 'fixed' }],
    ['dither', 'bool', true, [], null],
    ['zeroAt', 'enum', 'seaLevel', ['seaLevel', 'bottom'], null],
    ['origin', 'enum', 'center', ['center', 'corner'], null],
    ['baseLayer', 'text', 'Base', [63], null],
    ['layerBlend', 'enum', 'advanced', ['advanced', 'final'], null],
    ['layerFloor', 'float, ratio', 0.008, [0, 0.25], null],
    ['layerLimit', 'int', 0, [0, 16], null],
    ['partition', 'bool', true, [], null],
    ['gridComponents', 'int', 4, [1, 16], null],
    ['regionComponents', 'int', 32, [4, 64], null],
  ]);
  assert.deepEqual(shape(byType('io/export-layer')), [['layer', 'text', 'Layer', [63], null], ['weightBlended', 'bool', true, [], null]]);
  const dimension = ['dimension', 'enum', 'auto', ['auto', '1024', '2048', '4096', '8192'], null];
  assert.deepEqual(shape(byType('io/export-color')), [['name', 'text', 'Color', [64], null], dimension]);
  assert.deepEqual(shape(byType('io/export-normal')), [['name', 'text', 'Normal', [64], null], dimension]);
  assert.deepEqual(shape(byType('io/export-mask')), [['name', 'text', 'Mask', [64], null], dimension, ['bits', 'enum', '8', ['8', '16'], null]]);
  assert.deepEqual(shape(byType('io/export-field')), [
    ['name', 'text', 'Field', [64], null],
    ['format', 'enum', 'exr', ['png8', 'png16', 'r16', 'r32', 'exr', 'tiff16', 'tiff32'], null],
    ['rangeMode', 'enum', 'unit', ['unit', 'measured'], null],
  ]);
});

test('at its defaults each node declares the item of 2.4 and the files of 2.6, without an error', () => {
  const source = (node: string) => ({ node, input: 'in' });
  const files = (type: string): unknown => {
    const plan = planBuild(docWith(type), REGISTRY);
    assert.equal(plan.ok, true, `${type}: ${JSON.stringify(plan.problems)}`);
    return plan.files.filter((file) => file.nodeId === 'out').map((file) => [file.path, file.encoding, file.width, file.height, file.bytes]);
  };

  assert.deepEqual(itemOf('io/export-landscape'), {
    kind: 'landscape', source: source('out'), name: 'Orogen', range: { mode: 'measured', headroom: 0 }, dither: true, zeroAt: 'seaLevel', origin: 'center',
    baseLayer: 'Base', layerBlend: 'advanced', layerFloor: 0.008, layerLimit: 0, worldPartition: { enabled: true, gridSize: 4, regionSize: 32 },
  });
  assert.deepEqual(files('io/export-landscape'), [['OrogenHeight.png', 'png-gray16', 1009, 1009, null], ['OrogenHeight.r16', 'raw-u16', 1009, 1009, 2 * 1009 * 1009]]);
  assert.deepEqual(planBuild(docWith('io/export-landscape'), REGISTRY).files.at(-1), { path: 'Orogen.orogen.json', encoding: 'json', width: 0, height: 0, bytes: null, nodeId: null });

  assert.deepEqual(itemOf('io/export-layer'), { kind: 'layer', source: source('out'), layer: 'Layer', weightBlended: true });
  assert.deepEqual(files('io/export-layer'), [['LayerLayer.png', 'png-gray8', 1009, 1009, null], ['LayerLayer.r8', 'raw-u8', 1009, 1009, 1009 * 1009]]);
  // A weight-blended layer brings the base layer with it, which no node owns.
  const withBase = planBuild(docWith('io/export-layer'), REGISTRY);
  assert.deepEqual(withBase.layers, [{ name: 'Base', blend: 'advanced', base: true, nodeId: null }, { name: 'Layer', blend: 'advanced', base: false, nodeId: 'out' }]);
  assert.deepEqual(withBase.files.filter((file) => file.nodeId === null).map((file) => file.path), ['LayerBase.png', 'LayerBase.r8', 'Orogen.orogen.json']);

  assert.deepEqual(itemOf('io/export-color'), { kind: 'texture', source: source('out'), name: 'Color', content: 'color', size: 'auto', bits: 8 });
  assert.deepEqual(files('io/export-color'), [['T_Color_1024.png', 'png-rgb8', 1024, 1024, null]]);
  assert.deepEqual(itemOf('io/export-mask'), { kind: 'texture', source: source('out'), name: 'Mask', content: 'mask', size: 'auto', bits: 8 });
  assert.deepEqual(files('io/export-mask'), [['T_Mask_1024.png', 'png-gray8', 1024, 1024, null]]);
  assert.deepEqual(itemOf('io/export-normal'), { kind: 'texture', source: source('out'), name: 'Normal', content: 'normal', size: 'auto', bits: 8 });
  assert.deepEqual(files('io/export-normal'), [['T_Normal_1024.png', 'png-rgb8', 1024, 1024, null]]);
  assert.deepEqual(itemOf('io/export-field'), { kind: 'image', source: source('out'), name: 'Field', format: 'exr', map: 'unit' });
  assert.deepEqual(files('io/export-field'), [['Field.exr', 'exr-f32', 1009, 1009, 277 + 1009 * (16 + 4 * 1009)]]);
  // Without a landscape the build is named Export.
  assert.equal(planBuild(docWith('io/export-field'), REGISTRY).files.at(-1)!.path, 'Export.orogen.json');
});

test('every option of every enum and both values of every bool set the item member 2.4 states', () => {
  // [node, parameter, value, the item member as a path, the member's value]
  const cases: readonly (readonly [string, string, unknown, string, unknown])[] = [
    ['io/export-landscape', 'name', 'Alps', 'name', 'Alps'],
    ['io/export-landscape', 'rangeMode', 'measured', 'range.mode', 'measured'],
    ['io/export-landscape', 'rangeMode', 'fixed', 'range.mode', 'fixed'],
    ['io/export-landscape', 'headroom', 0.25, 'range.headroom', 0.25],
    ['io/export-landscape', 'dither', true, 'dither', true],
    ['io/export-landscape', 'dither', false, 'dither', false],
    ['io/export-landscape', 'zeroAt', 'seaLevel', 'zeroAt', 'seaLevel'],
    ['io/export-landscape', 'zeroAt', 'bottom', 'zeroAt', 'bottom'],
    ['io/export-landscape', 'origin', 'center', 'origin', 'center'],
    ['io/export-landscape', 'origin', 'corner', 'origin', 'corner'],
    ['io/export-landscape', 'baseLayer', 'Soil', 'baseLayer', 'Soil'],
    ['io/export-landscape', 'layerBlend', 'advanced', 'layerBlend', 'advanced'],
    ['io/export-landscape', 'layerBlend', 'final', 'layerBlend', 'final'],
    ['io/export-landscape', 'layerFloor', 0.1, 'layerFloor', 0.1],
    ['io/export-landscape', 'layerLimit', 4, 'layerLimit', 4],
    ['io/export-landscape', 'partition', true, 'worldPartition.enabled', true],
    ['io/export-landscape', 'partition', false, 'worldPartition.enabled', false],
    ['io/export-landscape', 'gridComponents', 8, 'worldPartition.gridSize', 8],
    ['io/export-landscape', 'regionComponents', 16, 'worldPartition.regionSize', 16],
    ['io/export-layer', 'layer', 'Rock_Wet', 'layer', 'Rock_Wet'],
    ['io/export-layer', 'weightBlended', true, 'weightBlended', true],
    ['io/export-layer', 'weightBlended', false, 'weightBlended', false],
    ...(['io/export-color', 'io/export-mask', 'io/export-normal'] as const).flatMap((type) => [
      [type, 'name', 'Detail 2', 'name', 'Detail 2'],
      [type, 'dimension', 'auto', 'size', 'auto'],
      [type, 'dimension', '1024', 'size', 1024],
      [type, 'dimension', '2048', 'size', 2048],
      [type, 'dimension', '4096', 'size', 4096],
      [type, 'dimension', '8192', 'size', 8192],
    ] as const),
    ['io/export-mask', 'bits', '8', 'bits', 8],
    ['io/export-mask', 'bits', '16', 'bits', 16],
    ['io/export-field', 'name', 'Flow', 'name', 'Flow'],
    ...(['png8', 'png16', 'r16', 'r32', 'exr', 'tiff16', 'tiff32'] as const).map((format) => ['io/export-field', 'format', format, 'format', format] as const),
    ['io/export-field', 'rangeMode', 'unit', 'map', 'unit'],
    ['io/export-field', 'rangeMode', 'measured', 'map', 'measured'],
  ];
  for (const [type, param, value, path, expected] of cases) {
    let member: unknown = itemOf(type, { [param]: value });
    for (const key of path.split('.')) member = (member as Record<string, unknown>)[key];
    assert.deepEqual(member, expected, `${type}: ${param} = ${JSON.stringify(value)} sets ${path}`);
  }
  // The fixed range takes both of its ends.
  assert.deepEqual((itemOf('io/export-landscape', { rangeMode: 'fixed', heightMin: 0.125, heightMax: 0.75 }) as { range: unknown }).range, { mode: 'fixed', min: 0.125, max: 0.75 });
  // Every enum option and both values of every bool were tried.
  for (const def of exportNodes) {
    for (const param of def.params.slice(1)) {
      const tried = cases.filter(([type, name]) => type === def.type && name === param.name).map(([, , value]) => value);
      if (param.kind === 'enum') assert.deepEqual(param.options.map((o) => o.value).filter((v) => !tried.includes(v)), [], `${def.type}: options of ${param.name} not tried`);
      if (param.kind === 'bool') assert.deepEqual([true, false].filter((v) => !tried.includes(v)), [], `${def.type}: values of ${param.name} not tried`);
      if (param.kind !== 'float' || !param.visibleWhen) assert.ok(tried.length > 0 || ['heightMin', 'heightMax'].includes(param.name), `${def.type}: ${param.name} was not tried`);
    }
  }
});

test('a hook is pure: two calls with the same context return equal results, and it asks for nothing but its source', () => {
  for (const def of exportNodes) {
    const calls: string[] = [];
    const ctx: ExportContext = {
      params: normalizeParams(def, {}).values as Readonly<Record<string, ParamValue>>,
      nodeId: 'n', title: def.title,
      connected: (input) => { calls.push(`connected ${input}`); return true; },
      source: (input) => { calls.push(`source ${input}`); return { node: 'n', input }; },
    };
    const first = def.export!(ctx), second = def.export!(ctx);
    assert.deepEqual(first, second, def.type);
    assert.notEqual(first, second, `${def.type}: each call makes its own list`);
    assert.deepEqual([...new Set(calls)], ['source in'], def.type);
  }
});

test('a disabled node contributes nothing, and an enabled one without a connection is E_INPUT_MISSING', () => {
  for (const def of exportNodes) {
    const disabled = planBuild(docWith(def.type, { enabled: false }), REGISTRY);
    assert.deepEqual(disabled.items.filter((entry) => entry.nodeId === 'out'), [], def.type);
    assert.deepEqual(disabled.files.filter((file) => file.nodeId === 'out'), [], def.type);
    assert.deepEqual(disabled.problems.filter((problem) => problem.nodeId === 'out'), [], def.type);
    // Disabled and unconnected: still nothing, not even a problem.
    assert.deepEqual(planBuild(docWith(def.type, { enabled: false }, false), REGISTRY).problems.filter((problem) => problem.nodeId === 'out'), [], def.type);

    const open = planBuild(docWith(def.type, {}, false), REGISTRY);
    assert.deepEqual(open.problems.filter((problem) => problem.nodeId === 'out').map((problem) => [problem.severity, problem.code]), [['error', 'E_INPUT_MISSING']], def.type);
    assert.match(open.problems.find((problem) => problem.nodeId === 'out')!.message, new RegExp(`^${def.title}: `), 'the message names the node by its title');
    assert.equal(open.ok, false);
    assert.deepEqual(open.items.filter((entry) => entry.nodeId === 'out'), []);
  }
});
