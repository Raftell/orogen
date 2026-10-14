// What the panels say of a node's ports from the core's own rules (runtime.md 4.3, 5.3 step 2, 5.6; engine.md
// 4.2, 4.13, 4.14), as the runtime entry module exports them: the label of a port, the inputs a connection can
// target, whether a node can be bypassed, and which required inputs are unconnected. The last is held to the
// evaluator's plan, which reports `missing-input` by the same function.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPlan } from '../../src/core/eval/plan.ts';
import {
  canBypass, inputKey, inputSources, inputsOf, missingInputs, newDoc, portLabel,
  type Edge, type GraphDoc, type NodeInstance,
} from '../../src/core/runtime.ts';
import { colorize, combine, gen, node, registry as fixtures, select, sink, soften } from './graph-fixtures.ts';
import { createRegistry } from '../../src/core/runtime.ts';

/** Two required inputs and an optional one, no output of the kind of the first input: cannot be bypassed. */
const mixer = node({
  type: 'ref/mixer', title: 'Mixer (Reference)',
  inputs: [{ name: 'a', type: 'field', label: 'First terrain' }, { name: 'b', type: 'color' }, { name: 'weights', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'color' }],
});
/** A field in, a field out, and a second required input: can be bypassed. */
const carve = node({
  type: 'ref/carve', title: 'Carve (Reference)',
  inputs: [{ name: 'in', type: 'field' }, { name: 'flow', type: 'field', role: 'data' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'depth', type: 'field', role: 'data', label: 'Carved depth' }],
});
const registry = createRegistry([...fixtures.list(), mixer, carve]);

