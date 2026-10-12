// registryDoc (testing.md 2.4): one instance of every node, its inputs wired by port as the masked variant of
// `orogen render` wires them (each height from a ref/fbm of its own, masks from a ref/slope-mask of the first,
// colours from a ref/colorize of their terrain), a chain of ref/combine nodes over every first output with the
// nodes that read a file last, and the view at the end of the chain. Evaluating the view evaluates every node.
//
// The three wiring types are reference nodes; graph.test.ts covers the document that is made when a registry
// lacks them.
//
// Sizes: fields of 129 x 129; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineNode, type NodeDef } from '../../../src/core/api.ts';
import fbm from '../../../src/core/nodes/ref/fbm.ts';
import { nodes as refNodes } from '../../../src/core/nodes/ref/index.ts';
import talus from '../../../src/core/nodes/ref/talus.ts';
import type { GraphDoc, PortRef } from '../../../src/core/runtime.ts';
import { expectFinite, expectNoLeaks, registryDoc, renderGraph, TEST_SETTINGS, useNodes } from '../../helpers/index.ts';
import { dim, either, firstByte, scale, split } from './nodes.ts';

function reference(type: string): NodeDef {
  const def = refNodes.find((candidate) => candidate.type === type);
  if (!def) throw new Error(`src/core/nodes/ref/ has no ${type}, which registryDoc wires inputs with (testing.md 10.1)`);
  return def;
}

const slopeMask = reference('ref/slope-mask');
const colorize = reference('ref/colorize');
const combine = reference('ref/combine');

/** One input of every kind a port can ask for, passed through. */
const wired = defineNode({
  type: 'ref/h-wired',
  title: 'Wired (Reference)',
  category: 'ref',
  description: 'Takes a height, a weight, a colour and a guide, and passes the height on.',
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'weight', type: 'field', role: 'mask' },
    { name: 'paint', type: 'color' },
    { name: 'guide', type: 'field', role: 'data', optional: true },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  evaluate(ctx) {
    ctx.output('out', ctx.input('in'));
  },
});

/** A node without an output, as an export node is: registryDoc makes no instance of it. */
const sink = defineNode({
  type: 'ref/h-sink',
  title: 'Sink (Reference)',
  category: 'ref',
  description: 'Takes a field and gives nothing back.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [],
  kernels: [],
  evaluate() { /* nothing to produce */ },
});

// The node that reads a file is given first: the chain puts it last all the same.
const DEFS: readonly NodeDef[] = [firstByte, fbm, talus, scale, dim, either, split, wired, sink, slopeMask, colorize, combine];
useNodes([slopeMask, colorize, combine]);

const typeOf = (doc: GraphDoc, id: string): string => doc.nodes[id]!.type;
/** What feeds an input: '<type of the source node>.<port>', or null. */
function feeds(doc: GraphDoc, node: string, port: string): PortRef | null {
  return Object.values(doc.edges).find((edge) => edge.to.node === node && edge.to.port === port)?.from ?? null;
}
const idsOf = (doc: GraphDoc, type: string): string[] => Object.keys(doc.nodes).filter((id) => typeOf(doc, id) === type);

