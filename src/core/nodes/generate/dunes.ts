// src/core/nodes/generate/dunes.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand } from './_land.ts';

const dunes = defineKernel({
  name: 'generate/dunes',
  outputs: { out: 'field' },
  params: { mode: 'u32', wind: 'vec2f', invSize: 'f32', height: 'f32', irregularity: 'f32' },
  includes: [generateLand],
  cost: 96,
  code: /* wgsl */ `
// The crest of a transverse dune lies this far along its wavelength: the windward slope takes the part before
// it, the slip face the rest.
const CREST = 0.74;

// The height of a dune at the position u = 0..1 along its wavelength, downwind: a long convex windward slope up to
// the brink, then the slip face straight down to the next trough.
fn ridge(u: f32) -> f32 {
  let up = sin(1.5707963 * saturate(u / CREST));
  let down = saturate((1.0 - u) / (1.0 - CREST));
  return min(pow(up, 1.3), down);
}

// Dunes in long ridges across the wind. p is in wavelengths, x downwind. The ridges are waves of one global
// phase, so they line up across the whole field; irregularity lets a field of random phasors shift that phase
// from place to place, which bends the crests, and where the phasors cancel a ridge ends or forks.
fn transverse(p: vec2f) -> f32 {
  let bend = P.irregularity * 0.9 * noise_fbm(p * 0.21 + vec2f(3.3, 7.7), seedFor(1u), 3, 2.0, 0.5);
  let q = p * 0.4;                                   // the phasors stand 2.5 wavelengths apart
  let cell = vec2i(floor(q));
  let f = q - floor(q);
  var acc = vec2f(0.0);
  var total = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2i(i, j);
      let h = hash_cell(cell + o, seedFor(2u));
      let d = f - (vec2f(o) + vec2f(0.25) + 0.5 * hash_unit2(h));
      let w1 = max(1.0 - dot(d, d) / 1.5625, 0.0);
      let w = w1 * w1 * w1;
      let shift = generateLand_TAU * 1.5 * P.irregularity * hash_unit(hash_u32(h ^ 0x9e3779b9u));
      acc += w * vec2f(cos(shift), sin(shift));
      total += w;
    }
  }
  let mean = acc / max(total, 1.0e-6);
  let strength = length(mean);
  // The phase of the mean phasor in turns; where the phasors cancel it is undefined, and the dunes are flat there.
  let turn = select(0.0, atan2(mean.y, mean.x) / generateLand_TAU, strength > 1.0e-5);
  let u = fract(p.x + bend + turn);
  // Irregular dunes also differ in height along their crests; regular ones all reach the full height.
  let tall = 1.0 - min(2.0 * P.irregularity, 1.0) * (0.28 - 0.28 * noise_fbm(p * 0.33 + vec2f(1.9, 4.6), seedFor(3u), 2, 2.0, 0.5));
  return ridge(u) * tall * smoothstep(0.0, 0.45, strength);
}

// Sand meets the ground at a tangent: the foot of a dune h is drawn out, and its top keeps 0.9 of its height.
fn toe(h: f32) -> f32 { return h * h / (h + 0.11); }

// One crescent dune in its own frame: x downwind, the body 1 wide to either side. A low dome, out of which the
// slip face is cut along a circle that lies downwind: what is left of the dome beside that circle are the horns.
fn crescent(q: vec2f) -> f32 {
  let dome = 1.0 - q.x * q.x / 1.21 - q.y * q.y;
  let face = 3.6 * (length(q - vec2f(0.72, 0.0)) - 0.78);
  return toe(max(min(dome, face), 0.0));
}

// Barchans: crescents on bare ground, in rows across the wind, every other row shifted by half a place.
fn barchans(p: vec2f) -> f32 {
  let q = p / 1.9;
  let row = floor(q.x);
  var best = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let r = i32(row) + i;
      let stagger = 0.5 * f32(r & 1);
      let c = vec2i(r, i32(floor(q.y - stagger)) + j);
      let h = hash_cell(c, seedFor(4u));
      let rnd = hash_unit2(h);
      let more = hash_unit2(hash_u32(h ^ 0x9e3779b9u));
      // Irregularity moves the dunes off their places, varies their size and leaves some places empty.
      if (more.y < 0.45 * P.irregularity) { continue; }
      let centre = vec2f(f32(c.x), f32(c.y) + stagger) + vec2f(0.5) + P.irregularity * 0.55 * (rnd - vec2f(0.5));
      let size = 1.0 - 0.5 * P.irregularity * more.x;
      // A dune 0.42 of a place in half-width; a smaller dune is lower in proportion.
      best = max(best, size * crescent((q - centre) / (0.42 * size)));
    }
  }
  return best;
}

// Star dunes: pyramids with three to five sinuous arms, where the wind turns through the year.
fn stars(p: vec2f) -> f32 {
  let q = p / 2.1;
  let home = vec2i(floor(q));
  var best = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = home + vec2i(i, j);
      let h = hash_cell(c, seedFor(5u));
      let rnd = hash_unit2(h);
      let more = hash_unit2(hash_u32(h ^ 0x9e3779b9u));
      let centre = vec2f(c) + vec2f(0.5) + P.irregularity * 0.6 * (rnd - vec2f(0.5));
      let size = 1.0 - 0.45 * P.irregularity * more.x;
      let d = (q - centre) / (0.74 * size);
      let rho = length(d);
      if (rho >= 1.0) { continue; }
      let arms = 3.0 + floor(3.0 * more.y);
      let sector = generateLand_TAU / arms;
      // The arms curl: their direction turns with the distance from the summit, one way or the other.
      let curl = (rnd.x - 0.5) * 2.4 * P.irregularity + 0.5;
      let angle = select(0.0, atan2(d.y, d.x), rho > 1.0e-6) - curl * rho + generateLand_TAU * rnd.y;
      let off = abs(fract(angle / sector + 0.5) - 0.5) * sector;   // the angle to the nearest arm
      let along = rho * cos(off);
      let across = rho * sin(off);
      // An arm's crest falls from the summit to its tip, and its sides fall away from the crest; the arms rise
      // out of a low mound of sand.
      let arm = pow(max(1.0 - along, 1.0e-6), 1.25) - 1.35 * across;
      let mound = 0.45 * (1.0 - rho) * (1.0 - rho);
      best = max(best, size * toe(max(max(arm, mound), 0.0)));
    }
  }
  return best;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = uv - vec2f(0.5);
  let p = vec2f(dot(d, P.wind), dot(d, vec2f(-P.wind.y, P.wind.x))) * P.invSize;
  var h = 0.0;
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { h = barchans(p); }
    case 2u: { h = stars(p); }
    default: { h = transverse(p); }
  }
  return P.height * h;
}`,
});

