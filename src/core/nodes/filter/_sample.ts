// src/core/nodes/filter/_sample.ts
// How the resampling filters (warp, slope-warp, transform, twirl) read a picture at a position between its texels.
import { defineLib } from '../../api.ts';

/** The edge rules, as the kernels number them: what a position outside the terrain reads. */
export const EDGE = { clamp: 0, mirror: 1, repeat: 2, constant: 3 } as const;

/** Texture loads of one filterSample_cubic. */
export const CUBIC_LOADS = 16;

export const filterSample = defineLib({
  name: 'filterSample',
  code: /* wgsl */ `
// Index i of an axis whose texels are 0..last, under an edge rule. An index inside the axis is itself under every
// rule, so that a picture read at its own vertices is that picture. Mirror turns back at the border vertices
// without repeating them; repeat has the period of the terrain, on which vertex 0 and vertex last are one place.
fn filterSample_index(i: i32, last: i32, edge: u32) -> i32 {
  if (last <= 0) { return 0; }
  if (i >= 0 && i <= last) { return i; }
  if (edge == 1u) {
    let period = 2 * last;
    let m = ((i % period) + period) % period;
    return select(m, period - m, m > last);
  }
  if (edge == 2u) { return ((i % last) + last) % last; }
  return clamp(i, 0, last);
}

// Texel i of t under an edge rule; with rule 3 a texel outside t is the value fill.
fn filterSample_tap(t: texture_2d<f32>, i: vec2i, edge: u32, fill: vec4f) -> vec4f {
  let last = vec2i(textureDimensions(t)) - vec2i(1);
  if (edge == 3u && (any(i < vec2i(0)) || any(i > last))) { return fill; }
  return ld4(t, vec2i(filterSample_index(i.x, last.x, edge), filterSample_index(i.y, last.y, edge)));
}

// The Catmull-Rom weights of the four texels around a position f of the way from the second to the third:
// (0, 1, 0, 0) at f = 0.
fn filterSample_weights(f: f32) -> vec4f {
  let f2 = f * f;
  let f3 = f2 * f;
  return vec4f(-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1.0, -1.5 * f3 + 2.0 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2);
}

// t at the fractional texel position x, in t's own texels (vertex-centred: texel i is at position i): the
// Catmull-Rom cubic through the 4 x 4 texels around x, limited to the range of the 2 x 2 texels x lies between.
// At a texel it returns that texel exactly. The cubic keeps slopes continuous where bilinear reading facets a
// magnified terrain; the limit removes its overshoot at a cliff or a mask's edge.
fn filterSample_cubic(t: texture_2d<f32>, x: vec2f, edge: u32, fill: vec4f) -> vec4f {
  let c = clamp(x, vec2f(-1.0e8), vec2f(1.0e8));
  let base = vec2i(floor(c));
  let f = c - floor(c);
  let wx = filterSample_weights(f.x);
  let wy = filterSample_weights(f.y);
  // Summed as differences from the texel at or just before x: a constant picture stays that constant and the
  // alpha of an opaque color stays 1, bit for bit.
  let anchor = filterSample_tap(t, base, edge, fill);
  var lo = anchor;
  var hi = anchor;
  var sum = vec4f(0.0);
  for (var j = -1; j <= 2; j++) {
    var row = vec4f(0.0);
    for (var i = -1; i <= 2; i++) {
      let v = filterSample_tap(t, base + vec2i(i, j), edge, fill);
      row += wx[i + 1] * (v - anchor);
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = min(lo, v);
        hi = max(hi, v);
      }
    }
    sum += wy[j + 1] * row;
  }
  return clamp(anchor + sum, lo, hi);
}`,
});
