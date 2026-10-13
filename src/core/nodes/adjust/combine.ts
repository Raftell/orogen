// src/core/nodes/adjust/combine.ts
import { MASK_INPUT, convert, defineKernel, defineNode, param } from '../../api.ts';
import { adjust, type Kind } from './_wgsl.ts';

// One variant for each pair of kinds. The result has the kind of `a`; a `b` of the other kind is read as the
// evaluator would convert it (the core library `convert`). val_t is what the blend works on: a height, or the red, green and blue of a color.
const VALUE = { field: 'f32', color: 'vec3f' } as const;
const READ_A = { field: 'a_at(px)', color: 'a_at(px).rgb' } as const;
const READ_B = {
  field: { field: 'b_at(px)', color: 'convert_luma(b_at(px))' },
  color: { field: 'vec3f(b_at(px))', color: 'b_at(px).rgb' },
} as const;
const STORE = { field: 'adjust_field(v)', color: 'adjust_color(v, a_at(px).a)' } as const;
const BLEND = { field: 'adjust_blend', color: 'adjust_blend3' } as const;

const combine = (kind: Kind, other: Kind) => defineKernel({
  name: `adjust/combine#${kind}-${other}`,
  inputs: { a: kind, b: other, mask: MASK_INPUT },   // the node's own mask: reads 1 when unconnected, saturated on read
  outputs: { out: kind },
  params: { mode: 'u32', strength: 'f32', smoothness: 'f32' },
  includes: [adjust, convert],
  cost: 3,
  code: /* wgsl */ `
alias val_t = ${VALUE[kind]};

// What a smooth maximum stands above the higher of its two operands, and a smooth minimum below the lower:
// a cubic in how near the two are, a sixth of the smoothness where they are equal and 0 where they differ by
// the smoothness or more. It joins the two surfaces without a step in slope or in curvature, and it is the
// same whichever operand comes first.
fn seam(x: val_t, y: val_t) -> val_t {
  if (P.smoothness <= 0.0) { return val_t(0.0); }
  let h = max(val_t(P.smoothness) - abs(x - y), val_t(0.0)) / P.smoothness;
  return h * h * h * (P.smoothness / 6.0);
}

// Every mode is defined for every pair of finite values: none of them clamps or divides.
fn combined(x: val_t, y: val_t) -> val_t {
  var r = y;                                            // 0: mix
  switch (P.mode) {                                     // the index of the option, in the order the node lists them
    case 1u: { r = x + y; }
    case 2u: { r = x - y; }
    case 3u: { r = x * y; }
    case 4u: { r = 1.0 - (1.0 - x) * (1.0 - y); }       // screen
    case 5u: {                                          // overlay: multiply below one half of a, screen above; the two meet at b
      r = select(1.0 - 2.0 * (1.0 - x) * (1.0 - y), 2.0 * x * y, x < val_t(0.5));
    }
    case 6u: { r = max(x, y); }
    case 7u: { r = min(x, y); }
    case 8u: { r = abs(x - y); }
    case 9u: { r = max(x, y) + seam(x, y); }
    case 10u: { r = min(x, y) - seam(x, y); }
    default: {}
  }
  return r;
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let x: val_t = ${READ_A[kind]};
  let y: val_t = ${READ_B[kind][other]};
  let v = ${BLEND[kind]}(x, combined(x, y), P.strength * mask_at(px));
  return ${STORE[kind]};
}`,
});
const kernels = {
  field: { field: combine('field', 'field'), color: combine('field', 'color') },
  color: { field: combine('color', 'field'), color: combine('color', 'color') },
};

export default defineNode({
  type: 'adjust/combine',
  title: 'Combine',
  category: 'adjust',
  description: 'Blends two terrains or two color maps by mixing, adding, multiplying, or taking the higher or the lower with a hard or a smooth seam.',
  keywords: ['blend', 'mix', 'merge', 'composite', 'layer', 'average', 'union', 'smooth max', 'smooth min'],
  inputs: [
    { name: 'a', type: 'any' },
    { name: 'b', type: 'any' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [{ name: 'out', type: { sameAs: 'a' } }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'mix',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'mix', label: 'Mix' },
        { value: 'add', label: 'Add' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'screen', label: 'Screen' },
        { value: 'overlay', label: 'Overlay' },
        { value: 'maximum', label: 'Maximum' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'difference', label: 'Difference' },
        { value: 'smooth-maximum', label: 'Smooth maximum' },
        { value: 'smooth-minimum', label: 'Smooth minimum' },
      ],
      help: 'How the second input is combined with the first. Mix replaces the first by the second; the others compute with both.',
    },
    param.strength({
      default: 0.5,
      help: 'How much of the combination replaces the first input. Larger values show more of it; a mask scales it from place to place.',
    }),
    {
      kind: 'float', name: 'smoothness', label: 'Smoothness', unit: 'height', default: 0.1, min: 0, max: 1, soft: true,
      visibleWhen: { param: 'mode', equals: ['smooth-maximum', 'smooth-minimum'] },
      help: 'Larger values round the seam where the two inputs cross over a taller band. At 0 the seam is a crease.',
    },
  ],
  kernels: [kernels.field.field, kernels.field.color, kernels.color.field, kernels.color.color],
  evaluate(ctx) {
    const { strength, smoothness } = ctx.params;
    const a = ctx.input('a'), b = ctx.input('b');
    const out = ctx.alloc(a.kind);
    ctx.run(kernels[a.kind][b.kind], {
      in: { a, b, mask: ctx.input('mask') },
      out: { out },
      params: { mode: ctx.enumIndex('mode'), strength, smoothness: Math.max(smoothness, 0) },
    });
    ctx.output('out', out);
  },
});
