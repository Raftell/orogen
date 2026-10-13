// src/core/nodes/surface/ripples.ts
import { defineKernel, defineNode, hash, ops, param } from '../../api.ts';
import { slopeBand, surfaceSlope } from './_slope.ts';

/** The constants of the kernel, which the tests read. */
export const RIPPLES = {
  /** Ripples per cell of the lattice whose points each carry a patch of ripples. */
  waves: 3,
  /** How far a patch reaches from its point, in cells. */
  reach: 1.25,
  /** At full irregularity: how far the ripples of a patch are turned off the wind, in radians, at the most. */
  turn: 0.45,
  /** How much longer or shorter than the size the ripples of a patch are, at the most. */
  stretch: 0.25,
  /** How far a patch is out of step with the others, as a part of a ripple, at the most. */
  shift: 0.5,
  /** How much of the second harmonic the profile has: it makes the side the wind climbs twice as long as the lee side. */
  skew: 1,
  /** The height of the profile grows by this much with the skew: 1 + 0.3 skew is its largest value before it is divided out. */
  skewGain: 0.3,
  /** A ripple of this many texels or fewer is left out, and one of twice as many is whole. */
  texels: 2.5,
  /** A ripple of this many texels or fewer is drawn with even sides, and one of twice as many with its lee side. */
  skewTexels: 4,
  /** The angle below the upper slope over which the ripples fade. */
  feather: 15,
  /** The slope is that of the terrain smoothed over this part of the size. */
  ground: 0.5,
} as const;

const ripples = defineKernel({
  name: 'surface/ripples',
  // src: the terrain. ground: the terrain smoothed, whose slope says where sand lies.
  inputs: { src: 'field', ground: 'field' },
  outputs: { out: 'field' },
  // cells: lattice cells across the terrain. wind: the unit vector the wind blows along. half: half the height of
  // a ripple. skew: how uneven its two sides are. band: the slopes over which the ripples fade.
  params: { cells: 'f32', wind: 'vec2f', half: 'f32', irregularity: 'f32', skew: 'f32', band: 'vec4f' },
  includes: [hash, surfaceSlope],
  // The terrain, its slope, and nine patches at a hash and a wave each.
  cost: 6 + 9 * 3,
  code: /* wgsl */ `
const TAU = 6.283185307;
const WAVES = ${RIPPLES.waves}.0;
const REACH = ${RIPPLES.reach};
const TURN = ${RIPPLES.turn};
const STRETCH = ${RIPPLES.stretch};
const SHIFT = ${RIPPLES.shift};
const SKEW_GAIN = ${RIPPLES.skewGain};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let z = src_at(px);
  // Sand lies on gentle ground.
  let keep = surfaceSlope_below(length(slopeAt(ground, px)), P.band);
  if (keep <= 0.0) { return z; }

  // Every point of a lattice carries a patch of ripples, and where patches overlap their waves are added as
  // turning pointers. Without irregularity all patches are cut from one wave train and the sum is that train.
  // With it each patch is turned a little, has its own length of ripple and is out of step: where neighbours
  // agree the ripples run through, and where they do not a crest ends or forks, as on real sand.
  let p = clamp(uv * P.cells, vec2f(-1.0e8), vec2f(1.0e8));
  let cell = vec2i(floor(p));
  var sum = vec2f(0.0);
  var total = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = cell + vec2i(i, j);
      let h = hash_cell(c, seedFor(0u));
      let h2 = hash_u32(h);
      let point = vec2f(c) + vec2f(0.25) + 0.5 * hash_unit2(h);
      let d = p - point;
      let near = max(1.0 - dot(d, d) / (REACH * REACH), 0.0);
      let w = near * near * near;
      let odd = P.irregularity * (2.0 * hash_unit2(h2) - vec2f(1.0));
      let turn = TURN * odd.x;
      let along = vec2f(P.wind.x * cos(turn) - P.wind.y * sin(turn), P.wind.x * sin(turn) + P.wind.y * cos(turn));
      let step = SHIFT * P.irregularity * (2.0 * hash_unit(hash_u32(h2)) - 1.0);
      let phase = TAU * (WAVES * (dot(P.wind, point) + (1.0 + STRETCH * odd.y) * dot(along, d)) + step);
      sum += w * vec2f(cos(phase), sin(phase));
      total += w;
    }
  }
  let len = length(sum);
  let wave = sum / max(len, 1.0e-9);
  // The profile of a ripple: the wind climbs its long side and drops over the short one. A sine with its
  // second harmonic, which puts the crest two thirds of the way along. Where the patches cancel there is no ripple.
  let profile = wave.y * (1.0 - P.skew * wave.x) / (1.0 + SKEW_GAIN * P.skew);
  return z + P.half * keep * smoothstep(0.1, 0.5, len / max(total, 1.0e-9)) * profile;
}`,
});

export default defineNode({
  type: 'surface/ripples',
  title: 'Ripples',
  category: 'surface',
  description: 'Lays small ripples across gentle ground, as wind leaves them in sand: a long windward side, a short lee side, crests that end and fork.',
  keywords: ['sand', 'wind', 'waves', 'dunes', 'aeolian', 'ridges', 'corrugation', 'washboard'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size({ label: 'Ripple length', default: 0.04, help: 'How far it is from one crest to the next.' }),
    param.angle({ label: 'Wind direction', help: 'The direction the wind blows to. The crests lie across it, and the short, steep side of every ripple faces that way.' }),
    param.height({ default: 0.016, help: 'How far a crest stands above the trough beside it.' }),
    {
      kind: 'float', name: 'irregularity', label: 'Irregularity', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values let the crests wander, end and fork. At 0 they are straight and even.',
    },
    param.slope('slopeMax', { label: 'Upper slope', default: 55, help: 'Ripples lie on ground no steeper than this, and fade towards it.' }),
    param.seed(),
  ],
  kernels: [ripples],
  maskable: true,
  evaluate(ctx) {
    const { irregularity, slopeMax } = ctx.params;
    const src = ctx.input('in');
    // Soft parameters: any finite number can arrive.
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 4);
    const height = Math.min(Math.max(ctx.params.height, 0), 4);
    // Ripples the grid cannot hold are left out, and those it can barely hold have even sides: the lee side
    // is a wave of half the length.
    const texels = ctx.lengthToPx(size);
    const held = smooth(texels / RIPPLES.texels - 1);
    if (height * held <= 0) {
      ctx.output('out', src);
      return;
    }
    const turn = (ctx.params.angle * Math.PI) / 180;
    // How steep the ground is, without the ripples of an earlier pass and what else is smaller than they are.
    const ground = ops.smooth(ctx, src, RIPPLES.ground * size);
    const out = ctx.alloc('field');
    ctx.run(ripples, {
      in: { src, ground },
      out: { out },
      params: {
        cells: 1 / (size * RIPPLES.waves),
        wind: [Math.cos(turn), Math.sin(turn)],
        half: 0.5 * height * held,
        irregularity,
        skew: RIPPLES.skew * smooth(texels / RIPPLES.skewTexels - 1),
        band: slopeBand(slopeMax - RIPPLES.feather, slopeMax),
      },
    });
    ctx.release(ground);
    ctx.output('out', out);
  },
});

/** The smooth step of t between 0 and 1. */
function smooth(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}
