// src/core/nodes/surface/outcrops.ts
import { defineKernel, defineNode, noise, ops, param, type Field } from '../../api.ts';
import { CELL_SEARCH, surfaceCells } from './_cells.ts';
import { slopeBand, surfaceSlope } from './_slope.ts';

/** The constants of the kernel, which the tests read. */
export const OUTCROPS = {
  /** The layers of blocks at the most: the first of the block size, each further one smaller by the ratio. */
  layers: 4,
  /** The layers whose blocks break out of the ground; those of the further layers stand on rock alone. */
  breaking: 2,
  /** How many times smaller the blocks of a layer are than those of the layer before. */
  ratio: 2.5,
  /** The ground a layer of blocks stands on is the terrain smoothed over this part of the size of its blocks. */
  ground: 0.25,
  /** How far from the middle of a block the ground is read for its slope, in block sizes. */
  probe: 0.2,
  /** The angle over which the rock comes out of the ground, above the slope it begins at. */
  feather: 10,
  /** The side faces of a block: two across the slope and two along it. */
  faces: 4,
  /** How far a side face is turned off its direction, at the most, in radians. */
  skew: 0.35,
  /** How far from the middle of a block a side face begins, least and most, in block sizes: for the two faces across the slope. */
  reach: [0.25, 0.45],
  /** How many times further out the two faces along the slope begin: a block is longer across the slope than it is deep. */
  long: 1.3,
  /** What the top of a block keeps of the bumps and furrows the smoothing took from the terrain. */
  carry: 0.2,
  /** How steep a side face stands, in degrees. */
  face: 70,
  /** What the top of a block keeps of the slope of the ground under it, least and most: 0 is a level top. */
  lay: [0.25, 0.65],
  /** How far the top of a block is tipped to a side, at the most, as a part of the slope of the ground. */
  tip: 0.25,
  /** How far the middle of a block's top stands above the ground, least and most, in falls of the slope across a block. */
  set: [0.05, 0.3],
  /** The steepest slope a block is shaped by, as a tangent: on steeper ground the blocks get no taller. */
  steepest: 1.2,
  /** How far a block that has not come out lies under the ground: in falls of the slope across a block, and in falls of a slope of 1. */
  sink: [0.6, 0.3],
  /** The size of the patches of ground with and without rock, in block sizes, and the part of the ground that has rock. */
  patch: [5, 0.5],
  /** From how far from its middle a block is cut off, and where it ends, in block sizes: the lattice cells searched hold every block within 1.6. */
  end: [1.3, 1.55],
  /** A block of this many texels or fewer is left out, and one of twice as many is whole. */
  texels: 2,
  /** The rock on which the smaller blocks stand in full is this many times as far above the ground as that of full coverage. */
  footing: 3,
  /** What the rock stands above the ground where the coverage is full, as a part of what a slope of 1 falls across a block. */
  edge: 0.1,
} as const;

const steepness = defineKernel({
  name: 'surface/outcrops.steepness',
  // ground: the terrain smoothed, whose slope says where rock comes out.
  inputs: { ground: 'field' },
  outputs: { out: 'field' },
  // band: the slopes over which the rock comes out.
  params: { band: 'vec4f' },
  includes: [surfaceSlope],
  cost: 6,
  code: /* wgsl */ `
// How far the ground is steep enough for rock to come out of it, 0..1.
fn compute(px: vec2i, uv: vec2f) -> f32 { return surfaceSlope_above(length(slopeAt(ground, px)), P.band); }`,
});

