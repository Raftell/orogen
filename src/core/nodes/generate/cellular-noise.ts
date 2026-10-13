// src/core/nodes/generate/cellular-noise.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateNoise } from './_noise.ts';

/** The feature points lie on a triangular lattice, one to a hexagonal cell of area 1: these are its measures, in feature sizes. */
export const CELLS = {
  /** From a lattice point to each of its six neighbours: sqrt(2 / sqrt(3)). */
  pitch: 1.0745699318,
  /** From one row of lattice points to the next: pitch * sqrt(3) / 2. */
  row: 0.9306048591,
  /** From the centre of a cell to its corners: pitch / sqrt(3). */
  corner: 0.6204032394,
} as const;

const cellular = defineKernel({
  name: 'generate/cellular-noise',
  outputs: { out: 'field' },
  params: { cells: 'f32', jitter: 'f32', mode: 'u32' },
  includes: [generateNoise],
  cost: 48,
  code: /* wgsl */ `
const PITCH = ${CELLS.pitch};
const ROW = ${CELLS.row};
const CORNER = ${CELLS.corner};
// Heights follow the value up to 0.9 and bend from there towards 1, which they never reach: distances are
// in feature sizes, and only one texel in a hundred is further than 0.9 from its feature point.
const KNEE = 0.9;
const ROOM = 0.1;
// Coordinates beyond this are clamped before they become lattice points: every sum of two of them is an i32.
const FAR = 5.0e8;
// From the centre of a cell to every second of its corners: the cell is the three rhombi that two of these span.
const SPOKES = array<vec2f, 3>(vec2f(0.0, CORNER), vec2f(-0.866025404 * CORNER, -0.5 * CORNER), vec2f(0.866025404 * CORNER, -0.5 * CORNER));

// Lattice point (i, j) lies at i (PITCH, 0) + j (PITCH / 2, ROW): rows along x, every row half a pitch against
// the one before. Its cell, the ground nearer to it than to any other lattice point, is a regular hexagon
// with a corner straight above and below the point.
fn centre(site: vec2i) -> vec2f { return vec2f((f32(site.x) + 0.5 * f32(site.y)) * PITCH, f32(site.y) * ROW); }

// The lattice point nearest to p.
fn nearestSite(p: vec2f) -> vec2i {
  let z = p.y / ROW;
  let x = p.x / PITCH - 0.5 * z;
  let y = -x - z;
  var rx = floor(x + 0.5);
  let ry = floor(y + 0.5);
  var rz = floor(z + 0.5);
  let dx = abs(rx - x);
  let dy = abs(ry - y);
  let dz = abs(rz - z);
  if (dx > dy && dx > dz) { rx = -ry - rz; } else if (dz >= dy) { rz = -rx - ry; }
  return vec2i(i32(rx), i32(rz));
}

// The feature point of a lattice point, from that point: anywhere in its cell with equal chance at full jitter,
// so that the points cover the terrain evenly, and on the lattice point itself without. Scattered over a disc
// instead, they leave more of the lattice in the pattern: measured, 1.3 to 2.2 times the trace of this.
fn feature(site: vec2i, seed: u32) -> vec2f {
  let h = hash_cell(site, seed);
  let h2 = hash_u32(h);
  let rhombus = hash_u32(h2) % 3u;
  return (hash_unit(h) * SPOKES[rhombus] + hash_unit(h2) * SPOKES[(rhombus + 1u) % 3u]) * P.jitter;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let p = clamp((uv - vec2f(0.5)) * P.cells, vec2f(-FAR), vec2f(FAR));
  let home = nearestSite(p);
  let origin = centre(home) - p;        // p lies in the cell of home: no further than CORNER from it
  let seed = seedFor(0u);
  // The lattice points up to two steps from home hold the two feature points nearest to p. A feature point is
  // within CORNER of its lattice point and p within CORNER of home, so the nearest is within 2 CORNER of p and
  // the second within CORNER of the lattice point next nearest to p. A lattice point three steps from home is
  // 2.84 from it or more, and its feature point further from p than both, wherever p lies in its cell.
  var first = 64.0;                     // squared distances
  var second = 64.0;
  var nearest = vec2f(0.0);
  var owner = vec2i(0);
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      if (abs(i + j) > 2) { continue; }
      let o = vec2i(i, j);
      let d = origin + centre(o) + feature(home + o, seed);
      let d2 = dot(d, d);
      if (d2 < first) { second = first; first = d2; nearest = d; owner = o; } else if (d2 < second) { second = d2; }
    }
  }
  var value = sqrt(first);              // 0: distance
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { value = 0.75 * sqrt(second); }
    case 2u: {
      // The distance to the nearest wall: to the line half way between the nearest point and each other one.
      // Against a search six steps wide, these 19 lattice points gave the same wall at three million points.
      var wall = 64.0;
      for (var j = -2; j <= 2; j++) {
        for (var i = -2; i <= 2; i++) {
          let o = vec2i(i, j);
          if (abs(i + j) > 2 || all(o == owner)) { continue; }
          let d = origin + centre(o) + feature(home + o, seed);
          let across = d - nearest;
          let span = dot(across, across);
          // Two points that float32 cannot tell apart have no line between them.
          if (span > 1.0e-12) { wall = min(wall, dot(0.5 * (nearest + d), across) / sqrt(span)); }
        }
      }
      value = 2.0 * max(wall, 0.0);
    }
    case 3u: { return hash_unit(hash_cell(home + owner, seedFor(1u))); }
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
      help: 'Larger values scatter the points more freely. Without jitter the cells are a honeycomb.',
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
      cost: ctx.params.mode === 'edge' ? 96 : 48,
    });
    ctx.output('out', out);
  },
});
