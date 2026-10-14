// planBuild (export-unreal.md 2.5, 2.6, 3.3) without a GPU: the order of items, layers and files of a full
// build, and every problem code of the plan from a document made to provoke it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineNode, type NodeDef } from '../../../src/core/api.ts';
import type { BuildPlan, BuildProblem } from '../../../src/core/runtime.ts';
import { alnumOnly, checkExportNode, edgeInto, isBuildResolution, lettersOnly, planBuild } from '../../../src/export/plan.ts';
import { docOf, REGISTRY, registryOf, SOURCES, type NodeSpec } from './_docs.ts';

// ---- export nodes of the tests: hooks that misbehave, and one that returns whatever its instance spells out ----

const hooked = (name: string, hook: (ctx: { source(input: 'in'): { node: string; input: string }; params: { readonly item?: string } }) => unknown, category: 'io' | 'ref' = 'io'): NodeDef => defineNode({
  type: category === 'io' ? `io/export-test-${name}` : `ref/test-${name}`,
  title: `Test ${name}`,
  category,
  description: 'Declares what a test wants a build to meet.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    { kind: 'text', name: 'item', default: '{}', maxLength: 2000, help: 'The members of the item, as JSON.' },
  ],
  kernels: [],
  evaluate() {},
  export: hook as never,
});

const LANDSCAPE = {
  kind: 'landscape', name: 'Test', range: { mode: 'measured', headroom: 0 }, dither: false, zeroAt: 'seaLevel', origin: 'center',
  baseLayer: 'Base', layerBlend: 'advanced', layerFloor: 0, layerLimit: 0, worldPartition: { enabled: true, gridSize: 4, regionSize: 32 },
};
const TEST_NODES: readonly NodeDef[] = [
  hooked('throws', () => { throw new Error('the hook gave up'); }),
  hooked('no-list', (ctx) => ({ kind: 'image', source: ctx.source('in') })),
  hooked('unknown-kind', (ctx) => [{ kind: 'splines', source: ctx.source('in') }]),
  hooked('foreign-source', () => [{ kind: 'image', source: { node: 'elsewhere', input: 'in' }, name: 'A', format: 'exr', map: 'unit' }]),
  hooked('unasked-source', () => [{ kind: 'image', source: { node: 'x', input: 'in' }, name: 'A', format: 'exr', map: 'unit' }]),
  hooked('no-item', () => [null]),
  hooked('empty', () => []),
  // The item its instance spells out, over a valid landscape, texture or image item of that kind.
  hooked('raw', (ctx) => {
    const given = JSON.parse(ctx.params.item ?? '{}') as { kind?: string };
    const base = given.kind === 'landscape' ? LANDSCAPE
      : given.kind === 'layer' ? { kind: 'layer', layer: 'Layer', weightBlended: true }
      : given.kind === 'texture' ? { kind: 'texture', name: 'Tex', content: 'mask', size: 'auto', bits: 8 }
      : { kind: 'image', name: 'Img', format: 'exr', map: 'unit' };
    return [{ ...base, ...given, source: ctx.source('in') }];
  }),
  hooked('wrong-category', (ctx) => [{ kind: 'image', source: ctx.source('in'), name: 'A', format: 'exr', map: 'unit' }], 'ref'),
];
const TEST_REGISTRY = registryOf(TEST_NODES);

const plan = (nodes: Readonly<Record<string, NodeSpec>>, opts?: { resolution?: number }, settings: Parameters<typeof docOf>[1] = {}): BuildPlan =>
  planBuild(docOf({ ...SOURCES, ...nodes }, settings, TEST_REGISTRY), TEST_REGISTRY, opts);
const codes = (p: BuildPlan): string[] => p.problems.map((problem) => problem.code);
const problemOf = (p: BuildPlan, code: string): BuildProblem => {
  const found = p.problems.filter((problem) => problem.code === code);
  assert.equal(found.length, 1, `one ${code} among ${JSON.stringify(codes(p))}`);
  return found[0]!;
};
const raw = (item: Readonly<Record<string, unknown>>, feed = 'land.out'): NodeSpec => ({ type: 'io/export-test-raw', params: { item: JSON.stringify(item) }, in: feed });
const landscape = (params: Readonly<Record<string, unknown>> = {}): NodeSpec => ({ type: 'io/export-landscape', params, in: 'land.out' });
const layer = (name: string, weightBlended = true): NodeSpec => ({ type: 'io/export-layer', params: { layer: name, weightBlended }, in: 'steep.out' });

