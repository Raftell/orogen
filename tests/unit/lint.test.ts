// The registry lint as a library (src/core/graph/lint.ts; testing.md section 4), against small registries:
// one that obeys every rule, and one definition or source text per rule that breaks it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeImage, hash, noise, param, type AnyCpuTask, type NodeDef, type ParamDef, type WgslLib } from '../../src/core/api.ts';
import { lintCategory, lintNode, lintNodes, lintNodeSource, lintTestLocations, type CategorySources, type LintProblem } from '../../src/core/graph/lint.ts';
import { defs, kernel, node } from './graph-fixtures.ts';

const COMPUTE = 'fn compute(px: vec2i, uv: vec2f) -> f32 { return uv.x; }';
/** A float param, or whatever `over` turns it into. */
const float = (over: Record<string, unknown> & { name: string }): ParamDef =>
  ({ kind: 'float', unit: 'none', help: 'Larger values do more.', default: 0.5, min: 0, max: 1, ...over }) as unknown as ParamDef;

/** The rule ids a definition breaks, without repeats, in the order found. */
const rules = (def: NodeDef): string[] => [...new Set(lintNode(def).map((p) => p.rule))];
/** Asserts that `def` breaks exactly `rule`, and returns the details after `<rule> <type>: `. */
function breaks(def: NodeDef, rule: string): string[] {
  const problems = lintNode(def);
  assert.deepEqual([...new Set(problems.map((p) => p.rule))], [rule], JSON.stringify(problems.map((p) => p.message)));
  for (const p of problems) {
    assert.equal(p.subject, def.type);
    assert.ok(p.message.startsWith(`${rule} ${def.type}: `), p.message);
  }
  return problems.map((p) => p.message.slice(`${rule} ${def.type}: `.length));
}

// ---- a registry that obeys every rule ---------------------------------------------------------------------------

