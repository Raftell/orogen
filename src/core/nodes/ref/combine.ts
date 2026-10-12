// src/core/nodes/ref/combine.ts
import { MASK_INPUT, defineKernel, defineNode, param } from '../../api.ts';

const combine = defineKernel({
  name: 'ref/combine',
  inputs: { a: 'field', b: 'field', mask: MASK_INPUT },   // the node's own mask: reads 1 when unconnected, saturated on read
  outputs: { out: 'field' },
  params: { mode: 'u32', strength: 'f32' },
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let va = a_at(px);
  let vb = b_at(px);
  var r = vb;                           // 0: mix
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { r = va + vb; }
    case 2u: { r = va * vb; }
    case 3u: { r = max(va, vb); }
    case 4u: { r = min(va, vb); }
    default: {}
  }
  let t = P.strength * mask_at(px);
  // A device may evaluate mix as a + t * (r - a), which is not r at t = 1: the two ends are selected, so that
  // no strength leaves a and full strength gives the combination, bit for bit.
  return select(select(mix(va, r, t), r, t >= 1.0), va, t <= 0.0);
}`,
});

export default defineNode({
  type: 'ref/combine',
  title: 'Combine (Reference)',
  category: 'ref',
  description: 'Combines two terrains by mixing, adding, multiplying or taking the higher or lower; the reference node for two inputs.',
  keywords: ['blend', 'mix', 'math', 'merge'],
  inputs: [
    { name: 'a', type: 'field' },
    { name: 'b', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'mix',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'mix', label: 'Mix' },
        { value: 'add', label: 'Add' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'max', label: 'Maximum' },
        { value: 'min', label: 'Minimum' },
      ],
      help: 'How the second input is combined with the first.',
    },
    param.strength({ default: 0.5 }),
  ],
  kernels: [combine],
  version: 2,
  migrate(params, from) {
    if (from === 1) {
      // Version 1 stored `amount`, in percent. A document that never set it keeps the default.
      const { amount, ...rest } = params;
      return typeof amount === 'number' ? { ...rest, strength: amount / 100 } : rest;
    }
    return params;
  },
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(combine, {
      in: { a: ctx.input('a'), b: ctx.input('b'), mask: ctx.input('mask') },
      out: { out },
      params: { mode: ctx.enumIndex('mode'), strength: ctx.params.strength },
    });
    ctx.output('out', out);
  },
});
