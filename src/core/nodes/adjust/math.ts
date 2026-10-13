// src/core/nodes/adjust/math.ts
import { defineKernel, defineNode } from '../../api.ts';
import { adjust } from './_wgsl.ts';

const math = defineKernel({
  name: 'adjust/math',
  inputs: { src: 'field', b: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  params: { mode: 'u32', value: 'f32' },
  includes: [adjust],
  cost: 2,
  code: /* wgsl */ `
// The remainder that has the sign of the divisor: for a divisor above 0 a sawtooth from 0 up to the divisor,
// through negative values too. 0 for a divisor of 0. It never leaves the band between 0 and the divisor, also
// where the height is so many divisors that their number is no float.
fn modulo(v: f32, w: f32) -> f32 {
  if (w == 0.0) { return 0.0; }
  return clamp(v - w * floor(v / w), min(w, 0.0), max(w, 0.0));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let v = src_at(px);
  // The second operand: the second input where one is connected, the constant otherwise.
  var w = P.value;
  if (b_bound()) { w = b_at(px); }
  var r = v + w;                                        // 0: add
  switch (P.mode) {                                     // the index of the option, in the order the node lists them
    case 1u: { r = v - w; }
    case 2u: { r = v * w; }
    case 3u: {                                          // divide: 0 where the divisor is 0
      r = 0.0;
      if (w != 0.0) { r = v / w; }
    }
    case 4u: {                                          // power: of the magnitude, with the sign of the value kept
      r = 0.0;
      if (v != 0.0) { r = sign(v) * pow(abs(v), w); }
    }
    case 5u: { r = abs(v - w); }
    case 6u: { r = min(v, w); }
    case 7u: { r = max(v, w); }
    case 8u: { r = modulo(v, w); }
    case 9u: {                                          // fold: back and forth between 0 and the magnitude of the operand
      // The pattern is the same on both sides of 0, so it is read from the magnitude of the height: within the
      // first rise that is the height itself, bit for bit, however large the operand. Twice the operand is the
      // period, kept a float.
      let period = 2.0 * min(abs(w), 1.7e38);
      let up = modulo(abs(v), period);
      r = min(up, period - up);
    }
    default: {}
  }
  return adjust_field(r);
}`,
});

export default defineNode({
  type: 'adjust/math',
  title: 'Math',
  category: 'adjust',
  description: 'Applies one arithmetic operation to every height, with a constant or with a second terrain as the other operand.',
  keywords: ['arithmetic', 'add', 'multiply', 'scale', 'offset', 'power', 'modulo', 'abs', 'ping-pong'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'b', type: 'field', optional: true, label: 'Operand' },
  ],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Operation', default: 'multiply',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'add', label: 'Add' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'divide', label: 'Divide' },
        { value: 'power', label: 'Power' },
        { value: 'absolute', label: 'Absolute difference' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'maximum', label: 'Maximum' },
        { value: 'modulo', label: 'Modulo' },
        { value: 'fold', label: 'Fold' },
      ],
      help: 'What is done with each height and the operand. Dividing by 0 gives 0, a power keeps the sign of a negative height, and Fold bounces heights between 0 and the operand.',
    },
    {
      kind: 'float', name: 'value', label: 'Value', unit: 'none', default: 0.5, min: -2, max: 2, soft: true,
      help: 'The operand where no second input is connected: what is added, the factor, the divisor, the exponent or the level compared with.',
    },
  ],
  kernels: [math],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(math, {
      in: { src: ctx.input('in'), b: ctx.input('b') },
      out: { out },
      params: { mode: ctx.enumIndex('mode'), value: ctx.params.value },
    });
    ctx.output('out', out);
  },
});
