// src/core/nodes/color/_wgsl.ts
// What the kernels of this category share: the limit a stored color keeps.
import { defineLib } from '../../api.ts';

export const colorStore = defineLib({
  name: 'colorStore',
  code: /* wgsl */ `
const colorStore_HALF = 65504.0;   // the largest value a channel of a color holds: beyond it the stored half float is infinite

// The channels as a color stores them: finite, whatever the inputs and the parameters were.
fn colorStore_rgba(c: vec4f) -> vec4f { return clamp(c, vec4f(-colorStore_HALF), vec4f(colorStore_HALF)); }
fn colorStore_rgb(rgb: vec3f, alpha: f32) -> vec4f { return colorStore_rgba(vec4f(rgb, alpha)); }
`,
});