const erosion = node({
  type: 'simulate/thermal-erosion',
  title: 'Thermal Erosion',
  category: 'simulate',
  description: 'Collapses slopes steeper than a talus angle into scree.',
  keywords: ['talus', 'scree', 'slump', 'thermal'],
  inputs: [{ name: 'in', type: 'field' }, { name: 'guide', type: 'field', role: 'data', label: 'Guide', optional: true }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'moved', type: 'field', role: 'data', label: 'Moved material' }],
  params: [
    param.slope('talus', { label: 'Talus angle', default: 35, help: 'Slopes steeper than this collapse.' }),
    { kind: 'float', name: 'reach', unit: 'length', default: 0.02, min: 0.001, max: 0.25, scale: 'log', help: 'How far material can travel downslope.' },
    param.strength(),
    { kind: 'enum', name: 'mode', help: 'Chooses how material settles.', default: 'even', options: [{ value: 'even', label: 'Even' }, { value: 'png16', label: '16 bit' }] },
    { kind: 'vec2', name: 'offset', unit: 'length', help: 'Shifts the pattern across the terrain.', default: [0, 0], min: -4, max: 4 },
    { kind: 'float', name: 'heightMin', unit: 'height', help: 'Heights below this are left alone.', default: 0, min: -1, max: 1, soft: true },
    param.size({ name: 'warpSize', label: 'Warp size' }),
    param.octaves(),
    param.seed(),
  ],
  kernels: [
    kernel('simulate/thermal-erosion.step', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(frame.res.x) * frame.cellSize + f32(seedFor(0u)); }'),
    kernel('simulate/talus.step', COMPUTE, [hash]),
  ],
  cpuTasks: [decodeImage, { name: 'simulate/route', run: () => 0 }],
});
const slope = node({
  type: 'select/slope',
  title: 'Slope',
  category: 'select',
  description: 'Selects terrain by its steepness.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [param.slope('slopeMin', { label: 'Minimum slope', default: 20 }), param.slope('slopeMax', { label: 'Maximum slope', default: 45 })],
});
const noiseNode = node({
  type: 'generate/fractal-noise',
  title: 'Fractal Noise 2D',
  category: 'generate',
  description: 'Generates fractal gradient noise.',
  keywords: ['perlin', 'fbm', 'value noise', '2d'],
  outputs: [{ name: 'out', type: 'field' }],
  params: [param.seed(), param.size(), param.octaves(), param.gain()],
  kernels: [kernel('generate/fractal-noise', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(seedFor(0u)) * uv.x; }')],
});
const exporter = node({
  type: 'io/export-layer',
  title: 'Landscape Layer',
  category: 'io',
  description: 'Exports a mask as a landscape layer.',
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [],
  params: [{ kind: 'bool', name: 'enabled', label: 'Enabled', help: 'Includes this layer in the build.', default: true }],
  export: () => [],
});
const reference = node({ type: 'ref/fbm', title: 'Fractal Noise (Reference)', description: 'Generates fractal gradient noise; the reference node for generators.' });
const good: readonly NodeDef[] = [erosion, slope, noiseNode, exporter, reference];

test('definitions that obey every rule have no problem', () => {
  for (const def of good) assert.deepEqual(lintNode(def), [], def.type);
  assert.deepEqual(lintNodes(good), []);
  // The fixtures of the other tests of this folder, except the one without outputs.
  for (const def of defs.filter((d) => d.outputs.length > 0)) assert.deepEqual(lintNode(def), [], def.type);
  assert.deepEqual(lintNodes(defs), []);
});

test('the canonical parameters obey the rules they define', () => {
  const all = node({
    type: 'ref/canonical',
    title: 'Canonical (Reference)',
    params: [param.seed(), param.size(), param.radius(), param.strength(), param.height(), param.angle(), param.slope('talus'), param.octaves(), param.gain()],
  });
  assert.deepEqual(lintNode(all), []);
});

// ---- one bad definition per rule --------------------------------------------------------------------------------

test('kernel-name: a kernel or task of a node begins with the category, except those api.ts exports', () => {
  const wrong = kernel('filter/blur.pass', COMPUTE);
  const task: AnyCpuTask = { name: 'route', run: () => 0 };
  assert.deepEqual(breaks(node({ type: 'ref/sample', kernels: [kernel('ref/sample', COMPUTE), wrong], cpuTasks: [task, decodeImage] }), 'kernel-name'), [
    'the name of kernel "filter/blur.pass" does not begin with "ref/"',
    'the name of CPU task "route" does not begin with "ref/"',
  ]);
  // A task with a core name that api.ts does not export is no exception.
  const impostor: AnyCpuTask = { name: decodeImage.name, run: () => 0 };
  assert.deepEqual(rules(node({ type: 'ref/sample', cpuTasks: [impostor] })), ['kernel-name']);
});

test('generator-frame: the kernels of a node without required inputs mention neither frame.res nor frame.cellSize', () => {
  const lib = (name: string, code: string, deps: readonly WgslLib[] = []): WgslLib => ({ name, code, deps });
  const reads = kernel('ref/sample.a', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(frame.res.x); }');
  const viaLib = kernel('ref/sample.b', COMPUTE, [lib('refOuter', '', [lib('refInner', 'fn refInner_cell() -> f32 { return frame.cellSize; }')])]);
  assert.deepEqual(breaks(node({ type: 'ref/sample', kernels: [reads, viaLib] }), 'generator-frame'), [
    'kernel "ref/sample.a" mentions frame.res; a node without required inputs is a function of uv',
    'kernel "ref/sample.b" mentions frame.cellSize; a node without required inputs is a function of uv',
  ]);
  const optional = [{ name: 'in', type: 'field', optional: true }] as const;
  assert.deepEqual(rules(node({ type: 'ref/sample', inputs: optional, kernels: [reads] })), ['generator-frame']);
  // With a required input the node is a filter, and a core library is not the author's code.
  assert.deepEqual(lintNode(node({ type: 'ref/sample', inputs: [{ name: 'in', type: 'field' }], kernels: [reads, viaLib] })), []);
  // Whatever a core library reads: it is not the node's code, and the lint does not look into it.
  assert.deepEqual(lintNode(node({ type: 'ref/sample', kernels: [kernel('ref/sample.c', COMPUTE, [hash, noise, lib('refOwn', '', [noise])])] })), []);
});

test('title: at most 24 characters, every word capitalised, no trailing punctuation', () => {
  const title = (text: string, category: NodeDef['category'] = 'filter'): NodeDef => node({ type: `${category}/sample`, category, title: text, inputs: [{ name: 'in', type: 'field' }] });
  assert.deepEqual(breaks(title('Thermal erosion node'), 'title'), ['the word "erosion" of "Thermal erosion node" does not begin with a capital letter or a digit']);
  // Title Case leaves its small words and the signs between two names as they are, inside a title: the catalog has all three.
  for (const text of ['Bias and Gain', 'Grow / Shrink', 'Hue / Saturation', 'Height to Mask', 'Rock & Scree']) assert.deepEqual(lintNode(title(text)), [], text);
  assert.deepEqual(breaks(title('and Gain'), 'title'), ['the word "and" of "and Gain" does not begin with a capital letter or a digit']);
  assert.deepEqual(breaks(title('Bias and'), 'title'), ['the word "and" of "Bias and" does not begin with a capital letter or a digit']);
  assert.deepEqual(breaks(title('Bias with Gain'), 'title'), ['the word "with" of "Bias with Gain" does not begin with a capital letter or a digit']);
  assert.deepEqual(breaks(title('Blur:'), 'title'), ['"Blur:" ends in punctuation']);
  assert.deepEqual(breaks(title('Blur.'), 'title'), ['"Blur." ends in punctuation']);
  assert.deepEqual(breaks(title('A Title Of Twenty Five Ch'), 'title'), ['"A Title Of Twenty Five Ch" has 25 characters; a title has at most 24']);
  assert.deepEqual(breaks(title(''), 'title'), ['the title is empty']);
  assert.deepEqual(lintNode(title('A Title Of Twenty Four C')), []);
  assert.deepEqual(lintNode(title('3D Warp')), []);
  // A bracket is punctuation and begins no word; only the " (Reference)" of a ref node is set aside.
  assert.deepEqual(rules(title('Blur (Fast)')), ['title']);
  assert.deepEqual(lintNode(title('Blur 2')), []);
});

test('title: a ref node ends in " (Reference)", which is not counted', () => {
  assert.deepEqual(breaks(node({ type: 'ref/sample', title: 'Sample' }), 'title'), ['the title "Sample" of a ref node does not end in " (Reference)"']);
  assert.deepEqual(lintNode(node({ type: 'ref/sample', title: 'A Title Of Twenty Four C (Reference)' })), []);
  assert.deepEqual(rules(node({ type: 'ref/sample', title: 'A Title Of Twenty Five Ch (Reference)' })), ['title']);
  assert.deepEqual(rules(node({ type: 'ref/sample', title: 'lower (Reference)' })), ['title']);
});

test('description: one sentence of at most 140 characters, a third-person verb first, a full stop last', () => {
  const described = (description: string): NodeDef => node({ type: 'ref/sample', description });
  assert.deepEqual(breaks(described('This node implements a pairwise-gather solver.'), 'description'), [
    'the description begins with "This", not with a capitalised verb in the third person such as "Generates"',
  ]);
  assert.deepEqual(rules(described('Blur the terrain.')), ['description']);
  assert.deepEqual(rules(described('blurs the terrain.')), ['description']);
  assert.deepEqual(rules(described('A blur.')), ['description']);
  assert.deepEqual(breaks(described('Blurs the terrain'), 'description'), ['the description does not end with a full stop']);
  assert.deepEqual(breaks(described('Blurs the terrain. Keeps the edges.'), 'description'), ['the description is more than one sentence']);
  assert.deepEqual(breaks(described('Blurs the terrain\nwith a wide kernel.'), 'description'), ['the description has a line break']);
  assert.deepEqual(breaks(described(`Blurs ${'x'.repeat(134)}.`), 'description'), ['141 characters; a description has at most 140']);
  assert.deepEqual(lintNode(described(`Blurs ${'x'.repeat(133)}.`)), []);
  assert.deepEqual(lintNode(described('Cross-fades two terrains by a mask.')), []);
  assert.deepEqual(lintNode(described('Relaxes slopes steeper than the talus angle; the reference node for iterative simulations.')), []);
});

test('help: at most 200 characters, a capital first, a full stop last, not the label', () => {
  const helped = (help: string, over: Record<string, unknown> = {}): NodeDef => node({ type: 'ref/sample', params: [float({ name: 'reach', help, ...over })] });
  assert.deepEqual(breaks(helped('how far material travels.'), 'help'), ['the help of param "reach" does not begin with a capital']);
  assert.deepEqual(breaks(helped('How far material travels'), 'help'), ['the help of param "reach" does not end with a full stop']);
  assert.deepEqual(breaks(helped('Reach.'), 'help'), ['the help of param "reach" repeats its label']);
  assert.deepEqual(breaks(helped('Talus angle.', { label: 'Talus angle' }), 'help'), ['the help of param "reach" repeats its label']);
  assert.deepEqual(breaks(helped(`H${'x'.repeat(199)}.`), 'help'), ['the help of param "reach" has 201 characters; at most 200']);
  assert.deepEqual(lintNode(helped(`H${'x'.repeat(198)}.`)), []);
});

test('label: param, option and port labels of at most 24 characters, a capital or digit first, no trailing punctuation', () => {
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'reach', label: 'Talus Angle:' })] }), 'label'), [
    'the label "Talus Angle:" of param "reach" ends in punctuation',
  ]);
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'reach', label: 'reach of material' })] }), 'label'), [
    'the label "reach of material" of param "reach" does not begin with a capital or a digit',
  ]);
  // A default label is the name with a capital: a long name needs a label of its own.
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'aVeryLongParameterNameIndeed' })] }), 'label'), [
    'the label "AVeryLongParameterNameIndeed" of param "aVeryLongParameterNameIndeed" has 28 characters; a label has at most 24',
  ]);
  const options = [{ value: 'a', label: 'ridged' }, { value: 'b', label: 'Billow.' }, { value: 'c', label: '2 octaves' }];
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [{ kind: 'enum', name: 'mode', help: 'Chooses the shape.', default: 'a', options }] }), 'label'), [
    'the label "ridged" of option "a" of param "mode" does not begin with a capital or a digit',
    'the label "Billow." of option "b" of param "mode" ends in punctuation',
  ]);
  assert.deepEqual(breaks(node({
    type: 'ref/sample',
    inputs: [{ name: 'in', type: 'field', label: 'source' }],
    outputs: [{ name: 'out', type: 'field', label: 'Result!' }],
  }), 'label'), [
    'the label "source" of input "in" does not begin with a capital or a digit',
    'the label "Result!" of output "out" ends in punctuation',
  ]);
});