const outcrops = defineKernel({
  name: 'surface/outcrops',
  // base: the terrain. src: the terrain with the rock of the layers before. ground: what the blocks of this layer
  // stand on: the terrain without what is smaller than they are. steep: how far the ground is steep enough for rock, 0..1.
  inputs: { base: 'field', src: 'field', ground: 'field', steep: 'field' },
  outputs: { out: 'field', coverage: 'field' },
  // cells: blocks of this layer across the terrain. strength: the part of its height above the ground a block
  // is given. perBlock: the heights a slope of 1 falls across one block of this layer. probe: how far from the
  // middle of a block the ground is read for its slope, a length. held: how much of this layer the grid holds.
  // full: the height above the ground at which the coverage is full. layer: the number of the layer.
  params: { cells: 'f32', strength: 'f32', perBlock: 'f32', probe: 'f32', held: 'f32', full: 'f32', layer: 'u32' },
  includes: [noise, surfaceCells],
  // The terrain twice and the ground; for each of the sixteen blocks that can reach a texel how steep the ground
  // is at its middle, read between four texels, and for those on steep ground an octave of noise, the ground at
  // the middle and at four places around it, and a dozen hashes.
  cost: 3 + CELL_SEARCH * CELL_SEARCH * (4 + 8 + 20 + 4),
  code: /* wgsl */ `
const FACES = ${OUTCROPS.faces};
const REACH = vec2f(${OUTCROPS.reach[0]}, ${OUTCROPS.reach[1]});
const FACE = ${Math.tan((OUTCROPS.face * Math.PI) / 180)};
const LAY = vec2f(${OUTCROPS.lay[0]}, ${OUTCROPS.lay[1]});
const TIP = ${OUTCROPS.tip};
const SET = vec2f(${OUTCROPS.set[0]}, ${OUTCROPS.set[1]});
const STEEPEST = ${OUTCROPS.steepest};
const SINK = vec2f(${OUTCROPS.sink[0]}, ${OUTCROPS.sink[1]});
const PATCH = ${OUTCROPS.patch[0]}.0;
const SHARE = ${OUTCROPS.patch[1]};
const END = vec2f(${OUTCROPS.end[0]}, ${OUTCROPS.end[1]});
const TAU = 6.283185307;
const SKEW = ${OUTCROPS.skew};
const LONG = ${OUTCROPS.long};
const CARRY = ${OUTCROPS.carry};
const BREAKING = ${OUTCROPS.breaking}u;
const FOOTING = ${OUTCROPS.footing}.0;

// How far the block around the feature point of a lattice cell stands above the height z at p (in blocks);
// below 0 where it lies under it. A block is a flat top with steep flat sides: its top is a plane through the
// ground under its middle that keeps only a part of the slope of that ground, so it stands out of the slope
// on its downhill side and goes into it uphill, and its sides are planes that fall away from the edges of the
// top. All of it is measured in falls of the slope across one block: the steeper the ground, the taller the rock.
fn block(cell: vec2i, p: vec2f, z: f32, detail: f32) -> f32 {
  let seed = seedFor(3u * P.layer);
  let point = surfaceCells_point(cell, seed);
  let d = p - point;
  let far = length(d);
  if (far >= END.y) { return -1.0; }

  let middle = clamp(point / P.cells, vec2f(0.0), vec2f(1.0));
  // Rock comes out of steep ground, in patches, and every layer of blocks has patches of its own: here large
  // blocks stand alone, there small ones, and elsewhere both. At the edge of a patch the rock comes out less
  // and less, and the blocks go under one after the other.
  let sheer = steep_uv(middle);
  if (sheer <= 0.0) { return -1.0; }
  let rocky = smoothstep(-0.15, 0.15, noise_gradient(point / PATCH, seedFor(3u * P.layer + 1u)) + 1.2 * (SHARE - 0.5));
  let shown = P.held * sheer * rocky;
  if (shown <= 0.0) { return -1.0; }

  // The ground under the block and its slope, in heights per block, read between the texels a fixed length
  // apart, so that a block stands the same on every grid; for a block whose middle is beyond the border, on it.
  let east = clamp(middle + vec2f(P.probe, 0.0), vec2f(0.0), vec2f(1.0));
  let west = clamp(middle - vec2f(P.probe, 0.0), vec2f(0.0), vec2f(1.0));
  let south = clamp(middle + vec2f(0.0, P.probe), vec2f(0.0), vec2f(1.0));
  let north = clamp(middle - vec2f(0.0, P.probe), vec2f(0.0), vec2f(1.0));
  let slope = vec2f(
    (ground_uv(east) - ground_uv(west)) / max((east.x - west.x) * P.cells, 1.0e-9),
    (ground_uv(south) - ground_uv(north)) / max((south.y - north.y) * P.cells, 1.0e-9),
  );
  let h = hash_cell(cell, seedFor(3u * P.layer + 2u));
  let h2 = hash_u32(h);
  let h3 = hash_u32(h2);
  // On ground steeper than the steepest slope a block is shaped by, it is shaped by that slope.
  let fall = slope * min(1.0, STEEPEST * P.perBlock / max(length(slope), 1.0e-9));
  let tip = TIP * (2.0 * hash_unit(h2) - 1.0) * vec2f(-fall.y, fall.x);
  let tilt = mix(LAY.x, LAY.y, hash_unit(h)) * fall + tip;
  let lift = length(fall) * (shown * mix(SET.x, SET.y, hash_unit(h3)) - (1.0 - shown) * SINK.x) - (1.0 - shown) * SINK.y * P.perBlock;
  let top = ground_uv(middle) + lift + dot(tilt, d);

  // The sides: planes as steep as a rock face stands, each from a line some way from the middle outwards. They
  // follow the joints of the rock, which run up the slope and across it, give or take: the first and the third
  // face look up and down the slope, and the other two, further out, along it. A block is a slab that lies
  // across the slope, longer than it is deep.
  var uphill = vec2f(1.0, 0.0);
  if (length(fall) > 1.0e-9) { uphill = normalize(fall); }
  var cut = 0.0;
  var k = h3;
  for (var i = 0; i < FACES; i++) {
    k = hash_u32(k);
    let u = hash_unit2(k);
    k = hash_u32(k);
    let turn = 0.25 * TAU * f32(i) + SKEW * (2.0 * u.x - 1.0);
    let n = vec2f(uphill.x * cos(turn) - uphill.y * sin(turn), uphill.x * sin(turn) + uphill.y * cos(turn));
    var reach = mix(REACH.x, REACH.y, u.y);
    if ((i & 1) == 1) { reach *= LONG; }
    cut = max(cut, (FACE * P.perBlock + max(dot(tilt, n), 0.0)) * (dot(n, d) - reach));
  }
  // A block ends before the cells of the lattice that are searched for it do: what is left of it there goes
  // down to the height it is measured against.
  return (top + detail - cut - z) * (1.0 - smoothstep(END.x, END.y, far));
}

fn compute(px: vec2i, uv: vec2f) -> Out {
  let z = src_at(px);
  let p = clamp(uv * P.cells, vec2f(-1.0e8), vec2f(1.0e8));
  let first = surfaceCells_first(p);
  // The top of a block keeps a part of the bumps and furrows of the terrain.
  let detail = CARRY * (base_at(px) - ground_at(px));
  var rise = 0.0;
  for (var j = 0; j < surfaceCells_SEARCH; j++) {
    for (var i = 0; i < surfaceCells_SEARCH; i++) {
      rise = max(rise, block(first + vec2i(i, j), p, z, detail));
    }
  }
  // Only the first layers break rock out of the ground. The blocks of the others break up the rock that is
  // there: every grid shows rock in the same places, and a finer one shows more of its joints.
  let ground0 = base_at(px);
  if (P.layer >= BREAKING) { rise *= saturate((z - ground0) / (FOOTING * P.full)); }
  let rock = z + P.strength * rise;
  return Out(rock, saturate((rock - ground0) / P.full));
}`,
});

