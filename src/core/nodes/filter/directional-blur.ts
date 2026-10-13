// src/core/nodes/filter/directional-blur.ts
import { defineKernel, defineNode, param, type Field } from '../../api.ts';

const MAX_TAPS = 15;                 // on each side of the centre, two loads each: 61 loads per pass, within the 64 of engine.md 3.15
/** The widest Gaussian one pass holds, in steps between its taps: weights beyond 3 sigma are dropped. */
const MAX_SIGMA = MAX_TAPS / 3;

// One pass of a Gaussian along a line. The taps lie a whole number of texels apart along the axis the line is
// nearer to and are read between the two texels the line passes there: two loads a tap, and none of the blur
// across the line that reading between four texels would add.
//
// The border: beyond it the picture continues as its mirror image, and the line runs on into that. A tap moves
// into the mirror image evenly as the texel nears the border, so that no row or column of a border differs from
// the next by where its line was cut. Repeating the border texel instead gives it the weight of everything
// beyond it, in every pass of a wide blur again.
const pass = (kind: 'field' | 'color') => defineKernel({
  name: `filter/directional-blur.pass#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  // major, minor: the unit steps along the two axes; lean: texels along minor per texel along major, within -1..1.
  params: { major: 'vec2i', minor: 'vec2i', lean: 'f32', stride: 'i32', taps: 'i32', falloff: 'f32' },
  cost: 4 * MAX_TAPS + 1,
  code: /* wgsl */ `
const MAX_TAPS = ${MAX_TAPS};

// The texel i of an axis whose texels are 0..last, mirrored into it at the border texels, which are not repeated.
fn mirrored(i: i32, last: i32) -> i32 {
  if (last <= 0) { return 0; }
  let period = 2 * last;
  var k = i % period;
  if (k < 0) { k += period; }
  return select(k, period - k, k > last);
}

// The same for a position between texels.
fn mirroredBetween(v: f32, last: f32) -> f32 {
  if (last <= 0.0) { return 0.0; }
  let period = 2.0 * last;
  let k = v - period * floor(v / period);
  return select(k, period - k, k > last);
}

// The picture on the line, step texels along the major axis from px.
fn along(px: vec2i, step: i32) -> out_t {
  let last = i32(frame.res.x) - 1;
  let across = mirroredBetween(f32(dot(px, P.minor)) + f32(step) * P.lean, f32(last));
  let whole = floor(across);
  let p = mirrored(dot(px, P.major) + step, last) * P.major + i32(whole) * P.minor;
  return mix(src_at(p), src_at(p + P.minor), across - whole);
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let taps = clamp(P.taps, 0, MAX_TAPS);
  let centre = src_at(px);
  // Summed as differences from the centre: a constant stays that constant and an opaque color opaque.
  var sum = out_t(0.0);
  var weight = 1.0;
  for (var i = 1; i <= taps; i++) {
    let w = exp(-P.falloff * f32(i * i));
    let step = i * P.stride;
    sum += w * ((along(px, -step) - centre) + (along(px, step) - centre));
    weight += 2.0 * w;
  }
  return centre + sum / weight;
}`,
});
const passes = { field: pass('field'), color: pass('color') };

interface Pass { readonly stride: number; readonly sigma: number }   // texels between taps along the major axis; sigma in taps

/**
 * The passes that together are the Gaussian of `sigma` texels along a line whose taps are `spacing` texels apart
 * at a stride of 1, finest first. Variances add. A pass with a stride above 1 reads a picture that the passes
 * before it have blurred along the line by half its stride, which removes what its taps would otherwise skip;
 * it supplies the rest of the variance and holds up to MAX_SIGMA of its own steps. Each pass is ten times as
 * wide as the one before: four are enough for any radius at 8129.
 */
function plan(sigma: number, spacing: number): Pass[] {
  const out: Pass[] = [];
  let left = sigma;
  for (let guard = 0; guard < 16; guard++) {
    const stride = Math.ceil(left / (MAX_SIGMA * spacing) - 1e-9);
    if (stride <= 1) {
      out.unshift({ stride: 1, sigma: left / spacing });
      break;
    }
    const before = (stride * spacing) / 2;
    out.unshift({ stride, sigma: Math.sqrt(left * left - before * before) / (stride * spacing) });
    left = before;
  }
  return out;
}

export default defineNode({
  type: 'filter/directional-blur',
  title: 'Directional Blur',
  category: 'filter',
  description: 'Blurs a terrain or a color map along one direction, which draws its features out into streaks.',
  keywords: ['motion blur', 'streak', 'linear', 'wind'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    param.radius({ default: 0.02, help: 'Larger values draw the features out into longer streaks.' }),
    param.angle({ help: 'The direction of the streaks. Larger values turn it clockwise in the top view.' }),
  ],
  kernels: [passes.field, passes.color],
  maskable: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const sigma = ctx.lengthToPx(Math.min(Math.max(ctx.params.radius, 0), 4));   // soft: any finite number can arrive

    // The line is stepped along the axis it is nearer to; `lean` is how far it moves along the other per step.
    const r = (ctx.params.angle * Math.PI) / 180;
    const dx = Math.cos(r), dy = Math.sin(r);
    const alongX = Math.abs(dx) >= Math.abs(dy);
    // Math.sin of 180 degrees is 1e-16, not 0: a line that close to an axis is the row or the column.
    const ratio = alongX ? dy / dx : dx / dy;
    const lean = Math.abs(ratio) < 1e-9 ? 0 : ratio;
    const axes = alongX ? { major: [1, 0], minor: [0, 1] } as const : { major: [0, 1], minor: [1, 0] } as const;
    const spacing = Math.hypot(1, lean);

    // The radius is the standard deviation, and weights beyond three of them are dropped: with no tap that near,
    // the blur changes nothing and the input itself is the output.
    const steps = plan(sigma, spacing).filter((step) => Math.floor(3 * step.sigma) >= 1);
    if (steps.length === 0) {
      ctx.output('out', src);
      return;
    }

    const targets = [ctx.alloc(src.kind), steps.length > 1 ? ctx.alloc(src.kind) : null];
    let current: Field<'field'> | Field<'color'> = src;
    await ctx.loop(steps.length, (i) => {
      const step = steps[i]!;
      const taps = Math.min(Math.floor(3 * step.sigma), MAX_TAPS);
      const out = targets[i % 2]!;
      ctx.run(passes[src.kind], {
        in: { src: current },
        out: { out },
        params: { ...axes, lean, stride: step.stride, taps, falloff: 1 / (2 * step.sigma * step.sigma) },
        cost: 4 * taps + 1,
      });
      current = out;
    });
    for (const target of targets) if (target && target !== current) ctx.release(target);
    ctx.output('out', current);
  },
});
