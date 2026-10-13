// src/core/nodes/generate/fractal-noise.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateNoise, warpReach } from './_noise.ts';

/** The share of the warp each octave keeps of the one before (WARP_FADE in the kernel). */
export const WARP_FADE = 0.7;

const fractal = defineKernel({
  name: 'generate/fractal-noise',
  outputs: { out: 'field' },
  params: { cells: 'f32', octaves: 'i32', gain: 'f32', lacunarity: 'f32', warpCells: 'f32', warpReach: 'f32', mode: 'u32' },
  includes: [generateNoise],
  code: /* wgsl */ `
// How far the crease of a folded octave is rounded, in units of the noise: sharp to the eye, and without the
// corner that no grid can sample.
const CREASE = 0.05;
// Fixed normalisation (engine.md 1.7), measured over 60 seeds: the mean of a folded octave, and the factors
// that bring the sum, whose spread does not depend on the roughness or the octaves, to a standard deviation
// of 0.166 around 0.5.
const FOLD_MEAN = 0.444;
const SPREAD_PLAIN = 0.31;
const SPREAD_FOLDED = 0.6;
// Heights follow the sum up to 0.1 and 0.9 and bend from there towards 0 and 1, which they never reach.
const KNEE = 0.4;
const ROOM = 0.1;
// Each octave follows the warp by this much less than the one before: the broad shapes bend and swirl, and
// the fine detail on them is not drawn out into streaks.
const WARP_FADE = ${WARP_FADE};

// |n| with its crease rounded: 0 at 0 and 1 at 1.
fn fold(n: f32) -> f32 { return (sqrt(n * n + CREASE * CREASE) - CREASE) / (sqrt(1.0 + CREASE * CREASE) - CREASE); }

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The lattice coordinates of an octave are those of the unwarped point plus its share of the displacement.
  var q = generateNoise_lattice(uv, P.cells);
  var bend = generateNoise_lattice(generateNoise_warp(uv, P.warpCells, P.warpReach, seedFor(1u)), P.cells) - q;
  let n = clamp(P.octaves, 1, generateNoise_MAX_OCTAVES);
  var sum = 0.0;
  var norm = 0.0;
  var power = 0.0;
  var amp = 1.0;
  var weight = 1.0;
  for (var i = 0; i < generateNoise_MAX_OCTAVES; i++) {
    if (i >= n) { break; }
    let s = generateNoise_octaveSeed(seedFor(0u), i);
    let v = generateNoise_simplex(q + bend + generateNoise_shift(s), s);
    var shaped = v;                                           // 0: fbm
    if (P.mode == 1u) {
      // Ridged: a crest where the octave crosses 0, and each octave only as strong as the terrain summed so
      // far stands high: full from half height up, so that crests and flanks carry the detail and the valley
      // floors stay smooth.
      let crest = max(1.0 - fold(v), 0.0);
      shaped = crest * sqrt(crest) * weight;
      let rise = saturate(2.0 * (sum + amp * shaped) / (norm + amp));
      weight = rise * (2.0 - rise);
    }
    if (P.mode == 2u) { shaped = fold(v) - FOLD_MEAN; }       // billow: a crease where the octave crosses 0
    sum += amp * shaped;
    norm += amp;
    power += amp * amp;
    amp *= P.gain;
    q = generateNoise_turn(q) * P.lacunarity;
    bend = generateNoise_turn(bend) * (P.lacunarity * WARP_FADE);
  }
  // Ridged octaves lie in 0..1 and so does their weighted mean.
  if (P.mode == 1u) { return sum / norm; }
  // The others are divided by the root of the summed squares, not by the summed amplitudes: the octaves are
  // independent, so the spread of the heights is the same for every roughness and every number of octaves.
  let spread = select(SPREAD_FOLDED, SPREAD_PLAIN, P.mode == 0u);
  return 0.5 + generateNoise_soften(spread * sum / sqrt(power), KNEE, ROOM);
}`,
});

export default defineNode({
  type: 'generate/fractal-noise',
  title: 'Fractal Noise',
  category: 'generate',
  description: 'Generates rolling, ridged or billowing terrain from layers of noise, each finer than the one before.',
  keywords: ['perlin', 'simplex', 'fbm', 'noise', 'ridged', 'billow', 'turbulence', 'multifractal', 'warp'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'fbm',
      options: [
        { value: 'fbm', label: 'Rolling' },
        { value: 'ridged', label: 'Ridged' },
        { value: 'billow', label: 'Billow' },
      ],
      help: 'Rolling gives hills and hollows alike, Ridged sharp crests over smooth valley floors, Billow round hills over sharp creases.',
    },
    param.size(),
    param.octaves(),
    // Not the canonical 0.5: these heights fill the whole range, and at 0.5 a terrain of the project's default
    // proportions (half as high as wide) is a field of spikes in the 3D view. 0.45 reads as mountains.
    param.gain({ default: 0.45 }),
    {
      kind: 'float', name: 'lacunarity', label: 'Lacunarity', unit: 'none', default: 2, min: 1.5, max: 4, step: 0.1,
      help: 'How much finer each layer is than the one before. Larger values leave wider gaps between the sizes of the features.',
    },
    param.strength({ name: 'warpStrength', label: 'Warp', default: 0, group: 'Warp', help: 'Larger values bend and swirl the features further out of shape.' }),
    param.size({ name: 'warpSize', label: 'Warp size', default: 0.5, group: 'Warp', help: 'Larger values bend the features in broader curves and move them further.' }),
    param.seed(),
  ],
  kernels: [fractal],
  evaluate(ctx) {
    const { size, octaves, gain, lacunarity, warpStrength, warpSize } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(fractal, {
      out: { out },
      params: {
        cells: 1 / Math.max(size, 0.001),              // both sizes are soft: 0 and negative values arrive
        octaves,
        gain,
        lacunarity,
        warpCells: 1 / Math.max(warpSize, 0.001),
        warpReach: warpReach(warpStrength, warpSize),
        mode: ctx.enumIndex('mode'),
      },
      cost: 8 * octaves + (warpStrength > 0 ? 32 : 0),
    });
    ctx.output('out', out);
  },
});