export default defineNode({
  type: 'surface/outcrops',
  title: 'Outcrops',
  category: 'surface',
  description: 'Breaks angular blocks of rock out of steep ground, large and small, with flat tops and steep faces; coverage is where the rock shows.',
  keywords: ['rock', 'crag', 'cliff', 'ledge', 'bedrock', 'blocks', 'boulders', 'scarp', 'exposed'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'coverage', type: 'field', role: 'mask' },
  ],
  params: [
    param.size({ label: 'Block size', default: 0.06, help: 'How wide the largest blocks are. Larger blocks stand further out of the slope, and smaller ones break out beside them.' }),
    param.strength({ help: 'Larger values let the blocks stand further out of the ground.' }),
    param.slope('slopeMin', { label: 'Lower slope', default: 30, help: 'Rock comes out of ground steeper than this, and in full a little above it.' }),
    param.seed(),
  ],
  kernels: [steepness, outcrops],
  maskable: true,
  evaluate(ctx) {
    const { strength, slopeMin } = ctx.params;
    const src = ctx.input('in');
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 4);   // soft: any finite number can arrive
    // A layer of blocks the grid cannot hold is left out: from four texels a block down to two it goes back into the ground.
    const held = (layer: number): number => Math.min(Math.max(ctx.lengthToPx(size / OUTCROPS.ratio ** layer) / OUTCROPS.texels - 1, 0), 1);
    const coverage = ctx.wants('coverage') ? ctx.alloc('field') : null;
    if (strength * held(0) <= 0) {
      ctx.output('out', src);
      if (coverage) {
        ctx.clear(coverage, 0);
        ctx.output('coverage', coverage);
      }
      return;
    }
    let layers = 1;
    while (layers < OUTCROPS.layers && held(layers) > 0) layers++;
    // A slope is metres per metre: across a block of the first layer it falls this many heights.
    const perBlock = (size * ctx.terrainSize) / ctx.heightRange;
    // The slope of the terrain without what is smaller than the largest blocks says where rock comes out.
    // Smoothed without anything assumed beyond the border, so the ground keeps its slope there.
    const broad = ops.smooth(ctx, src, OUTCROPS.ground * size);
    const steep = ctx.alloc('field');
    ctx.run(steepness, { in: { ground: broad }, out: { out: steep }, params: { band: slopeBand(slopeMin, slopeMin + OUTCROPS.feather) } });
    const breaking = Math.min(OUTCROPS.breaking, layers);
    let rock: Field<'field'> = src;
    for (let layer = 0; layer < layers; layer++) {
      const scale = OUTCROPS.ratio ** layer;
      // The blocks of every layer stand on the terrain without what is smaller than they are.
      const ground = layer === 0 ? broad : ops.smooth(ctx, src, (OUTCROPS.ground * size) / scale);
      const out = ctx.alloc('field');
      ctx.run(outcrops, {
        in: { base: src, src: rock, ground, steep },
        // The coverage is that of the layers that break out: the others stand on their rock and nowhere else.
        out: { out, coverage: layer === breaking - 1 ? coverage : null },
        params: {
          cells: scale / size,
          strength,
          perBlock: perBlock / scale,
          probe: (OUTCROPS.probe * size) / scale,
          held: held(layer),
          full: OUTCROPS.edge * perBlock,
          layer,
        },
      });
      ctx.release(ground);
      if (rock !== src) ctx.release(rock);
      rock = out;
    }
    ctx.release(steep);
    ctx.output('out', rock);
    if (coverage) ctx.output('coverage', coverage);
  },
});
