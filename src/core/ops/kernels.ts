import { FieldAccessError } from '../gpu/errors.ts';
import { CHANNELS, type Field, type FieldKind } from '../gpu/field.ts';
import { defineKernel, MASK_INPUT, type AnyKernel } from '../gpu/kernel.ts';

// ---- copy ----------------------------------------------------------------------------------------------------------

const copyKernel = (kind: FieldKind) => defineKernel({
  name: `ops/copy#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  return src_at(px);
}`,
});
export const copyKernels = {
  field: copyKernel('field'), vec2: copyKernel('vec2'), color: copyKernel('color'), aux: copyKernel('aux'),
  half: copyKernel('half'), half2: copyKernel('half2'), mask8: copyKernel('mask8'),
};

// ---- resample ------------------------------------------------------------------------------------------------------

/** P.shape of the resample kernel. */
export const RESAMPLE_SHAPE = { nearest: 0, tent: 1, bspline: 2 } as const;
/** The kernel reads the source texels from 1 - reach to reach around the mapped position: at most 8 per axis, 64 per texel. */
export const RESAMPLE_MAX_REACH = 4;

const resampleKernel = (kind: 'field' | 'color') => defineKernel({
  name: `ops/resample#${kind}`,
  inputs: { src: { kind, size: 'any' } },
  outputs: { out: kind },
  // ring: 1 in x when the source, in y when the written grid, carries one texel more on every side than the
  // terrain has vertices (resample.ts).
  params: { shape: 'u32', width: 'vec2f', reach: 'vec2i', ring: 'vec2i' },
  cost: 16,
  code: /* wgsl */ `
const MAX_REACH = ${RESAMPLE_MAX_REACH};

// Weight of the source texel at distance d from the mapped position, for a filter of scale w in source texels:
// the triangle of half-width w, or with shape 2 the cubic B-spline of knot spacing w.
fn weight(d: f32, w: f32) -> f32 {
  let x = abs(d) / max(w, 1.0);
  if (P.shape == 2u) {
    if (x >= 2.0) { return 0.0; }
    if (x >= 1.0) { return (2.0 - x) * (2.0 - x) * (2.0 - x) / 6.0; }
    return 2.0 / 3.0 - x * x * (1.0 - 0.5 * x);
  }
  return max(1.0 - x, 0.0);
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  // The mapped position vertex * (source vertices - 1) / (written vertices - 1) as an integer quotient and
  // remainder: a float quotient is not exact on every device, and a shared vertex must land on its source texel
  // exactly. The division rounds down: a texel of a ring lies before the first vertex.
  let srcLast = vec2i(src_res()) - vec2i(1 + 2 * P.ring.x);
  let dstLast = max(vec2i(frame.res) - vec2i(1 + 2 * P.ring.y), vec2i(1));
  let num = (px - vec2i(P.ring.y)) * srcLast;
  let quotient = num / dstLast;
  let below = vec2i(num - quotient * dstLast < vec2i(0));
  let base = quotient - below + vec2i(P.ring.x);
  let rem = num - (quotient - below) * dstLast;
  if (P.shape == 0u) {
    return src_at(base + vec2i(2 * rem >= dstLast));
  }
  let at = vec2f(rem) / vec2f(dstLast);
  let reach = clamp(P.reach, vec2i(1), vec2i(MAX_REACH));
  // Summed as differences from the texel at or just below the mapped position, which always has a positive
  // weight: a constant field stays that constant and the alpha of an opaque color stays 1, bit for bit. A sum
  // divided by its own weight does not come out exact on every device.
  let anchor = src_at(base);
  var sum = out_t(0.0);
  var norm = 0.0;
  for (var j = 1 - reach.y; j <= reach.y; j++) {
    let wy = weight(f32(j) - at.y, P.width.y);
    if (wy <= 0.0) { continue; }
    for (var i = 1 - reach.x; i <= reach.x; i++) {
      let w = wy * weight(f32(i) - at.x, P.width.x);
      if (w <= 0.0) { continue; }
      sum += w * (src_at(base + vec2i(i, j)) - anchor);
      norm += w;
    }
  }
  return anchor + sum / norm;
}`,
});
export const resampleKernels = { field: resampleKernel('field'), color: resampleKernel('color') };

// ---- blur ----------------------------------------------------------------------------------------------------------