test('registryDoc: one instance of every node with outputs, wired by port: a terrain per height input, the slope mask, the colouring', () => {
  const doc = registryDoc(DEFS);
  assert.deepEqual(doc.settings, TEST_SETTINGS);
  for (const def of DEFS) {
    // Beside the instances: a link of the chain for every instance, the second terrain and the terrain under the
    // mask, the slope mask that feeds mask inputs, and the colorize that feeds colour inputs.
    const beside: Readonly<Record<string, number>> = { 'ref/fbm': 3, 'ref/slope-mask': 2, 'ref/colorize': 2, 'ref/combine': DEFS.filter((d) => d.outputs.length > 0).length };
    const expected = def.outputs.length === 0 ? 0 : beside[def.type] ?? 1;
    assert.equal(idsOf(doc, def.type).length, expected, `nodes of type ${def.type}`);
  }
  // Every instance holds its defaults.
  assert.deepEqual(doc.nodes[idsOf(doc, 'ref/h-scale')[0]!]!.params, { factor: 2 });
  assert.deepEqual(doc.nodes[idsOf(doc, 'ref/talus')[0]!]!.params, { talus: 35, reach: 0.02 });

  // The instance of ref/fbm is the first terrain; the second has a seed and a feature size of its own, and the
  // terrain under the mask is the broad shape of the first.
  const terrains = idsOf(doc, 'ref/fbm');
  const noise = terrains.find((id) => doc.nodes[id]!.params.seed === 0 && doc.nodes[id]!.params.octaves === 8)!;
  const second = terrains.find((id) => doc.nodes[id]!.params.seed === 1)!;
  const broad = terrains.find((id) => doc.nodes[id]!.params.octaves === 3)!;
  assert.deepEqual([doc.nodes[noise]!.params, doc.nodes[second]!.params, doc.nodes[broad]!.params], [
    { seed: 0, size: 0.25, octaves: 8, gain: 0.5 }, { seed: 1, size: 0.1, octaves: 8, gain: 0.5 }, { seed: 0, size: 0.25, octaves: 3, gain: 0.5 },
  ]);
  // The mask is a slope mask of that broad shape; the instance of ref/slope-mask, at its defaults, reads the first terrain.
  const steep = idsOf(doc, 'ref/slope-mask').find((id) => feeds(doc, id, 'in')?.node === broad)!;
  const instance = idsOf(doc, 'ref/slope-mask').find((id) => id !== steep)!;
  assert.deepEqual([doc.nodes[steep]!.params, doc.nodes[instance]!.params], [{ slopeMin: 35, slopeMax: 50 }, { slopeMin: 20, slopeMax: 45 }]);
  assert.deepEqual(feeds(doc, instance, 'in'), { node: noise, port: 'out' });
  // The colorize that feeds colour inputs reads the fbm alone; the instance under test has its `base` fed by it.
  const paints = idsOf(doc, 'ref/colorize');
  const painter = paints.find((id) => feeds(doc, id, 'base') === null)!;
  const painted = paints.find((id) => id !== painter)!;
  assert.deepEqual([feeds(doc, painter, 'in'), feeds(doc, painted, 'in'), feeds(doc, painted, 'base')], [{ node: noise, port: 'out' }, { node: noise, port: 'out' }, { node: painter, port: 'out' }]);

  const node = idsOf(doc, 'ref/h-wired')[0]!;
  assert.deepEqual(
    ['in', 'weight', 'paint', 'guide', 'mask'].map((port) => feeds(doc, node, port)),
    [{ node: noise, port: 'out' }, { node: steep, port: 'out' }, { node: painter, port: 'out' }, { node: second, port: 'out' }, { node: steep, port: 'out' }],
    'the height from the first terrain and the data input from the second, mask inputs from the slope mask, the colour input from the colorize',
  );
  // Two inputs of equal rank are two terrains: the instance of ref/combine is not shown one field twice.
  const mixer = idsOf(doc, 'ref/combine').find((id) => feeds(doc, id, 'a')?.node === noise && feeds(doc, id, 'b')?.node === second)!;
  assert.deepEqual(feeds(doc, mixer, 'mask'), { node: steep, port: 'out' }, 'its optional mask is connected');
  assert.deepEqual(feeds(doc, idsOf(doc, 'ref/h-either')[0]!, 'in'), { node: noise, port: 'out' }, 'an `any` input takes a terrain');
  assert.deepEqual(feeds(doc, idsOf(doc, 'ref/h-dim')[0]!, 'in'), { node: painter, port: 'out' });
  assert.deepEqual(feeds(doc, idsOf(doc, 'ref/h-scale')[0]!, 'mask'), { node: steep, port: 'out' }, 'the mask the evaluator adds to a maskable node is wired like any optional mask');
  assert.equal(Object.values(doc.edges).some((edge) => edge.from.node === edge.to.node), false);
});

