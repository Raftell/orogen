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

/** The terrain's shape as the nodes of the category measure it. */
export const selectTerrain = defineLib({
  name: 'selectTerrain',
  code: /* wgsl */ `
// The derivative at a sample from itself and the next two samples on one side: the one-sided difference of
// second order, in steps of one sample.
fn selectTerrain_oneSided(a: f32, b: f32, c: f32) -> f32 {
  return 0.5 * (4.0 * b - 3.0 * a - c);
}

// Gradient (dz/dx, dz/dy) of the height texture t of the given size at texel p, in metres per metre: slopeAt,
// but of second order on the border too. The one-sided difference slopeAt takes there is wrong by half a cell
// of the terrain's bend, twice as much at one level of the ladder as at the next, and a mask would differ along
// every border between a preview and a build.
fn selectTerrain_gradient(t: texture_2d<f32>, size: vec2u, p: vec2i) -> vec2f {
  let last = vec2i(size) - vec2i(1);
  let q = clamp(p, vec2i(0), last);
  let x = vec2i(1, 0);
  let y = vec2i(0, 1);
  let c = ld(t, q);
  var d = vec2f(0.0);
  if (last.x < 2) {
    d.x = (ld(t, vec2i(last.x, q.y)) - ld(t, vec2i(0, q.y))) / f32(max(last.x, 1));
  } else if (q.x == 0) {
    d.x = selectTerrain_oneSided(c, ld(t, q + x), ld(t, q + 2 * x));
  } else if (q.x == last.x) {
    d.x = -selectTerrain_oneSided(c, ld(t, q - x), ld(t, q - 2 * x));
  } else {
    d.x = 0.5 * (ld(t, q + x) - ld(t, q - x));
  }
  if (last.y < 2) {
    d.y = (ld(t, vec2i(q.x, last.y)) - ld(t, vec2i(q.x, 0))) / f32(max(last.y, 1));
  } else if (q.y == 0) {
    d.y = selectTerrain_oneSided(c, ld(t, q + y), ld(t, q + 2 * y));
  } else if (q.y == last.y) {
    d.y = -selectTerrain_oneSided(c, ld(t, q - y), ld(t, q - 2 * y));
  } else {
    d.y = 0.5 * (ld(t, q + y) - ld(t, q - y));
  }
  return d * frame.heightRange * vec2f(max(last, vec2i(1))) / frame.terrainSize;
}`,
});