/** Taps on either side of the centre in one pass of the blur kernel: 63 loads per texel. */
export const BLUR_MAX_RADIUS = 31;

const blurKernel = (kind: 'field' | 'color') => defineKernel({
  name: `ops/blur#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { dir: 'vec2i', radius: 'i32', falloff: 'f32' },
  cost: 2 * BLUR_MAX_RADIUS + 1,
  code: /* wgsl */ `
const MAX_RADIUS = ${BLUR_MAX_RADIUS};

// One axis of a Gaussian: weights exp(-falloff * k * k) for |k| <= radius, renormalised. Reads clamp to the border.
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let radius = clamp(P.radius, 0, MAX_RADIUS);
  let centre = src_at(px);
  // Summed as differences from the centre, for the reason given in the resample kernel.
  var sum = out_t(0.0);
  var norm = 1.0;
  for (var k = 1; k <= radius; k++) {
    let w = exp(-P.falloff * f32(k * k));
    sum += w * ((src_at(px - k * P.dir) - centre) + (src_at(px + k * P.dir) - centre));
    norm += 2.0 * w;
  }
  return centre + sum / norm;
}`,
});
export const blurKernels = { field: blurKernel('field'), color: blurKernel('color') };

// ---- smooth --------------------------------------------------------------------------------------------------------

/** Taps of one pass of the fit on each side of the centre: 61 loads, within the 64 of engine.md 3.15. */
export const FIT_MAX_TAPS = 30;

// One axis of the Gaussian that assumes nothing beyond the border: a polynomial through the samples the source
// has, weighted by the Gaussian, and its value, slope and bend at the texel. Inside the source the weights are
// symmetric and these are the Gaussian and its first two derivatives; at the border a plane stays the plane it
// is and a paraboloid keeps its slope and its bend, where a blur that clamps continues the source level.
const fitKernel = (kind: 'field' | 'color') => defineKernel({
  name: `ops/smooth.fit#${kind}`,
  inputs: { src: kind },
  // value: the line through the samples, at the texel. slope and bend: the first and second derivative of the
  // parabola through them, per texel and per texel squared.
  outputs: { value: kind, slope: kind, bend: kind },
  // ring: how many texels at each end of a row or column are no samples of the source but texels to fill (the
  // ring of a coarser grid). skip: how far from the first and the last sample, in texels, samples are left
  // out as well. perSigma: 1 / sigma, in texels. level: 1 takes the value as the mean of the samples, not
  // from the line through them.
  params: { dir: 'vec2i', taps: 'i32', perSigma: 'f32', ring: 'i32', skip: 'f32', level: 'u32' },
  cost: 2 * FIT_MAX_TAPS + 2,
  code: /* wgsl */ `
const MAX_TAPS = ${FIT_MAX_TAPS};

fn compute(px: vec2i, uv: vec2f) -> Out {
  let taps = clamp(P.taps, 0, MAX_TAPS);
  let last = dot(vec2i(src_res()) - vec2i(1), P.dir);
  let first = min(max(P.ring, 0), last);
  let end = max(last - max(P.ring, 0), first);
  // The samples from lo to hi count. What is left out ends between two samples: a sample counts by the part
  // of its own texel that lies beyond that, so that the cut is at the same place on a finer grid.
  let gone = max(i32(ceil(P.skip - 0.5)), 0);
  let lo = min(first + gone, end);
  let hi = max(end - gone, lo);
  let at = dot(px, P.dir);
  let row = px - at * P.dir;
  // Sums are taken of differences from one sample of the source: a constant stays that constant.
  let base = src_at(row + clamp(at, lo, hi) * P.dir);
  // The moments of the weights over the samples there are, with offsets counted in sigmas so that the fourth
  // moment stays near the zeroth, and the moments of the weighted differences.
  var m0 = 0.0;
  var m1 = 0.0;
  var m2 = 0.0;
  var m3 = 0.0;
  var m4 = 0.0;
  var t0 = src_t(0.0);
  var t1 = src_t(0.0);
  var t2 = src_t(0.0);
  for (var i = -taps; i <= taps; i++) {
    let j = at + i;
    if (j < lo || j > hi) { continue; }
    let x = f32(i) * P.perSigma;
    let xx = x * x;
    var w = exp(-0.5 * xx);
    if (P.skip > 0.0) { w *= saturate(f32(min(j - first, end - j)) + 0.5 - P.skip); }
    let d = src_at(row + j * P.dir) - base;
    m0 += w;
    m1 += w * x;
    m2 += w * xx;
    m3 += w * xx * x;
    m4 += w * xx * xx;
    t0 += w * d;
    t1 += w * x * d;
    t2 += w * xx * d;
  }
  // The line through the samples. With samples on both sides alike m1 is 0 and its value is the mean. Samples
  // at a single offset fix no line: there the mean is taken, and the slope is 0.
  var value = base;
  var slope = src_t(0.0);
  var bend = src_t(0.0);
  let spread = m0 * m2 - m1 * m1;
  let line = spread > 1e-4 * m0 * m2;
  if (line && P.level == 0u) {
    value = base + (m2 * t0 - m1 * t1) / spread;
  } else if (m0 > 0.0) {
    value = base + t0 / m0;
  }
  if (line) { slope = (m0 * t1 - m1 * t0) / spread; }
  // The parabola, by Cramer's rule. Samples at fewer than three offsets fix none: the slope stays the line's.
  let a = m2 * m4 - m3 * m3;
  let b = m1 * m4 - m2 * m3;
  let c = m1 * m3 - m2 * m2;
  let det = m0 * a - m1 * b + m2 * c;
  if (line && det > 1e-4 * m0 * m2 * m4) {
    slope = (m0 * (t1 * m4 - m3 * t2) - t0 * b + m2 * (m1 * t2 - m2 * t1)) / det;
    bend = 2.0 * (m0 * (m2 * t2 - m3 * t1) - m1 * (m1 * t2 - m2 * t1) + t0 * c) / det;
  }
  return Out(value, slope * P.perSigma, bend * P.perSigma * P.perSigma);
}`,
});
export const fitKernels = { field: fitKernel('field'), color: fitKernel('color') };

