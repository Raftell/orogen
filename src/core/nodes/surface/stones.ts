// src/core/nodes/surface/stones.ts
import { defineKernel, defineNode, noise, ops, param } from '../../api.ts';
import { surfaceCells } from './_cells.ts';
import { slopeBand, surfaceSlope } from './_slope.ts';

/** The constants of the kernel, which the tests read. */
export const STONES = {
  /** The side of the lattice cell that holds one stone at the most, in sizes of the largest stone. */
  spacing: 1.15,
  /** The smallest stone, as a part of the largest. Stones are mostly small: the part grows as the square of a uniform number. */
  smallest: 0.3,
  /** How much longer than wide the longest stone is. A stone keeps its area: it is narrower by as much as it is longer. */
  stretch: 1.5,
  /** How far a stone is sunk into the ground, as a part of the half height of the ball it is cut from. */
  sunk: 0.3,
  /** The faces cut off the ball: the first is the top of the stone, the others its sides. */
  faces: 4,
  /** How far from the middle of the ball the top face lies, least and most, in radii: at 1 it touches the ball, and the stone has a round top as tall as the height. */
  top: [0.7, 1],
  /** The same for a side face. */
  cut: [0.6, 0.92],
  /** How steep a face is, as a tangent on the ball before it is pressed flat: the top at the most, and the sides least and most. */
  lean: [0.3, 0.7, 1.8],
  /** How uneven the stones lie: at a density of a half, the part of the cells that hold one varies by this much either way from patch to patch. */
  cluster: 0.5,
  /** The size of those patches, in lattice cells. */
  patch: 4,
  /** The ground a stone lies on is the terrain smoothed over this part of the size. */
  ground: 0.3,
  /** The angle below the upper slope over which the stones dwindle. */
  feather: 10,
  /** The part of the density over which a stone grows from nothing to its size. */
  grow: 0.1,
  /** A stone with a radius of this many texels or fewer is left out, and one of twice as many is whole. */
  texels: 0.75,
  /** What a stone stands above the ground where the coverage is full, as a part of its height. */
  edge: 0.1,
} as const;

