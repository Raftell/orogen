// src/core/nodes/surface/cracks.ts
import { defineKernel, defineNode, noise, param } from '../../api.ts';
import { CELL_SEARCH, surfaceCells } from './_cells.ts';

/** The constants of the kernel, which the tests read. */
export const CRACKS = {
  /** How many times smaller the plates are that a plate breaks into, and those of these again. */
  finer: 2.3,
  /** The part of the plates that break into smaller ones, and of those that break again. */
  split: [0.6, 0.5],
  /** What a crack between smaller plates keeps of the width and of the depth of the cracks one size up. */
  lesser: 0.6,
  /** The narrowest half of a crack as it is drawn, in texels: a narrower one is drawn this wide and as much shallower. */
  texels: 1,
  /** A plate this many texels across or fewer has no cracks around it, and one of twice as many has them whole. */
  plateTexels: 3,
  /** How far the cracks are bent off the straight, in sizes, and the size of the broadest bends, in sizes. */
  bend: [0.2, 1.5],
  /** The layers of bends, each half as broad and half as far as the one before. */
  bends: 3,
} as const;

const cracks = defineKernel({
  name: 'surface/cracks',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  // cells: the largest plates across the terrain. half: half the width of the widest cracks, a length. depth: of
  // the widest cracks. texel: the length of a texel.
  params: { cells: 'f32', half: 'f32', depth: 'f32', texel: 'f32' },
  includes: [noise, surfaceCells],
  // The terrain, the noise of the bends, and two rounds over the lattice cells for each of three sizes of plate.
  cost: 1 + 16 * CRACKS.bends + 3 * 2 * CELL_SEARCH * CELL_SEARCH,
  code: /* wgsl */ `
const FINER = ${CRACKS.finer};
const SPLIT = vec2f(${CRACKS.split[0]}, ${CRACKS.split[1]});
const LESSER = ${CRACKS.lesser};
const TEXELS = ${CRACKS.texels}.0;
const PLATE_TEXELS = ${CRACKS.plateTexels}.0;
const BEND = vec2f(${CRACKS.bend[0]}, ${CRACKS.bend[1]});
const BENDS = ${CRACKS.bends};

// How deep the crack is at the distance d from the middle of it, a length, for cracks between plates that are
// plate across, a length, and smaller by rank steps than the largest. The crack is a groove with a rounded
// floor and rounded lips. One narrower than the grid can draw is drawn as wide as it can and as much
// shallower, so that it fades on a coarse grid; around plates the grid cannot tell apart there is none.
fn groove(d: f32, plate: f32, rank: f32) -> f32 {
  let less = pow(LESSER, rank);
  let half = P.half * less;
  let drawn = max(half, TEXELS * P.texel);
  let t = saturate(d / drawn);
  let held = saturate(plate / (PLATE_TEXELS * P.texel) - 1.0);
  return P.depth * less * held * (half / drawn) * (1.0 - t * t * (3.0 - 2.0 * t));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The plates are the cells around scattered points, and the cracks their walls: one connected net. Bending
  // the plane bends the walls, which would otherwise be straight from corner to corner.
  let size = 1.0 / P.cells;
  let q = uv * P.cells / BEND.y;
  let bent = uv + BEND.x * size * vec2f(noise_fbm(q, seedFor(5u), BENDS, 2.0, 0.5), noise_fbm(q + vec2f(31.7, 17.3), seedFor(6u), BENDS, 2.0, 0.5));
  let p = bent * P.cells;
  let plate = surfaceCells_cell(p, seedFor(0u));
  var deep = groove(plate.edge * size, size, 0.0);
  // Some plates break into smaller ones, and some of those again: the finer cracks end on the walls of the
  // plate they break, and are narrower and shallower than those.
  if (hash_unit(hash_cell(plate.home, seedFor(1u))) < SPLIT.x) {
    let piece = surfaceCells_cell(p * FINER, seedFor(2u));
    deep = max(deep, groove(piece.edge * size / FINER, size / FINER, 1.0));
    if (hash_unit(hash_cell(piece.home, seedFor(3u))) < SPLIT.y) {
      let chip = surfaceCells_edge(p * FINER * FINER, seedFor(4u));
      deep = max(deep, groove(chip * size / (FINER * FINER), size / (FINER * FINER), 2.0));
    }
  }
  return src_at(px) - deep;
}`,
});

export default defineNode({
  type: 'surface/cracks',
  title: 'Cracks',
  category: 'surface',
  description: 'Cuts a connected net of cracks into the ground, around plates of varied size, as in dried mud or jointed rock.',
  keywords: ['fissures', 'mud', 'joints', 'crevasses', 'fractures', 'polygons', 'desiccation', 'voronoi'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size({ label: 'Plate size', default: 0.1, help: 'How far apart the main cracks lie. Many plates between them break into smaller ones.' }),
    param.height({ name: 'depth', label: 'Depth', default: 0.05, help: 'How deep the main cracks are cut. The cracks between smaller plates are shallower.' }),
    {
      kind: 'float', name: 'width', label: 'Width', unit: 'length', default: 0.012, min: 0.0005, max: 0.1, scale: 'log', soft: true,
      help: 'How wide the main cracks are from lip to lip. The cracks between smaller plates are narrower.',
    },
    param.seed(),
  ],
  kernels: [cracks],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    // Soft parameters: any finite number can arrive.
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 4);
    const depth = Math.min(Math.max(ctx.params.depth, 0), 4);
    const width = Math.min(Math.max(ctx.params.width, 0), 1);
    if (depth <= 0 || width <= 0) {
      ctx.output('out', src);
      return;
    }
    const out = ctx.alloc('field');
    ctx.run(cracks, {
      in: { src },
      out: { out },
      params: { cells: 1 / size, half: width / 2, depth, texel: 1 / Math.max(ctx.res - 1, 1) },
    });
    ctx.output('out', out);
  },
});
