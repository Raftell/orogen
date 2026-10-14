// Level of detail of the terrain mesh: CDLOD (Strugar 2010) over a quadtree in uv. One patch of PATCH × PATCH
// quads is drawn once per selected node; a node of level l covers 2^l leaves, so its quads are 2^l fine quads
// wide. Pure arithmetic: the renderer draws what `selectPatches` returns, and the vertex shader morphs with the
// same distances.
//
// The distance that selects a level is horizontal, plus the camera's height above the slab of all heights. It
// does not depend on the height of the ground, so the level changes along lines the shader and this file agree
// on to the last bit, whatever the relief; that is what keeps the mesh free of cracks.

import { boxInFrustum, type Vec3 } from './camera.ts';

/** Quads along one side of a patch. A quarter of a node is drawn with half of it, so it is a multiple of 4. */
export const PATCH = 64;
/** Levels whose quads are a texel wide or wider: enough for a field of 16 385 vertices a side. */
export const MAX_LEVELS = 9;
/**
 * Levels below the texel: the finest quads are a quarter of a texel wide. From near, the picture is of a smooth
 * surface through the field (shaders.ts, `shownHeight`), and a mesh whose vertices are the texels would draw
 * the notches that surface is there to take away. They are selected by distance like any level, so a terrain
 * seen whole has none of them.
 */
export const SUB_LEVELS = 2;
/** Where in a level's range its vertices begin to move onto the grid of the next level, as a share of the range. */
export const MORPH_START = 0.85;
/** Instances one draw may hold; a selection that would exceed it stops refining. */
export const MAX_INSTANCES = 4096;
/** Floats per instance: the node's origin in fine quads (x, y), the width of one of its quads in fine quads, its level. */
export const INSTANCE_FLOATS = 4;

export interface LodSetup {
  readonly levels: number;
  /** Leaf nodes along one side: 2^(levels − 1). */
  readonly leaves: number;
  /** Fine quads along one side: leaves × PATCH. A vertex is addressed by its whole number on this grid. */
  readonly fine: number;
  /** How many of the levels, the finest, have quads narrower than a texel. */
  readonly sub: number;
}

/**
 * The quadtree for a field of `resolution` vertices a side: the quads of level `sub` are at most one texel wide,
 * and those of the `sub` levels below it halve them.
 */
export function lodSetup(resolution: number, sub: number = SUB_LEVELS): LodSetup {
  const quads = Math.max(1, Math.floor(resolution) - 1);
  const levels = Math.max(1, Math.min(MAX_LEVELS, Math.ceil(Math.log2(quads / PATCH)) + 1)) + sub;
  const leaves = 2 ** (levels - 1);
  return { levels, leaves, fine: leaves * PATCH, sub };
}

export interface HeightBounds {
  /** The lowest and highest normalised height of the field. */
  readonly min: number;
  readonly max: number;
  /**
   * For each level from the texel's level up (`LodSetup.sub`), the lowest and highest height in each node, row by
   * row; null while only the whole is known. A node below the texel's level lies in one of that level's, which
   * holds no more texels than the grid these are made from has in a cell.
   */
  readonly nodes: readonly { readonly min: Float32Array; readonly max: Float32Array }[] | null;
}

/** What is assumed of a field nothing is known of yet: wide enough that no node is taken for invisible. */
export const UNKNOWN_BOUNDS: HeightBounds = { min: -1, max: 2, nodes: null };

/** Minima and maxima of a field in blocks: `cellsX` × `cellsY` pairs (min, max), each over `cellTexels` × `cellTexels` texels. */
export interface MinMaxGrid {
  readonly cellsX: number;
  readonly cellsY: number;
  readonly cellTexels: number;
  readonly data: Float32Array;
}

/** The lowest and highest value of a grid; (0, 0) when it holds no finite value. */
export function gridRange(grid: MinMaxGrid): readonly [number, number] {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.cellsX * grid.cellsY; i++) {
    const a = grid.data[i * 2]!, b = grid.data[i * 2 + 1]!;
    if (a <= b) {
      if (a < min) min = a;
      if (b > max) max = b;
    }
  }
  return min <= max ? [min, max] : [0, 0];
}

/**
 * The bounds of every node of a field `width` × `height` texels, from the grid of its minima and maxima. A node's
 * bounds take in the texels two beyond its edges: the smooth surface the picture has up close is made from them
 * too, and lies between the lowest and the highest of the texels it is made from.
 */