function doc(nodes: Readonly<Record<string, string | { type: string; bypass?: boolean }>>, edges: readonly string[] = []): GraphDoc {
  const instances: Record<string, NodeInstance> = {};
  for (const [id, spec] of Object.entries(nodes)) {
    const { type, bypass } = typeof spec === 'string' ? { type: spec, bypass: undefined } : spec;
    instances[id] = { id, type, version: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, params: {}, ...(bypass ? { bypass: true } : {}) };
  }
  const records: Record<string, Edge> = {};
  edges.forEach((text, i) => {
    const [from, to] = text.split(' -> ').map((end) => end.split('.')) as [[string, string], [string, string]];
    records[`e${i}`] = { id: `e${i}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } };
  });
  return { ...newDoc(), nodes: instances, edges: records };
}
const names = (d: GraphDoc, id: string): string[] => missingInputs(d, registry, id).map((port) => port.name);

test('portLabel: the label a port declares, else its name with a capital', () => {
  assert.equal(portLabel({ name: 'in' }), 'In');
  assert.equal(portLabel({ name: 'flowAccumulation' }), 'FlowAccumulation');
  assert.equal(portLabel({ name: 'a', label: 'First terrain' }), 'First terrain');
  assert.deepEqual(mixer.inputs.map(portLabel), ['First terrain', 'B', 'Weights']);
  assert.deepEqual(carve.outputs.map(portLabel), ['Out', 'Carved depth']);
  assert.equal(portLabel({ name: '' }), '');
});

test('inputsOf: the declared inputs, then the mask of a maskable node', () => {
  assert.deepEqual(inputsOf(gen), []);
  assert.deepEqual(inputsOf(select).map((port) => port.name), ['in']);
  assert.deepEqual(inputsOf(soften).map((port) => [port.name, port.type, port.role, port.optional]), [['in', 'any', undefined, undefined], ['mask', 'field', 'mask', true]]);
  assert.equal(portLabel(inputsOf(soften)[1]!), 'Mask');
  // A node that declares an input of that name itself is not maskable: its inputs are what it declares.
  assert.deepEqual(inputsOf(combine).map((port) => port.name), ['a', 'b', 'mask']);
  assert.equal(inputsOf(combine), combine.inputs);
});

test('canBypass: inputs[0] and outputs[0] exist with the same type', () => {
  assert.deepEqual([gen, soften, combine, colorize, select, sink, mixer, carve].map((def) => [def.type, canBypass(def)]), [
    ['ref/gen', false],        // no input
    ['ref/soften', true],      // any in, the same out
    ['ref/combine', true],     // field in, field out
    ['ref/colorize', false],   // field in, colour out
    ['ref/select', true],      // field in, a field out, whatever its role
    ['ref/sink', false],       // no output
    ['ref/mixer', false],
    ['ref/carve', true],
  ]);
  assert.equal(canBypass({ inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'other' } }] }), false);
  assert.equal(canBypass({ inputs: [{ name: 'in', type: 'color' }], outputs: [{ name: 'out', type: 'color' }] }), true);
});

test('missingInputs: the required inputs the evaluator finds unconnected, in declaration order', () => {
  const d = doc({ g: 'ref/gen', paint: 'ref/colorize', m: 'ref/mixer', c: 'ref/carve', s: 'ref/soften', k: 'ref/combine' }, ['g.out -> m.b']);
  assert.deepEqual(names(d, 'm'), ['a'], 'b is connected, and weights is optional');
  assert.deepEqual(names(d, 'c'), ['in', 'flow']);
  assert.deepEqual(names(d, 's'), ['in'], 'the mask of a maskable node is never missing');
  assert.deepEqual(names(d, 'k'), ['a', 'b']);
  assert.deepEqual(names(d, 'paint'), ['in'], 'an optional input is not missing');
  assert.deepEqual(names(d, 'g'), []);
  assert.deepEqual(missingInputs(d, registry, 'm').map(portLabel), ['First terrain'], 'the ports themselves, for whoever names them');
});

test('missingInputs: an edge the evaluator ignores connects nothing, and of two edges into one input the first counts', () => {
  const d = doc({ g: 'ref/gen', lost: 'weather/rain', c: 'ref/carve', self: 'ref/carve', twice: 'ref/carve' }, [
    'lost.out -> c.in',          // from a node of a type no build has
    'g.none -> c.flow',          // from an output its node lacks
    'self.out -> self.in',       // a node to itself
    'g.out -> twice.in', 'g.out -> twice.in', 'g.out -> twice.flow',
  ]);
  assert.deepEqual(names(d, 'c'), ['in', 'flow']);
  assert.deepEqual(names(d, 'self'), ['in', 'flow']);
  assert.deepEqual(names(d, 'twice'), []);
  const sources = inputSources(d, registry);
  assert.deepEqual([...sources.keys()], [inputKey({ node: 'twice', port: 'in' }), inputKey({ node: 'twice', port: 'flow' })]);
  assert.deepEqual(sources.get(inputKey({ node: 'twice', port: 'in' })), { node: 'g', port: 'out' });
  assert.deepEqual(missingInputs(d, registry, 'c', sources).map((port) => port.name), ['in', 'flow'], 'with the sources made once for many nodes');
});

test('missingInputs: none for a node whose bypass takes effect, for an unknown type and for no node at all', () => {
  const d = doc({
    passed: { type: 'ref/carve', bypass: true },       // bypass takes effect: nothing is read but what is passed on
    kept: { type: 'ref/mixer', bypass: true },         // cannot be bypassed: the flag is ignored
    lost: 'weather/rain',
  });
  assert.deepEqual(names(d, 'passed'), []);
  assert.deepEqual(names(d, 'kept'), ['a', 'b']);
  assert.deepEqual(names(d, 'lost'), []);
  assert.deepEqual(names(d, 'nobody'), []);
  assert.deepEqual(names(d, 'constructor'), [], 'an id that every object has as a member is no node');
});

test('missingInputs is the evaluator\'s rule: a node has a missing input exactly when its plan says missing-input, and of the same port', () => {
  const d = doc({
    g: 'ref/gen', paint: 'ref/colorize', m: 'ref/mixer', c: 'ref/carve', s: 'ref/soften', k: 'ref/combine', sel: 'ref/select', end: 'ref/sink',
    passed: { type: 'ref/carve', bypass: true }, kept: { type: 'ref/mixer', bypass: true }, half: 'ref/carve', whole: 'ref/carve',
  }, ['g.out -> paint.in', 'g.out -> m.b', 'g.out -> half.in', 'g.out -> whole.in', 'g.out -> whole.flow', 'g.out -> sel.in', 'sel.out -> s.mask', 'whole.out -> end.in']);
  const plan = buildPlan(d, registry, Object.keys(d.nodes).map((id) => ({ node: id })));
  let missing = 0;
  for (const planned of plan.nodes) {
    const lacking = missingInputs(d, registry, planned.nodeId);
    const error = planned.error?.kind === 'missing-input' ? planned.error.message : null;
    assert.equal(error, lacking.length > 0 ? `missing input "${lacking[0]!.name}"` : null, planned.nodeId);
    if (lacking.length > 0) missing++;
  }
  assert.equal(plan.nodes.length, Object.keys(d.nodes).length);
  assert.equal(missing, 6, 'm, c, s, k, kept and half');
});