export default defineNode({
  type: 'generate/dunes',
  title: 'Dunes',
  category: 'generate',
  description: 'Generates a field of wind-shaped dunes with gentle windward slopes and steep slip faces.',
  keywords: ['sand', 'desert', 'barchan', 'erg', 'wind', 'ripples'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Dune type', default: 'transverse',
      options: [
        { value: 'transverse', label: 'Transverse ridges' },
        { value: 'barchan', label: 'Barchans' },
        { value: 'star', label: 'Star dunes' },
      ],
      help: 'Long ridges across the wind, separate crescents with horns downwind, or pyramids with arms.',
    },
    param.size({ label: 'Dune spacing', default: 0.11, min: 0.01, max: 1, help: 'Larger values set the dunes further apart and make each one broader.' }),
    param.angle({ label: 'Wind direction', default: 20, help: 'The direction the wind blows to: slip faces look that way.' }),
    param.height({ default: 0.07, help: 'Larger values pile the dunes higher, which also steepens their faces.' }),
    {
      kind: 'float', name: 'irregularity', label: 'Irregularity', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values bend the crests, vary the dunes in size and break their ranks; 0 gives a perfectly regular field.',
    },
    param.seed(),
  ],
  kernels: [dunes],
  evaluate(ctx) {
    const { size, angle, height, irregularity } = ctx.params;
    const turn = (angle * Math.PI) / 180;
    const out = ctx.alloc('field');
    ctx.run(dunes, {
      out: { out },
      params: {
        mode: ctx.enumIndex('mode'),
        wind: [Math.cos(turn), Math.sin(turn)],
        invSize: 1 / Math.max(size, 0.001),
        height,
        irregularity,
      },
    });
    ctx.output('out', out);
  },
});
