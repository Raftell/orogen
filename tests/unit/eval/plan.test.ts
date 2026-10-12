// The plan of an evaluation (runtime.md 5.3 steps 1, 2, 4 and 6): order, the checks before any GPU work,
// conversions, wanted outputs and the peak of a build's outputs. No device is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPlan, outputPeak, type EvalPlan } from '../../../src/core/eval/plan.ts';
import type { EvalTarget, GraphDoc } from '../../../src/core/runtime.ts';
import { createRegistry } from '../../../src/core/runtime.ts';
import { node } from '../graph-fixtures.ts';

const registry = createRegistry([
  node({ type: 'ref/gen' }),
  node({ type: 'ref/paint', outputs: [{ name: 'out', type: 'color' }] }),
  node({ type: 'ref/filter', inputs: [{ name: 'in', type: 'field' }], maskable: true }),
  node({ type: 'ref/tone', inputs: [{ name: 'in', type: 'color' }], outputs: [{ name: 'out', type: 'color' }] }),
  node({ type: 'ref/any', inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'in' } }, { name: 'extra', type: 'field', role: 'data' }] }),
  node({
    type: 'ref/mix',
    inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field' }, { name: 'weight', type: 'field', optional: true }],
    params: [{ kind: 'enum', name: 'mode', help: 'A choice.', default: 'mix', options: [{ value: 'mix', label: 'Mix' }, { value: 'add', label: 'Add' }] }],
  }),
  node({ type: 'ref/two', version: 2, migrate: (params) => params }),
]);