test('keywords: at most 12, lower case, no duplicates', () => {
  const keyed = (keywords: readonly string[]): NodeDef => node({ type: 'ref/sample', keywords });
  assert.deepEqual(breaks(keyed(['Node', 'erosion']), 'keywords'), ['"Node" is not lower-case letters, digits, spaces and hyphens']);
  assert.deepEqual(breaks(keyed(['a_b']), 'keywords'), ['"a_b" is not lower-case letters, digits, spaces and hyphens']);
  assert.deepEqual(breaks(keyed([' lead']), 'keywords'), ['" lead" is not lower-case letters, digits, spaces and hyphens']);
  assert.deepEqual(breaks(keyed(['talus', 'scree', 'talus']), 'keywords'), ['"talus" is listed twice']);
  assert.deepEqual(breaks(keyed(Array.from({ length: 13 }, (_, i) => `k${i}`)), 'keywords'), ['13 keywords; at most 12']);
  assert.deepEqual(lintNode(keyed(Array.from({ length: 12 }, (_, i) => `k${i}`))), []);
  assert.deepEqual(lintNode(keyed(['value noise', 'fbm-like', '2d'])), []);
});

test('enum-value: begins with a lower-case letter or a digit', () => {
  const options = [{ value: 'Ridged', label: 'Ridged' }, { value: 'png16', label: 'PNG 16' }, { value: 'sea_level', label: 'Sea level' }, { value: 'seaLevel', label: 'Sea' }];
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [{ kind: 'enum', name: 'mode', help: 'Chooses the shape.', default: 'png16', options }] }), 'enum-value'), [
    'the value "Ridged" of param "mode" does not match [a-z0-9][A-Za-z0-9-]*',
    'the value "sea_level" of param "mode" does not match [a-z0-9][A-Za-z0-9-]*',
  ]);
});

