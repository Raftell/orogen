// src/core/nodes/select/slope.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { invert } from './_params.ts';
import { scaleKernels, smoothed } from './_scale.ts';
import { selectShape, selectTerrain } from './_wgsl.ts';

/** A tangent no slope reaches, for a threshold at or beyond 90 degrees: finite, as a kernel param has to be. */
const NEVER = 1e30;

const band = defineKernel({
  name: 'select/slope',
  inputs: { height: 'field' },
  outputs: { out: 'field' },
  // The band and the two ends of its feather as tangents; the band and the feather in radians (engine.md 4.5 rule 2).
  params: { tanBelow: 'f32', tanLo: 'f32', tanHi: 'f32', tanAbove: 'f32', lo: 'f32', hi: 'f32', feather: 'f32', invert: 'u32' },
  includes: [selectShape, selectTerrain],
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The slope is physical: metres per metre, from the terrain size and the height range.
  let slope = length(selectTerrain_gradient(height, height_res(), px));
  var v = 0.0;
  if (slope >= P.tanLo && slope <= P.tanHi) {
    v = 1.0;
  } else if (slope > P.tanBelow && slope < P.tanAbove) {
    // Only the texels of the feather need the angle. With a feather of 0 there are none: the two tests above
    // decide every slope, and nothing is divided by it.
    let angle = atan(slope);
    let outside = select(angle - P.hi, P.lo - angle, slope < P.tanLo);
    v = selectShape_ease(1.0 - outside / P.feather);
  }
  return selectShape_flip(v, P.invert);
}`,
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export default defineNode({
  type: 'select/slope',
  title: 'Slope',
  category: 'select',
  description: 'Selects the terrain whose slope lies between two angles, measured in real metres after smoothing over a radius.',
  keywords: ['steepness', 'angle', 'gradient', 'cliff', 'flat', 'incline'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.slope('slopeMin', { label: 'Lower slope', default: 40, help: 'Terrain at least this steep is fully selected.' }),
    param.slope('slopeMax', { label: 'Upper slope', default: 70, help: 'Terrain up to this steep is fully selected.' }),
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'angle', default: 5, min: 0, max: 45,
      help: 'Larger values fade the selection out over a wider margin of angles below and above the band.',
    },
    param.radius({ help: 'Smooths the terrain before its slope is measured: larger values follow the broad shape and ignore small detail.' }),
    invert,
  ],
  kernels: [band, ...scaleKernels],
  evaluate(ctx) {
    const { slopeMin, slopeMax, feather, radius } = ctx.params;
    const lo = radians(slopeMin);
    const hi = radians(Math.max(slopeMax, slopeMin));   // an upper angle below the lower one leaves a band of no width at the lower
    const soft = radians(feather);
    const src = smoothed(ctx, ctx.input('in'), radius);
    const out = ctx.alloc('field');
    ctx.run(band, {
      in: { height: src.field },
      out: { out },
      params: {
        // Below 0 degrees and from 90 upwards an end of the feather is a slope no texel has.
        tanBelow: lo - soft < 0 ? -1 : Math.tan(lo - soft),
        tanLo: Math.tan(lo),
        tanHi: Math.tan(hi),          // Math.tan of 90 degrees is 1.6e16, not infinite
        tanAbove: hi + soft >= Math.PI / 2 ? NEVER : Math.tan(hi + soft),
        lo, hi, feather: soft, invert: ctx.params.invert,
      },
    });
    if (src.owned) ctx.release(src.field);
    ctx.output('out', out);
  },
});
