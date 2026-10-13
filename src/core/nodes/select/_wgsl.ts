// src/core/nodes/select/_wgsl.ts
import { defineLib } from '../../api.ts';

/** How a measured quantity becomes a mask: the soft edges and the complement every node of the category shares. */
export const selectShape = defineLib({
  name: 'selectShape',
  code: /* wgsl */ `
// The smooth step of t: 0 at 0 and below, 1 at 1 and above, both exactly, and level at both ends.
fn selectShape_ease(t: f32) -> f32 {
  let x = saturate(t);
  return x * x * (3.0 - 2.0 * x);
}

// 1 from lo to hi, 0 from feather outside them, eased between. A feather of 0 is a hard edge; nothing is divided by it.
fn selectShape_band(v: f32, lo: f32, hi: f32, feather: f32) -> f32 {
  if (v >= lo && v <= hi) { return 1.0; }
  let outside = select(v - hi, lo - v, v < lo);
  if (outside >= feather) { return 0.0; }
  return selectShape_ease(1.0 - outside / feather);
}

// The mask, or its complement when invert is set. 1 - v is exact for 0 and for 1.
fn selectShape_flip(v: f32, invert: u32) -> f32 {
  let m = saturate(v);
  return select(m, 1.0 - m, invert != 0u);
}`,
});
