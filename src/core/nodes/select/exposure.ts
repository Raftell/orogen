// src/core/nodes/select/exposure.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape, selectTerrain } from './_wgsl.ts';

/** Half the height of the sun's disc at a softness of 1, in degrees: what the edge of a cast shadow is blurred over. */
const MAX_HALF_DISC = 15;
/** The steepest ray the march counts with, as a tangent: beyond 89.99994 degrees nothing casts a shadow anyway. */
const STEEPEST = 1e6;

// How shadows are found. A point is in the shadow of a sun at the elevation e when some ground towards the sun
// rises above the ray: when max over the distance s of z(p + s) - s * tan(e) exceeds z(p). That maximum over
// all s is taken in a few passes: after pass k a texel holds it over the s below 2^k steps, and the next pass
// takes the larger of that and the same of the texel 2^k steps on, lowered by 2^k steps of the ray. Thirteen
// passes of six loads reach across 8129 texels, where a march texel by texel would take thousands of loads.
//
// Two rays are followed: the lower and the upper edge of the sun's disc. A point above both is lit and one
// below the upper is dark, exactly; between them the lower ray keeps the distance of the ground that hides it,
// which gives the angle of the horizon and with it the share of the disc that is seen.

const start = defineKernel({
  name: 'select/exposure.start',
  inputs: { height: 'field' },
  // ray: the height of the lower ray's shadow in metres, and the distance in metres of the ground that casts it.
  // top: the height of the upper ray's shadow.
  outputs: { ray: 'vec2', top: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let z = height_at(px) * frame.heightRange;
  return Out(vec2f(z, 0.0), z);
}`,
});

const march = defineKernel({
  name: 'select/exposure.march',
  inputs: { ray: 'vec2', top: 'field' },
  outputs: { rayNext: 'vec2', topNext: 'field' },
  // step: one step towards the sun in texels, a whole texel along the axis it mostly runs along. jump: how many
  // steps this pass looks ahead. run: metres per step. dropLo, dropHi: metres the two rays fall per step.
  params: { step: 'vec2f', jump: 'f32', run: 'f32', dropLo: 'f32', dropHi: 'f32' },
  cost: 6,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  var best = ray_at(px);
  var high = top_at(px);
  let q = vec2f(px) + P.step * P.jump;
  // Beyond the terrain there is no ground to cast a shadow.
  if (all(q >= vec2f(0.0)) && all(q <= vec2f(ray_res()) - vec2f(1.0))) {
    // Along one axis q is a whole texel; along the other it lies between two, whose values are interpolated.
    let whole = floor(q);
    let part = q - whole;
    let a = vec2i(whole);
    let b = a + vec2i(part > vec2f(0.0));
    let t = max(part.x, part.y);
    let far = mix(ray_at(a), ray_at(b), t);
    let lifted = far.x - P.jump * P.dropLo;
    if (lifted > best.x) { best = vec2f(lifted, far.y + P.jump * P.run); }
    high = max(high, mix(top_at(a), top_at(b), t) - P.jump * P.dropHi);
  }
  return Out(best, high);
}`,
});

const light = defineKernel({
  name: 'select/exposure',
  inputs: { height: 'field', ray: 'vec2', top: 'field' },
  outputs: { out: 'field' },
  // sun: the unit vector towards the sun. tanLo: the tangent of the lower edge of its disc; lo and hi: the two
  // edges in radians.
  params: { sun: 'vec3f', tanLo: 'f32', lo: 'f32', hi: 'f32', invert: 'u32' },
  includes: [selectShape, selectTerrain],
  cost: 8,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The light a surface receives is the cosine between its normal and the direction of the sun, from physical slopes.
  let g = selectTerrain_gradient(height, height_res(), px);
  let facing = dot(normalize(vec3f(-g.x, -g.y, 1.0)), P.sun);
  var lit = 0.0;
  if (facing > 0.0) {
    let z = height_at(px) * frame.heightRange;
    let lower = ray_at(px);
    var seen = 1.0;
    if (top_at(px) > z) {
      seen = 0.0;
    } else if (lower.x > z && lower.y > 0.0) {
      // Only the texels in the half-shadow need an angle: that of the ground hiding the lower edge of the disc.
      // A disc of no height has no half-shadow; nothing is divided by it.
      seen = 0.0;
      if (P.hi > P.lo) { seen = selectShape_ease((P.hi - atan(P.tanLo + (lower.x - z) / lower.y)) / (P.hi - P.lo)); }
    }
    lit = facing * seen;
  }
  return selectShape_flip(lit, P.invert);
}`,
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const tangent = (angle: number): number => (angle >= Math.PI / 2 ? STEEPEST : Math.max(Math.min(Math.tan(angle), STEEPEST), -STEEPEST));

export default defineNode({
  type: 'select/exposure',
  title: 'Exposure',
  category: 'select',
  description: 'Selects the ground a sun at a given direction and elevation lights, by how squarely it is lit and with cast shadows.',
  keywords: ['sunlight', 'insolation', 'shadow', 'shade', 'light', 'sun', 'illumination', 'hillshade'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.angle({ default: 180, help: 'The direction from the terrain towards the sun, as seen from above: 0 is +X, and larger values turn clockwise.' }),
    {
      kind: 'float', name: 'elevation', label: 'Elevation', unit: 'angle', default: 30, min: 0, max: 90,
      help: 'The height of the sun above the horizon: larger values shorten the shadows and light level ground more.',
    },
    {
      kind: 'float', name: 'softness', label: 'Softness', unit: 'ratio', default: 0.2, min: 0, max: 1,
      help: 'Larger values blur the edges of cast shadows more, as a wider sun does, and more the farther the shadow falls.',
    },
    invert,
  ],
  kernels: [start, march, light],
  async evaluate(ctx) {
    const { angle, elevation, softness } = ctx.params;
    const src = ctx.input('in');
    const direction = radians(angle);
    const high = radians(elevation);
    const disc = radians(softness * MAX_HALF_DISC);
    const lo = high - disc, hi = high + disc;

    // One step towards the sun is a whole texel along the axis the direction mostly runs along.
    const toSun = [Math.cos(direction), Math.sin(direction)] as const;
    const major = Math.max(Math.abs(toSun[0]), Math.abs(toSun[1]));
    const step = [toSun[0] / major, toSun[1] / major] as const;
    const run = ctx.cellSize / major;

    // All state is allocated before the loop.
    let ray = ctx.alloc('vec2'), rayNext = ctx.alloc('vec2');
    let top = ctx.alloc('field'), topNext = ctx.alloc('field');
    const out = ctx.alloc('field');
    ctx.run(start, { in: { height: src }, out: { ray, top } });

    // Pass k looks 2^k steps ahead: together the passes cover every step across the terrain.
    const passes = Math.ceil(Math.log2(ctx.res));
    await ctx.loop(passes, (k) => {
      ctx.run(march, {
        in: { ray, top },
        out: { rayNext, topNext },
        params: { step, jump: 2 ** k, run, dropLo: run * tangent(lo), dropHi: run * tangent(hi) },
      });
      [ray, rayNext] = [rayNext, ray];
      [top, topNext] = [topNext, top];
    });
    ctx.release(rayNext);
    ctx.release(topNext);

    ctx.run(light, {
      in: { height: src, ray, top },
      out: { out },
      params: {
        sun: [Math.cos(high) * toSun[0], Math.cos(high) * toSun[1], Math.sin(high)],
        tanLo: tangent(lo), lo, hi, invert: ctx.params.invert,
      },
    });
    ctx.release(ray);
    ctx.release(top);
    ctx.output('out', out);
  },
});
