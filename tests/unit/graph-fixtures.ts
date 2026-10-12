// Node definitions for the GPU-free tests of src/core/graph/. They are plain objects, not made by defineNode,
// so that a test of the document layer does not depend on the kernel system; define-node.test.ts tests
// defineNode itself.

import type { AnyKernel, NodeDef, ParamDef, WgslLib } from '../../src/core/api.ts';
import { createRegistry, type NodeRegistry } from '../../src/core/runtime.ts';

export function kernel(name: string, code: string, includes: readonly WgslLib[] = []): AnyKernel {
  return { name, def: { name, outputs: { out: 'field' }, includes, code } };
}

export function node(def: Partial<NodeDef> & Pick<NodeDef, 'type'>): NodeDef {
  return {
    title: 'Node (Reference)',
    category: 'ref',
    description: 'Generates nothing.',
    inputs: [],
    outputs: [{ name: 'out', type: 'field' }],
    params: [],
    kernels: [],
    evaluate() {},
    ...def,
  };
}

/** One param of every kind, in the order of the table of runtime.md 4.4. */
export const everyKind: readonly ParamDef[] = [
  { kind: 'float', name: 'hard', unit: 'ratio', help: 'Hard limits.', default: 0.5, min: 0, max: 1 },
  { kind: 'float', name: 'soft', unit: 'length', help: 'Soft limits.', default: 0.25, min: 0.001, max: 4, soft: true, scale: 'log' },
  { kind: 'int', name: 'count', help: 'A count.', default: 4, min: 1, max: 16 },
  { kind: 'bool', name: 'invert', help: 'Inverts.', default: false },
  { kind: 'enum', name: 'mode', help: 'A choice.', default: 'mix', options: [{ value: 'mix', label: 'Mix' }, { value: 'add', label: 'Add' }] },
  { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 },
  { kind: 'vec2', name: 'offset', unit: 'length', help: 'A shift.', default: [0, 0], min: -1, max: 1 },
  { kind: 'vec2', name: 'center', unit: 'length', help: 'A position.', default: [0.5, 0.5], min: 0, max: 1, soft: true },
  { kind: 'color', name: 'tint', help: 'A colour.', default: [1, 1, 1] },
  { kind: 'curve', name: 'profile', help: 'A curve.', default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  { kind: 'gradient', name: 'ramp', help: 'A gradient.', default: [{ t: 0, color: [0, 0, 0] }, { t: 1, color: [1, 1, 1] }] },
  { kind: 'file', name: 'file', help: 'A file.', default: '', filters: ['png'] },
  { kind: 'text', name: 'label', help: 'A text.', default: 'Layer', maxLength: 8 },
];

/** A generator with one param of every kind. */
export const gen = node({ type: 'ref/gen', title: 'Gen (Reference)', params: everyKind });

/** `any` in, the same kind out; maskable. */
export const soften = node({
  type: 'ref/soften',
  title: 'Soften (Reference)',
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [{ kind: 'float', name: 'radius', unit: 'length', help: 'A radius.', default: 0.005, min: 0.0001, max: 0.25, soft: true, scale: 'log' }],
  maskable: true,
});

/** Two inputs and the node's own mask; version 2 with the migration of testing.md 10.1. */
export const combine = node({
  type: 'ref/combine',
  title: 'Combine (Reference)',
  inputs: [
    { name: 'a', type: 'field' },
    { name: 'b', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  params: [
    { kind: 'enum', name: 'mode', help: 'A choice.', default: 'mix', options: [{ value: 'mix', label: 'Mix' }, { value: 'add', label: 'Add' }] },
    { kind: 'float', name: 'strength', unit: 'ratio', help: 'A strength.', default: 0.5, min: 0, max: 1 },
  ],
  version: 2,
  migrate(params, from) {
    if (from !== 1) throw new Error(`unexpected version ${from}`);
    const { amount, ...rest } = params;
    if (typeof amount !== 'number') throw new Error('amount is missing');
    return { ...rest, strength: amount / 100 };
  },
});

/** A field in, a colour out, an optional colour input. */
export const colorize = node({
  type: 'ref/colorize',
  title: 'Colorize (Reference)',
  inputs: [{ name: 'in', type: 'field' }, { name: 'base', type: 'color', optional: true }],
  outputs: [{ name: 'out', type: 'color' }],
});

/** A mask and a data output. */
export const select = node({
  type: 'ref/select',
  title: 'Select (Reference)',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }, { name: 'flow', type: 'field', role: 'data' }],
});

/** No outputs at all. */
export const sink = node({ type: 'ref/sink', title: 'Sink (Reference)', inputs: [{ name: 'in', type: 'field' }], outputs: [] });

export const defs: readonly NodeDef[] = [gen, soften, combine, colorize, select, sink];
export const registry: NodeRegistry = createRegistry(defs);
