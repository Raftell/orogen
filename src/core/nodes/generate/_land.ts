// Shared by the landform generators: the WGSL library `generateLand` (smooth minima, segment distances and roofs,
// domain warps, slope-aligned gullies) and the seeded number stream their skeletons are laid out with on the CPU.
import { defineLib, hashU32, hashUnit, mixSeed, noise } from '../../api.ts';

const code = /* wgsl */ `
const generateLand_TAU = 6.28318530718;
const generateLand_MAX_OCTAVES = 8;
// Waves of a gully octave per lattice cell: more make longer, straighter gullies that follow a turning slope
// less closely.
const generateLand_WAVES = 2.0;
// Lattice coordinates beyond this are clamped before they become integers.
const generateLand_LIMIT = 1.0e9;

// Polynomial smooth minimum; k is the width of the blend in the units of a and b.
fn generateLand_smin(a: f32, b: f32, k: f32) -> f32 {
  let w = max(k, 1.0e-9);
  let t = max(w - abs(a - b), 0.0) / w;
  return min(a, b) - 0.25 * w * t * t;
}

// (distance from p to the segment a-b, position 0..1 of the nearest point along it).
fn generateLand_segment(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let ab = b - a;
  let ap = p - a;
  let t = saturate(dot(ap, ab) / max(dot(ab, ab), 1.0e-12));
  return vec2f(length(ap - ab * t), t);
}

// Fractal gradient noise with its derivative: .x is the value in [-1, 1], .yz its gradient with respect to p.
fn generateLand_fbmD(p: vec2f, seed: u32, octaves: i32, gain: f32) -> vec3f {
  let n = clamp(octaves, 1, generateLand_MAX_OCTAVES);
  var sum = vec3f(0.0);
  var norm = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  for (var i = 0; i < generateLand_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    let v = noise_gradientD(p * freq, mixSeed(seed, u32(i)));
    sum += amp * vec3f(v.x, v.yz * freq);
    norm += amp;
    amp *= gain;
    freq *= 2.0;
  }
  return sum / norm;
}

// Two independent fractal noises, each in [-1, 1]: the displacement of a domain warp.
fn generateLand_warp(p: vec2f, seed: u32, octaves: i32) -> vec2f {
  return vec2f(
    noise_fbm(p, mixSeed(seed, 1u), octaves, 2.0, 0.5),
    noise_fbm(p + vec2f(37.19, 11.73), mixSeed(seed, 2u), octaves, 2.0, 0.5),
  );
}

// The roof over the crest segment a-b, whose crest is at height ha at a and hb at b and whose sides fall at
// the slope k. The crest is rounded over the distance round, so the gradient turns across it instead of
// flipping, and the roof has a continuous gradient everywhere. Returns (height at p, gradient of that height,
// the slope of the roof's sides far from the crest).
fn generateLand_roof(p: vec2f, a: vec2f, b: vec2f, ha: f32, hb: f32, k: f32, round: f32) -> vec4f {
  let ab = b - a;
  let ap = p - a;
  let len2 = max(dot(ab, ab), 1.0e-12);
  let raw = dot(ap, ab) / len2;
  let t = saturate(raw);
  let off = ap - ab * t;
  let soft = sqrt(dot(off, off) + round * round);
  // The crest eases from one end's height to the other's, level at both ends: its slope has no jump where
  // the nearest point passes an end of the segment.
  let ease = t * t * (3.0 - 2.0 * t);
  let along = ab * ((hb - ha) * 6.0 * t * (1.0 - t) / len2);
  return vec4f(mix(ha, hb, ease) - k * (soft - round), along - k * off / max(soft, 1.0e-6), sqrt(k * k + dot(along, along)));
}

// The mean of unit phasors with the given number of waves per lattice cell along the unit vector t, anchored at
// one jittered point per cell and weighted by a kernel of radius 1.25 cells. Every point within that radius
// lies in the 3 x 3 cells read, so the result is continuous; its length is 1 where the neighbours agree in
// phase and falls to 0 where they cancel.
fn generateLand_phasor(p: vec2f, t: vec2f, waves: f32, seed: u32) -> vec2f {
  let q = clamp(p, vec2f(-generateLand_LIMIT), vec2f(generateLand_LIMIT));
  let cell = vec2i(floor(q));
  let f = q - floor(q);
  var acc = vec2f(0.0);
  var total = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2i(i, j);
      let d = f - (vec2f(o) + vec2f(0.25) + 0.5 * hash_unit2(hash_cell(cell + o, seed)));
      let w1 = max(1.0 - dot(d, d) / 1.5625, 0.0);
      let w = w1 * w1 * w1;
      let phase = generateLand_TAU * waves * dot(d, t);
      acc += w * vec2f(cos(phase), sin(phase));
      total += w;
    }
  }
  return acc / max(total, 1.0e-6);
}

// Carves gullies that run down the slope of a height h0 whose gradient is g0 (height per unit of p), octave by
// octave: each octave lays waves along the contours of what was carved so far, as far as branch lets the
// carving turn them, so finer gullies enter the coarser ones at an angle. The waves are cut in proportion to
// the slope of h0 and mostly below it: a gully floor lies 1.6 amplitudes down and a crest 0.4 up, and level
// ground stays untouched. wavelength is the spacing of the first octave in units of p; each further octave has
// half of it. sharp 0 gives rounded waves, 1 knife-edged crests between rounded gullies and -1 notched gullies
// between rounded crests. Returns (height, the gradient the last octave followed).
fn generateLand_erode(p: vec2f, h0: f32, g0: vec2f, wavelength: f32, strength: f32, octaves: i32, sharp: f32, branch: f32, seed: u32) -> vec3f {
  let n = clamp(octaves, 0, generateLand_MAX_OCTAVES);
  var h = h0;
  var g = g0;
  var lambda = max(wavelength, 1.0e-6);
  for (var i = 0; i < generateLand_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    let slope = length(g);
    let t = vec2f(-g.y, g.x) / max(slope, 1.0e-6);
    let ph = generateLand_phasor(p / (lambda * generateLand_WAVES), t, generateLand_WAVES, mixSeed(seed, u32(i)));
    let len = length(ph);
    let c = ph.x / max(len, 1.0e-6);
    let s = ph.y / max(len, 1.0e-6);
    // Crest at phase 0. The rounded wave is cos. The sharp ones have a crease: at the crest for a positive
    // sharp, 1 - 2 |sin(phase / 2)|, and at the floor for a negative one, 2 |cos(phase / 2)| - 1.
    let creased = select(2.0 * sqrt(max(0.5 * (1.0 + c), 0.0)) - 1.0, 1.0 - 2.0 * sqrt(max(0.5 * (1.0 - c), 0.0)), sharp >= 0.0);
    let profile = mix(c, creased, abs(sharp));
    let a = strength * min(length(g0), 8.0) * lambda * 0.16 * smoothstep(0.0, 0.4, len);
    h += a * (profile - 0.6);
    // The slope of the rounded wave turns the next octave, whatever the profile: it has no jump at a crest.
    g -= branch * a * s * (generateLand_TAU / lambda) * t;
    lambda *= 0.5;
  }
  return vec3f(h, g);
}
`;