test('param-words: no name holds px, pixel, texel, iterations, iters, steps or passes as a word', () => {
  const named = (name: string): string[] => rules(node({ type: 'ref/sample', params: [float({ name, label: 'Value' })] }));
  for (const name of ['radiusPx', 'px', 'pixelSize', 'blurPixels', 'texel', 'sizeInTexels', 'iterations', 'maxIters', 'steps', 'smoothPasses', 'stepsPerCell']) {
    assert.deepEqual(named(name).includes('param-words'), true, name);
  }
  for (const name of ['footsteps', 'expand', 'compass', 'bypass', 'pxl', 'stepped', 'duration']) assert.deepEqual(named(name), [], name);
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'maxIters', label: 'Limit' })] }), 'param-words'), [
    'param "maxIters" contains "iters"; a stored value is never in texels or iterations',
  ]);
});

test('param-canonical: a canonical name has the kind and unit of its concept', () => {
  const canonical = (p: ParamDef): string[] => rules(node({ type: 'ref/sample', params: [p] }));
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'size', unit: 'none' })] }), 'param-canonical'), [
    'param "size" is a float of unit "none"; that name is a float of unit "length"',
  ]);
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [{ kind: 'int', name: 'gridSize', help: 'Cells per side.', default: 4, min: 1, max: 16 }] }), 'param-canonical'), [
    'param "gridSize" is a int; that name is a float of unit "length"',
  ]);
  assert.deepEqual(canonical(float({ name: 'radius', unit: 'ratio' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'strength', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'height', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'angle', unit: 'none', max: 360 })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'octaves', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'gain', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'edgeRadius', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'detailStrength', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical(float({ name: 'sunAngle', unit: 'none' })), ['param-canonical']);
  assert.deepEqual(canonical({ kind: 'vec2', name: 'size', unit: 'length', help: 'Width and depth.', default: [1, 1], min: 0, max: 4 }), ['param-canonical']);
  // Another kind is no parameter of the concept, and a name that only contains the word is free.
  assert.deepEqual(canonical({ kind: 'enum', name: 'size', help: 'Side of the texture.', default: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: '1024', label: '1024' }] }), []);
  assert.deepEqual(canonical(float({ name: 'heightMin', unit: 'height' })), []);
  assert.deepEqual(canonical(float({ name: 'triangle', unit: 'none' })), []);
  assert.deepEqual(canonical(float({ name: 'sizeBias', unit: 'none' })), []);
});

test('unit-range: the range a unit allows', () => {
  const ranged = (over: Record<string, unknown>): string[] => rules(node({ type: 'ref/sample', params: [float({ name: 'value', ...over })] }));
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'value', unit: 'ratio', max: 2 })] }), 'unit-range'), [
    'param "value" has the range 0..2; a float of unit "ratio" lies within 0..1',
  ]);
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'value', unit: 'ratio', soft: true })] }), 'unit-range'), [
    'param "value" is a ratio and cannot be soft',
  ]);
  assert.deepEqual(ranged({ unit: 'ratio', min: -1, default: 0 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'angle', max: 720 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'angle', min: -90, max: 90, default: 0 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'length', max: 8 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'length', min: -1, default: 0 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'height', min: -2, default: 0 }), ['unit-range']);
  assert.deepEqual(ranged({ unit: 'height', max: 1.5 }), ['unit-range']);
  assert.deepEqual(ranged({ kind: 'vec2', unit: 'length', default: [0, 0], min: -8, max: 8 }), ['unit-range']);
  assert.deepEqual(ranged({ kind: 'vec2', unit: 'ratio', default: [0, 0], min: 0, max: 1, soft: true }), ['unit-range']);

  assert.deepEqual(ranged({ unit: 'angle', max: 360 }), []);
  assert.deepEqual(ranged({ unit: 'length', max: 4, soft: true }), []);
  assert.deepEqual(ranged({ unit: 'height', min: -1, max: 1, soft: true }), []);
  assert.deepEqual(ranged({ kind: 'vec2', unit: 'length', default: [0, 0], min: -4, max: 4 }), []);
  assert.deepEqual(ranged({ unit: 'none', min: -1000, max: 1000 }), []);
});

test('log-scale: a float from a positive minimum over two decades or more is logarithmic', () => {
  const scaled = (over: Record<string, unknown>): string[] => rules(node({ type: 'ref/sample', params: [float({ name: 'value', ...over })] }));
  assert.deepEqual(breaks(node({ type: 'ref/sample', params: [float({ name: 'value', min: 0.01, max: 1 })] }), 'log-scale'), [
    "param \"value\" spans 0.01..1 and does not declare scale: 'log'",
  ]);
  assert.deepEqual(scaled({ min: 0.001, max: 4, scale: 'linear' }), ['log-scale']);
  assert.deepEqual(scaled({ min: 0.01, max: 1, scale: 'log' }), []);
  assert.deepEqual(scaled({ min: 0.02, max: 1 }), []);
  assert.deepEqual(scaled({ min: 0, max: 1000 }), []);
});

