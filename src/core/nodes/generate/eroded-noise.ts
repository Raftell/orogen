// src/core/nodes/generate/eroded-noise.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateNoise } from './_noise.ts';

/**
 * The constants of the kernel, which the tests read. Each is the value at full erosion; the `erosion`
 * parameter scales it, so that without erosion the node is the plain sum of generate/fractal-noise.
 */
const env = (name: string, value: number): number => Number((globalThis as any).process?.env?.[name] ?? value);
export const ERODED = {
  /** The octaves that shape the massif. They stay as they are, and their slope is what the gullies run down. */
  massif: 2,
  /** Gullies per lattice unit of their octave, where the ground is steep. */
  stripes: env('E_STRIPES', 1.3),
  /** The slope, in heights of the noise per feature size of the first octave, at which the gullies have half their depth. */
  steep: env('E_STEEP', 2.0),
  /** The depth of a gully octave, as a share of the plain octave it stands beside. */
  depth: env('E_DEPTH', 1.0),
  /** What each gully octave keeps of the depth of the one before, beyond what the roughness gives it. */
  fade: env('E_FADE', 0.85),
  /** The strength of a blended wave below which its gullies fade out. */
  agree: env('E_AGREE', 0.3),
  /** How far the crest between two gullies is rounded, as a share of the profile. */
  sharp: env('E_SHARP', 0.15),
  /** The height of the crest in the profile, which then has the mean 0. */
  crest: env('E_CREST', 1.27),
  /** How strongly the walls of the gullies cut so far steer the finer ones: these run down the walls and branch off. */
  branch: env('E_BRANCH', 0.6),
  /** How strongly a slope holds back the plain octaves that follow, per squared slope in the units of `steep`. */
  damping: env('E_DAMPING', 2),
  /** Added to the exponent 1 of the final profile: above 1 it hollows the slopes, widens the valley floors and narrows the crests. */
  hollow: env('E_HOLLOW', 0.35),
  /** What the spread of the heights grows by, to make up for the octaves held back. */
  lift: env('E_LIFT', 0.1),
};

