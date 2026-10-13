// src/core/nodes/select/exposure.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { invert } from './_params.ts';
import { scaleKernels, smoothed } from './_scale.ts';
import { selectShape, selectTerrain } from './_wgsl.ts';

/** Half the height of the sun's disc at a softness of 1, in degrees: what the edge of a cast shadow is blurred over. */
const MAX_HALF_DISC = 15;
/** The steepest ray the march counts with, as a tangent: beyond 89.99994 degrees nothing casts a shadow anyway. */
const STEEPEST = 1e6;
/**
 * The strips a disc with a height is marched in. Whether the horizon lies below a strip, above it or inside it
 * is exact; where inside is an estimate that is too low when the ground nearest the strip's lower edge is not
 * the ground that makes the horizon, and a strip is as much of the mask as it is of the disc. Against the
 * horizon found texel by texel on ref/fbm, the mask of one strip is off by more than 0.1 on 0.2 to 11 % of
 * the texels, the more the taller the disc, and by up to 0.9; that of four on 0.14 % at most, and by up to 0.26.
 */
const STRIPS = 4;

// How shadows are found. A point is in the shadow of a sun at the elevation e when some ground towards the sun
// rises above the ray: when max over the distance s of z(p + s) - s * tan(e) exceeds z(p). That maximum over
// all s is taken in a few passes: after pass k a texel holds it over the s below 2^k steps, and the next pass
// takes the larger of that and the same of the texel 2^k steps on, lowered by 2^k steps of the ray. Thirteen
// passes of six loads reach across 8129 texels, where a march texel by texel would take thousands of loads.
//
// Two rays are followed at a time: the lower and the upper edge of a strip of the sun's disc. A point above
// both sees the whole strip and one below the upper sees none of it, exactly; between them the lower ray keeps
// the distance of the ground that hides it, which gives the angle of the horizon and with it the share of the
// strip that is seen. A disc taller than one strip is marched strip by strip, and the shares add up.

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

// The share of one strip of the disc a texel sees, added to the shares of the strips below it.
const gather = defineKernel({
  name: 'select/exposure.gather',
  inputs: { height: 'field', ray: 'vec2', top: 'field' },
  inPlace: { seen: 'field' },
  // tanLo: the tangent of the lower edge of the strip; lo and hi: its two edges in radians. weight: the strip's
  // share of the disc.
  params: { tanLo: 'f32', lo: 'f32', hi: 'f32', weight: 'f32' },
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let z = height_at(px) * frame.heightRange;
  let lower = ray_at(px);
  var share = 1.0;
  if (top_at(px) > z) {
    share = 0.0;
  } else if (lower.x > z && lower.y > 0.0) {
    // Only the texels whose horizon lies inside the strip need an angle: that of the ground hiding its lower
    // edge. A strip of no height has no inside; nothing is divided by it.
    share = 0.0;
    if (P.hi > P.lo) { share = saturate((P.hi - atan(P.tanLo + (lower.x - z) / lower.y)) / (P.hi - P.lo)); }
  }
  return Out(cur.seen + P.weight * share);
}`,
});

const light = defineKernel({
  name: 'select/exposure',
  inputs: { height: 'field' },
  // seen: the share of the sun's disc the texel sees; it becomes the mask.
  inPlace: { seen: 'field' },
  // sun: the unit vector towards the sun.
  params: { sun: 'vec3f', invert: 'u32' },
  includes: [selectShape, selectTerrain],
  cost: 6,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  // The light a surface receives is the cosine between its normal and the direction of the sun, from physical slopes.
  let g = selectTerrain_gradient(height, height_res(), px);
  let facing = dot(normalize(vec3f(-g.x, -g.y, 1.0)), P.sun);
  var lit = 0.0;
  if (facing > 0.0) { lit = facing * selectShape_ease(cur.seen); }
  return Out(selectShape_flip(lit, P.invert));
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
    param.radius({ help: 'Smooths the terrain before it is lit: larger values light the broad shape and ignore small detail.' }),
    invert,
  ],
  kernels: [start, march, gather, light, ...scaleKernels],
  async evaluate(ctx) {
    const { angle, elevation, softness, radius } = ctx.params;
    const direction = radians(angle);
    const high = radians(elevation);
    const disc = radians(softness * MAX_HALF_DISC);
    const lo = high - disc, hi = high + disc;
    // The part of the disc below the horizontal is never seen: the rays start at the horizontal at the lowest.
    const from = Math.max(lo, 0);
    const strips = hi > from ? STRIPS : 1;
    const edge = (strip: number): number => from + ((hi - from) * strip) / strips;

    // One step towards the sun is a whole texel along the axis the direction mostly runs along.
    const toSun = [Math.cos(direction), Math.sin(direction)] as const;
    const major = Math.max(Math.abs(toSun[0]), Math.abs(toSun[1]));
    const step = [toSun[0] / major, toSun[1] / major] as const;
    const run = ctx.cellSize / major;

    const src = smoothed(ctx, ctx.input('in'), radius);
    // All state is allocated before the loop. The mask's own field collects the shares of the strips.
    let ray = ctx.alloc('vec2'), rayNext = ctx.alloc('vec2');
    let top = ctx.alloc('field'), topNext = ctx.alloc('field');
    const out = ctx.alloc('field', { clear: 0 });

    // Pass k of a strip looks 2^k steps ahead: together its passes cover every step across the terrain.
    const passes = Math.ceil(Math.log2(ctx.res));
    await ctx.loop(strips * passes, (i) => {
      const strip = Math.floor(i / passes), k = i % passes;
      const below = edge(strip), above = edge(strip + 1);
      if (k === 0) ctx.run(start, { in: { height: src.field }, out: { ray, top } });
      ctx.run(march, {
        in: { ray, top },
        out: { rayNext, topNext },
        params: { step, jump: 2 ** k, run, dropLo: run * tangent(below), dropHi: run * tangent(above) },
      });
      [ray, rayNext] = [rayNext, ray];
      [top, topNext] = [topNext, top];
      if (k === passes - 1) {
        ctx.run(gather, {
          in: { height: src.field, ray, top },
          rw: { seen: out },
          // A disc of no height is one strip of no height, which is all of it.
          params: { tanLo: tangent(below), lo: below, hi: above, weight: hi > lo ? (above - below) / (hi - lo) : 1 },
        });
      }
    });
    ctx.release(ray);
    ctx.release(rayNext);
    ctx.release(top);
    ctx.release(topNext);

    ctx.run(light, {
      in: { height: src.field },
      rw: { seen: out },
      params: { sun: [Math.cos(high) * toSun[0], Math.cos(high) * toSun[1], Math.sin(high)], invert: ctx.params.invert },
    });
    if (src.owned) ctx.release(src.field);
    ctx.output('out', out);
  },
});