interface Spec { type: string; in?: Record<string, string>; params?: Record<string, unknown>; bypass?: boolean; version?: number }
function doc(nodes: Record<string, Spec>, extraEdges: [string, string][] = []): GraphDoc {
  const out = { format: 'orogen', version: 1, settings: { terrainSize: 1, heightRange: 1, seed: 0, buildResolution: 513, previewLevel: 0, seaLevel: 0 }, nodes: {} as Record<string, unknown>, edges: {} as Record<string, unknown>, groups: {}, ui: {} };
  let n = 0;
  const edge = (from: string, to: string): void => {
    const [fromNode, fromPort] = from.split('.'), [toNode, toPort] = to.split('.');
    const id = `e${++n}`;
    out.edges[id] = { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
  };
  for (const [id, spec] of Object.entries(nodes)) {
    out.nodes[id] = { id, type: spec.type, version: spec.version ?? registry.get(spec.type)?.version ?? 1, position: { x: 0, y: 0 }, params: spec.params ?? {}, ...(spec.bypass ? { bypass: true } : {}) };
    for (const [port, from] of Object.entries(spec.in ?? {})) edge(from, `${id}.${port}`);
  }
  for (const [from, to] of extraEdges) edge(from, to);
  return out as unknown as GraphDoc;
}
const targets = (...refs: string[]): EvalTarget[] => refs.map((ref) => {
  const [n, port] = ref.split('.');
  return port === undefined ? { node: n! } : { ref: { node: n!, port } };
});
const order = (plan: EvalPlan): string[] => plan.nodes.map((n) => n.nodeId);

test('the order is the depth-first post-order from the targets, inputs in declaration order, the mask last', () => {
  const d = doc({
    unused: { type: 'ref/gen' },
    m: { type: 'ref/gen' },
    b: { type: 'ref/gen' },
    a: { type: 'ref/gen' },
    w: { type: 'ref/gen' },
    // Stored in another order than declared: weight, b, a.
    mix: { type: 'ref/mix', in: { weight: 'w.out', b: 'b.out', a: 'a.out' } },
    f: { type: 'ref/filter', in: { mask: 'm.out', in: 'mix.out' } },
    last: { type: 'ref/gen' },
  });
  const plan = buildPlan(d, registry, targets('f.out', 'last.out', 'a.out'));
  assert.deepEqual(order(plan), ['a', 'b', 'w', 'mix', 'm', 'f', 'last'], 'each node once; nodes no target needs are not in the plan');
  assert.deepEqual(plan.byId.get('f')!.inputs, [
    { port: 'in', from: { node: 'mix', port: 'out' }, conversion: '' },
    { port: 'mask', from: { node: 'm', port: 'out' }, conversion: '' },
  ]);
  assert.ok(plan.nodes.every((n) => n.error === null && n.upstream === null));
  assert.deepEqual(order(buildPlan(d, registry, targets('last', 'unused'))), ['last', 'unused']);
  assert.deepEqual(order(buildPlan(d, registry, [])), []);
});

test('a bypassed node reads inputs[0] only: what feeds its other inputs is not in the plan, and nothing of it is checked', () => {
  const d = doc({
    a: { type: 'ref/gen' },
    side: { type: 'ref/gen' },
    mask: { type: 'ref/gen' },
    off: { type: 'ref/filter', in: { in: 'a.out', mask: 'mask.out' }, bypass: true },
    // Bypassed with a missing required input, an invalid param and a newer version.
    loose: { type: 'ref/mix', in: { a: 'off.out' }, params: { mode: 'nonsense' }, bypass: true, version: 9 },
    gen: { type: 'ref/gen', bypass: true },
  });
  const plan = buildPlan(d, registry, targets('loose.out', 'gen.out'));
  assert.deepEqual(order(plan), ['a', 'off', 'loose', 'gen']);
  assert.deepEqual(plan.nodes.map((n) => [n.bypassed, n.error, n.params === null]), [[false, null, false], [true, null, true], [true, null, true], [false, null, false]]);
  assert.deepEqual(plan.byId.get('loose')!.inputs.map((i) => i.port), ['a']);
  assert.equal(plan.byId.get('gen')!.bypassed, false, 'bypass is ignored without inputs[0]');
});

test('the checks of step 2, each with its message, and "upstream" for everything that reads a failed node', () => {
  const d = doc({
    gen: { type: 'ref/gen' },
    gone: { type: 'ref/removed' },
    old: { type: 'ref/two', version: 1 },
    missing: { type: 'ref/mix', in: { a: 'gen.out' } },
    param: { type: 'ref/mix', in: { a: 'gen.out', b: 'gen.out' }, params: { mode: 'nonsense' } },
    reader: { type: 'ref/filter', in: { in: 'param.out' } },
    far: { type: 'ref/mix', in: { a: 'gen.out', b: 'gen.out', weight: 'reader.out' } },
    ring1: { type: 'ref/filter', in: { in: 'ring2.out' } },
    ring2: { type: 'ref/filter', in: { in: 'ring1.out' } },
    // Unknown type and a version that differs: the type is reported.
    both: { type: 'ref/removed', version: 7 },
  });
  const plan = buildPlan(d, registry, targets('gone', 'old.out', 'missing.out', 'far.out', 'ring2.out', 'both'));
  const errors = Object.fromEntries(plan.nodes.filter((n) => n.error).map((n) => [n.nodeId, [n.error!.kind, n.error!.message, n.error!.nodeType]]));
  assert.deepEqual(errors, {
    gone: ['unknown-type', 'Unknown node type "ref/removed"', 'ref/removed'],
    old: ['version', 'Saved with version 1 of this node; this build has version 2', 'ref/two'],
    missing: ['missing-input', 'missing input "b"', 'ref/mix'],
    param: ['param', 'param "mode": unknown value "nonsense"', 'ref/mix'],
    ring1: ['cycle', 'Part of a cycle', 'ref/filter'],
    ring2: ['cycle', 'Part of a cycle', 'ref/filter'],
    both: ['unknown-type', 'Unknown node type "ref/removed"', 'ref/removed'],
  });
  assert.deepEqual(Object.fromEntries(plan.nodes.filter((n) => n.upstream !== null).map((n) => [n.nodeId, n.upstream])), { reader: 'param', far: 'param' }, 'the failed node itself, however far away');
  assert.equal(plan.byId.get('gen')!.error, null);
});

test('an edge the evaluator ignores counts as no connection; of several edges into one input the first is used', () => {
  const d = doc({
    gone: { type: 'ref/removed' },
    a: { type: 'ref/gen' },
    b: { type: 'ref/gen' },
    afterGone: { type: 'ref/filter', in: { in: 'gone.out' } },
    twice: { type: 'ref/filter', in: { in: 'a.out' } },
  }, [['b.out', 'twice.in'], ['a.nothing', 'twice.mask']]);
  const plan = buildPlan(d, registry, targets('afterGone.out', 'twice.out'));
  assert.deepEqual(order(plan), ['afterGone', 'a', 'twice']);
  assert.deepEqual([plan.byId.get('afterGone')!.error?.kind, plan.byId.get('afterGone')!.upstream], ['missing-input', null]);
  assert.deepEqual(plan.byId.get('twice')!.inputs.map((i) => i.from?.node ?? null), ['a', null]);
});

test('conversions: a field input reads a colour as luma, a colour input a field as grey; sameAs carries the kind on', () => {
  const d = doc({
    field: { type: 'ref/gen' },
    colour: { type: 'ref/paint' },
    toField: { type: 'ref/filter', in: { in: 'colour.out', mask: 'colour.out' } },
    toColour: { type: 'ref/tone', in: { in: 'field.out' } },
    anyColour: { type: 'ref/any', in: { in: 'colour.out' } },
    anyField: { type: 'ref/any', in: { in: 'field.out' } },
    chained: { type: 'ref/any', in: { in: 'anyColour.out' } },
    back: { type: 'ref/filter', in: { in: 'chained.out' } },
    open: { type: 'ref/any' },
  });
  const plan = buildPlan(d, registry, targets('toField.out', 'toColour.out', 'anyField.out', 'back.out', 'open.out'));
  const conversions = (id: string): string[] => plan.byId.get(id)!.inputs.map((i) => i.conversion);
  assert.deepEqual([conversions('toField'), conversions('toColour'), conversions('anyColour'), conversions('anyField'), conversions('back')], [['luma', 'luma'], ['grey'], [''], [''], ['luma', '']]);
  assert.deepEqual(plan.byId.get('anyColour')!.outputKinds, { out: 'color', extra: 'field' });
  assert.deepEqual(plan.byId.get('chained')!.outputKinds, { out: 'color', extra: 'field' });
  assert.deepEqual(plan.byId.get('anyField')!.outputKinds.out, 'field');
  assert.deepEqual([plan.byId.get('open')!.outputKinds.out, plan.byId.get('open')!.error?.kind], ['field', 'missing-input']);
});

test('a target that names a node or an output the document lacks is a TypeError', () => {
  const d = doc({ g: { type: 'ref/gen' }, gone: { type: 'ref/removed' } });
  assert.throws(() => buildPlan(d, registry, targets('nobody')), TypeError);
  assert.throws(() => buildPlan(d, registry, targets('nobody.out')), /names the node "nobody"/);
  assert.throws(() => buildPlan(d, registry, targets('g.flow')), /names the output "flow"/);
  assert.throws(() => buildPlan(d, registry, targets('constructor')), TypeError, 'an inherited member is no node');
  assert.throws(() => buildPlan(d, registry, [{ ref: { node: 'g', port: 'out' }, as: 'grey' as never }]), TypeError);
  // The outputs of an unknown type cannot be known; the node is blocked instead.
  assert.equal(buildPlan(d, registry, targets('gone.anything')).nodes[0]!.error?.kind, 'unknown-type');
});

test('a chain and a ring of 20 000 nodes are planned without recursion', () => {
  const COUNT = 20_000;
  const chain: Record<string, Spec> = { n0: { type: 'ref/gen' } };
  for (let i = 1; i < COUNT; i++) chain[`n${i}`] = { type: 'ref/filter', in: { in: `n${i - 1}.out` } };
  const plan = buildPlan(doc(chain), registry, targets(`n${COUNT - 1}.out`));
  assert.equal(plan.nodes.length, COUNT);
  assert.deepEqual([plan.nodes[0]!.nodeId, plan.nodes[COUNT - 1]!.nodeId], ['n0', `n${COUNT - 1}`]);
  assert.equal(plan.nodes.filter((n) => n.error !== null || n.upstream !== null).length, 0);

  const ring: Record<string, Spec> = {};
  for (let i = 0; i < COUNT; i++) ring[`n${i}`] = { type: 'ref/filter', in: { in: `n${(i + COUNT - 1) % COUNT}.out` } };
  const round = buildPlan(doc(ring), registry, targets('n7.out'));
  assert.equal(round.nodes.length, COUNT);
  assert.equal(round.nodes.filter((n) => n.error?.kind === 'cycle').length, COUNT);
});

test('outputPeak: the largest sum of what is alive at one step, and the first step at which it occurs', () => {
  assert.deepEqual(outputPeak([], 4), { bytes: 0, step: 0 });
  assert.deepEqual(outputPeak([{ bytes: 5, from: 0, to: 0 }], 0), { bytes: 0, step: 0 });
  // a: steps 0..1, b: 1..2, c: 2..2 and a target alive from 0 to the end.
  const lifetimes = [{ bytes: 10, from: 0, to: 1 }, { bytes: 10, from: 1, to: 2 }, { bytes: 10, from: 2, to: 2 }];
  assert.deepEqual(outputPeak(lifetimes, 3), { bytes: 20, step: 1 });
  assert.deepEqual(outputPeak([...lifetimes, { bytes: 7, from: 0, to: 99 }], 3), { bytes: 27, step: 1 });
  assert.deepEqual(outputPeak([{ bytes: 1, from: 2, to: 2 }, { bytes: 3, from: 0, to: 0 }], 3), { bytes: 3, step: 0 });
  assert.deepEqual(outputPeak([{ bytes: 4, from: -5, to: 1 }, { bytes: 4, from: 2, to: 1 }], 3), { bytes: 4, step: 0 }, 'lifetimes are clipped to the steps');
});
