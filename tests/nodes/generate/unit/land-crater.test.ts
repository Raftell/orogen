// tests/nodes/generate/unit/land-crater.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundAt, levelGround, type CoarseTerrain } from '../../../../src/core/nodes/generate/_land-crater.ts';

/** A terrain of `size` vertices a side holding fn(u, v). */
function terrainOf(size: number, fn: (u: number, v: number) => number): CoarseTerrain {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = fn(x / (size - 1), y / (size - 1));
  return { data, size };
}

const plane = (u: number, v: number): number => 0.3 + 0.25 * u - 0.1 * v;

test('generate/land-crater: the ground under a crater on a plane is that plane, wherever the crater lies and whatever its size', () => {
  for (const size of [33, 64, 128]) {
    const terrain = terrainOf(size, plane);
    // In the middle, on a border, in a corner, beyond the border, and between vertices; small craters and large.
    for (const [x, y] of [[0.5, 0.5], [0.37, 0.81], [0, 0.4], [1, 1], [-0.05, 0.3], [1.05, -0.05]] as const) {
      for (const radius of [0.004, 0.03, 0.2, 0.5]) {
        const ground = groundAt(terrain, x, y, radius, 1);
        assert.ok(Math.abs(ground.height - plane(x, y)) < 1e-5, `size ${size}, (${x}, ${y}), radius ${radius}: height ${ground.height}, the plane is at ${plane(x, y)}`);
        assert.ok(Math.abs(ground.slopeX - 0.25) < 1e-4 && Math.abs(ground.slopeY + 0.1) < 1e-4, `size ${size}, (${x}, ${y}), radius ${radius}: slope ${ground.slopeX}, ${ground.slopeY}`);
      }
    }
  }
});

test('generate/land-crater: relief smaller than the crater is no part of the ground under it', () => {
  // Bumps 0.05 high and four vertices apart on the plane: the plane fitted under a crater that spans many of
  // them lies within a fifth of their height of the plane without them.
  const terrain = terrainOf(129, (u, v) => plane(u, v) + 0.05 * Math.sin(32 * Math.PI * u) * Math.sin(32 * Math.PI * v + 1));
  for (const [x, y] of [[0.5, 0.5], [0.31, 0.66], [0.8, 0.2]] as const) {
    const ground = groundAt(terrain, x, y, 0.2, 1);
    assert.ok(Math.abs(ground.height - plane(x, y)) < 0.01, `(${x}, ${y}): height ${ground.height}, the plane is at ${plane(x, y)}`);
  }
});

test('generate/land-crater: the ground tilts by no more than the limit from the center to the rim', () => {
  const terrain = terrainOf(65, (u) => 2 * u);
  const free = groundAt(terrain, 0.5, 0.5, 0.1, 1);
  assert.ok(Math.abs(free.slopeX - 2) < 1e-4 && Math.abs(free.slopeY) < 1e-4, `the slope of the cliff is ${free.slopeX}, ${free.slopeY}`);
  const held = groundAt(terrain, 0.5, 0.5, 0.1, 0.05);
  assert.ok(Math.abs(Math.hypot(held.slopeX, held.slopeY) * 0.1 - 0.05) < 1e-6, `held to a tilt of 0.05, the ground rises ${Math.hypot(held.slopeX, held.slopeY) * 0.1} over the radius`);
  assert.ok(Math.abs(held.height - 1) < 1e-5, `the height under the center stays at ${held.height}`);
});

test('generate/land-crater: the ground is known under a crater that spans cells of the terrain, and not under one that lies between its vertices', () => {
  const terrain = terrainOf(33, plane);
  // Cells are 1 / 32 wide.
  assert.equal(groundAt(terrain, 0.5, 0.5, 2 / 32, 1).known, 1);
  assert.equal(groundAt(terrain, 0.5, 0.5, 0.5 / 32, 1).known, 0);
  const between = groundAt(terrain, 0.5, 0.5, 1.25 / 32, 1).known;
  assert.ok(between > 0.4 && between < 0.6, `halfway between, the ground is known ${between}`);
  assert.deepEqual(levelGround(0.5), { height: 0.5, slopeX: 0, slopeY: 0, known: 1 });
});