/** Helpers of the landform generators: smooth minima, segment distances and roofs, warps, and slope-aligned gullies. */
export const generateLand = defineLib({ name: 'generateLand', code, deps: [noise] });

/** A stream of uniform numbers in [0, 1) that depends on the seed alone: integer hashing, as in the kernels. */
export function landRandom(seed: number, stream: number): () => number {
  let state = mixSeed(seed >>> 0, stream >>> 0);
  return () => {
    state = hashU32((state + 0x9e3779b9) >>> 0);
    return hashUnit(state);
  };
}

/** Segments of a skeleton as a `vec4f` table: (ax, ay, bx, by) then (value at a, value at b, extra, extra) for each. */
export class SegmentList {
  private readonly values: number[] = [];

  get count(): number {
    return this.values.length / 8;
  }

  add(ax: number, ay: number, bx: number, by: number, va: number, vb: number, extraA = 0, extraB = 0): void {
    this.values.push(ax, ay, bx, by, va, vb, extraA, extraB);
  }

  /** At least one segment, so that the table is never empty: a degenerate one far from the terrain. */
  table(): Float32Array<ArrayBuffer> {
    if (this.values.length === 0) return new Float32Array([1e6, 1e6, 1e6, 1e6, -1e6, -1e6, 0, 0]);
    return new Float32Array(this.values);
  }
}
