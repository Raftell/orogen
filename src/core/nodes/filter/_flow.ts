// src/core/nodes/filter/_flow.ts
// The direction in which the slope-driven filters (slope-blur, slope-warp, warp by a guide) move things.
import { defineLib } from '../../api.ts';

/** Below this slope, in metres per metre, ground counts as level and things on it hardly move: 8.5 degrees. */
export const GENTLE_SLOPE = 0.15;

export const filterFlow = defineLib({
  name: 'filterFlow',
  code: /* wgsl */ `
const filterFlow_GENTLE = ${GENTLE_SLOPE};

// A physical gradient g, in metres per metre, as a step: uphill, with a length that grows from 0 on level ground
// towards 1 on steep ground. A direction alone, the normalised gradient, is noise wherever the ground is level.
fn filterFlow_soft(g: vec2f) -> vec2f {
  return g / sqrt(dot(g, g) + filterFlow_GENTLE * filterFlow_GENTLE);
}

// The step at texel p of the height texture t.
fn filterFlow_at(t: texture_2d<f32>, p: vec2i) -> vec2f {
  return filterFlow_soft(slopeAt(t, p));
}

// A physical gradient g as a push: in proportion to the slope up to 45 degrees, and of length 1 beyond. Unlike
// the step above it does not turn about where a slope changes its direction, on a ridge or in a hollow, so that
// what is pushed by it stays in one piece.
fn filterFlow_push(g: vec2f) -> vec2f {
  return g / max(length(g), 1.0);
}

// The physical gradient at the fractional texel position x of t, in metres per metre: that of the bilinear surface
// through the four texels around x, so that a path can be followed between texels at 4 loads a step.
fn filterFlow_slope(t: texture_2d<f32>, x: vec2f) -> vec2f {
  let last = vec2i(textureDimensions(t)) - vec2i(1);
  let c = clamp(x, vec2f(0.0), vec2f(last));
  let i = min(vec2i(floor(c)), max(last - vec2i(1), vec2i(0)));
  let f = c - vec2f(i);
  let h00 = ld(t, i);
  let h10 = ld(t, i + vec2i(1, 0));
  let h01 = ld(t, i + vec2i(0, 1));
  let h11 = ld(t, i + vec2i(1, 1));
  let d = vec2f(mix(h10 - h00, h11 - h01, f.y), mix(h01 - h00, h11 - h10, f.x));
  let cell = frame.terrainSize / vec2f(max(last, vec2i(1)));
  return d * frame.heightRange / cell;
}`,
});
