// The WGSL library `generateNoise` of the basic generators: gradient noise on a triangular lattice with its
// derivative, the placement of the octaves of a fractal sum, and the domain warp. Every random number is an
// integer hash of a lattice cell and a seed the caller passes: the library itself reads no seed.
import { defineLib, hash, type WgslLib } from '../../api.ts';

/** The steps in which the warp carries a point. */
export const WARP_STEPS = 4;
/**
 * The displacement, in warp feature sizes, that full warp strength gives per unit of the warp noise's
 * derivative, all steps together. The derivative is 3.6 in the root mean square and at most 7.3: full strength
 * moves a point by a fifth of a warp feature size on average and by two fifths at the most. Measured over
 * 180 000 points, the warped plane is then nowhere folded (the smallest area ratio is 0.43) and squeezed more
 * than fivefold on 1 % of it. At twice this reach the four steps fold it, on 0.06 % of the plane.
 */
export const WARP_REACH = 0.06;

const code = /* wgsl */ `
// Lattice coordinates beyond this are clamped before they become integers: every function stays finite for any finite p.
const generateNoise_LIMIT = 1.0e9;
const generateNoise_MAX_OCTAVES = 16;
// The triangular lattice has sqrt(3) points per unit area. Coordinates times 3^(-1/4) give it one point per
// unit square, the density of a square lattice: a feature size means the same here as in the core noise.
const generateNoise_DENSITY = 0.759835686;

// Sixteen unit gradients, 22.5 degrees apart, none along an axis. A table, not cos and sin of a hashed angle.
const generateNoise_GRADIENTS = array<vec2f, 16>(
  vec2f(0.980785280, 0.195090322), vec2f(0.831469612, 0.555570233),
  vec2f(0.555570233, 0.831469612), vec2f(0.195090322, 0.980785280),
  vec2f(-0.195090322, 0.980785280), vec2f(-0.555570233, 0.831469612),
  vec2f(-0.831469612, 0.555570233), vec2f(-0.980785280, 0.195090322),
  vec2f(-0.980785280, -0.195090322), vec2f(-0.831469612, -0.555570233),
  vec2f(-0.555570233, -0.831469612), vec2f(-0.195090322, -0.980785280),
  vec2f(0.195090322, -0.980785280), vec2f(0.555570233, -0.831469612),
  vec2f(0.831469612, -0.555570233), vec2f(0.980785280, -0.195090322),
);
fn generateNoise_gradientAt(c: vec2i, seed: u32) -> vec2f { return generateNoise_GRADIENTS[hash_cell(c, seed) >> 28u]; }

// Gradient noise on the triangular (simplex) lattice: .x is the value, in [-1, 1], and .yz its derivative
// with respect to p. Each lattice point carries a radial kernel (0.5 - r^2)^4 that ends exactly on the
// opposite edge of its triangles, so the sum is smooth everywhere, and it is 0 on the lattice points.
// The largest value three unit gradients can give is 1 / 99.204, on the middle of an edge.
fn generateNoise_simplexD(p: vec2f, seed: u32) -> vec3f {
  let q = clamp(p, vec2f(-generateNoise_LIMIT), vec2f(generateNoise_LIMIT));
  let cell = floor(q + (q.x + q.y) * 0.366025404);
  let i = vec2i(cell);
  let x0 = (q - cell) + (cell.x + cell.y) * 0.211324865;
  let o = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  let x1 = x0 - o + 0.211324865;
  let x2 = x0 - 0.577350269;
  let g0 = generateNoise_gradientAt(i, seed);
  let g1 = generateNoise_gradientAt(i + vec2i(o), seed);
  let g2 = generateNoise_gradientAt(i + vec2i(1, 1), seed);
  let t = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3f(0.0));
  let t2 = t * t;
  let t4 = t2 * t2;
  let ramp = vec3f(dot(g0, x0), dot(g1, x1), dot(g2, x2));
  let fall = -8.0 * t2 * t * ramp;
  let value = dot(t4, ramp);
  let slope = t4.x * g0 + t4.y * g1 + t4.z * g2 + fall.x * x0 + fall.y * x1 + fall.z * x2;
  return vec3f(value, slope) * 99.2;
}
// The value alone, for a sum that needs no derivative: the same number as generateNoise_simplexD(p, seed).x.
fn generateNoise_simplex(p: vec2f, seed: u32) -> f32 {
  let q = clamp(p, vec2f(-generateNoise_LIMIT), vec2f(generateNoise_LIMIT));
  let cell = floor(q + (q.x + q.y) * 0.366025404);
  let i = vec2i(cell);
  let x0 = (q - cell) + (cell.x + cell.y) * 0.211324865;
  let o = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  let x1 = x0 - o + 0.211324865;
  let x2 = x0 - 0.577350269;
  let t = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3f(0.0));
  let t2 = t * t;
  let ramp = vec3f(
    dot(generateNoise_gradientAt(i, seed), x0),
    dot(generateNoise_gradientAt(i + vec2i(o), seed), x1),
    dot(generateNoise_gradientAt(i + vec2i(1, 1), seed), x2),
  );
  return dot(t2 * t2, ramp) * 99.2;
}

// A turn by atan(3/4), 36.87 degrees. No multiple of it is a symmetry of the lattice, so octaves that are
// each turned against the one before never line up, with each other or with the terrain's borders.
fn generateNoise_turn(p: vec2f) -> vec2f { return vec2f(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y); }
// The same turn backwards: carries a derivative from a turned lattice to the one before.
fn generateNoise_unturn(p: vec2f) -> vec2f { return vec2f(0.8 * p.x + 0.6 * p.y, -0.6 * p.x + 0.8 * p.y); }
// The seed of octave i, and the shift of its lattice: without a shift every octave has a lattice point,
// where gradient noise is 0, on the point the sum is scaled about.
fn generateNoise_octaveSeed(seed: u32, i: i32) -> u32 { return mixSeed(seed, u32(i)); }
fn generateNoise_shift(octaveSeed: u32) -> vec2f { return hash_unit2(mixSeed(octaveSeed, 0xffffu)) * 16.0; }
// Lattice coordinates of the first octave for a terrain coordinate: scaled about the terrain's centre.
fn generateNoise_lattice(uv: vec2f, cells: f32) -> vec2f {
  return generateNoise_turn((uv - vec2f(0.5)) * (cells * generateNoise_DENSITY));
}

// A soft limit: x itself up to the knee, then bending towards the knee plus the room, which it never reaches.
// Twice differentiable at the knee.
fn generateNoise_soften(x: f32, knee: f32, room: f32) -> f32 {
  let over = (abs(x) - knee) / room;
  if (over <= 0.0) { return x; }
  return sign(x) * (knee + room * over / sqrt(1.0 + over * over));
}

// Domain warp. The point is carried along the contours of a smooth noise in a fixed number of short steps,
// as a particle in a flow without sources or sinks. Such a flow keeps areas and cannot fold the plane over
// itself, and the steps follow it closely enough at the reach the nodes give them (WARP_REACH): a pattern
// looked up at the warped point bends and swirls but does not tear or double. Adding two noises to the
// coordinates instead folds 12 % of the plane at the same mean displacement.
// cells: lattice cells of the warp noise across the terrain. reach: the displacement of one step, in terrain
// widths, for a unit derivative. reach 0 returns uv itself.
const generateNoise_WARP_STEPS = ${WARP_STEPS};
fn generateNoise_warp(uv: vec2f, cells: f32, reach: f32, seed: u32) -> vec2f {
  if (reach == 0.0) { return uv; }
  let shift = generateNoise_shift(seed);
  var p = uv;
  for (var k = 0; k < generateNoise_WARP_STEPS; k++) {
    let d = generateNoise_simplexD(generateNoise_lattice(p, cells) + shift, seed).yz;
    p += reach * generateNoise_unturn(vec2f(d.y, -d.x));
  }
  return p;
}`;

/** Simplex gradient noise with derivative, octave placement and the fold-free domain warp of the basic generators. */
export const generateNoise: WgslLib = defineLib({ name: 'generateNoise', code, deps: [hash] });

/** The `reach` argument of generateNoise_warp for a warp strength (a ratio) and a warp feature size (a length). */
export function warpReach(strength: number, size: number): number {
  return (strength * WARP_REACH * Math.max(size, 0.001)) / WARP_STEPS;
}