// A triangle that clamps at the border leaves the border vertices of the grid it reduces to a little inside the
// source: by `beta` of the step to the next vertex, where the source is a slope. This takes that back, along
// each axis, from the vertex and its neighbour alone. With `ring` 1 the grid has a ring and its vertices are
// the texels 1 to last - 1; with 0 they are all its texels.
const borderKernel = (kind: 'field' | 'color') => defineKernel({
  name: `ops/smooth.border#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { beta: 'f32', ring: 'i32' },
  cost: 4,
  code: /* wgsl */ `
// The vertex taken back, from itself and its neighbour: (v - beta * n) / (1 - beta), written so that a
// constant stays that constant.
fn back(v: src_t, n: src_t) -> src_t {
  return v + (v - n) * P.beta / (1.0 - P.beta);
}

fn alongX(p: vec2i, last: vec2i) -> src_t {
  let v = src_at(p);
  if (last.x - 2 * P.ring < 1) { return v; }
  if (p.x == P.ring) { return back(v, src_at(p + vec2i(1, 0))); }
  if (p.x == last.x - P.ring) { return back(v, src_at(p - vec2i(1, 0))); }
  return v;
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let last = vec2i(src_res()) - vec2i(1);
  let v = alongX(px, last);
  if (last.y - 2 * P.ring < 1) { return v; }
  if (px.y == P.ring) { return back(v, alongX(px + vec2i(0, 1), last)); }
  if (px.y == last.y - P.ring) { return back(v, alongX(px - vec2i(0, 1), last)); }
  return v;
}`,
});
export const borderKernels = { field: borderKernel('field'), color: borderKernel('color') };

// ---- blend ---------------------------------------------------------------------------------------------------------

const blendKernel = (kind: 'field' | 'color') => defineKernel({
  name: `ops/blend#${kind}`,
  inputs: { a: kind, b: kind, mask: MASK_INPUT },
  outputs: { out: kind },
  params: { amount: 'f32' },
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let t = mask_at(px) * P.amount;
  let va = a_at(px);
  let vb = b_at(px);
  // WGSL lets a device reassociate arithmetic, and a + t * (b - a) is not b at t = 1: the two ends are selected,
  // so that a mask of 0 leaves a and a mask of 1 gives b bit for bit.
  return select(select(mix(va, vb, t), vb, t >= 1.0), va, t <= 0.0);
}`,
});
export const blendKernels = { field: blendKernel('field'), color: blendKernel('color') };

// ---- slope and normal ----------------------------------------------------------------------------------------------

export const slopeKernel = defineKernel({
  name: 'ops/slope',
  inputs: { height: 'field' },
  outputs: { out: 'field' },
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return degrees(atan(length(slopeAt(height, px))));
}`,
});