export function buildBounds(setup: LodSetup, width: number, height: number, grid: MinMaxGrid): HeightBounds {
  const { cellsX, cellsY, cellTexels, data } = grid;
  const lastX = Math.max(1, width - 1), lastY = Math.max(1, height - 1);
  const n = setup.leaves >> setup.sub;
  let lo = new Float32Array(n * n), hi = new Float32Array(n * n);
  let min = Infinity, max = -Infinity;
  const cellOf = (texel: number, cells: number): number => Math.max(0, Math.min(cells - 1, Math.floor(texel / cellTexels)));
  for (let y = 0; y < n; y++) {
    const cy0 = cellOf(Math.floor((y / n) * lastY) - 2, cellsY), cy1 = cellOf(Math.ceil(((y + 1) / n) * lastY) + 2, cellsY);
    for (let x = 0; x < n; x++) {
      const cx0 = cellOf(Math.floor((x / n) * lastX) - 2, cellsX), cx1 = cellOf(Math.ceil(((x + 1) / n) * lastX) + 2, cellsX);
      let a = Infinity, b = -Infinity;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const at = (cy * cellsX + cx) * 2;
          const cellMin = data[at]!, cellMax = data[at + 1]!;
          // A block without a finite height holds (huge, −huge).
          if (cellMin <= cellMax) {
            if (cellMin < a) a = cellMin;
            if (cellMax > b) b = cellMax;
          }
        }
      }
      if (a > b) { a = 0; b = 0; }
      lo[y * n + x] = a;
      hi[y * n + x] = b;
      if (a < min) min = a;
      if (b > max) max = b;
    }
  }
  if (min > max) { min = 0; max = 0; }
  const nodes = [{ min: lo, max: hi }];
  for (let level = 1, size = n >> 1; level < setup.levels - setup.sub; level++, size >>= 1) {
    const nextLo = new Float32Array(size * size), nextHi = new Float32Array(size * size);
    const from = size * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * 2 * from + x * 2;
        nextLo[y * size + x] = Math.min(lo[i]!, lo[i + 1]!, lo[i + from]!, lo[i + from + 1]!);
        nextHi[y * size + x] = Math.max(hi[i]!, hi[i + 1]!, hi[i + from]!, hi[i + from + 1]!);
      }
    }
    nodes.push({ min: nextLo, max: nextHi });
    lo = nextLo;
    hi = nextHi;
  }
  return { min, max, nodes };
}

export interface LodView {
  readonly eye: Vec3;
  /** The planes of camera.ts `frustumPlanes`; null: nothing is culled. */
  readonly planes: Float64Array | null;
  readonly terrainSize: number;
  /** Metres of display height per unit of normalised height: heightRange × verticalScale. */
  readonly zScale: number;
  /** The range of level 0 in metres; level l reaches r0 × 2^l, and the coarsest reaches everything. */
  readonly r0: number;
}

/**
 * The range of level 0 for a picture `pixels` high seen with `focal` = 1 / tan(fovY / 2): a quad of the level
 * that is drawn is about `quadPixels` wide on screen. Never below what the morph needs: a node must fit between
 * the end of its range and the start of the next level's morph.
 */
export function levelZeroRange(setup: LodSetup, terrainSize: number, pixels: number, focal: number, quadPixels: number): number {
  const quads = Math.max((pixels * focal) / (2 * quadPixels), 2.5 * PATCH);
  return (quads * terrainSize) / setup.fine;
}

/** The camera's height above (or below) the slab of all heights, in metres; 0 inside it. */
export function slabDistance(view: LodView, bounds: HeightBounds): number {
  const low = bounds.min * view.zScale, high = bounds.max * view.zScale;
  return Math.max(view.eye[2] - Math.max(low, high), Math.min(low, high) - view.eye[2], 0);
}

export interface Selection {
  /** Whole nodes, drawn with the full patch. */
  readonly full: Float32Array;
  fullCount: number;
  /** Quarters of nodes, drawn with half the patch. */
  readonly half: Float32Array;
  halfCount: number;
}

export function createSelection(): Selection {
  return { full: new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS), fullCount: 0, half: new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS), halfCount: 0 };
}

