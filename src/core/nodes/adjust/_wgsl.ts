// src/core/nodes/adjust/_wgsl.ts
// What the kernels of this category share: the limits a stored value keeps and the blend whose two ends are exact.
import { defineLib } from '../../api.ts';

/** The kinds a node of type `any` serves: one kernel variant for each. */
export type Kind = 'field' | 'color';

export const adjust = defineLib({
  name: 'adjust',
  code: /* wgsl */ `
const adjust_BIG = 3.4028234e38;   // the largest value a field holds
const adjust_HALF = 65504.0;       // the largest value a channel of a color holds: beyond it the stored half float is infinite

// A result as a field stores it: finite, whatever the parameters and the inputs were.
fn adjust_field(v: f32) -> f32 { return clamp(v, -adjust_BIG, adjust_BIG); }
// The three channels as a color stores them, with the alpha given.
fn adjust_color(rgb: vec3f, alpha: f32) -> vec4f {
  return vec4f(clamp(rgb, vec3f(-adjust_HALF), vec3f(adjust_HALF)), alpha);
}

// mix(a, r, t) whose two ends are selected: a device may evaluate mix as a + t * (r - a), which is not r at
// t = 1. No strength leaves a and full strength gives r, bit for bit.
fn adjust_blend(a: f32, r: f32, t: f32) -> f32 { return select(select(mix(a, r, t), r, t >= 1.0), a, t <= 0.0); }
fn adjust_blend3(a: vec3f, r: vec3f, t: f32) -> vec3f { return select(select(mix(a, r, vec3f(t)), r, t >= 1.0), a, t <= 0.0); }
`,
});

/**
 * The `compute` of a kernel with the input `src` and one output of the same kind that applies the kernel's own
 * `fn shape(x: f32) -> f32` to every value: to a height, or to the red, green and blue of a color, whose alpha
 * passes through.
 */
export const perChannel = (kind: Kind): string => (kind === 'field'
  ? /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return adjust_field(shape(src_at(px)));
}`
  : /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let c = src_at(px);
  return adjust_color(vec3f(shape(c.r), shape(c.g), shape(c.b)), c.a);
}`);
