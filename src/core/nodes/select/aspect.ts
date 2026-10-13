// src/core/nodes/select/aspect.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

/** A tangent no slope reaches, for a threshold at or beyond 90 degrees: finite, as a kernel param has to be. */
const NEVER = 1e30;

const facing = defineKernel({
  name: 'select/aspect',
  inputs: { height: 'field' },
  outputs: { out: 'field' },
  // dir: the unit vector of the direction. spread, lo and feather in radians; tanLo and tanFull are the slopes
  // at which a slope begins to count and counts in full (engine.md 4.5 rule 2).
  params: { dir: 'vec2f', spread: 'f32', tanLo: 'f32', tanFull: 'f32', lo: 'f32', feather: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let gradient = slopeAt(height, px);
  let slope = length(gradient);
  var v = 0.0;
  // Level ground faces nowhere, and neither does ground no steeper than the lower slope.
  if (slope > 0.0 && slope > P.tanLo) {
    // A slope faces the way it falls: the horizontal part of its normal, which is against the gradient.
    let down = -gradient / slope;
    // The angle between that and the direction, 0 to pi: atan2 of the cross and the dot product keeps its
    // precision where the two all but agree, which acos does not.
    let turn = abs(atan2(down.x * P.dir.y - down.y * P.dir.x, dot(down, P.dir)));
    if (turn < P.spread) {
      v = selectShape_ease(1.0 - turn / P.spread);
      // Only the slopes of the feather need their angle; with a feather of 0 there are none.
      if (slope < P.tanFull) { v *= selectShape_ease((atan(slope) - P.lo) / P.feather); }
    }
  }
  return selectShape_flip(v, P.invert);
}`,
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export default defineNode({
  type: 'select/aspect',
  title: 'Aspect',
  category: 'select',
  description: 'Selects the slopes that face a direction, most where they face it squarely and none beyond a spread to either side.',
  keywords: ['facing', 'orientation', 'compass', 'direction', 'north', 'south', 'windward', 'leeward'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.angle({ default: 180, help: 'The direction the selected slopes face, as seen from above: 0 faces +X, and larger values turn clockwise.' }),
    {
      kind: 'float', name: 'spread', label: 'Spread', unit: 'angle', default: 60, min: 0, max: 180,
      help: 'How far a slope may turn away from the direction before it is left out: larger values select a wider fan of slopes.',
    },
    param.slope('slopeMin', { label: 'Lower slope', default: 10, help: 'Ground no steeper than this faces nowhere and is left out.' }),
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'angle', default: 10, min: 0, max: 45,
      help: 'Larger values bring slopes in more gradually above the lower slope.',
    },
    param.radius({ help: 'Smooths the terrain before its slopes are measured: larger values follow the broad shape and ignore small detail.' }),
    invert,
  ],
  kernels: [facing],
  evaluate(ctx) {
    const { angle, spread, slopeMin, feather, radius } = ctx.params;
    const direction = radians(angle);
    const lo = radians(slopeMin);
    const soft = radians(feather);
    const height = ops.smooth(ctx, ctx.input('in'), Math.max(radius, 0));   // soft: any finite number can arrive
    const out = ctx.alloc('field');
    ctx.run(facing, {
      in: { height },
      out: { out },
      params: {
        dir: [Math.cos(direction), Math.sin(direction)],
        spread: radians(spread),
        tanLo: Math.tan(lo),           // Math.tan of 90 degrees is 1.6e16, not infinite: a slope no texel reaches
        tanFull: lo + soft >= Math.PI / 2 ? NEVER : Math.tan(lo + soft),
        lo, feather: soft, invert: ctx.params.invert,
      },
    });
    ctx.release(height);
    ctx.output('out', out);
  },
});
