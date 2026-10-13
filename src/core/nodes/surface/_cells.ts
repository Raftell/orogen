// Scattered feature points and the cells around them, shared by the surface nodes that build from blocks:
// one point in every cell of a square lattice, and the lattice cells that can hold the points nearest to a place.
import { defineLib, hash } from '../../api.ts';

/** How much of its lattice cell a feature point may lie in, along each axis; the rest is a margin on both sides. */
export const CELL_JITTER = 0.8;
/** The side of the square of lattice cells searched around a place. */
export const CELL_SEARCH = 4;

export const surfaceCells = defineLib({
  name: 'surfaceCells',
  deps: [hash],
  code: /* wgsl */ `
const surfaceCells_JITTER = ${CELL_JITTER};
const surfaceCells_SEARCH = ${CELL_SEARCH};
// Coordinates beyond this many cells are clamped before they become integers.
const surfaceCells_LIMIT = 1.0e8;

// The feature point of a lattice cell, in cells: somewhere in the middle part of the cell.
fn surfaceCells_point(cell: vec2i, seed: u32) -> vec2f {
  return vec2f(cell) + vec2f(0.5 * (1.0 - surfaceCells_JITTER)) + surfaceCells_JITTER * hash_unit2(hash_cell(cell, seed));
}

// The first of the SEARCH x SEARCH lattice cells around p. A point is at least 1.1 cells from p along an axis
// when its cell is not among them; the nearest point is within 1.28 of p and usually much nearer, and a point
// that shares a wall with it near p is not much further: every point that shapes the ground at p is among them.
fn surfaceCells_first(p: vec2f) -> vec2i {
  return vec2i(floor(clamp(p, vec2f(-surfaceCells_LIMIT), vec2f(surfaceCells_LIMIT)) - vec2f(0.5))) - vec2i(1);
}

// The lattice cell whose feature point is nearest to p.
fn surfaceCells_nearest(p: vec2f, seed: u32) -> vec2i {
  let first = surfaceCells_first(p);
  var best = 1.0e30;
  var cell = first;
  for (var j = 0; j < surfaceCells_SEARCH; j++) {
    for (var i = 0; i < surfaceCells_SEARCH; i++) {
      let c = first + vec2i(i, j);
      let d = surfaceCells_point(c, seed) - p;
      let d2 = dot(d, d);
      if (d2 < best) {
        best = d2;
        cell = c;
      }
    }
  }
  return cell;
}

// How far p is from the wall between the cell of the point at own, which is the nearest to p, and the cell of
// the point at other: the distance to the line half way between the two points. 0 on the wall.
fn surfaceCells_wall(p: vec2f, own: vec2f, other: vec2f) -> f32 {
  let across = other - own;
  let span = dot(across, across);
  // Two points that float32 cannot tell apart have no line between them.
  if (span < 1.0e-12) { return 0.0; }
  return max(dot(0.5 * (own + other) - p, across) / sqrt(span), 0.0);
}

// The cell p lies in: the lattice cell of its feature point, and how far p is from the nearest wall of the cell,
// in cells: 0 on a wall, and largest near the feature point. The walls are straight, and those of all the cells
// together are one connected net.
struct surfaceCells_Cell { home: vec2i, edge: f32 }
fn surfaceCells_cell(p: vec2f, seed: u32) -> surfaceCells_Cell {
  let home = surfaceCells_nearest(p, seed);
  let own = surfaceCells_point(home, seed);
  let first = surfaceCells_first(p);
  var edge = 8.0;
  for (var j = 0; j < surfaceCells_SEARCH; j++) {
    for (var i = 0; i < surfaceCells_SEARCH; i++) {
      let cell = first + vec2i(i, j);
      if (all(cell == home)) { continue; }
      edge = min(edge, surfaceCells_wall(p, own, surfaceCells_point(cell, seed)));
    }
  }
  return surfaceCells_Cell(home, edge);
}
fn surfaceCells_edge(p: vec2f, seed: u32) -> f32 { return surfaceCells_cell(p, seed).edge; }`,
});