const eroded = defineKernel({
  name: 'generate/eroded-noise',
  outputs: { out: 'field' },
  params: { cells: 'f32', octaves: 'i32', gain: 'f32', erosion: 'f32' },
  includes: [generateNoise],
  code: /* wgsl */ `
const MASSIF = ${ERODED.massif};
const STRIPES = ${ERODED.stripes};
const STEEP = ${ERODED.steep};
const DEPTH = ${ERODED.depth};
const BRANCH = ${ERODED.branch};
const DAMPING = ${ERODED.damping};
const HOLLOW = ${ERODED.hollow};
const LIFT = ${ERODED.lift};
const AGREE = ${ERODED.agree};
const SHARP = ${ERODED.sharp};
const CREST = ${ERODED.crest};
const FADE = ${ERODED.fade};
const VARIANT = ${process.env.EV ?? 0};
const TAU = 6.283185307;
// The normalisation of generate/fractal-noise, mode fbm: with no erosion the two nodes give the same terrain.
const SPREAD = 0.31;
const KNEE = 0.4;
const ROOM = 0.1;

// One layer of gullies. Every point of the triangular lattice carries a plane wave with the wave vector k,
// in lattice units, around an anchor of its own near it; the waves are blended with the kernel of the gradient
// noise. Returns the blended wave as (cos, sin) of its phase times its strength, which is 1 where the waves
// agree and less where they cancel. With k = 0 every wave is at its crest: (1, 0).
fn gullies(p: vec2f, k: vec2f, seed: u32) -> vec2f {
  let q = clamp(p, vec2f(-generateNoise_LIMIT), vec2f(generateNoise_LIMIT));
  let cell = floor(q + (q.x + q.y) * 0.366025404);
  let i = vec2i(cell);
  let x0 = (q - cell) + (cell.x + cell.y) * 0.211324865;
  let o = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  let x1 = x0 - o + 0.211324865;
  let x2 = x0 - 0.577350269;
  let t = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3f(0.0));
  let t2 = t * t;
  let w = t2 * t2;
  let a0 = hash_unit2(hash_cell(i, seed)) - vec2f(0.5);
  let a1 = hash_unit2(hash_cell(i + vec2i(o), seed)) - vec2f(0.5);
  let a2 = hash_unit2(hash_cell(i + vec2i(1, 1), seed)) - vec2f(0.5);
  let phase = TAU * vec3f(dot(k, x0 - a0), dot(k, x1 - a1), dot(k, x2 - a2));
  return vec2f(dot(w, cos(phase)), dot(w, sin(phase))) / (w.x + w.y + w.z);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  var q = generateNoise_lattice(uv, P.cells);
  let n = clamp(P.octaves, 1, generateNoise_MAX_OCTAVES);
  var sum = 0.0;
  var norm = 0.0;
  var power = 0.0;
  var amp = 1.0;
  var finer = 1.0;                      // how much finer this octave is than the first
  var turned = vec2f(1.0, 0.0);         // how far its lattice is turned against the first, as (cos, sin)
  var slope = vec2f(0.0);               // of the plain octaves so far, in lattice units of the first octave
  var flow = vec2f(0.0);                // the slope the gullies run down: the massif's, and the walls of the gullies so far
  var level = 0.5;                      // the height of the massif, 0..1
  var fading = 1.0;                     // what a gully octave keeps of its depth: each a share of the one before
  for (var i = 0; i < generateNoise_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    let s = generateNoise_octaveSeed(seedFor(0u), i);
    let at = q + generateNoise_shift(s);
    let nd = generateNoise_simplexD(at, s);
    // The derivative in the lattice of the first octave.
    let d = (amp * finer) * vec2f(nd.y * turned.x + nd.z * turned.y, nd.z * turned.x - nd.y * turned.y);
    if (i < MASSIF) {
      sum += amp * nd.x;
      slope += d;
      flow += d;
      level = 0.5 + 0.5 * sum / (norm + amp);
    } else {
      // A plain octave is held back where the terrain is steep and where the massif lies low: its detail
      // stays on the crests and leaves the slopes, which the gullies take, and the valley floors.
      let high = saturate((level - 0.15) / 0.7);
      let keep = mix(1.0, 2.0 * high * high * (3.0 - 2.0 * high) / (1.0 + DAMPING * dot(slope, slope) / (STEEP * STEEP)), P.erosion);
      // The gullies of this octave run down the slope: their wave vector lies along the contour.
      let steep = dot(flow, flow);
      let along = vec2f(flow.y, -flow.x) * inverseSqrt(steep + STEEP * STEEP);     // length 0 on level ground, 1 on steep
      let k = STRIPES * vec2f(along.x * turned.x - along.y * turned.y, along.x * turned.y + along.y * turned.x);
      let wave = gullies(at, k, generateNoise_octaveSeed(seedFor(1u), i));
      // The profile across the gullies, by the phase of the blended wave: VARIANT picks it.
      let size = sqrt(dot(wave, wave) + 1.0e-12);
      let c = wave.x / size;
      let down = (1.0 - c) * 0.5;
      var profile = c;
      if (VARIANT == 1) { profile = (sqrt(1.0 - down + SHARP * SHARP) - sqrt(down + SHARP * SHARP)) / (sqrt(1.0 + SHARP * SHARP) - SHARP); }
      if (VARIANT == 2) { profile = CREST - 2.0 * (sqrt(down + SHARP * SHARP) - SHARP) / (sqrt(1.0 + SHARP * SHARP) - SHARP); }
      if (VARIANT == 3) { profile = 2.0 * (sqrt(1.0 - down + SHARP * SHARP) - SHARP) / (sqrt(1.0 + SHARP * SHARP) - SHARP) - CREST; }
      let strength = P.erosion * DEPTH * fading * dot(along, along) * smoothstep(0.1, 0.4, level);
      sum += amp * (keep * nd.x + strength * min(size, 1.0) * profile);
      slope += keep * d;
      flow += (BRANCH * strength * amp * finer * TAU * STRIPES) * (-wave.y) * along;
      fading *= FADE;
    }
    norm += amp;
    power += amp * amp;
    amp *= P.gain;
    finer *= 2.0;
    q = generateNoise_turn(q) * 2.0;
    turned = generateNoise_turn(turned);
  }
  let h = 0.5 + generateNoise_soften(SPREAD * (1.0 + LIFT * P.erosion) * sum / sqrt(power), KNEE, ROOM);
  return pow(max(h, 1.0e-6), 1.0 + HOLLOW * P.erosion);
}`,
});

export default defineNode({
  type: 'generate/eroded-noise',
  title: 'Eroded Noise',
  category: 'generate',
  description: 'Generates mountains with gullied slopes, sharp crests and smooth valley floors, as erosion leaves them.',
  keywords: ['erosion', 'mountains', 'ridges', 'valleys', 'gullies', 'alpine', 'fbm', 'noise'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size(),
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.75, min: 0, max: 1,
      help: 'Larger values cut deeper gullies into the slopes and smooth more of the valley floors. At 0 the result is plain fractal noise.',
    },
    param.octaves(),
    param.gain({ help: 'Larger values make the fine gullies and the detail on the crests stronger.' }),
    param.seed(),
  ],
  kernels: [eroded],
  evaluate(ctx) {
    const { size, octaves, gain, erosion } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(eroded, {
      out: { out },
      params: { cells: 1 / Math.max(size, 0.001), octaves, gain, erosion },   // size is soft: 0 and negative values arrive
      cost: 20 * octaves,
    });
    ctx.output('out', out);
  },
});
