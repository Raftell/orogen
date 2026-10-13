// The document `render` and `gallery` evaluate (testing.md 8.6): how the inputs of a node type are wired, how
// --max-params, --param and --seed land in it, which terrain a picture is drawn over, and what is refused as a
// usage error. The node definitions are plain objects; nothing is evaluated.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeDef } from '../../../src/core/api.ts';
import { createRegistry, newDoc, previewResolution, serializeDoc, type GraphDoc, type NodeRegistry } from '../../../src/core/runtime.ts';
import { UsageError } from '../../../src/cli/args.ts';
import {
  feedSource, firstTerrain, hasConnectedVariant, inputFeeds, maskFeed, projectDocument, RENDER_SETTINGS, terrainParams, terrainType, typeDocument, type RenderPlan,
} from '../../../src/cli/document.ts';
import { colorize, combine, everyKind, gen, node, select, sink, soften } from '../graph-fixtures.ts';

const fbm = node({
  type: 'ref/fbm', title: 'Fractal Noise (Reference)',
  params: [
    { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 },
    { kind: 'float', name: 'size', unit: 'length', help: 'A size.', default: 0.25, min: 0.001, max: 4, soft: true, scale: 'log' },
    { kind: 'int', name: 'octaves', help: 'Octaves.', default: 8, min: 1, max: 16 },
  ],
});
const slopeMask = node({
  type: 'ref/slope-mask', title: 'Slope Mask (Reference)',
  inputs: [{ name: 'in', type: 'field' }], outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    { kind: 'float', name: 'slopeMin', unit: 'angle', help: 'The lower slope.', default: 20, min: 0, max: 90 },
    { kind: 'float', name: 'slopeMax', unit: 'angle', help: 'The upper slope.', default: 45, min: 0, max: 90 },
  ],
});
const FIRST = { seed: 0, size: 0.25, octaves: 8 };
/** The terrain the mask is a slope mask of: the broad shape of the first. */
const BROAD = { seed: 0, size: 0.25, octaves: 3 };
/** One input of every sort that is wired differently, and a plain height output. */
const subject = node({
  type: 'filter/subject', title: 'Subject', category: 'filter',
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'area', type: 'field', role: 'data' },
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
/** With a maskable node and one that has an optional mask input of its own. */
const masks: NodeRegistry = createRegistry([fbm, slopeMask, colorize, subject, soften, combine]);

/** The node an input of the plan's node is connected to; null: unconnected. */
function feedOf(plan: RenderPlan, port: string): GraphDoc['nodes'][string] | null {
  const edges = Object.values(plan.doc.edges).filter((edge) => edge.to.node === plan.nodeId && edge.to.port === port);
  assert.ok(edges.length <= 1, `the input "${port}" has ${edges.length} edges`);
  return edges[0] ? plan.doc.nodes[edges[0].from.node]! : null;
}
/** The type of that node, and the port it comes from. */
function sourceOf(plan: RenderPlan, port: string): string | null {
  const feed = feedOf(plan, port);
  return feed ? `${feed.type}.out` : null;
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

test('a node type: each height, data and `any` input takes a terrain of its own; a mask comes from a slope mask of the first, a colour from a colouring of its terrain', () => {
  // The connected variant: the optional colour input is connected too.
  const plan = typeDocument(full, 'filter/subject', { connected: true });
  assert.equal(plan.type, 'filter/subject');
  assert.equal(plan.def, subject);
  assert.equal(plan.connected, true);
  assert.equal(plan.doc.nodes[plan.nodeId]!.type, 'filter/subject');
  assert.deepEqual(
    ['in', 'area', 'either', 'weights', 'tint'].map((port) => sourceOf(plan, port)),
    ['ref/fbm.out', 'ref/fbm.out', 'ref/fbm.out', 'ref/slope-mask.out', 'ref/colorize.out'],
  );
  // Three terrains: the first is ref/fbm at its defaults, the others have a seed and a feature size of their own.
  assert.deepEqual(['in', 'area', 'either'].map((port) => feedOf(plan, port)!.params), [FIRST, { ...FIRST, seed: 1, size: 0.1 }, { ...FIRST, seed: 2, size: 0.5 }]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(terrainParams), [{}, { seed: 1, size: 0.1 }, { seed: 2, size: 0.5 }, { seed: 3, size: 0.05 }, { seed: 4, size: 0.25 }, { seed: 5, size: 0.1 }]);
  assert.deepEqual(typesOf(plan.doc), ['filter/subject', 'ref/colorize', 'ref/fbm', 'ref/fbm', 'ref/fbm', 'ref/fbm', 'ref/slope-mask']);
  // The colour is made of the first terrain. The mask is a slope mask of that terrain's broad shape, its first
  // three octaves, between angles that select about half of it.
  const first = feedOf(plan, 'in')!.id;
  const into = (id: string): string[] => Object.values(plan.doc.edges).filter((edge) => edge.to.node === id).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.port}`);
  assert.deepEqual(into(feedOf(plan, 'tint')!.id), [`${first}.out>in`], 'the optional colour input of the wiring node stays unconnected');
  const mask = feedOf(plan, 'weights')!;
  assert.deepEqual(mask.params, { slopeMin: 35, slopeMax: 50 });
  const beneath = Object.values(plan.doc.edges).filter((edge) => edge.to.node === mask.id).map((edge) => plan.doc.nodes[edge.from.node]!.params);
  assert.deepEqual(beneath, [BROAD]);
  assert.deepEqual(maskFeed(full), { terrain: { octaves: 3 }, slopes: { slopeMin: 35, slopeMax: 50 } });
  assert.deepEqual(plan.warnings, []);
  // What the node was given, in the order of its ports: the pictures of the inputs are drawn from this.
  assert.deepEqual(plan.inputs.map((input) => `${input.port}: ${input.kind} ${plan.doc.nodes[input.from.node]!.type}.${input.from.port}`), [
    'in: terrain ref/fbm.out', 'area: terrain ref/fbm.out', 'either: terrain ref/fbm.out', 'weights: mask ref/slope-mask.out', 'tint: color ref/colorize.out',
  ]);

  assert.deepEqual(inputFeeds(subject, true), {
    in: { kind: 'terrain', index: 0 }, area: { kind: 'terrain', index: 1 }, either: { kind: 'terrain', index: 2 }, weights: { kind: 'mask' }, tint: { kind: 'color', index: 0 },
  });
  // A second colour input is the colouring of the second terrain.
  const twoColors = node({ type: 'color/blend', title: 'Blend', category: 'color', inputs: [{ name: 'a', type: 'color' }, { name: 'b', type: 'color' }], outputs: [{ name: 'out', type: 'color' }] });
  const blended = typeDocument(createRegistry([fbm, colorize, twoColors]), 'color/blend');
  const under = (port: string): unknown => Object.values(blended.doc.edges).filter((edge) => edge.to.node === feedOf(blended, port)!.id).map((edge) => blended.doc.nodes[edge.from.node]!.params);
  assert.deepEqual([under('a'), under('b')], [[FIRST], [{ ...FIRST, seed: 1, size: 0.1 }]]);
});

test('a node type: the plain variant is the node as it is dropped into a graph: required inputs connected, optional ones and the mask of a maskable node not', () => {
  assert.deepEqual([hasConnectedVariant(combine), hasConnectedVariant(soften), hasConnectedVariant(subject), hasConnectedVariant(fbm), hasConnectedVariant(select)], [true, true, true, false, false]);

  // An optional input of any type: the colour of the subject.
  const dropped = typeDocument(full, 'filter/subject');
  assert.equal(dropped.connected, false);
  assert.deepEqual(['in', 'area', 'either', 'weights', 'tint'].map((port) => sourceOf(dropped, port)), ['ref/fbm.out', 'ref/fbm.out', 'ref/fbm.out', 'ref/slope-mask.out', null]);
  assert.deepEqual(typesOf(dropped.doc), ['filter/subject', 'ref/fbm', 'ref/fbm', 'ref/fbm', 'ref/fbm', 'ref/slope-mask'], 'no colouring is made for an input that is not connected');
  assert.deepEqual(inputFeeds(subject, false), {
    in: { kind: 'terrain', index: 0 }, area: { kind: 'terrain', index: 1 }, either: { kind: 'terrain', index: 2 }, weights: { kind: 'mask' }, tint: null,
  });
  assert.deepEqual(dropped.inputs.map((input) => input.port), ['in', 'area', 'either', 'weights']);

  // A node's own optional mask.
  const plain = typeDocument(masks, 'ref/combine');
  assert.deepEqual(['a', 'b', 'mask'].map((port) => sourceOf(plain, port)), ['ref/fbm.out', 'ref/fbm.out', null], 'the plain picture shows the full effect');
  assert.deepEqual(['a', 'b'].map((port) => feedOf(plain, port)!.params), [FIRST, { ...FIRST, seed: 1, size: 0.1 }], 'two inputs, two terrains');
  const connected = typeDocument(masks, 'ref/combine', { connected: true });
  assert.equal(connected.connected, true);
  assert.deepEqual(['a', 'b', 'mask'].map((port) => sourceOf(connected, port)), ['ref/fbm.out', 'ref/fbm.out', 'ref/slope-mask.out']);
  const steep = feedOf(connected, 'mask')!.id;
  assert.deepEqual(Object.values(connected.doc.edges).filter((edge) => edge.to.node === steep).map((edge) => connected.doc.nodes[edge.from.node]!.params), [BROAD], 'the mask is a slope mask of the broad shape of the first terrain');

  // The mask the evaluator adds to a maskable node.
  assert.deepEqual(['in', 'mask'].map((port) => sourceOf(typeDocument(masks, 'ref/soften'), port)), ['ref/fbm.out', null]);
  const softened = typeDocument(masks, 'ref/soften', { connected: true });
  assert.deepEqual(['in', 'mask'].map((port) => sourceOf(softened, port)), ['ref/fbm.out', 'ref/slope-mask.out']);
  assert.deepEqual(softened.inputs.map((input) => `${input.port}: ${input.kind}`), ['in: terrain', 'mask: mask'], 'the mask of a maskable node comes last');
  assert.deepEqual(inputFeeds(soften, true), { in: { kind: 'terrain', index: 0 }, mask: { kind: 'mask' } });
  assert.deepEqual(inputFeeds(soften, false), { in: { kind: 'terrain', index: 0 }, mask: null });

  // An optional first input is no exception: a crater dropped into a graph sits on level ground, and a node
  // that packs four optional channels shows nothing until one is connected.
  const crater = node({ type: 'generate/crater', title: 'Crater', category: 'generate', inputs: [{ name: 'in', type: 'field', optional: true }] });
  assert.deepEqual([inputFeeds(crater, false), inputFeeds(crater, true)], [{ in: null }, { in: { kind: 'terrain', index: 0 } }]);
  assert.equal(hasConnectedVariant(crater), true);
  const alone = typeDocument(createRegistry([fbm, crater]), 'generate/crater');
  assert.deepEqual([typesOf(alone.doc), Object.keys(alone.doc.edges), alone.inputs], [['generate/crater'], [], []]);
  const pack = node({
    type: 'color/pack', title: 'Pack', category: 'color',
    inputs: ['r', 'g', 'b', 'a'].map((name) => ({ name, type: 'field' as const, role: 'mask' as const, optional: true })), outputs: [{ name: 'out', type: 'color' }],
  });
  assert.deepEqual(inputFeeds(pack, false), { r: null, g: null, b: null, a: null });
  assert.deepEqual(inputFeeds(pack, true), { r: { kind: 'mask' }, g: { kind: 'mask' }, b: { kind: 'mask' }, a: { kind: 'mask' } });

  // An input has the same feed in both variants: an optional one that is left out still counts.
  const guided = node({
    type: 'filter/guided', title: 'Guided', category: 'filter',
    inputs: [{ name: 'in', type: 'field' }, { name: 'guide', type: 'field', optional: true }, { name: 'detail', type: 'field', optional: true }],
  });
  assert.deepEqual(inputFeeds(guided, false), { in: { kind: 'terrain', index: 0 }, guide: null, detail: null });
  assert.deepEqual(inputFeeds(guided, true), { in: { kind: 'terrain', index: 0 }, guide: { kind: 'terrain', index: 1 }, detail: { kind: 'terrain', index: 2 } });

  // A required mask is connected in both; a node without an optional input that is not maskable has no connected variant.
  assert.equal(sourceOf(typeDocument(masks, 'filter/subject'), 'weights'), 'ref/slope-mask.out');
  usage(() => typeDocument(masks, 'ref/fbm', { connected: true }), /^--connected connects the optional inputs of a node and the mask of a maskable one, and ref\/fbm has no optional input and is not maskable$/);
});

test('a node type: the first terrain is generate/eroded-noise where the registry holds it, and the mask is a slope mask of its broad shape', () => {
  const eroded = node({
    type: 'generate/eroded-noise', title: 'Eroded Noise', category: 'generate',
    params: [
      { kind: 'float', name: 'size', unit: 'length', help: 'A size.', default: 0.25, min: 0.001, max: 4, soft: true, scale: 'log' },
      { kind: 'int', name: 'octaves', help: 'Octaves.', default: 8, min: 1, max: 16 },
      { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 },
    ],
  });
  const product = createRegistry([fbm, slopeMask, colorize, subject, eroded]);
  assert.deepEqual([0, 1, 2].map((index) => terrainType(product, index)), ['generate/eroded-noise', 'ref/fbm', 'ref/fbm']);
  assert.deepEqual([0, 1].map((index) => terrainType(full, index)), ['ref/fbm', 'ref/fbm'], 'a registry without it falls back to ref/fbm');

  const plan = typeDocument(product, 'filter/subject', { connected: true });
  // Terrain 0 at the defaults of its type; every further terrain is a ref/fbm with a seed and a size of its own.
  assert.deepEqual(['in', 'area', 'either'].map((port) => `${feedOf(plan, port)!.type} ${JSON.stringify(feedOf(plan, port)!.params)}`), [
    'generate/eroded-noise {"size":0.25,"octaves":8,"seed":0}', 'ref/fbm {"seed":1,"size":0.1,"octaves":8}', 'ref/fbm {"seed":2,"size":0.5,"octaves":8}',
  ]);
  // The colouring is of terrain 0. The mask is of its broad shape, which the eroded noise has in two octaves,
  // between steeper angles than select half of ref/fbm.
  assert.deepEqual(maskFeed(product), { terrain: { octaves: 2 }, slopes: { slopeMin: 40, slopeMax: 55 } });
  assert.deepEqual(feedOf(plan, 'weights')!.params, { slopeMin: 40, slopeMax: 55 });
  const sourceTypes = (port: string): string[] => Object.values(plan.doc.edges).filter((edge) => edge.to.node === feedOf(plan, port)!.id).map((edge) => {
    const from = plan.doc.nodes[edge.from.node]!;
    return `${from.type} ${JSON.stringify(from.params)}`;
  });
  assert.deepEqual(sourceTypes('tint'), ['generate/eroded-noise {"size":0.25,"octaves":8,"seed":0}']);
  assert.deepEqual(sourceTypes('weights'), ['generate/eroded-noise {"size":0.25,"octaves":2,"seed":0}']);
  // The node itself, rendered alone, is not its own input.
  assert.deepEqual(typesOf(typeDocument(product, 'generate/eroded-noise').doc), ['generate/eroded-noise']);
});

// ---- the first terrain by category, and the inputs the wiring knows by name ---------------------------------------

const eroded = node({
  type: 'generate/eroded-noise', title: 'Eroded Noise', category: 'generate',
  params: [
    { kind: 'float', name: 'size', unit: 'length', help: 'A size.', default: 0.25, min: 0.001, max: 4, soft: true, scale: 'log' },
    { kind: 'int', name: 'octaves', help: 'Octaves.', default: 8, min: 1, max: 16 },
    { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 },
  ],
});
const landform = (type: string, title: string, size: number): NodeDef => node({
  type, title, category: 'generate',
  params: [
    { kind: 'float', name: 'size', unit: 'length', help: 'A size.', default: size, min: 0.05, max: 2, soft: true, scale: 'log' },
    { kind: 'float', name: 'erosion', unit: 'ratio', help: 'Gullies.', default: 0.6, min: 0, max: 1 },
  ],
});
const range = landform('generate/mountain-range', 'Mountain Range', 0.55), island = landform('generate/island', 'Island', 0.7), volcano = landform('generate/volcano', 'Volcano', 0.9);
const flowNode = node({
  type: 'simulate/flow', title: 'Flow', category: 'simulate',
  inputs: [{ name: 'in', type: 'field' }, { name: 'precipitation', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'field', role: 'data' }, { name: 'wetness', type: 'field', role: 'data' }],
});
const snowNode = node({
  type: 'simulate/snow', title: 'Snow', category: 'simulate',
  inputs: [{ name: 'in', type: 'field' }, { name: 'mask', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'snow', type: 'field', role: 'mask' }, { name: 'depth', type: 'field', role: 'data' }],
});
const natural = node({
  type: 'color/natural', title: 'Natural Color', category: 'color',
  inputs: [{ name: 'in', type: 'field' }, { name: 'flow', type: 'field', role: 'data', optional: true }, { name: 'snow', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'color' }],
});
const scatter = node({ type: 'surface/scatter', title: 'Scatter', category: 'surface', inputs: [{ name: 'in', type: 'field' }, { name: 'stamp', type: 'field' }], maskable: true });
const world: NodeRegistry = createRegistry([fbm, slopeMask, colorize, combine, eroded, range, island, volcano, flowNode, snowNode, natural, scatter, subject, select]);

/** `type params` of the node an input is connected to, and of what that node reads. */
function chainOf(plan: RenderPlan, port: string): string[] {
  const chain: string[] = [];
  const edge = Object.values(plan.doc.edges).find((candidate) => candidate.to.node === plan.nodeId && candidate.to.port === port);
  for (let from = edge?.from, hops = 0; from !== undefined && hops < 8; hops++) {
    const at = plan.doc.nodes[from.node]!;
    chain.push(`${at.type}.${from.port} ${JSON.stringify(at.params)}`);
    from = Object.values(plan.doc.edges).find((candidate) => candidate.to.node === at.id)?.from;
  }
  return chain;
}

test('the first terrain is that of the category: a range on gentle ground for surface, an island for simulate and color, the eroded noise for the others', () => {
  const kinds = (['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref'] as const).map((category) => `${category}: ${firstTerrain(world, category).type} ${JSON.stringify(firstTerrain(world, category).params)}`);
  assert.deepEqual(kinds, [
    'generate: generate/eroded-noise {}', 'adjust: generate/eroded-noise {}', 'filter: generate/eroded-noise {}', 'simulate: generate/island {"size":1}', 'select: generate/eroded-noise {}',
    'color: generate/island {"size":1}', 'surface: generate/mountain-range {}', 'io: generate/eroded-noise {}', 'ref: generate/eroded-noise {}',
  ]);
  // A document of every category has one first terrain for all of them.
  assert.equal(firstTerrain(world, null).type, 'generate/eroded-noise');
  assert.deepEqual([terrainType(world, 0, 'surface'), terrainType(world, 1, 'surface'), terrainType(world, 0), terrainType(world, 0, 'simulate')], ['generate/mountain-range', 'ref/fbm', 'generate/eroded-noise', 'generate/island']);
  // A registry that lacks the terrain of a category has the eroded noise for it, and one that lacks that too the reference noise.
  assert.equal(firstTerrain(createRegistry([fbm, eroded]), 'surface').type, 'generate/eroded-noise');
  assert.deepEqual([firstTerrain(full, 'surface').type, firstTerrain(full, 'simulate').type, firstTerrain(full, null).type], ['ref/fbm', 'ref/fbm', 'ref/fbm']);

  // The mask of each: a slope mask of the terrain's broad shape. The range has slopes only where it stands, so
  // its mask is that of the reference noise, whose regions lie across the range and the ground alike.
  assert.deepEqual(maskFeed(world, 'simulate'), { terrain: { size: 1, erosion: 0 }, slopes: { slopeMin: 10, slopeMax: 25 } });
  assert.deepEqual(maskFeed(world, 'surface'), { type: 'ref/fbm', terrain: { octaves: 3 }, slopes: { slopeMin: 35, slopeMax: 50 } });
  assert.deepEqual(maskFeed(world, 'filter'), { terrain: { octaves: 2 }, slopes: { slopeMin: 40, slopeMax: 55 } });

  // In a document: the surface node on the range under a mask of the reference noise. The range does not stand
  // on the floor of the height range, where whatever a node cuts into the ground would lie below it: a broad,
  // low reference noise is added to it, three tenths of its height.
  assert.deepEqual(firstTerrain(world, 'surface').ground, { params: { seed: 9, size: 0.5, octaves: 2 }, strength: 0.3 });
  assert.deepEqual([firstTerrain(world, 'simulate').ground, firstTerrain(world, 'filter').ground], [undefined, undefined]);
  const stamped = typeDocument(world, 'surface/scatter', { connected: true });
  assert.deepEqual(chainOf(stamped, 'in'), ['ref/combine.out {"mode":"add","strength":0.3}', 'generate/mountain-range.out {"size":0.55,"erosion":0.6}']);
  const ground = stamped.doc.nodes[Object.values(stamped.doc.edges).find((edge) => edge.to.port === 'b' && stamped.doc.nodes[edge.to.node]!.type === 'ref/combine')!.from.node]!;
  assert.deepEqual([ground.type, ground.params], ['ref/fbm', { seed: 9, size: 0.5, octaves: 2 }]);
  assert.deepEqual(Object.values(stamped.doc.edges).filter((edge) => stamped.doc.nodes[edge.to.node]!.type === 'ref/combine').map((edge) => edge.to.port), ['a', 'b'], 'the mask of the sum is unconnected');
  assert.deepEqual(chainOf(stamped, 'mask'), ['ref/slope-mask.out {"slopeMin":35,"slopeMax":50}', 'ref/fbm.out {"seed":0,"size":0.25,"octaves":3}']);
  // Without ref/combine the range stands where its node puts it.
  assert.deepEqual(chainOf(typeDocument(createRegistry([fbm, range, scatter]), 'surface/scatter'), 'in'), ['generate/mountain-range.out {"size":0.55,"erosion":0.6}']);
  // A simulation on the island, its mask the slopes of the island without its gullies.
  const snowed = typeDocument(world, 'simulate/snow', { connected: true });
  assert.deepEqual(chainOf(snowed, 'in'), ['generate/island.out {"size":1,"erosion":0.6}']);
  assert.deepEqual(chainOf(snowed, 'mask'), ['ref/slope-mask.out {"slopeMin":10,"slopeMax":25}', 'generate/island.out {"size":1,"erosion":0}']);
  // A node of another category stays on the eroded noise, whatever the registry holds.
  assert.deepEqual(chainOf(typeDocument(world, 'filter/subject'), 'in'), ['generate/eroded-noise.out {"size":0.25,"octaves":8,"seed":0}']);
  // The terrain a mask or a colour is drawn over is the first terrain of the category.
  const colored = typeDocument(world, 'color/natural');
  assert.deepEqual([colored.doc.nodes[colored.terrain!.node]!.type, colored.doc.nodes[colored.terrain!.node]!.params], ['generate/island', { size: 1, erosion: 0.6 }]);
});

test('an input named stamp, flow or snow is fed what it is named for: a landform, the drainage of the first terrain, the snow on it', () => {
  assert.deepEqual(inputFeeds(scatter, false), { in: { kind: 'terrain', index: 0 }, stamp: { kind: 'terrain', index: 1, named: 'stamp' }, mask: null });
  assert.deepEqual(inputFeeds(natural, true), { in: { kind: 'terrain', index: 0 }, flow: { kind: 'terrain', index: 1, named: 'flow' }, snow: { kind: 'mask', named: 'snow' } });
  assert.deepEqual(inputFeeds(natural, false), { in: { kind: 'terrain', index: 0 }, flow: null, snow: null });
  // The name alone does not make it: the role is that of the name. A mask named flow is a mask, a colour named snow a colour.
  const odd = node({ type: 'filter/odd', title: 'Odd', category: 'filter', inputs: [{ name: 'flow', type: 'field', role: 'mask' }, { name: 'snow', type: 'color' }, { name: 'stamp', type: 'field', role: 'data' }] });
  assert.deepEqual(inputFeeds(odd, true), { flow: { kind: 'mask' }, snow: { kind: 'color', index: 0 }, stamp: { kind: 'terrain', index: 0 } });

  // The stamp of a surface node is a volcano at its defaults, in both variants: the input is required.
  const stamped = typeDocument(world, 'surface/scatter');
  assert.deepEqual(chainOf(stamped, 'stamp'), ['generate/volcano.out {"size":0.9,"erosion":0.6}']);
  assert.deepEqual(stamped.inputs.map((input) => `${input.port}: ${input.kind}`), ['in: terrain', 'stamp: stamp']);
  assert.equal(stamped.terrain, null, 'its output is a height');

  // The drainage and the snow are those of the terrain the node reads, from the product's own nodes; their
  // optional inputs stay unconnected.
  const colored = typeDocument(world, 'color/natural', { connected: true });
  const terrain = '{"size":1,"erosion":0.6}';
  assert.deepEqual(chainOf(colored, 'in'), [`generate/island.out ${terrain}`]);
  assert.deepEqual(chainOf(colored, 'flow'), ['simulate/flow.out {}', `generate/island.out ${terrain}`]);
  assert.deepEqual(chainOf(colored, 'snow'), ['simulate/snow.snow {}', `generate/island.out ${terrain}`]);
  assert.deepEqual(typesOf(colored.doc), ['color/natural', 'generate/island', 'simulate/flow', 'simulate/snow'], 'one island feeds the node, its drainage and its snow');
  assert.deepEqual(colored.inputs.map((input) => `${input.port}: ${input.kind} ${input.from.port}`), ['in: terrain out', 'flow: flow out', 'snow: snow snow']);
  assert.deepEqual(typesOf(typeDocument(world, 'color/natural').doc), ['color/natural', 'generate/island'], 'the plain variant has neither');

  // A registry without those nodes: the input takes what its type gives it, counted as it always is.
  const without = createRegistry([fbm, slopeMask, colorize, natural, scatter]);
  const bareColored = typeDocument(without, 'color/natural', { connected: true });
  assert.deepEqual(['in', 'flow', 'snow'].map((port) => chainOf(bareColored, port)[0]), ['ref/fbm.out {"seed":0,"size":0.25,"octaves":8}', 'ref/fbm.out {"seed":1,"size":0.1,"octaves":8}', 'ref/slope-mask.out {"slopeMin":35,"slopeMax":50}']);
  assert.deepEqual(bareColored.inputs.map((input) => `${input.port}: ${input.kind}`), ['in: terrain', 'flow: terrain', 'snow: mask']);
  assert.deepEqual(chainOf(typeDocument(without, 'surface/scatter'), 'stamp'), ['ref/fbm.out {"seed":1,"size":0.1,"octaves":8}']);

  // feedSource is the one place that says what a feed is made of: the harness's registryDoc builds from it too.
  assert.deepEqual(feedSource(world, { kind: 'mask', named: 'snow' }, 'color'), {
    node: { key: 'snow', type: 'simulate/snow', params: {}, port: 'snow', reads: { in: { key: 'terrain 0', type: 'generate/island', params: { size: 1 }, reads: {}, port: 'out' } } }, given: 'snow',
  });
  assert.deepEqual(feedSource(world, { kind: 'terrain', index: 2 }, 'color'), { node: { key: 'terrain 2', type: 'ref/fbm', params: { seed: 2, size: 0.5 }, reads: {}, port: 'out' }, given: 'terrain' });
  assert.deepEqual(feedSource(world, { kind: 'color', index: 0 }, null).node.reads, { in: { key: 'terrain 0', type: 'generate/eroded-noise', params: {}, reads: {}, port: 'out' } });
  assert.deepEqual(feedSource(world, { kind: 'terrain', index: 0, named: 'stamp' }, 'surface'), { node: { key: 'stamp', type: 'generate/volcano', params: {}, reads: {}, port: 'out' }, given: 'stamp' });
  // The first terrain of a surface node is a sum: the landform and its ground are the two things it reads.
  const sum = feedSource(world, { kind: 'terrain', index: 0 }, 'surface').node;
  assert.deepEqual([sum.key, sum.type, sum.params, Object.entries(sum.reads).map(([port, read]) => `${port}: ${read.key} ${read.type}`)], [
    'terrain 0', 'ref/combine', { mode: 'add', strength: 0.3 }, ['a: terrain 0 landform generate/mountain-range', 'b: terrain 0 ground ref/fbm'],
  ]);
});

test('a node type: where the registry lacks ref/slope-mask or ref/colorize, the terrain itself is connected', () => {
  const plan = typeDocument(bare, 'filter/subject', { connected: true });
  assert.deepEqual(['in', 'area', 'either', 'weights', 'tint'].map((port) => sourceOf(plan, port)), Array<string>(5).fill('ref/fbm.out'));
  assert.deepEqual(typesOf(plan.doc), ['filter/subject', 'ref/fbm', 'ref/fbm', 'ref/fbm']);
  assert.deepEqual(['weights', 'tint'].map((port) => feedOf(plan, port)!.id), [feedOf(plan, 'in')!.id, feedOf(plan, 'in')!.id], 'the first terrain stands in for its mask and its colouring');
});

test('a node type without inputs is alone in its document, with the settings of testing.md 8.6', () => {
  const plan = typeDocument(full, 'ref/fbm');
  assert.deepEqual(typesOf(plan.doc), ['ref/fbm']);
  assert.deepEqual(Object.keys(plan.doc.edges), []);
  // The settings of the tests and of the acceptance graphs: a sea level above the floor, so that a node that reads it has a sea to show.
  assert.deepEqual(plan.doc.settings, { ...newDoc().settings, terrainSize: 4096, heightRange: 1024, seed: 1, seaLevel: 0.25 });
  assert.deepEqual(RENDER_SETTINGS, { terrainSize: 4096, heightRange: 1024, seed: 1, seaLevel: 0.25 });
  assert.equal(plan.terrain, null);
});

test('a node type: the terrain a picture is drawn over is what feeds the first height input, or what the mask or colour was made of', () => {
  // A mask and a data output: both are drawn over the height input.
  const selected = typeDocument(full, 'ref/select');
  assert.deepEqual(selected.terrain && [selected.doc.nodes[selected.terrain.node]!.type, selected.terrain.port], ['ref/fbm', 'out']);
  // A colour output.
  const colored = typeDocument(full, 'ref/colorize');
  assert.deepEqual(colored.terrain && [colored.doc.nodes[colored.terrain.node]!.type, colored.terrain.port], ['ref/fbm', 'out']);
  assert.equal(sourceOf(colored, 'base'), null, 'its optional colour input is unconnected in the plain variant');
  assert.equal(sourceOf(typeDocument(full, 'ref/colorize', { connected: true }), 'base'), 'ref/colorize.out', 'and takes another ref/colorize in the connected one');
  // A node whose first output is a height has its mask and data outputs drawn over that height: no terrain is
  // read back for them, whatever the node was given.
  const blend = node({
    type: 'adjust/height-blend', title: 'Height Blend', category: 'adjust',
    inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field' }], outputs: [{ name: 'out', type: 'field' }, { name: 'weight', type: 'field', role: 'mask' }],
  });
  assert.equal(typeDocument(createRegistry([fbm, blend]), 'adjust/height-blend').terrain, null);
  // The first height input is not the first input.
  const grown = typeDocument(full, 'select/grow');
  assert.equal(sourceOf(grown, 'in'), 'ref/slope-mask.out');
  assert.deepEqual(grown.terrain && [grown.doc.nodes[grown.terrain.node]!.type, grown.terrain.port], ['ref/fbm', 'out']);
  // Height outputs only: nothing is drawn over a terrain, so none is read back.
  assert.equal(typeDocument(full, 'filter/subject').terrain, null);
  // No height input: a mask is drawn over the terrain it is a slope mask of, a colour over the terrain it colours.
  const lone = createRegistry([
    fbm, slopeMask, colorize,
    node({ type: 'select/edge', title: 'Edge', category: 'select', inputs: [{ name: 'in', type: 'field', role: 'mask' }], outputs: [{ name: 'out', type: 'field', role: 'data' }] }),
    node({ type: 'color/tone', title: 'Tone', category: 'color', inputs: [{ name: 'in', type: 'color' }], outputs: [{ name: 'out', type: 'color' }] }),
    node({ type: 'generate/disc', title: 'Disc', category: 'generate', outputs: [{ name: 'out', type: 'field', role: 'mask' }] }),
  ]);
  for (const type of ['select/edge', 'color/tone']) {
    const plan = typeDocument(lone, type);
    assert.ok(plan.terrain, type);
    assert.deepEqual([plan.doc.nodes[plan.terrain.node]!.type, plan.doc.nodes[plan.terrain.node]!.params, plan.terrain.port], ['ref/fbm', FIRST, 'out'], `${type}: the first terrain`);
  }
  // The colouring is of that very terrain; the mask is of its broad shape, so the terrain is in the document for the picture alone.
  const toned = typeDocument(lone, 'color/tone');
  assert.equal(Object.values(toned.doc.edges).find((edge) => edge.to.node === feedOf(toned, 'in')!.id)!.from.node, toned.terrain!.node);
  const edged = typeDocument(lone, 'select/edge');
  assert.equal(Object.values(edged.doc.edges).some((edge) => edge.from.node === edged.terrain!.node), false);
  // No input at all: there is no terrain to draw over.
  assert.equal(typeDocument(lone, 'generate/disc').terrain, null);
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
  assert.deepEqual(Object.values(withInput.doc.nodes).find((instance) => instance.type === 'ref/fbm')!.params, FIRST);
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