/** Selects the nodes to draw into `out` and returns it. */
export function selectPatches(setup: LodSetup, bounds: HeightBounds, view: LodView, out: Selection): Selection {
  out.fullCount = 0;
  out.halfCount = 0;
  const top = setup.levels - 1;
  const dz = slabDistance(view, bounds);
  const dz2 = dz * dz;
  const metres = view.terrainSize / setup.leaves;       // a leaf's width
  const cx = view.eye[0], cy = view.eye[1];

  /** Whether the node's square comes within the range of `level`. The coarsest level reaches everything. */
  const within = (x0: number, y0: number, size: number, level: number): boolean => {
    if (level >= top) return true;
    const r = view.r0 * 2 ** level;
    const dx = Math.max(x0 - cx, 0, cx - (x0 + size));
    const dy = Math.max(y0 - cy, 0, cy - (y0 + size));
    return dx * dx + dy * dy + dz2 < r * r;
  };
  const visible = (ix: number, iy: number, level: number, x0: number, y0: number, size: number): boolean => {
    if (!view.planes) return true;
    let lo = bounds.min, hi = bounds.max;
    // A node below the texel's level has the bounds of the node of that level it lies in.
    const kept = Math.max(level, setup.sub);
    const nodes = bounds.nodes?.[kept - setup.sub];
    if (nodes) {
      const at = (iy >> (kept - level)) * (setup.leaves >> kept) + (ix >> (kept - level));
      lo = nodes.min[at]!;
      hi = nodes.max[at]!;
    }
    const z0 = Math.min(lo, hi) * view.zScale, z1 = Math.max(lo, hi) * view.zScale;
    return boxInFrustum(view.planes, x0, y0, Math.min(z0, z1), x0 + size, y0 + size, Math.max(z0, z1));
  };
  const emit = (list: Float32Array, count: number, fineX: number, fineY: number, level: number): void => {
    const at = count * INSTANCE_FLOATS;
    list[at] = fineX;
    list[at + 1] = fineY;
    list[at + 2] = 2 ** level;
    list[at + 3] = level;
  };
  const full = (ix: number, iy: number, level: number): void => {
    if (out.fullCount >= MAX_INSTANCES) return;
    emit(out.full, out.fullCount++, ix * PATCH * 2 ** level, iy * PATCH * 2 ** level, level);
  };

  // ix, iy: the node's place among the nodes of its level.
  const select = (ix: number, iy: number, level: number): boolean => {
    const size = metres * 2 ** level;
    const x0 = ix * size, y0 = iy * size;
    if (!within(x0, y0, size, level)) return false;
    if (!visible(ix, iy, level, x0, y0, size)) return true;
    if (level === 0 || !within(x0, y0, size, level - 1) || out.fullCount + 4 > MAX_INSTANCES || out.halfCount + 4 > MAX_INSTANCES) {
      full(ix, iy, level);
      return true;
    }
    for (let q = 0; q < 4; q++) {
      const qx = q & 1, qy = q >> 1;
      if (select(ix * 2 + qx, iy * 2 + qy, level - 1)) continue;
      // The child is beyond the finer level's range: this node draws that quarter itself, with its own quads.
      const half = size / 2;
      if (!visible(ix * 2 + qx, iy * 2 + qy, level - 1, x0 + qx * half, y0 + qy * half, half)) continue;
      emit(out.half, out.halfCount++, (ix * 2 + qx) * PATCH * 2 ** (level - 1), (iy * 2 + qy) * PATCH * 2 ** (level - 1), level);
    }
    return true;
  };
  select(0, 0, top);
  return out;
}

/** The patch: (PATCH + 1)² vertices as whole grid coordinates, with the triangles of the full patch and of its first quarter. */
export function patchMesh(): { readonly vertices: Float32Array; readonly full: Uint32Array; readonly half: Uint32Array } {
  const side = PATCH + 1;
  const vertices = new Float32Array(side * side * 2);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      vertices[(y * side + x) * 2] = x;
      vertices[(y * side + x) * 2 + 1] = y;
    }
  }
  const triangles = (quads: number): Uint32Array => {
    const indices = new Uint32Array(quads * quads * 6);
    let at = 0;
    for (let y = 0; y < quads; y++) {
      for (let x = 0; x < quads; x++) {
        const a = y * side + x, b = a + 1, c = a + side, d = c + 1;
        // The diagonals alternate, so that a ridge is notched no more along one diagonal of the grid than along the
        // other. The diagonal of a quad runs through its even corner: four quads morphed onto the coarser grid
        // fold into the one that begins on the odd vertex, whose diagonal joins the two corners that stay.
        if ((x + y) % 2 === 0) {
          indices[at++] = a; indices[at++] = c; indices[at++] = d;
          indices[at++] = a; indices[at++] = d; indices[at++] = b;
        } else {
          indices[at++] = a; indices[at++] = c; indices[at++] = b;
          indices[at++] = b; indices[at++] = c; indices[at++] = d;
        }
      }
    }
    return indices;
  };
  return { vertices, full: triangles(PATCH), half: triangles(PATCH / 2) };
}

/**
 * Where the vertex shader puts a vertex of a patch, on the grid of the finest quads: the arithmetic of
 * `vsTerrain` (shaders.ts), for the tests of the mesh. `gridX`, `gridY` are the vertex's place in its patch;
 * `instance` is the four floats of its node.
 */
export function morphVertex(setup: LodSetup, bounds: HeightBounds, view: LodView, instance: ArrayLike<number>, gridX: number, gridY: number): readonly [number, number] {
  const stride = instance[2]!, level = instance[3]!;
  const fineX = instance[0]! + gridX * stride, fineY = instance[1]! + gridY * stride;
  const metres = view.terrainSize / setup.fine;
  const dz = slabDistance(view, bounds);
  const d = Math.sqrt((fineX * metres - view.eye[0]) ** 2 + (fineY * metres - view.eye[1]) ** 2 + dz * dz);
  const range = view.r0 * 2 ** level;
  const start = range * MORPH_START;
  const k = level >= setup.levels - 1 ? 0 : Math.min(1, Math.max(0, (d - start) / (range - start)));
  return [fineX - (gridX % 2) * stride * k, fineY - (gridY % 2) * stride * k];
}
