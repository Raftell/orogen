// The fractal noise of the surface nodes: gradient noise summed over octaves that are each turned against the
// one before, with its derivative, and with every octave faded out before it gets finer than a grid can hold.
import { defineLib, noise } from '../../api.ts';

/** The most octaves a sum takes. */
export const NOISE_MAX_OCTAVES = 8;
/** An octave whose wavelength is this many texels or fewer is left out, and one of twice as many is whole. */
export const NOISE_FINEST = 2.5;

export const surfaceNoise = defineLib({
  name: 'surfaceNoise',
  deps: [noise],
  code: /* wgsl */ `
const surfaceNoise_MAX_OCTAVES = ${NOISE_MAX_OCTAVES};
const surfaceNoise_FINEST = ${NOISE_FINEST};

// How much of a wave of the given length in texels a grid holds: nothing of one of 2.5 texels, all of one of 5.
fn surfaceNoise_held(texels: f32) -> f32 { return smoothstep(surfaceNoise_FINEST, 2.0 * surfaceNoise_FINEST, texels); }

// Fractal gradient noise with its derivative: .x is the value, in [-1, 1], and .yz its gradient with respect
// to p. Each octave has half the wavelength of the one before and is turned against it by the angle whose
// cosine is 0.8, of which no multiple is a quarter turn: the lattices never line up, and the sum shows no weave.
// texels is the wavelength of the first octave in texels of the grid written: an octave the grid cannot hold
// is faded out of the sum, which then has less in it on a coarse grid and never anything false.
fn surfaceNoise_fbmD(p: vec2f, seed: u32, octaves: i32, gain: f32, texels: f32) -> vec3f {
  let n = clamp(octaves, 1, surfaceNoise_MAX_OCTAVES);
  let turn = mat2x2f(1.6, 1.2, -1.2, 1.6);
  var m = mat2x2f(1.0, 0.0, 0.0, 1.0);
  var sum = vec3f(0.0);
  var norm = 0.0;
  var amp = 1.0;
  var wave = texels;
  for (var i = 0; i < surfaceNoise_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    let held = surfaceNoise_held(wave);
    if (held > 0.0) {
      let v = noise_gradientD(m * p, mixSeed(seed, u32(i)));
      sum += amp * held * vec3f(v.x, transpose(m) * v.yz);
    }
    norm += amp;
    amp *= gain;
    wave *= 0.5;
    m = turn * m;
  }
  return sum / norm;
}`,
});