test('role-select, role-generate and has-output', () => {
  const select = (output: NodeDef['outputs'][number]): NodeDef => node({ type: 'select/sample', category: 'select', title: 'Sample', inputs: [{ name: 'in', type: 'field' }], outputs: [output] });
  assert.deepEqual(breaks(select({ name: 'out', type: 'field' }), 'role-select'), ['output "out" of a select node has role "mask" or "data"']);
  assert.deepEqual(rules(select({ name: 'out', type: 'field', role: 'height' })), ['role-select']);
  assert.deepEqual(rules(select({ name: 'out', type: 'color' })), ['role-select']);
  assert.deepEqual(lintNode(select({ name: 'out', type: 'field', role: 'data' })), []);
  assert.deepEqual(lintNode(select({ name: 'out', type: 'field', role: 'mask' })), []);

  const generate = (output: NodeDef['outputs'][number]): NodeDef => node({ type: 'generate/sample', category: 'generate', title: 'Sample', outputs: [output] });
  assert.deepEqual(breaks(generate({ name: 'out', type: 'field', role: 'data' }), 'role-generate'), ['output "out" of a generate node is a field of role "height" or "mask"']);
  assert.deepEqual(rules(generate({ name: 'out', type: 'color' })), ['role-generate']);
  assert.deepEqual(lintNode(generate({ name: 'out', type: 'field' })), []);
  assert.deepEqual(lintNode(generate({ name: 'out', type: 'field', role: 'mask' })), []);

  assert.deepEqual(breaks(node({ type: 'ref/sample', outputs: [] }), 'has-output'), ['the node has no output and is not an export node']);
  assert.deepEqual(lintNode(node({ type: 'ref/sample', outputs: [], export: () => [] })), []);
});

test('a definition that breaks several rules reports each, every message beginning with its rule and the type', () => {
  const bad = node({
    type: 'select/sample',
    category: 'select',
    title: 'bad title.',
    description: 'it is bad',
    keywords: ['Bad'],
    outputs: [{ name: 'out', type: 'field' }],
    params: [float({ name: 'blurPx', unit: 'ratio', max: 5, help: 'bad' })],
    kernels: [kernel('filter/blur', 'fn compute(px: vec2i, uv: vec2f) -> f32 { return frame.cellSize; }')],
  });
  const problems = lintNode(bad);
  assert.deepEqual([...new Set(problems.map((p) => p.rule))].sort(), [
    'description', 'generator-frame', 'help', 'kernel-name', 'keywords', 'param-words', 'role-select', 'title', 'unit-range',
  ]);
  for (const p of problems) assert.ok(p.message.startsWith(`${p.rule} select/sample: `), p.message);
});

// ---- across definitions -----------------------------------------------------------------------------------------

test('title-unique: no two nodes have the same title', () => {
  const a = node({ type: 'filter/blur', category: 'filter', title: 'Blur' });
  const b = node({ type: 'filter/soften', category: 'filter', title: 'Blur' });
  const c = node({ type: 'color/blur', category: 'color', title: 'Blur' });
  const d = node({ type: 'filter/sharpen', category: 'filter', title: 'Sharpen' });
  assert.deepEqual(lintNodes([a, d, b, c]), [
    { rule: 'title-unique', subject: 'filter/soften', message: 'title-unique filter/soften: the title "Blur" is also the title of filter/blur' },
    { rule: 'title-unique', subject: 'color/blur', message: 'title-unique color/blur: the title "Blur" is also the title of filter/blur' },
  ]);
  assert.deepEqual(lintNodes([a, d]), []);
  assert.deepEqual(lintNodes([]), []);
});

// ---- source text ------------------------------------------------------------------------------------------------

const FILE = 'src/core/nodes/filter/blur.ts';
const sourceRules = (text: string, path = FILE): string[] => [...new Set(lintNodeSource(path, text).map((p) => p.rule))];
const sourceMessages = (text: string, path = FILE): string[] => lintNodeSource(path, text).map((p: LintProblem) => p.message);

const CLEAN = `
import { defineKernel, defineNode, param } from '../../api.ts';
import { filterKernel } from './_wgsl.ts';

const pass = (kind: 'field' | 'color') => defineKernel({
  name: \`filter/blur.pass#\${kind}\`,
  inputs: { src: kind },
  outputs: { out: kind },
  includes: [filterKernel],
  code: /* wgsl */ \`fn compute(px: vec2i, uv: vec2f) -> out_t { return src_at(px); }\`,
});
const compose = defineKernel({ name: 'filter/blur', outputs: { out: 'field' }, code: '' });

export default defineNode({
  type: 'filter/blur',
  title: 'Blur',
  category: 'filter',
  description: 'Blurs the terrain.',
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [param.radius()],
  kernels: [pass('field'), pass('color'), compose],
  maskable: true,
  evaluate(ctx) { ctx.output('out', ctx.input('in')); },
});
`;

test('a clean node file and a clean private module have no problem', () => {
  assert.deepEqual(lintNodeSource(FILE, CLEAN), []);
  const module = `
export const filterKernel = defineLib({ name: 'filterKernel', code: 'fn filterKernel_w(i: i32) -> f32 { return 1.0; }' });
export const step = defineKernel({
  name: 'filter/kernel.step',
  code: '',
});
export const edt = defineCpuTask({ name: 'filter/kernel', run() { return 0; } });
`;
  assert.deepEqual(lintNodeSource('src/core/nodes/filter/_kernel.ts', module), []);
});