test('registryDoc: a chain of ref/combine takes the first output of every instance, file nodes last, and the view shows its end', () => {
  const doc = registryDoc(DEFS);
  const view = doc.ui.view?.height;
  assert.ok(view, 'ui.view shows the end of the chain');
  assert.equal(typeOf(doc, view.node), 'ref/combine');

  // Walk the chain back from the view: each link mixes the chain so far (a) with one more instance (b).
  const order: string[] = [];
  let at: PortRef | null = view;
  for (let links = 0; at && links <= Object.keys(doc.nodes).length; links++) {
    const a = feeds(doc, at.node, 'a'), b = feeds(doc, at.node, 'b');
    const isLink = typeOf(doc, at.node) === 'ref/combine' && a !== null && b !== null && !order.includes(at.node) && (links === 0 || feeds(doc, order.at(-1)!, 'a')?.node === at.node);
    if (!isLink) {
      order.push(`first:${typeOf(doc, at.node)}.${at.port}`);
      break;
    }
    order.push(at.node);
    at = a;
  }
  const links = order.filter((entry) => !entry.startsWith('first:'));
  const instances = DEFS.filter((def) => def.outputs.length > 0);
  assert.equal(links.length, instances.length - 1, 'one link for every instance after the first');
  const taken = [order.at(-1)!.slice('first:'.length), ...links.reverse().map((id) => { const b = feeds(doc, id, 'b')!; return `${typeOf(doc, b.node)}.${b.port}`; })];
  const expected = [...instances.filter((def) => def !== firstByte), firstByte].map((def) => `${def.type}.${def.outputs[0]!.name}`);
  assert.deepEqual(taken, expected, 'outputs[0] of every instance in the order given, the node with a file parameter last');
});

test('registryDoc: evaluating the view evaluates every node; only the node whose file is not selected fails', async () => {
  const doc = registryDoc(DEFS);
  const view = doc.ui.view!.height!;
  const { fields, report } = await renderGraph(doc, [`${view.node}.${view.port}`], { res: 129, outputs: 'all' });
  assert.deepEqual(Object.keys(report.nodes).sort(), Object.keys(doc.nodes).sort(), 'every node of the document is in the plan of the view');
  const file = idsOf(doc, 'ref/h-byte')[0]!;
  const lastLink = view.node;
  for (const [id, node] of Object.entries(report.nodes)) {
    if (id === file) assert.deepEqual([node.state, node.error?.message], ['error', 'No file selected']);
    else if (id === lastLink) assert.deepEqual([node.state, node.upstream], ['skipped', file], 'the link after the file node');
    else assert.equal(node.state, 'done', `${typeOf(doc, id)} ended ${node.state}${node.error ? `: ${node.error.message}` : ''}`);
  }
  assert.equal(report.status, 'errors');
  assert.deepEqual(Object.keys(fields), []);

  // Without the file node the view is delivered, and it is a terrain.
  const whole = registryDoc(DEFS.filter((def) => def !== firstByte));
  const end = whole.ui.view!.height!;
  const ok = await renderGraph(whole, [`${end.node}.${end.port}`], { res: 129, outputs: 'all' });
  assert.equal(ok.report.status, 'ok');
  assert.ok(Object.values(ok.report.nodes).every((node) => node.state === 'done'), 'no two nodes of the document have one key: none is a cache hit');
  expectFinite(ok.fields[`${end.node}.${end.port}`]!);
  await expectNoLeaks();
});

test('registryDoc: a single node is its own view, and a list without outputs gives an empty document', () => {
  const single = registryDoc([fbm]);
  assert.equal(Object.keys(single.nodes).length, 1);
  assert.deepEqual(single.ui.view, { height: { node: Object.keys(single.nodes)[0]!, port: 'out' } });
  const none = registryDoc([sink]);
  assert.deepEqual([Object.keys(none.nodes).length, none.ui.view], [0, undefined]);
  // A node that is not among the definitions still gets its wiring.
  const lone = registryDoc([wired]);
  assert.deepEqual(Object.values(lone.nodes).map((node) => node.type).sort(), ['ref/colorize', 'ref/fbm', 'ref/fbm', 'ref/fbm', 'ref/h-wired', 'ref/slope-mask']);
  assert.equal(lone.ui.view?.height?.node, idsOf(lone, 'ref/h-wired')[0]);
});
