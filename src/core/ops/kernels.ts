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