test('every message of a source rule begins with the rule and the file, with the line where there is one', () => {
  const problems = lintNodeSource(FILE, 'const a = 1;\nconst t = Date.now();\n');
  assert.deepEqual(problems, [{
    rule: 'no-clock',
    subject: FILE,
    message: `no-clock ${FILE}:2: "Date.now": a node does not depend on the time or on Math.random`,
  }]);
});

test('no-clock: no Math.random, Date.now, new Date or performance.now', () => {
  assert.deepEqual(sourceMessages('const r = Math.random();\nconst d = new Date();\n\nconst p = performance.now();').map((m) => m.split(': ')[0]), [
    `no-clock ${FILE}:1`, `no-clock ${FILE}:2`, `no-clock ${FILE}:4`,
  ]);
  assert.deepEqual(sourceRules('const mathRandom = 1; const update = 2; const newDateFormat = 3;'), []);
});

test('no-catch: no catch clause and no .catch(', () => {
  assert.deepEqual(sourceMessages('try { run(); } catch (e) { }'), [`no-catch ${FILE}:1: a catch clause: a node lets cancellation, budget and device errors propagate`]);
  assert.deepEqual(sourceRules('try { run(); } catch { }'), ['no-catch']);
  assert.deepEqual(sourceMessages('await ctx.flush()\n  .catch(() => {});'), [`no-catch ${FILE}:2: .catch(: a node lets cancellation, budget and device errors propagate`]);
  assert.deepEqual(sourceRules('const catchment = 1; const catchAll = (x: number) => x;'), []);
});

test('no-float-hash: no fract(sin( in WGSL', () => {
  assert.deepEqual(sourceRules('const code = `fn r(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }`;'), ['no-float-hash']);
  assert.deepEqual(sourceRules('const code = `return fract ( sin (x));`;'), ['no-float-hash']);
  assert.deepEqual(sourceRules('const code = `return fract(x) * sin(y);`;'), []);
});

test('stats-flag: a node file that reads statistics declares resolutionDependent', () => {
  const stats = 'export default defineNode({ async evaluate(ctx) { const s = await ctx.stats(f); } });';
  const minMax = 'export default defineNode({ async evaluate(ctx) { const r = await ops.minMax(ctx, f); } });';
  assert.deepEqual(sourceMessages(stats), [`stats-flag ${FILE}: the file mentions .stats( or minMax( and does not declare resolutionDependent: true`]);
  assert.deepEqual(sourceRules(minMax), ['stats-flag']);
  assert.deepEqual(sourceRules(minMax.replace('async evaluate', 'resolutionDependent: false, async evaluate')), ['stats-flag']);
  assert.deepEqual(sourceRules(minMax.replace('async evaluate', 'resolutionDependent: true, async evaluate')), []);
  // A private module holds no node, so it has nothing to declare.
  assert.deepEqual(sourceRules(minMax, 'src/core/nodes/filter/_level.ts'), []);
});

test('lib-name: a category library begins with the category id and is not named like a core library', () => {
  assert.deepEqual(sourceMessages("const lib = defineLib({ name: 'kernelWeights', code: '' });"), [
    `lib-name ${FILE}:1: the library "kernelWeights" does not begin with the category id "filter"`,
  ]);
  assert.deepEqual(sourceMessages("const a = 1;\nconst lib = defineLib({\n  name: 'noise',\n  code: '',\n});"), [`lib-name ${FILE}:2: "noise" is the name of a core library`]);
  assert.deepEqual(sourceRules(`const lib = defineLib({ name: "${hash.name}", code: '' });`), ['lib-name']);
  assert.deepEqual(sourceRules("const lib = defineLib({ name: 'simulateTalus', code: '' });", 'src/core/nodes/simulate/_wgsl.ts'), []);
  assert.deepEqual(sourceRules("const lib = defineLib({ name: 'simulateTalus', code: '' });"), ['lib-name']);
});

test('kernel-name: a kernel or task carries the name of the file that defines it', () => {
  const wrong = "const a = defineKernel({ name: 'filter/blur.h', code: '' });\nconst b = defineKernel({ name: 'filter/sharpen', code: '' });\nconst c = defineCpuTask({ name: 'filter/blurry', run() {} });";
  assert.deepEqual(sourceMessages(wrong), [
    `kernel-name ${FILE}:2: the kernel "filter/sharpen" defined in this file is not named "filter/blur", "filter/blur.<pass>" or "filter/blur#<variant>"`,
    `kernel-name ${FILE}:3: the CPU task "filter/blurry" defined in this file is not named "filter/blur", "filter/blur.<pass>" or "filter/blur#<variant>"`,
  ]);
  assert.deepEqual(sourceRules("const a = defineKernel({ name: 'simulate/blur', code: '' });"), ['kernel-name']);
  assert.deepEqual(sourceRules('const a = (k: string) => defineKernel({ name: `filter/blur#${k}`, code: `` });'), []);
  assert.deepEqual(sourceRules('const a = (k: string) => defineKernel({ name: `filter/${k}`, code: `` });'), ['kernel-name']);
  // In a private module the name is the module's, not that of the node that uses it.
  assert.deepEqual(sourceRules("const a = defineKernel({ name: 'simulate/talus.step', code: '' });", 'src/core/nodes/simulate/_talus.ts'), []);
  assert.deepEqual(sourceRules("const a = defineKernel({ name: 'simulate/thermal-erosion.step', code: '' });", 'src/core/nodes/simulate/_talus.ts'), ['kernel-name']);
  // A name that is no literal cannot be read from the text; lintNode still checks its category.
  assert.deepEqual(sourceRules('const a = defineKernel({ name: kernelName, code: `` });'), []);
});

