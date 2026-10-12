// The text of engine.md section 2 and 3.8, which is normative. A change here is a change to that document.

/** `struct Frame` and its binding: the first segment of every kernel module (engine.md 3.2). */
export const FRAME_WGSL = /* wgsl */ `struct Frame {
  res: vec2u,          // offset  0  size of the grid this run writes, in texels (res.x == res.y)
  tileOrigin: vec2u,   // offset  8  first texel of this dispatch; framework use only (3.15)
  terrainSize: f32,    // offset 16  metres across the terrain
  cellSize: f32,       // offset 20  metres between neighbouring texels of the written grid
  heightRange: f32,    // offset 24  metres represented by height 1.0
  seed: u32,           // offset 28  mixSeed(project seed, node seed) (4.8)
  iteration: u32,      // offset 32  loop index inside ctx.loop, else 0, unless the run overrides it
  bound: u32,          // offset 36  bit i is set when declared input i is bound to a field
};                     // size 40, alignment 8
@group(0) @binding(0) var<uniform> frame: Frame;`;

/** The standard library: part of every kernel (engine.md 3.8). */
export const STDLIB_WGSL = /* wgsl */ `var<private> _px: vec2i;

// ---- the invocation's texel -------------------------------------------------
// Sets the invocation's texel from the dispatch id and the tile origin.
// Returns false when it lies outside the written grid. Raw mode calls it once, first.
fn beginPixel(gid: vec3u) -> bool {
  let p = gid.xy + frame.tileOrigin;
  _px = vec2i(p);
  return all(p < frame.res);
}
// The invocation's texel. Valid after beginPixel.
fn pixel() -> vec2i { return _px; }

// ---- the written grid -------------------------------------------------------
// True when p is a texel of the written grid.
fn inGrid(p: vec2i) -> bool { return all(p >= vec2i(0)) && all(p < vec2i(frame.res)); }
// p clamped to the written grid.
fn clampToGrid(p: vec2i) -> vec2i { return clamp(p, vec2i(0), vec2i(frame.res) - vec2i(1)); }
// Terrain coordinate of texel p of the written grid: p / (res - 1).
fn uvOf(p: vec2i) -> vec2f { return vec2f(p) / vec2f(max(frame.res, vec2u(2u)) - vec2u(1u)); }
// Position of texel p of the written grid in metres.
fn metresOf(p: vec2i) -> vec2f { return uvOf(p) * frame.terrainSize; }

// ---- texture reads, for library code that receives a texture ---------------
// Texel p of t, with p clamped to t's own size. A 1x1 texture is a constant.
fn ld(t: texture_2d<f32>, p: vec2i) -> f32 { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0).r; }
fn ld2(t: texture_2d<f32>, p: vec2i) -> vec2f { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0).rg; }
fn ld4(t: texture_2d<f32>, p: vec2i) -> vec4f { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0); }
// A mask value: saturate(ld(t, p)).
fn ldMask(t: texture_2d<f32>, p: vec2i) -> f32 { return saturate(ld(t, p)); }

// Bilinear at the fractional texel position x, in t's own texels, clamped to [0, size - 1].
fn bilinearPx4(t: texture_2d<f32>, x: vec2f) -> vec4f {
  let c = clamp(x, vec2f(0.0), vec2f(textureDimensions(t)) - vec2f(1.0));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  return mix(mix(ld4(t, i), ld4(t, i + vec2i(1, 0)), f.x), mix(ld4(t, i + vec2i(0, 1)), ld4(t, i + vec2i(1, 1)), f.x), f.y);
}
fn bilinearPx2(t: texture_2d<f32>, x: vec2f) -> vec2f { return bilinearPx4(t, x).rg; }
fn bilinearPx(t: texture_2d<f32>, x: vec2f) -> f32 { return bilinearPx4(t, x).r; }
// Bilinear at terrain coordinate uv. uv 0..1 spans t's first to last texel:
// texel position = uv * (size - 1). Never uv * size - 0.5.
fn bilinear4(t: texture_2d<f32>, uv: vec2f) -> vec4f { return bilinearPx4(t, uv * (vec2f(textureDimensions(t)) - vec2f(1.0))); }
fn bilinear2(t: texture_2d<f32>, uv: vec2f) -> vec2f { return bilinear4(t, uv).rg; }
fn bilinear(t: texture_2d<f32>, uv: vec2f) -> f32 { return bilinear4(t, uv).r; }

// ---- terrain shape ----------------------------------------------------------
// Gradient (dz/dx, dz/dy) of the height texture t at texel p, in metres per metre.
// Central difference; one-sided on t's border. The cell size is taken from t's own
// size, so t may have any resolution. Heights are multiplied by frame.heightRange.
fn slopeAt(t: texture_2d<f32>, p: vec2i) -> vec2f {
  let last = vec2i(textureDimensions(t)) - vec2i(1);
  let q = clamp(p, vec2i(0), last);
  let lo = max(q - vec2i(1), vec2i(0));
  let hi = min(q + vec2i(1), last);
  let d = vec2f(ld(t, vec2i(hi.x, q.y)) - ld(t, vec2i(lo.x, q.y)), ld(t, vec2i(q.x, hi.y)) - ld(t, vec2i(q.x, lo.y)));
  let run = vec2f(max(hi - lo, vec2i(1))) * (frame.terrainSize / vec2f(max(last, vec2i(1))));
  return d * frame.heightRange / run;
}
// Unit surface normal, +Z up: normalize(vec3f(-dz/dx, -dz/dy, 1)).
fn normalAt(t: texture_2d<f32>, p: vec2i) -> vec3f { let s = slopeAt(t, p); return normalize(vec3f(-s.x, -s.y, 1.0)); }

// ---- seeds ------------------------------------------------------------------
fn _pcg(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Combines two seeds. Identical to the TypeScript mixSeed (4.8).
fn mixSeed(a: u32, b: u32) -> u32 { return _pcg(_pcg(a) + b); }
// A sub-seed of the node's seed, decorrelated for each stream number.
fn seedFor(stream: u32) -> u32 { return mixSeed(frame.seed, stream); }`;