const stones = defineKernel({
  name: 'surface/stones',
  // src: the terrain. ground: the terrain smoothed, on which the stones lie.
  inputs: { src: 'field', ground: 'field' },
  outputs: { out: 'field', coverage: 'field' },
  // cells: lattice cells across the terrain. radius: of the largest stone, in cells. height: of the largest stone.
  // band: the slopes over which the stones dwindle. perCell: the heights a slope of 1 falls across one cell.
  // probe: how far from the middle of a stone the ground is read for its slope, a length.
  params: { cells: 'f32', radius: 'f32', density: 'f32', height: 'f32', band: 'vec4f', perCell: 'f32', probe: 'f32' },
  includes: [noise, surfaceCells, surfaceSlope],
  // The terrain; for each of nine lattice cells four hashes and the value noise of its patch; and for the stone
  // or two that reach a texel the ground under it and at four places around it, each read between four
  // texels, and a dozen hashes for its faces.
  cost: 1 + 9 * 5 + 2 * 24,
  code: /* wgsl */ `
const SMALLEST = ${STONES.smallest};
const STRETCH = ${STONES.stretch};
const SUNK = ${STONES.sunk};
const FACES = ${STONES.faces};
const TOP = vec2f(${STONES.top[0]}, ${STONES.top[1]});
const CUT = vec2f(${STONES.cut[0]}, ${STONES.cut[1]});
const LEAN = vec3f(${STONES.lean[0]}, ${STONES.lean[1]}, ${STONES.lean[2]});
const CLUSTER = ${STONES.cluster};
const PATCH = ${STONES.patch}.0;
const GROW = ${STONES.grow};
const TEXELS = ${STONES.texels};
const EDGE = ${STONES.edge};
const TAU = 6.283185307;

// The top of a stone above the place q, with the radius of the stone as the unit: a ball with flat faces cut
// off it, the first nearly level, which is the top of the stone, and the others steep, which are its sides.
// The faces are planes, so two of them meet in a straight edge, and where one runs into the ground the outline
// of the stone is straight. kind is the hash the faces are drawn from.
fn body(q: vec2f, kind: u32) -> f32 {
  var top = sqrt(max(1.0 - dot(q, q), 0.0));
  var h = kind;
  for (var i = 0; i < FACES; i++) {
    h = hash_u32(h);
    let u = hash_unit2(h);
    h = hash_u32(hash_u32(h));
    var lean = LEAN.x * u.y;
    var cut = mix(TOP.x, TOP.y, hash_unit(h));
    if (i > 0) {
      lean = mix(LEAN.y, LEAN.z, u.y);
      cut = mix(CUT.x, CUT.y, hash_unit(h));
    }
    let turn = TAU * u.x;
    // The plane whose normal leans by that tangent towards the turn and that passes the middle at the cut.
    top = min(top, cut * sqrt(1.0 + lean * lean) - lean * dot(vec2f(cos(turn), sin(turn)), q));
  }
  return top;
}

fn compute(px: vec2i, uv: vec2f) -> Out {
  let z = src_at(px);
  let last = f32(max(frame.res.x, 2u) - 1u);
  // One stone at the most in every cell of a lattice, somewhere in its cell. A stone reaches no further than
  // into the cells next to its own.
  let p = clamp(uv * P.cells, vec2f(-1.0e8), vec2f(1.0e8));
  let home = vec2i(floor(p));
  var top = z;
  var cover = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cell = home + vec2i(i, j);
      let h = hash_cell(cell, seedFor(1u));
      // The density is the part of the cells that hold a stone, and it is not the same everywhere: stones lie
      // in patches, close together in one and few in the next. At a density of 0 and of 1 there is no room for
      // that. A stone does not appear at its full size: it grows over a tenth of the density.
      let crowd = 2.0 * noise_value(vec2f(cell) / PATCH, seedFor(2u)) - 1.0;
      let density = saturate(P.density + CLUSTER * crowd * 4.0 * P.density * (1.0 - P.density));
      let grown = smoothstep(0.0, GROW, density - (1.0 - GROW) * hash_unit(h));
      if (grown <= 0.0) { continue; }
      let h2 = hash_u32(h);
      let part = hash_unit(h2);
      let radius = P.radius * mix(SMALLEST, 1.0, part * part);
      let point = surfaceCells_point(cell, seedFor(0u));
      let d = p - point;
      if (dot(d, d) >= radius * radius * STRETCH) { continue; }

      // The stone lies on the ground under its middle, tilted as that ground is: stones stay on gentle
      // ground, and towards the steepest they stay on they dwindle. The ground and its slope are read between
      // the texels, a fixed length apart, so that a stone lies the same on every grid; for a stone whose middle
      // is beyond the border, on the border.
      let middle = clamp(point / P.cells, vec2f(0.0), vec2f(1.0));
      let east = clamp(middle + vec2f(P.probe, 0.0), vec2f(0.0), vec2f(1.0));
      let west = clamp(middle - vec2f(P.probe, 0.0), vec2f(0.0), vec2f(1.0));
      let south = clamp(middle + vec2f(0.0, P.probe), vec2f(0.0), vec2f(1.0));
      let north = clamp(middle - vec2f(0.0, P.probe), vec2f(0.0), vec2f(1.0));
      // Heights per lattice cell.
      let tilt = vec2f(
        (ground_uv(east) - ground_uv(west)) / max((east.x - west.x) * P.cells, 1.0e-9),
        (ground_uv(south) - ground_uv(north)) / max((south.y - north.y) * P.cells, 1.0e-9),
      );
      let r = radius * grown * surfaceSlope_below(length(tilt) / P.perCell, P.band);
      // In texels. A stone the grid cannot hold is left out.
      let held = saturate(r / P.cells * last / TEXELS - 1.0);
      if (held <= 0.0) { continue; }

      // The stone is drawn out along one direction, pressed flat and sunk into the ground.
      let h3 = hash_u32(h2);
      let turn = TAU * hash_unit(h3);
      let h4 = hash_u32(h3);
      let drawn = sqrt(mix(1.0, STRETCH, hash_unit(h4)));
      let along = vec2f(cos(turn), sin(turn));
      let q = vec2f(dot(d, along) / drawn, dot(d, vec2f(-along.y, along.x)) * drawn) / r;
      let shape = body(q, h4);
      if (shape <= 0.0) { continue; }
      // As tall for its width as the largest stone is. What is sunk lies under the ground the stone lies on,
      // and shows where that ground has a hollow: there the side of the stone goes on down into it.
      let tall = P.height * held * r / P.radius;
      let stands = tall * (shape - SUNK) / (1.0 - SUNK);
      let stone = ground_uv(middle) + dot(tilt, p - middle * P.cells) + stands;
      top = max(top, stone);
      cover = max(cover, saturate((stone - z) / (EDGE * tall)));
    }
  }
  return Out(top, cover);
}`,
});