test('a path outside the node folders gets the rules that need no category', () => {
  assert.deepEqual(sourceRules("const lib = defineLib({ name: 'anything', code: '' }); const t = Date.now(); const s = await ctx.stats(f);", 'tests/helpers/source-node.ts'), ['no-clock']);
});

// ---- one category: file-name, index, test-file ------------------------------------------------------------------

const BLUR_TEST = `
import { conformance } from '../../helpers/index.ts';
import blur from '../../../src/core/nodes/filter/blur.ts';

conformance(blur);
`;
const blurDef = node({ type: 'filter/blur', category: 'filter', title: 'Blur', description: 'Blurs the terrain.', inputs: [{ name: 'in', type: 'field' }] });
const sharpenDef = node({ type: 'filter/sharpen', category: 'filter', title: 'Sharpen', description: 'Sharpens the terrain.', inputs: [{ name: 'in', type: 'field' }] });
const SHARPEN = "import { defineNode } from '../../api.ts';\nexport default defineNode({ type: 'filter/sharpen' });\n";
const SHARPEN_TEST = BLUR_TEST.replaceAll('blur', 'sharpen');

/** A category of two nodes and a private module that obeys every rule; `over` replaces members of it. */
const category = (over: Partial<CategorySources> = {}): CategorySources => ({
  category: 'filter',
  files: {
    'sharpen.ts': SHARPEN,
    'index.ts': "import blur from './blur.ts';\nimport sharpen from './sharpen.ts';\nexport const nodes = [blur, sharpen];\n",
    '_wgsl.ts': "export const filterKernel = defineLib({ name: 'filterKernel', code: '' });\n",
    'blur.ts': CLEAN,
    'notes.md': 'not a source file',
  },
  defaults: { 'blur.ts': blurDef, 'sharpen.ts': sharpenDef },
  index: [blurDef, sharpenDef],
  tests: { 'blur.test.ts': BLUR_TEST, 'sharpen.test.ts': SHARPEN_TEST },
  ...over,
});
const categoryMessages = (over: Partial<CategorySources>): string[] => lintCategory(category(over)).map((p) => p.message);

test('a category that obeys every rule has no problem, and so has an empty one', () => {
  assert.deepEqual(lintCategory(category()), []);
  assert.deepEqual(lintCategory({ category: 'surface', files: { 'index.ts': 'export const nodes = [];' }, defaults: {}, index: [], tests: {} }), []);
});

test('file-name: a node file default-exports the NodeDef its name gives, from exactly one defineNode call', () => {
  assert.deepEqual(categoryMessages({ defaults: { 'blur.ts': blurDef }, index: [blurDef] }), [
    'file-name src/core/nodes/filter/sharpen.ts: the file does not default-export a NodeDef',
  ]);
  const renamed = node({ ...sharpenDef, type: 'filter/unsharp-mask' });
  assert.deepEqual(categoryMessages({ defaults: { 'blur.ts': blurDef, 'sharpen.ts': renamed }, index: [blurDef, renamed] }), [
    'file-name src/core/nodes/filter/sharpen.ts: the default export has the type "filter/unsharp-mask"; the file name makes it "filter/sharpen"',
  ]);
  const two = `${SHARPEN}export const other = defineNode ({ type: 'filter/other' });\n`;
  assert.deepEqual(categoryMessages({ files: { ...category().files, 'sharpen.ts': two } }), [
    'file-name src/core/nodes/filter/sharpen.ts: the file contains 2 defineNode( calls; a node file holds exactly one node',
  ]);
  const none = "import inner from './_inner.ts';\n// export default defineNode({ ... }) lives elsewhere\nexport default inner;\n";
  assert.deepEqual(categoryMessages({ files: { ...category().files, 'sharpen.ts': none } }), [
    'file-name src/core/nodes/filter/sharpen.ts: the file contains 0 defineNode( calls; a node file holds exactly one node',
  ]);
});

test('index: nodes holds exactly the default exports of the node files, sorted by type', () => {
  const index = 'src/core/nodes/filter/index.ts';
  assert.deepEqual(categoryMessages({ index: [blurDef] }), [`index ${index}: nodes lacks filter/sharpen`]);
  assert.deepEqual(categoryMessages({ index: [sharpenDef, blurDef] }), [`index ${index}: nodes is not sorted by type`]);
  assert.deepEqual(categoryMessages({ index: [blurDef, blurDef, sharpenDef] }), [`index ${index}: nodes holds filter/blur twice`]);
  assert.deepEqual(categoryMessages({ index: [blurDef, reference, sharpenDef] }), [
    `index ${index}: nodes holds ref/fbm, which is not the default export of a node file of the folder`,
    `index ${index}: nodes is not sorted by type`,
  ]);
  // An equal definition is not the exported one.
  assert.deepEqual(categoryMessages({ index: [blurDef, { ...sharpenDef }] }), [
    `index ${index}: nodes lacks filter/sharpen`,
    `index ${index}: nodes holds filter/sharpen, which is not the default export of a node file of the folder`,
  ]);
  assert.deepEqual(categoryMessages({ index: undefined }), [`index ${index}: the file does not export the list \`nodes\``]);
});

