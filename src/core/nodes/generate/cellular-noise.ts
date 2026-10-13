// src/core/nodes/generate/cellular-noise.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateNoise } from './_noise.ts';

const cellular = defineKernel({
  name: 'generate/cellular-noise',
  outputs: { out: 'field' },
  params: { cells: 'f32', jitter: 'f32', mode: 'u32' },
  includes: [generateNoise],
  cost: 64,
  code: /* wgsl */ `
// Heights follow the value up to 0.9 and bend from there towards 1, which they never reach: distances are
// in feature sizes, and only one texel in a hundred is further than 0.9 from its feature point.
const KNEE = 0.9;
const ROOM = 0.1;

// The feature point of a cell, from the cell's corner: the centre of the cell, moved by up to half a cell each way.
fn feature(c: vec2i, seed: u32) -> vec2f {
  return vec2f(0.5) + (hash_unit2(hash_cell(c, seed)) - vec2f(0.5)) * P.jitter;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let p = clamp((uv - vec2f(0.5)) * P.cells, vec2f(-generateNoise_LIMIT), vec2f(generateNoise_LIMIT));
  let cell = vec2i(floor(p));
  let f = p - floor(p);
  let seed = seedFor(0u);
  // The 5 x 5 cells around p hold its two nearest feature points for certain: the nearest is within 1.42
  // and the second within 1.81, and every point outside them is at least 2 away.
  var first = 64.0;                     // squared distances
  var second = 64.0;
  var nearest = vec2f(0.0);
  var home = vec2i(0);
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let o = vec2i(i, j);
      let d = vec2f(o) + feature(cell + o, seed) - f;
      let d2 = dot(d, d);
      if (d2 < first) { second = first; first = d2; nearest = d; home = o; } else if (d2 < second) { second = d2; }
    }
  }
  var value = sqrt(first);              // 0: distance
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { value = 0.75 * sqrt(second); }
    case 2u: {
      // The distance to the nearest wall: to the line half way between the nearest point and each other one.
      // A point outside the 5 x 5 cells could own the nearest wall only across a gap wider than the cells
      // leave: against the 7 x 7 cells, four million points gave the same wall every time.
      var wall = 64.0;
      for (var j = -2; j <= 2; j++) {
        for (var i = -2; i <= 2; i++) {
          let o = vec2i(i, j);
          if (any(o != home)) {
            let d = vec2f(o) + feature(cell + o, seed) - f;
            let across = d - nearest;
            let span = dot(across, across);
            // Two points that float32 cannot tell apart have no line between them.
            if (span > 1.0e-12) { wall = min(wall, dot(0.5 * (nearest + d), across) / sqrt(span)); }
          }
        }
      }
      value = 2.0 * max(wall, 0.0);
    }
    case 3u: { return hash_unit(hash_cell(cell + home, seedFor(1u))); }
    default: {}
  }
  return generateNoise_soften(value, KNEE, ROOM);
}`,
});

export default defineNode({
  type: 'generate/cellular-noise',
  title: 'Cellular Noise',
  category: 'generate',
  description: 'Generates a pattern of cells around scattered points: pits, mounds, a web of walls or flat plates.',
  keywords: ['voronoi', 'worley', 'cells', 'cracks', 'honeycomb', 'scales', 'crystal', 'mosaic', 'noise'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'distance',
      options: [
        { value: 'distance', label: 'Distance' },
        { value: 'second', label: 'Second distance' },
        { value: 'edge', label: 'Edge distance' },
        { value: 'cell', label: 'Cell value' },
      ],
      help: 'Height by the distance to the nearest point, to the second nearest, or to the wall of the cell, or one random height per cell.',
    },
    param.size({ default: 0.125, help: 'Larger values give larger cells.' }),
    {
      kind: 'float', name: 'jitter', label: 'Jitter', unit: 'ratio', default: 1, min: 0, max: 1,
      help: 'Larger values scatter the points more freely. Without jitter the cells are squares in rows.',
    },
    param.seed(),
  ],
  kernels: [cellular],
  evaluate(ctx) {
    const { size, jitter } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(cellular, {
      out: { out },
      params: { cells: 1 / Math.max(size, 0.001), jitter, mode: ctx.enumIndex('mode') },   // size is soft: 0 and negative values arrive
      cost: ctx.params.mode === 'edge' ? 128 : 64,
    });
    ctx.output('out', out);
  },
});
