// src/core/nodes/adjust/switch.ts
import { convert, defineKernel, defineNode } from '../../api.ts';

// The output has the kind of `a`. A chosen input of the other kind is read as the evaluator would convert it.
const grey = defineKernel({
  name: 'adjust/switch#grey',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  includes: [convert],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  return convert_grey(src_at(px));
}`,
});

const luma = defineKernel({
  name: 'adjust/switch#luma',
  inputs: { src: 'color' },
  outputs: { out: 'field' },
  includes: [convert],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return convert_luma(src_at(px));
}`,
});

export default defineNode({
  type: 'adjust/switch',
  title: 'Switch',
  category: 'adjust',
  description: 'Passes one of up to four inputs through unchanged, so that variants of a terrain can be compared by flipping one setting.',
  keywords: ['select', 'choose', 'toggle', 'variant', 'route', 'compare'],
  inputs: [
    { name: 'a', type: 'any' },
    { name: 'b', type: 'any', optional: true },
    { name: 'c', type: 'any', optional: true },
    { name: 'd', type: 'any', optional: true },
  ],
  outputs: [{ name: 'out', type: { sameAs: 'a' } }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Input', default: 'a',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
        { value: 'd', label: 'D' },
      ],
      help: 'Which input is passed through. An input with nothing connected passes the first input instead.',
    },
  ],
  kernels: [grey, luma],
  evaluate(ctx) {
    const a = ctx.input('a');
    const chosen = ctx.input(ctx.params.mode) ?? a;
    // The chosen input itself is the output: no texture, no pass.
    if (chosen.kind === a.kind) {
      ctx.output('out', chosen);
      return;
    }
    if (chosen.kind === 'field') {
      const out = ctx.alloc('color');
      ctx.run(grey, { in: { src: chosen }, out: { out } });
      ctx.output('out', out);
    } else {
      const out = ctx.alloc('field');
      ctx.run(luma, { in: { src: chosen }, out: { out } });
      ctx.output('out', out);
    }
  },
});