test('index: a category two owners share lists its nodes in private index modules, which index.ts concatenates', () => {
  // nodes.md sections 1 and 4: each owner has one private index module; index.ts imports both and sorts.
  const shared = category({
    files: {
      ...category().files,
      '_first.ts': "import blur from './blur.ts';\nexport const nodes = [blur];\n",
      '_second.ts': "import sharpen from './sharpen.ts';\nexport const nodes = [sharpen];\n",
      'index.ts': "import { nodes as first } from './_first.ts';\nimport { nodes as second } from './_second.ts';\nexport const nodes = [...first, ...second].sort();\n",
    },
  });
  assert.deepEqual(lintCategory(shared), []);
  // What the lint holds the concatenation to is what it holds any index to.
  assert.deepEqual(lintCategory({ ...shared, index: [sharpenDef, blurDef] }).map((p) => p.message), ['index src/core/nodes/filter/index.ts: nodes is not sorted by type']);
  assert.deepEqual(lintCategory({ ...shared, index: [blurDef] }).map((p) => p.message), ['index src/core/nodes/filter/index.ts: nodes lacks filter/sharpen']);
});

test('test-file: every node has a test file that imports it and calls conformance at module scope', () => {
  const path = 'tests/nodes/filter/sharpen.test.ts';
  assert.deepEqual(categoryMessages({ tests: { 'blur.test.ts': BLUR_TEST } }), [`test-file filter/sharpen: ${path} does not exist`]);
  assert.deepEqual(categoryMessages({ tests: { 'blur.test.ts': BLUR_TEST, 'sharpen.test.ts': BLUR_TEST } }), [
    `test-file filter/sharpen: ${path} does not import src/core/nodes/filter/sharpen.ts`,
  ]);
  const inside = SHARPEN_TEST.replace('conformance(sharpen);', "test('later', () => {\n  conformance(sharpen);\n});");
  assert.deepEqual(categoryMessages({ tests: { 'blur.test.ts': BLUR_TEST, 'sharpen.test.ts': inside } }), [
    `test-file filter/sharpen: ${path} has no conformance( call at module scope`,
  ]);
  const commented = SHARPEN_TEST.replace('conformance(sharpen);', '// conformance(sharpen);');
  assert.deepEqual(categoryMessages({ tests: { 'blur.test.ts': BLUR_TEST, 'sharpen.test.ts': commented } }), [
    `test-file filter/sharpen: ${path} has no conformance( call at module scope`,
  ]);
  // A private module is no node and needs no test.
  assert.deepEqual(lintCategory(category({ files: { ...category().files, '_extra.ts': 'export const x = 1;\n' } })), []);
});

test('a category reports the source rules of each file and the definition rules of each node', () => {
  const badDef = node({ ...sharpenDef, title: 'sharpen' });
  const messages = categoryMessages({
    files: { ...category().files, '_wgsl.ts': "export const lib = defineLib({ name: 'kernelWeights', code: '' });\nconst t = Date.now();\n" },
    defaults: { 'blur.ts': blurDef, 'sharpen.ts': badDef },
    index: [blurDef, badDef],
  });
  assert.deepEqual(messages, [
    'no-clock src/core/nodes/filter/_wgsl.ts:2: "Date.now": a node does not depend on the time or on Math.random',
    'lib-name src/core/nodes/filter/_wgsl.ts:1: the library "kernelWeights" does not begin with the category id "filter"',
    'title filter/sharpen: the word "sharpen" of "sharpen" does not begin with a capital letter or a digit',
  ]);
});

// ---- test-location ----------------------------------------------------------------------------------------------

test('test-location: a test file is matched by exactly one layer pattern of testing.md 8.1', () => {
  const run = [
    'tests/unit/lint.test.ts', 'tests/unit/gpu/uniforms.test.ts', 'tests/nodes/filter/unit/kernel.test.ts', 'tests/export/unit/png.test.ts',
    'tests/ui/graph/unit/layout.test.ts', 'tests/engine/pool.test.ts', 'tests/engine/ops/blur.test.ts', 'tests/nodes/filter/blur.test.ts',
    'tests/export/build.test.ts', 'tests/graphs/01-generate.test.ts', 'tests/electron/kernels.test.ts', 'tests/ui/graph/connect.test.ts',
  ];
  assert.deepEqual(lintTestLocations(run), []);
  const stray = [
    'tests/lint.test.ts', 'tests/helpers/fixtures.test.ts', 'tests/nodes/blur.test.ts', 'tests/nodes/filter/deep/blur.test.ts',
    'tests/export/unit/deep/png.test.ts', 'tests/graphs/more/02.test.ts', 'tests/electron/deep/kernels.test.ts', 'tests/ui/connect.test.ts',
    'tests/tools/verify.test.ts',
  ];
  assert.deepEqual(lintTestLocations([...run, ...stray]).map((p) => p.subject), stray);
  assert.deepEqual(lintTestLocations(['tests/lint.test.ts']), [{
    rule: 'test-location',
    subject: 'tests/lint.test.ts',
    message: 'test-location tests/lint.test.ts: no layer of testing.md 8.1 matches the file, so it is never run',
  }]);
  // Other files are not test files.
  assert.deepEqual(lintTestLocations(['tests/helpers/index.ts', 'tests/unit/graph-fixtures.ts', 'tests/graphs/01-generate.expect.json']), []);
});
