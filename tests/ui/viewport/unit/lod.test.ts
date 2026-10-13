// The level of detail of the terrain mesh (src/viewport/lod.ts): the quadtree for each resolution of the ladder,
// a selection that covers the terrain exactly once, and a mesh without cracks: along every edge two drawn
// patches share, the finer one's vertices lie on the coarser one's, wherever the camera is.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frustumPlanes, viewOf, type OrbitView } from '../../../../src/viewport/camera.ts';
import {
  buildBounds, createSelection, gridRange, INSTANCE_FLOATS, levelZeroRange, lodSetup, MAX_INSTANCES, morphVertex, patchMesh, PATCH, selectPatches,
  UNKNOWN_BOUNDS, type HeightBounds, type LodSetup, type LodView, type Selection,
} from '../../../../src/viewport/lod.ts';

/** A number in 0..1 from a seed: the cameras of these tests are the same in every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FLAT: HeightBounds = { min: 0, max: 0.5, nodes: null };

function lodView(setup: LodSetup, eye: readonly [number, number, number], terrainSize: number, culled = false): LodView {
  const view = viewOf({ kind: 'orbit', target: [terrainSize / 2, terrainSize / 2, 0], yaw: 300, pitch: 30, distance: terrainSize, fovY: 35 }, { width: 1600, height: 1000 }) as OrbitView;
  return { eye, planes: culled ? frustumPlanes(view) : null, terrainSize, zScale: terrainSize / 4, r0: levelZeroRange(setup, terrainSize, 1000, view.focal, 2.5) };
}

interface Patch { readonly x: number; readonly y: number; readonly size: number; readonly quads: number; readonly instance: Float32Array }

function patches(selection: Selection): Patch[] {
  const out: Patch[] = [];
  for (const [list, count, quads] of [[selection.full, selection.fullCount, PATCH], [selection.half, selection.halfCount, PATCH / 2]] as const) {
    for (let i = 0; i < count; i++) {
      const instance = list.slice(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS);
      out.push({ x: instance[0]!, y: instance[1]!, size: instance[2]! * quads, quads, instance });
    }
  }
  return out;
}

test('the quadtree of a field: its finest quads are at most a texel wide, for every resolution of the ladder', () => {
  const levels = (resolution: number): number => lodSetup(resolution).levels;
  assert.deepEqual([8129, 4033, 2017, 1009, 505, 253, 127, 64, 33, 2].map(levels), [8, 7, 6, 5, 4, 3, 2, 1, 1, 1]);
  for (const resolution of [8129, 4065, 4033, 2017, 1009, 505, 253, 127, 65, 33, 2]) {
    const setup = lodSetup(resolution);
    assert.equal(setup.leaves, 2 ** (setup.levels - 1));
    assert.equal(setup.fine, setup.leaves * PATCH);
    assert.ok(setup.fine >= resolution - 1, `${resolution}: ${setup.fine} quads for ${resolution - 1} cells`);
    assert.ok(setup.fine < 2 * Math.max(PATCH, resolution - 1), `${resolution}: no finer than half a texel`);
  }
});

test('the patch: whole grid coordinates, two triangles a quad, and the quarter is its first corner', () => {
  const mesh = patchMesh();
  assert.equal(mesh.vertices.length, (PATCH + 1) ** 2 * 2);
  assert.deepEqual([mesh.full.length, mesh.half.length], [PATCH * PATCH * 6, (PATCH / 2) ** 2 * 6]);
  let far = 0;
  for (const index of mesh.half) far = Math.max(far, mesh.vertices[index * 2]!, mesh.vertices[index * 2 + 1]!);
  assert.equal(far, PATCH / 2);
  assert.equal(PATCH % 4, 0, 'a quarter begins on an even vertex of its node');
});

test('a selection covers the terrain exactly once, from any camera', () => {
  const next = random(7);
  for (const resolution of [8129, 4033, 1009, 253, 65]) {
    const setup = lodSetup(resolution);
    const size = 4032;
    for (let trial = 0; trial < 40; trial++) {
      const eye = [(next() * 3 - 1) * size, (next() * 3 - 1) * size, next() ** 2 * size * 2] as const;
      const selection = selectPatches(setup, FLAT, lodView(setup, eye, size), createSelection());
      const drawn = patches(selection);
      const area = drawn.reduce((sum, patch) => sum + patch.size * patch.size, 0);
      assert.equal(area, setup.fine * setup.fine, `resolution ${resolution}, eye ${eye.map(Math.round).join(' ')}`);
      for (const patch of drawn) {
        assert.ok(patch.x >= 0 && patch.y >= 0 && patch.x + patch.size <= setup.fine && patch.y + patch.size <= setup.fine);
        assert.ok(Number.isInteger(patch.x / (patch.size / patch.quads)), 'a patch begins on a vertex of its own level');
      }
      assert.ok(selection.fullCount <= MAX_INSTANCES && selection.halfCount <= MAX_INSTANCES);
    }
  }
});

test('no cracks: along an edge two patches share, both have their vertices at the same places', () => {
  const next = random(11);
  let shared = 0;
  for (const resolution of [8129, 1009]) {
    const setup = lodSetup(resolution);
    const size = 8128;
    for (let trial = 0; trial < 12; trial++) {
      const eye = [(next() * 2 - 0.5) * size, (next() * 2 - 0.5) * size, next() ** 3 * size] as const;
      const view = lodView(setup, eye, size);
      const drawn = patches(selectPatches(setup, FLAT, view, createSelection()));
      // Every vertex on the border of a patch, as the shader places it, by the edge it lies on.
      const edges = new Map<string, Map<number, Set<number>>>();   // 'x:<fine x>' or 'y:<fine y>' → patch index → places along the edge
      drawn.forEach((patch, index) => {
        const stride = patch.size / patch.quads;
        const put = (key: string, at: number): void => {
          let byPatch = edges.get(key);
          if (!byPatch) edges.set(key, byPatch = new Map());
          let places = byPatch.get(index);
          if (!places) byPatch.set(index, places = new Set());
          places.add(at);
        };
        for (let i = 0; i <= patch.quads; i++) {
          for (const [gx, gy] of [[i, 0], [i, patch.quads], [0, i], [patch.quads, i]] as const) {
            const [x, y] = morphVertex(setup, FLAT, view, patch.instance, gx, gy);
            // A vertex on the patch's border stays on the line of that border, or the border itself would move.
            if (gy === 0 || gy === patch.quads) {
              const line = patch.y + gy * stride;
              assert.equal(y, line, 'the first and the last row of a patch are even: they stay on their line');
              put(`y:${line}`, x);
            }
            if (gx === 0 || gx === patch.quads) {
              const line = patch.x + gx * stride;
              assert.equal(x, line);
              put(`x:${line}`, y);
            }
          }
        }
      });
      // On a line two patches share, over the stretch both cover, the vertices of the two are the same places.
      for (const [key, byPatch] of edges) {
        const along = key.startsWith('y:') ? 'x' : 'y';
        const line = Number(key.slice(2));
        const touching = [...byPatch.keys()].map((index) => ({ index, patch: drawn[index]! }));
        for (const a of touching) {
          for (const b of touching) {
            if (a.index >= b.index) continue;
            // Opposite sides of the line, and overlapping along it.
            const sideA = (key.startsWith('y:') ? a.patch.y : a.patch.x) === line, sideB = (key.startsWith('y:') ? b.patch.y : b.patch.x) === line;
            if (sideA === sideB) continue;
            const lo = Math.max(a.patch[along], b.patch[along]), hi = Math.min(a.patch[along] + a.patch.size, b.patch[along] + b.patch.size);
            if (hi <= lo) continue;
            const within = (places: Set<number>): number[] => [...places].filter((at) => at >= lo && at <= hi).sort((p, q) => p - q);
            const mine = within(byPatch.get(a.index)!).join(' '), theirs = within(byPatch.get(b.index)!).join(' ');
            assert.ok(mine === theirs, `the edge ${key} from ${lo} to ${hi}, eye ${eye.map(Math.round).join(' ')}: ${mine.slice(0, 120)} against ${theirs.slice(0, 120)}`);
            shared++;
          }
        }
      }
    }
  }
  assert.ok(shared > 200, `the cameras made patches of different levels meet: ${shared} shared edges`);
});

test('nodes outside the picture are left out, and what is left still tiles what is seen', () => {
  const setup = lodSetup(4033);
  const size = 4032;
  const all = selectPatches(setup, FLAT, lodView(setup, [size / 2, size * 1.2, 300], size), createSelection());
  const allArea = patches(all).reduce((sum, patch) => sum + patch.size ** 2, 0);
  const seen = selectPatches(setup, FLAT, lodView(setup, [size / 2, size / 2, 60], size, true), createSelection());
  const seenArea = patches(seen).reduce((sum, patch) => sum + patch.size ** 2, 0);
  assert.equal(allArea, setup.fine ** 2);
  assert.ok(seenArea > 0 && seenArea < allArea, `a camera inside the terrain sees part of it: ${seenArea} of ${allArea}`);
});

test('the bounds of the nodes hold every height below them, and a block without a finite height counts for nothing', () => {
  const setup = lodSetup(1009);
  // 16 × 16 blocks of 64 texels: a ramp along x, one block of nothing.
  const cells = 16;
  const data = new Float32Array(cells * cells * 2);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const empty = x === 3 && y === 5;
      data[(y * cells + x) * 2] = empty ? 1e30 : x / cells;
      data[(y * cells + x) * 2 + 1] = empty ? -1e30 : (x + 1) / cells;
    }
  }
  const grid = { cellsX: cells, cellsY: cells, cellTexels: 64, data };
  assert.deepEqual(gridRange(grid), [0, 1]);
  const bounds = buildBounds(setup, 1009, 1009, grid);
  assert.deepEqual([bounds.min, bounds.max], [0, 1]);
  assert.equal(bounds.nodes!.length, setup.levels);
  const top = bounds.nodes![setup.levels - 1]!;
  assert.deepEqual([top.min.length, top.min[0], top.max[0]], [1, 0, 1]);
  // A leaf holds the heights of the blocks it touches: at least its own stretch of the ramp.
  const leaves = bounds.nodes![0]!;
  for (let x = 0; x < setup.leaves; x++) {
    assert.ok(leaves.min[x]! <= x / setup.leaves + 1e-6 && leaves.max[x]! >= (x + 1) / setup.leaves - 1e-6, `leaf ${x}: ${leaves.min[x]} .. ${leaves.max[x]}`);
  }
  assert.deepEqual(gridRange({ cellsX: 1, cellsY: 1, cellTexels: 64, data: new Float32Array([1e30, -1e30]) }), [0, 0]);
  assert.ok(UNKNOWN_BOUNDS.min < 0 && UNKNOWN_BOUNDS.max > 1);
});