export const normalKernel = defineKernel({
  name: 'ops/normal',
  inputs: { height: 'field' },
  outputs: { out: 'color' },
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  return vec4f(normalAt(height, px), 1.0);
}`,
});

// ---- shadow --------------------------------------------------------------------------------------------------------

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

export const shadowStartKernel = defineKernel({
  name: 'ops/shadow.start',
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

export const shadowMarchKernel = defineKernel({
  name: 'ops/shadow.march',
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
    // Written out, not mix(): between two equal heights this is that height to the last bit on every device,
    // and level ground does not rise above itself by the rounding of a product.
    let rayA = ray_at(a);
    let topA = top_at(a);
    let far = rayA + t * (ray_at(b) - rayA);
    let lifted = far.x - P.jump * P.dropLo;
    if (lifted > best.x) { best = vec2f(lifted, far.y + P.jump * P.run); }
    high = max(high, topA + t * (top_at(b) - topA) - P.jump * P.dropHi);
  }
  return Out(best, high);
}`,
});

// The share of one strip of the disc a texel sees, added to the shares of the strips below it.
export const shadowGatherKernel = defineKernel({
  name: 'ops/shadow.gather',
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

// ---- occlusion -----------------------------------------------------------------------------------------------------

/** How many doublings of the distance count in ops.occlusion: the ground from a quarter of the radius out to four times the radius. */
export const OCCLUSION_OCTAVES = 4;

// How sheltered a point is, at one distance. Along each of four axes it looks that far to both sides; the two
// heights there, against its own, are a hollow when their mean lies above it, and the angle of that hollow is
// what the ground on both sides hides of the sky above the lie of the land between them. A plane is no hollow
// at any tilt, so a slope is not sheltered by being steep; the foot of a cliff, a valley floor and a pit are.
//
// The march is bounded by doubling the distance, on a level of the terrain reduced as far: reach k looks 2^k
// texels out, which on the terrain reduced 2^(k - 1) times is two texels, and writes what it finds at that
// level. One texel there is the ground between this reach and the next, so the hollows found at a distance are
// hollows of that size, and ground rough at the scale of a texel does not come out as a speckle of pits. The
// distances that count are those from a quarter of the radius out to four times the radius, most at the
// radius itself: at most six reaches of ten loads, each on its own small grid, where a march texel by texel
// across a radius of a quarter of 8129 texels would take thousands of loads on the full one.
export const occlusionReachKernel = defineKernel({
  name: 'ops/occlusion.reach',
  // level: the terrain on the grid this reach writes. carry: the sum of the farther reaches, on the same grid.
  inputs: { level: 'field', carry: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  // stride: the distance of this reach in texels of that grid, 1 or 2. outer: the farthest distance that
  // counts, in the same texels.
  params: { stride: 'i32', outer: 'f32' },
  cost: 10,
  code: /* wgsl */ `
const OCTAVES = ${OCCLUSION_OCTAVES}.0;
const PI = 3.14159265358979;

// How many texels there are from p to the border along one component of an axis, the way that component points.
fn room(p: i32, last: i32, along: i32) -> i32 {
  if (along == 0) { return 1 << 20; }
  return select(p, last - p, along > 0);
}

// .x: the sine of the angle by which the ground at both ends of one axis stands above the texel at p, weighted
// by how near the radius this reach lies; 0 where the ground does not. .y: 1 where the axis has ground at both
// ends and so says something, else 0.
fn hollow(p: vec2i, z: f32, axis: vec2i) -> vec2f {
  // Near the border an end is as far out as the terrain goes. With the border at the texel itself the axis has
  // one end only, and one end says nothing: a slope would count as a hollow by the way it happens to face.
  let last = vec2i(level_res()) - vec2i(1);
  let ahead = min(P.stride, min(room(p.x, last.x, axis.x), room(p.y, last.y, axis.y)));
  let behind = min(P.stride, min(room(p.x, last.x, -axis.x), room(p.y, last.y, -axis.y)));
  if (ahead < 1 || behind < 1) { return vec2f(0.0, 0.0); }
  // The weight over the doublings below the farthest distance, most in their middle, which is the radius: the
  // weights of all the reaches add up to 2.
  let below = -log2(length(vec2f(axis)) * f32(P.stride) / P.outer);
  if (below <= 0.0 || below >= OCTAVES) { return vec2f(0.0, 1.0); }
  // Heights in metres over the distance in metres: the tangent to each end, and their mean. A plane has
  // tangents that cancel at any tilt, with its ends at different distances too.
  let up = (level_at(p + axis * ahead) - z) / f32(ahead) + (level_at(p - axis * behind) - z) / f32(behind);
  let rise = 0.5 * up * frame.heightRange / (length(vec2f(axis)) * frame.cellSize);
  if (rise <= 0.0) { return vec2f(0.0, 1.0); }
  let weight = sin(PI * below / OCTAVES) * sin(PI * below / OCTAVES);
  return vec2f(weight * rise / sqrt(1.0 + rise * rise), 1.0);
}

// The hollows of the four axes at p, added up, and how many of the axes said something.
fn hollows(p: vec2i) -> vec2f {
  let z = level_at(p);
  return hollow(p, z, vec2i(1, 0)) + hollow(p, z, vec2i(1, 1)) + hollow(p, z, vec2i(0, 1)) + hollow(p, z, vec2i(-1, 1));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // What is found is the mean over the axes that said something: on the border, the axis that runs along it.
  // A valley that runs out of the terrain is sheltered up to the border as it is inside, and the result has no
  // frame along it. Measured on ref/fbm against the same ground with more of it beyond the border, the
  // texels of the border are sheltered a twentieth more in the mean; faded out with the room there is, half as much.
  var found = hollows(px);
  if (found.y < 0.5) {
    // A corner has the border at one end of every axis: it takes what the texel diagonally inside it finds.
    let last = vec2i(level_res()) - vec2i(1);
    let nearest = min(vec2i(1), last / 2);
    found = hollows(clamp(px, nearest, max(last - vec2i(1), nearest)));
  }
  // On a grid too small for an axis to have two ends nothing is found.
  var sheltered = 0.0;
  if (found.y > 0.5) { sheltered = found.x / found.y; }
  return carry_at(px) + 0.5 * sheltered;
}`,
});

// ---- min-max -------------------------------------------------------------------------------------------------------

/** Side of the block one texel of a reduction pass covers: 64 loads per texel. */
export const MINMAX_BLOCK = 8;

// A block of texels that are all non-finite is recorded as (BIG, -BIG), which changes nothing in the next pass.
// Reads beyond the source clamp to its border and repeat texels of the source, which a minimum and a maximum ignore.
const MINMAX_HEAD = /* wgsl */ `
const BLOCK = ${MINMAX_BLOCK};
const BIG = 3.4028234e38;

fn result(lo: f32, hi: f32) -> vec2f {
  if (P.last != 0u && lo > hi) { return vec2f(0.0); }
  return vec2f(lo, hi);
}
`;

export const minMaxFirstKernel = defineKernel({
  name: 'ops/min-max.first',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'vec2' },
  params: { last: 'u32' },
  cost: MINMAX_BLOCK * MINMAX_BLOCK,
  code: /* wgsl */ `${MINMAX_HEAD}
fn compute(px: vec2i, uv: vec2f) -> vec2f {
  var lo = BIG;
  var hi = -BIG;
  for (var y = 0; y < BLOCK; y++) {
    for (var x = 0; x < BLOCK; x++) {
      let v = src_at(px * BLOCK + vec2i(x, y));
      // The integer test survives a compiler that folds v != v away.
      if ((bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u) {
        lo = min(lo, v);
        hi = max(hi, v);
      }
    }
  }
  return result(lo, hi);
}`,
});

export const minMaxNextKernel = defineKernel({
  name: 'ops/min-max.next',
  inputs: { src: { kind: 'vec2', size: 'any' } },
  outputs: { out: 'vec2' },
  params: { last: 'u32' },
  cost: MINMAX_BLOCK * MINMAX_BLOCK,
  code: /* wgsl */ `${MINMAX_HEAD}
fn compute(px: vec2i, uv: vec2f) -> vec2f {
  var lo = BIG;
  var hi = -BIG;
  for (var y = 0; y < BLOCK; y++) {
    for (var x = 0; x < BLOCK; x++) {
      let v = src_at(px * BLOCK + vec2i(x, y));
      lo = min(lo, v.x);
      hi = max(hi, v.y);
    }
  }
  return result(lo, hi);
}`,
});

// ---- remap ---------------------------------------------------------------------------------------------------------

export const remapKernel = defineKernel({
  name: 'ops/remap',
  inputs: { src: 'field', range: { kind: 'vec2', default: 0 } },
  outputs: { out: 'field' },
  params: { span: 'vec2f', to: 'vec2f', limit: 'u32' },
  cost: 2,
  code: /* wgsl */ `
const BIG = 3.4028234e38;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  var span = P.span;
  if (range_bound()) { span = range_at(vec2i(0)); }
  let width = span.y - span.x;
  var v = P.to.x;
  if (width != 0.0) {
    let s = src_at(px);
    // A span of almost no width overflows the quotient; the result stays finite.
    let t = clamp((s - span.x) / width, -BIG, BIG);
    v = clamp(P.to.x + t * (P.to.y - P.to.x), -BIG, BIG);
    // A device may divide a number by itself to just below 1: the end of the span is the end of the target, exactly.
    if (s == span.y) { v = P.to.y; }
  }
  if (P.limit != 0u) { v = clamp(v, min(P.to.x, P.to.y), max(P.to.x, P.to.y)); }
  return v;
}`,
});

/**
 * Every kernel the shared operations run. They are the engine's own: createEngine compiles them, and ctx.run
 * accepts them from any node although no NodeDef lists them (engine.md 4.6).
 */
export function opsKernels(): readonly AnyKernel[] {
  return [
    ...Object.values(copyKernels), resampleKernels.field, resampleKernels.color, blurKernels.field, blurKernels.color,
    blendKernels.field, blendKernels.color, slopeKernel, normalKernel, minMaxFirstKernel, minMaxNextKernel, remapKernel,
    fitKernels.field, fitKernels.color, borderKernels.field, borderKernels.color,
    shadowStartKernel, shadowMarchKernel, shadowGatherKernel, occlusionReachKernel,
  ];
}

// ---- what the operations check before they allocate ----------------------------------------------------------------

const sizeText = (field: Field): string => `${field.width}x${field.height}`;

/** Throws unless `field` is a field handle. The types say so already; a cast or an untyped caller gets past them. */
export function requireField(op: string, what: string, field: Field): void {
  if (field === null || typeof field !== 'object' || !Object.hasOwn(CHANNELS, field.kind)) {
    throw new FieldAccessError(`${op}: ${what} is not a field`);
  }
}

/** Throws unless `field` has `channels` channels. */
export function requireChannels(op: string, what: string, field: Field, channels: 1 | 2 | 4): void {
  requireField(op, what, field);
  if (CHANNELS[field.kind] !== channels) {
    throw new FieldAccessError(`${op}: ${what} is field #${field.id} of kind "${field.kind}"; it needs ${channels} channel${channels === 1 ? '' : 's'}`);
  }
}

/** Throws unless `field` is a `field` or a `color`: the kinds an operation on images accepts and returns. */
export function requireImage(op: string, what: string, field: Field): void {
  requireField(op, what, field);
  if (field.kind !== 'field' && field.kind !== 'color') {
    throw new FieldAccessError(`${op}: ${what} is field #${field.id} of kind "${field.kind}"; it must be a "field" or a "color"`);
  }
}

/** Throws unless `field` is square. An operation's result has the size of its input, and kernels write square grids (engine.md 1.1). */
export function requireSquare(op: string, what: string, field: Field): void {
  if (field.width !== field.height) {
    throw new FieldAccessError(`${op}: ${what} is field #${field.id}, which is ${sizeText(field)}; the operation writes a field of that size, and only square fields are written. Bring it onto a grid with ops.resample first`);
  }
}

/** Throws unless the two fields have one size. */
export function requireSameSize(op: string, whatA: string, a: Field, whatB: string, b: Field): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new FieldAccessError(`${op}: ${whatA} is field #${a.id}, which is ${sizeText(a)}, but ${whatB} is field #${b.id}, which is ${sizeText(b)}; they must have the same size. Resample one first`);
  }
}