export default defineNode({
  type: 'surface/stones',
  title: 'Stones',
  category: 'surface',
  description: 'Scatters stones and boulders of varied size over gentle ground, in patches, each a faceted body lying on it; coverage is where they lie.',
  keywords: ['boulders', 'rocks', 'rubble', 'scree', 'pebbles', 'debris', 'scatter', 'erratics'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'coverage', type: 'field', role: 'mask' },
  ],
  params: [
    param.size({ label: 'Stone size', default: 0.04, help: 'How wide the largest stones are. Most stones are smaller, down to a third of this.' }),
    {
      kind: 'float', name: 'density', label: 'Density', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values put more stones on the ground, which lie in patches. At 1 they lie about a stone apart everywhere.',
    },
    param.height({ default: 0.06, help: 'How far the tallest stones stand above the ground. Smaller stones are lower in proportion.' }),
    param.slope('slopeMax', { label: 'Upper slope', default: 50, help: 'Stones lie on ground no steeper than this, and get smaller towards it.' }),
    param.seed(),
  ],
  kernels: [stones],
  maskable: true,
  evaluate(ctx) {
    const { density, slopeMax } = ctx.params;
    const src = ctx.input('in');
    // Soft parameters: any finite number can arrive.
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 4);
    const height = Math.min(Math.max(ctx.params.height, 0), 4);
    const coverage = ctx.wants('coverage') ? ctx.alloc('field') : null;
    // The largest stone is left out when the grid cannot hold it: then all are.
    if (density <= 0 || height <= 0 || ctx.lengthToPx(size / 2) <= STONES.texels) {
      ctx.output('out', src);
      if (coverage) {
        ctx.clear(coverage, 0);
        ctx.output('coverage', coverage);
      }
      return;
    }
    // A stone lies on the terrain without what is smaller than it is. Smoothed without anything assumed beyond
    // the border, so the ground keeps its slope there.
    const ground = ops.smooth(ctx, src, STONES.ground * size);
    const out = ctx.alloc('field');
    const cell = size * STONES.spacing;
    ctx.run(stones, {
      in: { src, ground },
      out: { out, coverage },
      params: {
        cells: 1 / cell,
        radius: 0.5 / STONES.spacing,
        density,
        height,
        band: slopeBand(slopeMax - STONES.feather, slopeMax),
        // A slope is metres per metre: across a lattice cell it falls this many heights.
        perCell: (cell * ctx.terrainSize) / ctx.heightRange,
        probe: 0.5 * STONES.ground * size,
      },
    });
    ctx.release(ground);
    ctx.output('out', out);
    if (coverage) ctx.output('coverage', coverage);
  },
});
