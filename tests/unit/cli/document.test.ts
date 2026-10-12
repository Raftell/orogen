// The document `render` and `gallery` evaluate (testing.md 8.6): how the inputs of a node type are wired, how
// --max-params, --param and --seed land in it, which terrain a picture is drawn over, and what is refused as a
// usage error. The node definitions are plain objects; nothing is evaluated.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeDef } from '../../../src/core/api.ts';
import { createRegistry, newDoc, previewResolution, serializeDoc, type GraphDoc, type NodeRegistry } from '../../../src/core/runtime.ts';
import { UsageError } from '../../../src/cli/args.ts';
import { projectDocument, RENDER_SETTINGS, typeDocument, type RenderPlan } from '../../../src/cli/document.ts';
import { colorize, everyKind, gen, node, select, sink } from '../graph-fixtures.ts';

const fbm = node({ type: 'ref/fbm', title: 'Fractal Noise (Reference)', params: [{ kind: 'seed', name: 'seed', help: 'A seed.', default: 0 }] });
const slopeMask = node({
  type: 'ref/slope-mask', title: 'Slope Mask (Reference)',
  inputs: [{ name: 'in', type: 'field' }], outputs: [{ name: 'out', type: 'field', role: 'mask' }],
});
/** One input of every sort that is wired differently, and a plain height output. */
const subject = node({
  type: 'filter/subject', title: 'Subject', category: 'filter',
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'flow', type: 'field', role: 'data' },
    { name: 'either', type: 'any' },
    { name: 'weights', type: 'field', role: 'mask' },
    { name: 'tint', type: 'color', optional: true },
  ],
});
const maskFirst = node({
  type: 'select/grow', title: 'Grow', category: 'select',
  inputs: [{ name: 'in', type: 'field', role: 'mask' }, { name: 'terrain', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
});
const plain = node({ type: 'filter/plain', title: 'Plain', category: 'filter', inputs: [{ name: 'in', type: 'field' }], params: everyKind.filter((param) => param.kind !== 'seed') });

const full: NodeRegistry = createRegistry([fbm, slopeMask, colorize, subject, maskFirst, plain, gen, select, sink]);
const bare: NodeRegistry = createRegistry([fbm, subject, select]);

/** The type of the node an input of the plan's node is connected to, and the port it comes from. */
function sourceOf(plan: RenderPlan, port: string): string | null {
  const edges = Object.values(plan.doc.edges).filter((edge) => edge.to.node === plan.nodeId && edge.to.port === port);
  assert.ok(edges.length <= 1, `the input "${port}" has ${edges.length} edges`);
  const edge = edges[0];
  return edge ? `${plan.doc.nodes[edge.from.node]!.type}.${edge.from.port}` : null;
}
const typesOf = (doc: GraphDoc): string[] => Object.values(doc.nodes).map((instance) => instance.type).sort();

function usage(run: () => unknown, message: RegExp): void {
  assert.throws(run, (thrown: unknown) => {
    assert.ok(thrown instanceof UsageError, `threw ${String(thrown)}`);
    assert.match(thrown.message, message);
    assert.equal(thrown.subcommand, 'render');
    return true;
  });
}

test('a node type: heights, data and `any` inputs come from a ref/fbm, masks from a ref/slope-mask of it, colours from a ref/colorize of it', () => {
  const plan = typeDocument(full, 'filter/subject');
  assert.equal(plan.type, 'filter/subject');
  assert.equal(plan.def, subject);
  assert.equal(plan.doc.nodes[plan.nodeId]!.type, 'filter/subject');
  assert.deepEqual(
    ['in', 'flow', 'either', 'weights', 'tint'].map((port) => sourceOf(plan, port)),
    ['ref/fbm.out', 'ref/fbm.out', 'ref/fbm.out', 'ref/slope-mask.out', 'ref/colorize.out'],
  );
  // One node of each wiring type, whatever the number of inputs it feeds; the mask and the colour are made of the same terrain.
  assert.deepEqual(typesOf(plan.doc), ['filter/subject', 'ref/colorize', 'ref/fbm', 'ref/slope-mask']);
  const idOf = (type: string): string => Object.values(plan.doc.nodes).find((instance) => instance.type === type)!.id;
  const into = (type: string): string[] => Object.values(plan.doc.edges).filter((edge) => edge.to.node === idOf(type)).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.port}`);
  assert.deepEqual(into('ref/slope-mask'), [`${idOf('ref/fbm')}.out>in`]);
  assert.deepEqual(into('ref/colorize'), [`${idOf('ref/fbm')}.out>in`], 'the optional colour input of the wiring node stays unconnected');
  assert.deepEqual(plan.warnings, []);
});

test('a node type: where the registry lacks ref/slope-mask or ref/colorize, the ref/fbm itself is connected', () => {
  const plan = typeDocument(bare, 'filter/subject');
  assert.deepEqual(['in', 'flow', 'either', 'weights', 'tint'].map((port) => sourceOf(plan, port)), Array<string>(5).fill('ref/fbm.out'));
  assert.deepEqual(typesOf(plan.doc), ['filter/subject', 'ref/fbm']);
});

test('a node type without inputs is alone in its document, with the settings of testing.md 8.6', () => {
  const plan = typeDocument(full, 'ref/fbm');
  assert.deepEqual(typesOf(plan.doc), ['ref/fbm']);
  assert.deepEqual(Object.keys(plan.doc.edges), []);
  assert.deepEqual(plan.doc.settings, { ...newDoc().settings, terrainSize: 4096, heightRange: 1024, seed: 1 });
  assert.deepEqual(RENDER_SETTINGS, { terrainSize: 4096, heightRange: 1024, seed: 1 });
  assert.equal(plan.terrain, null);
});

test('a node type: the terrain a picture is drawn over is what feeds the first height input, for outputs that are no heights', () => {
  // A mask and a data output: both are drawn over the height input.
  const selected = typeDocument(full, 'ref/select');
  assert.deepEqual(selected.terrain && [selected.doc.nodes[selected.terrain.node]!.type, selected.terrain.port], ['ref/fbm', 'out']);
  // A colour output.
  const colored = typeDocument(full, 'ref/colorize');
  assert.deepEqual(colored.terrain && [colored.doc.nodes[colored.terrain.node]!.type, colored.terrain.port], ['ref/fbm', 'out']);
  assert.equal(sourceOf(colored, 'base'), 'ref/colorize.out', 'its colour input takes another ref/colorize');
  // The first height input is not the first input.
  const grown = typeDocument(full, 'select/grow');
  assert.equal(sourceOf(grown, 'in'), 'ref/slope-mask.out');
  assert.deepEqual(grown.terrain && [grown.doc.nodes[grown.terrain.node]!.type, grown.terrain.port], ['ref/fbm', 'out']);
  // Height outputs only: nothing is drawn over a terrain, so none is read back.
  assert.equal(typeDocument(full, 'filter/subject').terrain, null);
  // A mask output and no height input.
  const lone = createRegistry([fbm, slopeMask, node({ type: 'select/edge', title: 'Edge', category: 'select', inputs: [{ name: 'in', type: 'field', role: 'mask' }], outputs: [{ name: 'out', type: 'field', role: 'data' }] })]);
  assert.equal(typeDocument(lone, 'select/edge').terrain, null);
});

test('a node type: defaults, then --max-params, then each --param, then --seed', () => {
  const params = (plan: RenderPlan): Readonly<Record<string, unknown>> => plan.doc.nodes[plan.nodeId]!.params;
  const defaults = Object.fromEntries(everyKind.map((param) => [param.name, param.default]));
  assert.deepEqual(params(typeDocument(full, 'ref/gen')), defaults);

  // Every float, int and vec2 parameter at its max, soft ones included; the other kinds stay.
  const maxed = { ...defaults, hard: 1, soft: 4, count: 16, offset: [1, 1], center: [1, 1] };
  assert.deepEqual(params(typeDocument(full, 'ref/gen', { maxParams: true })), maxed);

  const given = typeDocument(full, 'ref/gen', {
    maxParams: true, seed: 7,
    params: [{ name: 'count', value: 3 }, { name: 'mode', value: 'add' }, { name: 'soft', value: 25 }, { name: 'tint', value: [0.5, 0.25, 0] }, { name: 'label', value: 'Rock' }, { name: 'count', value: 5 }],
  });
  assert.deepEqual(params(given), { ...maxed, count: 5, mode: 'add', soft: 25, tint: [0.5, 0.25, 0], label: 'Rock', seed: 7 });
  // The wiring nodes keep their defaults.
  const withInput = typeDocument(full, 'filter/plain', { maxParams: true });
  assert.deepEqual(Object.values(withInput.doc.nodes).find((instance) => instance.type === 'ref/fbm')!.params, { seed: 0 });
  assert.equal(params(withInput).count, 16);
});

test('a node type: usage errors', () => {
  usage(() => typeDocument(full, 'ref/nothing'), /^Unknown node type "ref\/nothing"; the nodes of "ref" are ref\/fbm, ref\/slope-mask, ref\/colorize, ref\/gen, ref\/select, ref\/sink$/);
  usage(() => typeDocument(full, 'weather/rain'), /^Unknown node type "weather\/rain"; the registry has nodes in ref, filter, select$/);
  usage(() => typeDocument(full, 'ref/sink'), /^ref\/sink has no outputs: there is nothing to draw$/);

  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'radius', value: 1 }] }), /^ref\/gen has no parameter "radius"; its parameters are hard, soft, count, invert, mode, seed, offset, center, tint, profile, ramp, file, label$/);
  usage(() => typeDocument(full, 'ref/select', { params: [{ name: 'radius', value: 1 }] }), /^ref\/select has no parameter "radius"; it has none$/);
  // A value the parameter cannot hold as given is refused, not clamped, rounded or replaced by the default.
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'hard', value: 1.5 }] }), /^--param hard of ref\/gen: 1\.5 is outside 0\.\.1$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'count', value: 2.5 }] }), /^--param count of ref\/gen: 2\.5 is not an integer$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'count', value: 'many' }] }), /^--param count of ref\/gen: "many" is not a finite number$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'invert', value: 1 }] }), /^--param invert of ref\/gen: 1 is not true or false$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'mode', value: 'subtract' }] }), /^--param mode of ref\/gen: unknown value "subtract"$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'offset', value: [0, 0, 0] }] }), /^--param offset of ref\/gen: \[0,0,0\] is not a pair of finite numbers$/);
  usage(() => typeDocument(full, 'ref/gen', { params: [{ name: 'label', value: 'A long label' }] }), /^--param label of ref\/gen: the text is longer than 8 characters$/);

  usage(() => typeDocument(full, 'ref/select', { seed: 3 }), /^--seed sets the node's seed, and ref\/select has no seed parameter$/);

  // The reference terrain is part of every build: a registry without it is a defect of the program, not of the arguments.
  assert.throws(() => typeDocument(createRegistry([subject]), 'filter/subject'), (thrown: unknown) => !(thrown instanceof UsageError) && /The registry lacks ref\/fbm/.test((thrown as Error).message));
});

/** A project file: a ref/fbm feeding a ref/select and a ref/colorize, a sink, and a node of a type no build has. */
function project(): string {
  const node = (id: string, type: string): Record<string, unknown> => ({ id, type, version: 1, position: { x: 0, y: 0 }, params: {} });
  const edge = (id: string, from: string, to: string, port = 'in'): Record<string, unknown> => ({ id, from: { node: from, port: 'out' }, to: { node: to, port } });
  return JSON.stringify({
    format: 'orogen', version: 1,
    settings: { terrainSize: 2000, heightRange: 500, seed: 9, buildResolution: 2017, previewLevel: 3, seaLevel: 0.1 },
    nodes: {
      noise: node('noise', 'ref/fbm'), picked: node('picked', 'ref/select'), painted: node('painted', 'ref/colorize'),
      end: node('end', 'ref/sink'), lost: node('lost', 'weather/rain'), loose: node('loose', 'ref/select'), fed: node('fed', 'ref/select'),
    },
    edges: {
      e1: edge('e1', 'noise', 'picked'), e2: edge('e2', 'noise', 'painted'), e3: edge('e3', 'picked', 'end'),
      // From a node of a type no build has: the evaluator ignores this edge.
      e4: edge('e4', 'lost', 'fed'),
    },
    groups: {}, ui: {},
  });
}

test('a project file: the document as stored, the node named, and the terrain connected to its height input', () => {
  const plan = projectDocument(full, project(), 'picked', 'island.orogen');
  assert.equal(plan.nodeId, 'picked');
  assert.equal(plan.type, 'ref/select');
  assert.equal(plan.def, select);
  assert.deepEqual(plan.terrain, { node: 'noise', port: 'out' });
  assert.deepEqual(plan.doc.settings, { terrainSize: 2000, heightRange: 500, seed: 9, buildResolution: 2017, previewLevel: 3, seaLevel: 0.1 });
  assert.deepEqual(Object.keys(plan.doc.nodes), ['noise', 'picked', 'painted', 'end', 'lost', 'loose', 'fed']);
  assert.equal(previewResolution(plan.doc.settings), 253);

  assert.deepEqual(projectDocument(full, project(), 'painted', 'island.orogen').terrain, { node: 'noise', port: 'out' });
  assert.equal(projectDocument(full, project(), 'noise', 'island.orogen').terrain, null, 'a height output is drawn by itself');
  assert.equal(projectDocument(full, project(), 'loose', 'island.orogen').terrain, null, 'the height input is unconnected');
  assert.equal(projectDocument(full, project(), 'fed', 'island.orogen').terrain, null, 'the edge comes from a node of unknown type');

  // A node of a type the registry lacks is planned: the evaluation reports it.
  const lost = projectDocument(full, project(), 'lost', 'island.orogen');
  assert.deepEqual([lost.type, lost.def, lost.terrain], ['weather/rain', null, null]);
  assert.ok(lost.warnings.some((warning) => /node "lost"/.test(warning)), `the loader's problems are passed on: ${lost.warnings.join(' | ')}`);

  // The document a node type is rendered from is a project file like any other.
  const made = typeDocument(full, 'ref/select');
  const again = projectDocument(full, serializeDoc(made.doc), made.nodeId, 'made.orogen');
  assert.deepEqual(again.doc, made.doc);
  assert.deepEqual([again.terrain, again.warnings], [made.terrain, []]);
});

test('a project file: usage errors', () => {
  usage(() => projectDocument(full, 'not json', 'a', 'island.orogen'), /^island\.orogen is not a project file: /);
  usage(() => projectDocument(full, JSON.stringify({ format: 'something-else' }), 'a', 'island.orogen'), /^island\.orogen is not a project file: /);
  usage(() => projectDocument(full, project(), 'nobody', 'island.orogen'), /^island\.orogen has no node "nobody"; its nodes are noise, picked, painted, end, lost, loose, fed$/);
  usage(() => projectDocument(full, serializeDoc(newDoc()), 'a', 'empty.orogen'), /^empty\.orogen has no node "a"; it has no nodes$/);
  usage(() => projectDocument(full, project(), 'end', 'island.orogen'), /^The node "end" is a ref\/sink, which has no outputs: there is nothing to draw$/);
  // An id that is a member of every object is no node.
  usage(() => projectDocument(full, project(), 'constructor', 'island.orogen'), /has no node "constructor"/);
});

test('the preview resolution is the ladder level the settings name', () => {
  const settings = newDoc().settings;
  assert.equal(previewResolution({ ...settings, buildResolution: 4033, previewLevel: 2 }), 1009);
  assert.equal(previewResolution({ ...settings, buildResolution: 513, previewLevel: 1 }), 257);
  assert.equal(previewResolution({ ...settings, buildResolution: 8129, previewLevel: 0 }), 8129);
});

// The fixtures above are what these tests assume of them.
test('the fixtures: a node with a mask and a data output and one height input, and one without outputs', () => {
  const ports = (def: NodeDef): string[] => [...def.inputs.map((port) => `in:${port.name}`), ...def.outputs.map((port) => `out:${port.name}:${port.role ?? 'height'}`)];
  assert.deepEqual(ports(select), ['in:in', 'out:out:mask', 'out:flow:data']);
  assert.deepEqual(ports(sink), ['in:in']);
});