test('lettersOnly and alnumOnly make the file names of 2.6', () => {
  assert.equal(lettersOnly('alps 01 (wet)'), 'Alpswet');
  assert.equal(alnumOnly('Rock_Wet 2'), 'RockWet2');
  assert.deepEqual([lettersOnly(''), lettersOnly('123 _-'), lettersOnly('é'), lettersOnly('x'), lettersOnly('Orogen')], ['', '', '', 'X', 'Orogen']);
  assert.deepEqual([alnumOnly(''), alnumOnly('T_Color_1024.png'), alnumOnly('9 lives')], ['', 'TColor1024png', '9lives']);
  assert.deepEqual([129, 513, 1009, 2017, 4033, 8129, 8177].map(isBuildResolution), Array(7).fill(true));
  assert.deepEqual([128, 1000, 1010, 8193, 8209, 257.5, NaN, '1009'].map(isBuildResolution), Array(8).fill(false));
});

test('a full build: the items in processing order, the layers, and every file in the order of 3.3', () => {
  const p = plan({
    // Ids chosen against the order the plan must make: it sorts by kind and name, not by id.
    a: { type: 'io/export-field', params: { name: 'Wear', format: 'png16', rangeMode: 'measured' }, in: 'land.out' },
    b: layer('rock'),
    c: { type: 'io/export-normal', params: { name: 'Normal', dimension: '2048' }, in: 'land.out' },
    d: layer('wet2', false),
    e: { type: 'io/export-color', in: 'paint.out' },
    f: layer('Grass'),
    g: { type: 'io/export-landscape', params: { name: 'alps 01 (wet)', layerBlend: 'final' }, in: 'land.out', title: 'My Terrain' },
    h: { type: 'io/export-mask', params: { name: 'Mask', bits: '16' }, in: 'steep.out' },
    i: layer('Flow', false),
    j: { type: 'io/export-field', params: { name: 'Depth' }, in: 'land.out' },
    k: { type: 'io/export-field', params: { name: 'Off', enabled: false }, in: 'land.out' },
  });
  assert.deepEqual(p.problems, []);
  assert.equal(p.ok, true);
  assert.deepEqual([p.resolution, p.name], [1009, 'Alpswet']);

  // The landscape; the weight-blended layers by name, ignoring case; the other layers likewise; textures and images by file name.
  assert.deepEqual(p.items.map((entry) => entry.nodeId), ['g', 'f', 'b', 'i', 'd', 'e', 'h', 'c', 'j', 'a']);
  assert.deepEqual(p.items.map((entry) => entry.item.kind), ['landscape', 'layer', 'layer', 'layer', 'layer', 'texture', 'texture', 'texture', 'image', 'image']);
  assert.deepEqual(p.targets, p.items.map((entry) => ({ node: entry.nodeId, input: 'in' })));
  assert.deepEqual(p.layout, { quadsPerSection: 63, sectionsPerComponent: 2, components: 8, totalComponents: 64 });
  assert.deepEqual(p.layers, [
    { name: 'Base', blend: 'final', base: true, nodeId: null },
    { name: 'Grass', blend: 'final', base: false, nodeId: 'f' },
    { name: 'rock', blend: 'final', base: false, nodeId: 'b' },
    { name: 'Flow', blend: 'none', base: false, nodeId: 'i' },
    { name: 'wet2', blend: 'none', base: false, nodeId: 'd' },
  ]);
  const N = 1009, raw8 = N * N;
  assert.deepEqual(p.files.map((file) => [file.path, file.encoding, file.width, file.bytes, file.nodeId]), [
    ['AlpswetHeight.png', 'png-gray16', N, null, 'g'],
    ['AlpswetHeight.r16', 'raw-u16', N, 2 * raw8, 'g'],
    ['LayerBase.png', 'png-gray8', N, null, null],
    ['LayerBase.r8', 'raw-u8', N, raw8, null],
    ['LayerGrass.png', 'png-gray8', N, null, 'f'],
    ['LayerGrass.r8', 'raw-u8', N, raw8, 'f'],
    ['LayerRock.png', 'png-gray8', N, null, 'b'],
    ['LayerRock.r8', 'raw-u8', N, raw8, 'b'],
    ['LayerFlow.png', 'png-gray8', N, null, 'i'],
    ['LayerFlow.r8', 'raw-u8', N, raw8, 'i'],
    ['LayerWet.png', 'png-gray8', N, null, 'd'],
    ['LayerWet.r8', 'raw-u8', N, raw8, 'd'],
    ['T_Color_1024.png', 'png-rgb8', 1024, null, 'e'],
    ['T_Mask_1024.png', 'png-gray16', 1024, null, 'h'],
    ['T_Normal_2048.png', 'png-rgb8', 2048, null, 'c'],
    ['Depth.exr', 'exr-f32', N, 277 + N * (16 + 4 * N), 'j'],
    ['Wear.png', 'png-gray16', N, null, 'a'],
    ['Alpswet.orogen.json', 'json', 0, null, null],
  ]);
  assert.ok(p.files.every((file) => file.width === file.height));
  // Two weight-blended layers are held as planes of 16-bit codes.
  assert.deepEqual(p.estimate, { planeBytes: 2 * 2 * raw8, knownFileBytes: 2 * raw8 + 5 * raw8 + 277 + N * (16 + 4 * N) });
  // A plan is plain data.
  assert.deepEqual(structuredClone(p), p);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test('the resolution of a plan: the option, else the project\'s; a landscape needs a landscape size', () => {
  assert.equal(plan({ out: landscape() }).resolution, 1009);
  const at8129 = plan({ out: landscape() }, { resolution: 8129 });
  assert.deepEqual([at8129.ok, at8129.resolution, at8129.layout?.components, at8129.files[1]!.bytes], [true, 8129, 32, 132_161_282]);

  for (const resolution of [1000, 1010, 100, 8193, 1009.5]) {
    const bad = plan({ out: landscape() }, { resolution });
    assert.deepEqual(codes(bad), ['E_RESOLUTION'], String(resolution));
    assert.deepEqual([bad.ok, bad.layout], [false, null]);
    assert.match(problemOf(bad, 'E_RESOLUTION').message, new RegExp(`^The build resolution ${resolution} is not valid`));
  }
  assert.deepEqual(codes(plan({ out: landscape() }, undefined, { buildResolution: 1000 })), ['E_RESOLUTION'], 'the project\'s own resolution is checked as well');

  // 513, 2049 and 4097 are build resolutions and no landscape sizes: the message lists the nearest ones.
  const square = plan({ out: landscape() }, { resolution: 2049 });
  assert.deepEqual(codes(square), ['E_SIZE_NOT_LANDSCAPE']);
  const problem = problemOf(square, 'E_SIZE_NOT_LANDSCAPE');
  assert.deepEqual([problem.severity, problem.nodeId], ['error', 'out']);
  assert.match(problem.message, /^Unreal Landscape: 2049 x 2049 is not a size an Unreal landscape can have; the nearest valid build resolutions are 2033 and 3025\.$/);
  // Textures and images need no landscape size.
  assert.deepEqual(codes(plan({ out: { type: 'io/export-field', in: 'land.out' }, tex: { type: 'io/export-color', in: 'paint.out' } }, { resolution: 2049 })), []);
});

test('2.5: nothing to export, an unconnected input, several landscapes, a layer without a landscape', () => {
  const none = plan({});
  assert.deepEqual(codes(none), ['E_NOTHING_TO_EXPORT']);
  assert.deepEqual([none.ok, none.items.length, none.name], [false, 0, 'Export']);
  assert.deepEqual(none.files.map((file) => file.path), ['Export.orogen.json']);
  assert.deepEqual(codes(plan({ out: { ...landscape(), params: { enabled: false } } })), ['E_NOTHING_TO_EXPORT'], 'a disabled node is no node');
  assert.deepEqual(codes(plan({ out: { type: 'io/export-test-empty', in: 'land.out' } })), ['E_NOTHING_TO_EXPORT'], 'a hook may return no item');

  const open = plan({ out: { type: 'io/export-landscape' } });
  assert.deepEqual(codes(open), ['E_INPUT_MISSING', 'E_NOTHING_TO_EXPORT']);
  // An edge from a node of a type the registry lacks, from a node the document lacks or from a missing output is no connection.
  for (const feed of ['ghost.out', 'nobody.out', 'land.nope']) {
    const p = plan({ ghost: { type: 'legacy/unknown' }, out: { type: 'io/export-landscape', in: feed } });
    assert.deepEqual(codes(p), ['E_INPUT_MISSING', 'E_NOTHING_TO_EXPORT'], feed);
  }

  const two = plan({ a: landscape({ name: 'One' }), b: { ...landscape({ name: 'Two' }), title: 'Second' } });
  assert.deepEqual(codes(two), ['E_SEVERAL_LANDSCAPES']);
  assert.match(problemOf(two, 'E_SEVERAL_LANDSCAPES').message, /2 nodes export one: Unreal Landscape, Second/);
  assert.equal(two.name, 'One', 'the first, by node id, names the build');

  const orphan = plan({ out: layer('Rock') });
  assert.deepEqual(codes(orphan), ['E_LAYER_WITHOUT_LANDSCAPE']);
  assert.deepEqual([problemOf(orphan, 'E_LAYER_WITHOUT_LANDSCAPE').nodeId, orphan.layers.length, orphan.layout], ['out', 1, null]);
});

test('E_HOOK_FAILED: a hook that throws or returns no items of 2.2, a parameter that cannot be read, a node that is no export node', () => {
  const failing: readonly (readonly [NodeSpec, RegExp])[] = [
    [{ type: 'io/export-test-throws', in: 'land.out', title: 'Broken' }, /^Broken: its export declaration failed: the hook gave up\.$/],
    [{ type: 'io/export-test-no-list', in: 'land.out' }, /returned no list of items/],
    [{ type: 'io/export-test-unknown-kind', in: 'land.out' }, /unknown kind "splines"/],
    [{ type: 'io/export-test-foreign-source', in: 'land.out' }, /source does not come from ctx\.source\(\) of the same call/],
    [{ type: 'io/export-test-unasked-source', in: 'land.out' }, /source does not come from ctx\.source\(\) of the same call/],
    [{ type: 'io/export-test-no-item', in: 'land.out' }, /no export item/],
    // An enum value the definition does not know stops the node, as it stops an evaluation (runtime.md 4.4).
    [{ type: 'io/export-field', params: { format: 'jpeg' }, in: 'land.out' }, /^Image File: param "format": unknown value "jpeg"\.$/],
    [{ type: 'ref/test-wrong-category', in: 'land.out' }, /breaks the rules for export nodes: an export node has the category "io"/],
  ];
  for (const [spec, message] of failing) {
    const p = plan({ out: spec, land2: landscape() });
    const problem = problemOf(p, 'E_HOOK_FAILED');
    assert.deepEqual([problem.severity, problem.nodeId, p.ok], ['error', 'out', false], spec.type);
    assert.match(problem.message, message, spec.type);
    assert.deepEqual(p.items.map((entry) => entry.nodeId), ['land2'], 'the other nodes are planned all the same');
  }
  // The source of an unconnected input cannot be asked for: the hook's own throw is reported.
  assert.deepEqual(checkExportNode(TEST_NODES.at(-1)!), ['an export node has the category "io" and a type that begins with "io/export-", not "ref/test-wrong-category"']);
});

test('E_NAME_INVALID, E_LAYER_NAME_INVALID, E_RANGE_INVALID and E_FORMAT_INVALID: a member of an item breaks its rule of 2.2', () => {
  const one = (nodes: Readonly<Record<string, NodeSpec>>, code: string): BuildProblem => {
    const p = plan(nodes);
    assert.deepEqual(codes(p).filter((c) => c !== 'E_NOTHING_TO_EXPORT'), [code], JSON.stringify(nodes));
    assert.equal(p.ok, false);
    return problemOf(p, code);
  };
  // Names that leave nothing for a file name.
  assert.match(one({ out: landscape({ name: '2026 (01)' }) }, 'E_NAME_INVALID').message, /^Unreal Landscape: the name "2026 \(01\)" leaves nothing for a file name; 1 to 64 ASCII letters are needed\.$/);
  one({ land2: landscape(), out: { type: 'io/export-color', params: { name: '!?' }, in: 'paint.out' } }, 'E_NAME_INVALID');
  one({ out: { type: 'io/export-field', params: { name: '' }, in: 'land.out' } }, 'E_NAME_INVALID');
  one({ out: raw({ kind: 'image', name: 'x'.repeat(65) }) }, 'E_NAME_INVALID');
  assert.deepEqual(codes(plan({ out: raw({ kind: 'image', name: 'x'.repeat(64) }) })), []);
  // A name Windows keeps for a device, where it would be the whole base name of a file: Con.orogen.json, NUL.r16.
  for (const name of ['Con', 'c-o-n', 'NUL', 'aux', 'Prn 1']) {
    const device = one({ out: landscape({ name }) }, 'E_NAME_INVALID');
    assert.match(device.message, /which Windows keeps for a device and cannot open as a file; choose another name\.$/, name);
  }
  assert.match(one({ out: { type: 'io/export-field', params: { name: 'com1' }, in: 'land.out' } }, 'E_NAME_INVALID').message, /gives the file name com1, which Windows keeps for a device/);
  one({ out: { type: 'io/export-field', params: { name: 'LPT9', format: 'r16' }, in: 'land.out' } }, 'E_NAME_INVALID');
  // Not the whole base name: a landscape named Console, an image named com10, and any texture or layer.
  assert.deepEqual(codes(plan({ out: landscape({ name: 'Console' }) })), []);
  assert.deepEqual(codes(plan({ out: { type: 'io/export-field', params: { name: 'com10' }, in: 'land.out' } })), []);
  assert.deepEqual(codes(plan({ out: { type: 'io/export-color', params: { name: 'con' }, in: 'paint.out' } })), []);
  assert.deepEqual(codes(plan({ land2: landscape(), out: layer('Con', false) })), []);
  // A landscape without a usable name is still planned, under the name of a build without one.
  assert.equal(plan({ out: landscape({ name: '42' }) }).name, 'Export');

  for (const name of ['1abc', 'has space', 'dash-ed', '', 'é', 'x'.repeat(64)]) {
    one({ land2: landscape(), out: raw({ kind: 'layer', layer: name }, 'steep.out') }, 'E_LAYER_NAME_INVALID');
    one({ out: raw({ kind: 'landscape', baseLayer: name }) }, 'E_LAYER_NAME_INVALID');
  }
  assert.deepEqual(codes(plan({ land2: landscape(), out: layer(`A${'_9'.repeat(31)}`) })), [], 'a letter, then 62 letters, digits and underscores');

  for (const range of [{ mode: 'fixed', min: 0.5, max: 0.5 }, { mode: 'fixed', min: 0.6, max: 0.5 }, { mode: 'measured', headroom: -0.1 }, { mode: 'measured', headroom: 1.5 }, { mode: 'other' }, { mode: 'fixed', min: 0 }]) {
    one({ out: raw({ kind: 'landscape', range }) }, 'E_RANGE_INVALID');
  }
  one({ out: landscape({ rangeMode: 'fixed', heightMin: 0.75, heightMax: 0.25 }) }, 'E_RANGE_INVALID');
  assert.deepEqual(codes(plan({ out: landscape({ rangeMode: 'fixed', heightMin: -0.5, heightMax: 2 }) })), [], 'a fixed range may reach beyond 0..1');

  const formats: readonly Readonly<Record<string, unknown>>[] = [
    { kind: 'landscape', layerFloor: 0.3 }, { kind: 'landscape', layerLimit: 17 }, { kind: 'landscape', layerLimit: 1.5 },
    { kind: 'landscape', worldPartition: { enabled: true, gridSize: 0, regionSize: 32 } }, { kind: 'landscape', worldPartition: { enabled: true, gridSize: 4, regionSize: 65 } },
    { kind: 'landscape', dither: 'yes' }, { kind: 'landscape', zeroAt: 'top' }, { kind: 'landscape', origin: 'middle' }, { kind: 'landscape', layerBlend: 'none' },
    { kind: 'texture', content: 'height' }, { kind: 'texture', size: 512 }, { kind: 'texture', bits: 32 }, { kind: 'texture', content: 'normal', bits: 16 },
    // A colour texture takes a colour, and so does a texture of three data channels: the test node's input is a field.
    { kind: 'texture', content: 'color' }, { kind: 'texture', content: 'data' }, { kind: 'texture', content: 'data', bits: 16 },
    { kind: 'image', format: 'jpeg' }, { kind: 'image', map: 'auto' },
  ];
  for (const item of formats) one({ out: raw(item) }, 'E_FORMAT_INVALID');
  // A texture of data is made of a colour, as a colour texture is, and is an 8-bit RGB file like it.
  const data = plan({ out: { type: 'io/export-color', params: { name: 'Packed', content: 'data' }, in: 'paint.out' } });
  assert.deepEqual([codes(data), data.items.map((entry) => (entry.item.kind === 'texture' ? entry.item.content : entry.item.kind)), data.files[0]!.path, data.files[0]!.encoding], [[], ['data'], 'T_Packed_1024.png', 'png-rgb8']);
  one({ land2: landscape(), out: raw({ kind: 'layer', weightBlended: 'true' }, 'steep.out') }, 'E_FORMAT_INVALID');
});

test('layer names are unique ignoring case, the base layer among them when it exists; at most 15 are weight-blended', () => {
  const twice = plan({ land2: landscape(), a: layer('Rock'), b: { ...layer('rock'), title: 'Wet Rock' } });
  // Their files collide as well, the PNG and the raw file of each, for that one reason: it is said once.
  assert.deepEqual(codes(twice), ['E_LAYER_NAME_DUPLICATE']);
  assert.equal(twice.ok, false);
  assert.match(problemOf(twice, 'E_LAYER_NAME_DUPLICATE').message, /^Wet Rock: the layer name "rock" is also used by Landscape Layer/);

  const base = plan({ land2: landscape(), a: layer('base') });
  assert.deepEqual(codes(base), ['E_LAYER_NAME_DUPLICATE']);
  assert.match(problemOf(base, 'E_LAYER_NAME_DUPLICATE').message, /is also used by the base layer of Unreal Landscape/);
  // Without a weight-blended layer there is no base layer to collide with.
  assert.deepEqual(codes(plan({ land2: landscape(), a: layer('base', false) })), []);
  assert.deepEqual(plan({ land2: landscape(), a: layer('base', false) }).layers.map((l) => l.name), ['base']);

  const many = (count: number, blended: boolean): Readonly<Record<string, NodeSpec>> =>
    Object.fromEntries([['land2', landscape()], ...Array.from({ length: count }, (_, i) => [`l${String(i).padStart(2, '0')}`, layer(`L${String.fromCharCode(65 + i)}`, blended)])]);
  assert.deepEqual(codes(plan(many(15, true))), ['W_MANY_LAYERS']);
  const sixteen = plan(many(16, true));
  assert.deepEqual(codes(sixteen), ['E_TOO_MANY_LAYERS', 'W_MANY_LAYERS']);
  assert.equal(sixteen.ok, false);
  // 12 layers in all, the base included, pass without a warning; the 13th is warned about, and warnings leave the plan ok.
  assert.deepEqual(codes(plan(many(11, true))), []);
  const thirteen = plan(many(12, true));
  assert.deepEqual([codes(thirteen), thirteen.ok, problemOf(thirteen, 'W_MANY_LAYERS').severity], [['W_MANY_LAYERS'], true, 'warning']);
  assert.deepEqual(codes(plan(many(12, false))), [], 'twelve independent masks have no base layer beside them');
  assert.deepEqual(codes(plan(many(16, false))), ['W_MANY_LAYERS'], 'any number of independent masks is planned');
});

test('W_GRID_SIZE and W_REGION_SIZE warn about World Partition values and leave the plan ok', () => {
  // 1009 has 8 components a side.
  const grid = plan({ out: landscape({ gridComponents: 5 }) });
  assert.deepEqual([codes(grid), grid.ok], [['W_GRID_SIZE'], true]);
  assert.match(problemOf(grid, 'W_GRID_SIZE').message, /8 components a side, which is not a multiple of the World Partition grid size 5/);
  for (const gridComponents of [1, 2, 4, 8]) assert.deepEqual(codes(plan({ out: landscape({ gridComponents }) })), []);
  assert.deepEqual(codes(plan({ out: landscape({ gridComponents: 16 }) })), ['W_GRID_SIZE']);
  assert.deepEqual(codes(plan({ out: landscape({ gridComponents: 16 }) }, { resolution: 8129 })), [], '32 components at 8129');
  const region = plan({ out: landscape({ regionComponents: 4 }) });
  assert.deepEqual([codes(region), region.ok, problemOf(region, 'W_REGION_SIZE').severity], [['W_REGION_SIZE'], true, 'warning']);
  assert.deepEqual(codes(plan({ out: landscape({ regionComponents: 5 }) })), []);
});

test('E_FILE_COLLISION: two files whose paths are equal ignoring case, with both nodes named', () => {
  const collision = (nodes: Readonly<Record<string, NodeSpec>>): BuildProblem => {
    const p = plan(nodes);
    assert.deepEqual(codes(p), ['E_FILE_COLLISION'], JSON.stringify(Object.keys(nodes)));
    assert.equal(p.ok, false);
    return problemOf(p, 'E_FILE_COLLISION');
  };
  // Layers named Rock1 and Rock2 are both LayerRock: the file names of the importer hold letters only. The PNG and the raw file both collide.
  const rocks = plan({ land2: landscape(), a: { ...layer('Rock1'), title: 'First' }, b: { ...layer('Rock2'), title: 'Second' } });
  assert.deepEqual(codes(rocks), ['E_FILE_COLLISION', 'E_FILE_COLLISION']);
  assert.match(rocks.problems[0]!.message, /^Second and First would both write the file LayerRock\.png; give them names that differ in letters\.$/);
  assert.equal(rocks.problems[0]!.nodeId, 'b');
  assert.deepEqual(codes(plan({ land2: landscape(), a: layer('RockA'), b: layer('RockB') })), []);

  assert.match(collision({ a: { type: 'io/export-color', in: 'paint.out' }, b: { type: 'io/export-mask', params: { name: 'color' }, in: 'steep.out' } }).message, /T_color_1024\.png/);
  assert.deepEqual(codes(plan({ a: { type: 'io/export-color', in: 'paint.out' }, b: { type: 'io/export-color', params: { dimension: '2048' }, in: 'paint.out' } })), [], 'two sizes are two files');
  collision({ a: { type: 'io/export-field', params: { name: 'Map', format: 'png8' }, in: 'land.out' }, b: { type: 'io/export-field', params: { name: 'MAP', format: 'png16' }, in: 'land.out' } });
  assert.deepEqual(codes(plan({ a: { type: 'io/export-field', params: { name: 'Map', format: 'tiff16' }, in: 'land.out' }, b: { type: 'io/export-field', params: { name: 'Map', format: 'png16' }, in: 'land.out' } })), [], 'two extensions are two files');
  // An image may not take the name of the heightmap or of a layer file.
  assert.match(collision({ a: landscape(), b: { type: 'io/export-field', params: { name: 'OrogenHeight', format: 'r16' }, in: 'land.out' } }).message, /^Image File and Unreal Landscape would both write the file OrogenHeight\.r16/);
  collision({ a: landscape(), l: layer('Rock', false), b: { type: 'io/export-field', params: { name: 'layerrock', format: 'png8' }, in: 'land.out' } });
});

test('what a plan ignores: the bypass flag, a title that is empty, nodes that export nothing', () => {
  const p = plan({ out: { ...landscape(), bypass: true, title: '' } });
  assert.deepEqual([codes(p), p.items.length], [[], 1]);
  // The edge the evaluator would use: the first into the input, in record order, that is valid.
  const doc = docOf({ ...SOURCES, out: landscape() }, {}, TEST_REGISTRY);
  assert.deepEqual(edgeInto(doc, TEST_REGISTRY, 'out', 'in')?.from, { node: 'land', port: 'out' });
  assert.equal(edgeInto(doc, TEST_REGISTRY, 'out', 'mask'), null);
  assert.equal(edgeInto(doc, TEST_REGISTRY, 'land', 'in'), null);
  const twoEdges = { ...doc, edges: { first: { id: 'first', from: { node: 'nobody', port: 'out' }, to: { node: 'out', port: 'in' } }, second: { id: 'second', from: { node: 'steep', port: 'out' }, to: { node: 'out', port: 'in' } }, ...doc.edges } };
  assert.equal(edgeInto(twoEdges, TEST_REGISTRY, 'out', 'in')?.id, 'second', 'an edge from a node the document lacks is passed over, and of two valid ones the first is taken');
  assert.deepEqual(planBuild(twoEdges, REGISTRY).problems, []);
});
