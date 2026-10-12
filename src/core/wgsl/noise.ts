import { defineLib, type WgslLib } from '../gpu/lib.ts';
import { hash } from './hash.ts';

// This text is the definition of the library (engine.md 3.9). Everything is a function of p and the seed
// through integer hashes of floor(p); no value comes from float trigonometry (engine.md 3.14 rule 4).
const code = /* wgsl */ `// Lattice coordinates beyond this are clamped: every function stays finite for any finite p.
const noise_LIMIT = 1.0e9;
const noise_MAX_OCTAVES = 16;

// Quintic fade and its derivative.
fn noise_fade(t: vec2f) -> vec2f { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn noise_fadeD(t: vec2f) -> vec2f { return 30.0 * t * t * (t * (t - 2.0) + 1.0); }

// Sixteen unit gradients, 22.5 degrees apart. A table, not cos and sin of a hashed angle.
const noise_GRADIENTS = array<vec2f, 16>(
  vec2f(0.980785280, 0.195090322), vec2f(0.831469612, 0.555570233),
  vec2f(0.555570233, 0.831469612), vec2f(0.195090322, 0.980785280),
  vec2f(-0.195090322, 0.980785280), vec2f(-0.555570233, 0.831469612),
  vec2f(-0.831469612, 0.555570233), vec2f(-0.980785280, 0.195090322),
  vec2f(-0.980785280, -0.195090322), vec2f(-0.831469612, -0.555570233),
  vec2f(-0.555570233, -0.831469612), vec2f(-0.195090322, -0.980785280),
  vec2f(0.195090322, -0.980785280), vec2f(0.555570233, -0.831469612),
  vec2f(0.831469612, -0.555570233), vec2f(0.980785280, -0.195090322),
);
// The gradient of a lattice point: one of the sixteen, chosen by the top four bits of the cell's hash.
fn noise_gradientAt(c: vec2i, seed: u32) -> vec2f { return noise_GRADIENTS[hash_cell(c, seed) >> 28u]; }

// Value noise in [0, 1]: quintic interpolation of hash_unit at the four cell corners.
fn noise_value(p: vec2f, seed: u32) -> f32 {
  let q = clamp(p, vec2f(-noise_LIMIT), vec2f(noise_LIMIT));
  let i = vec2i(floor(q));
  let u = noise_fade(q - floor(q));
  let a = hash_unit(hash_cell(i, seed));
  let b = hash_unit(hash_cell(i + vec2i(1, 0), seed));
  let c = hash_unit(hash_cell(i + vec2i(0, 1), seed));
  let d = hash_unit(hash_cell(i + vec2i(1, 1), seed));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Gradient noise in [-1, 1] and its derivative: .x is the value, .yz is d(value)/dp. 0 at lattice points.
fn noise_gradientD(p: vec2f, seed: u32) -> vec3f {
  let q = clamp(p, vec2f(-noise_LIMIT), vec2f(noise_LIMIT));
  let i = vec2i(floor(q));
  let f = q - floor(q);
  let u = noise_fade(f);
  let du = noise_fadeD(f);
  let ga = noise_gradientAt(i, seed);
  let gb = noise_gradientAt(i + vec2i(1, 0), seed);
  let gc = noise_gradientAt(i + vec2i(0, 1), seed);
  let gd = noise_gradientAt(i + vec2i(1, 1), seed);
  let a = dot(ga, f);
  let b = dot(gb, f - vec2f(1.0, 0.0));
  let c = dot(gc, f - vec2f(0.0, 1.0));
  let d = dot(gd, f - vec2f(1.0, 1.0));
  let v = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  let g = mix(mix(ga, gb, u.x), mix(gc, gd, u.x), u.y)
        + vec2f(du.x * mix(b - a, d - c, u.y), du.y * (mix(c, d, u.x) - mix(a, b, u.x)));
  // Unit gradients give a range of +-sqrt(2)/2; the factor makes it +-1.
  return vec3f(v, g) * 1.41421356;
}
fn noise_gradient(p: vec2f, seed: u32) -> f32 { return noise_gradientD(p, seed).x; }

// (F1, F2): distances to the nearest and second nearest feature point, one point per cell at
// cell + hash_unit2(hash_cell(cell, seed)). The 5 x 5 cells around p hold both points for certain:
// F2 is below 1.81 and every point outside them is at least 2 away.
fn noise_worley(p: vec2f, seed: u32) -> vec2f {
  let q = clamp(p, vec2f(-noise_LIMIT), vec2f(noise_LIMIT));
  let cell = vec2i(floor(q));
  let f = q - floor(q);
  var best = vec2f(64.0);                  // squared distances
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let o = vec2i(i, j);
      let d = vec2f(o) + hash_unit2(hash_cell(cell + o, seed)) - f;
      let d2 = dot(d, d);
      if (d2 < best.x) { best = vec2f(d2, best.x); } else if (d2 < best.y) { best.y = d2; }
    }
  }
  return sqrt(best);
}

// Fractal sum of gradient noise, normalised by the sum of the amplitudes: in [-1, 1].
// Octave i has frequency lacunarity^i, amplitude gain^i and the seed mixSeed(seed, i).
fn noise_fbm(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  let n = clamp(octaves, 1, noise_MAX_OCTAVES);
  var sum = 0.0;
  var norm = 0.0;
  var amp = 1.0;
  var q = p;
  for (var i = 0; i < noise_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    sum += amp * noise_gradient(q, mixSeed(seed, u32(i)));
    norm += abs(amp);
    amp *= gain;
    q *= lacunarity;
  }
  return sum / norm;
}`;

/** Lattice noise: noise_value, noise_gradient, noise_gradientD, noise_worley, noise_fbm (engine.md 3.9). This file is the definition of its text. */
export const noise: WgslLib = defineLib({ name: 'noise', code, deps: [hash] });
