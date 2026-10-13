// The camera of the renderer (src/viewport/camera.ts, runtime.md 7.5): the frame is presented left-handed, a
// pixel's ray and a point's place on the canvas are each other's inverse, and the planes of a view hold what it shows.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boxInFrustum, frustumPlanes, orbitEye, pixelRay, project, viewOf, type OrbitView } from '../../../../src/viewport/camera.ts';

const SIZE = { width: 1600, height: 1000 };
const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));

test('an orbit camera with yaw 0 looks along +X and has +Y on its right; its position is target − distance × forward', () => {
  const camera = { kind: 'orbit', target: [100, 200, 30], yaw: 0, pitch: 0, distance: 500, fovY: 40 } as const;
  const view = viewOf(camera, SIZE) as OrbitView;
  assert.ok(view.forward.every((v, i) => near(v, [1, 0, 0][i]!)) && view.right.every((v, i) => near(v, [0, 1, 0][i]!)) && view.up.every((v, i) => near(v, [0, 0, 1][i]!)));
  assert.ok(orbitEye(camera).every((v, i) => near(v, [-400, 200, 30][i]!)));
  // The target is in the middle of the picture; what lies towards +Y is right of it, what lies higher is above it.
  const middle = project(view, SIZE, [100, 200, 30], 1000)!;
  assert.ok(near(middle.x, 800) && near(middle.y, 500));
  assert.ok(project(view, SIZE, [100, 260, 30], 1000)!.x > 800);
  assert.ok(project(view, SIZE, [100, 200, 90], 1000)!.y < 500);
  assert.equal(project(view, SIZE, [-900, 200, 30], 1000), null, 'a point behind the camera is nowhere on the canvas');
  // Looking down with a pitch of 40 degrees, from the formula of 7.5.
  const down = orbitEye({ ...camera, pitch: 40 });
  assert.ok(near(down[0], 100 - 500 * Math.cos(40 * Math.PI / 180)) && near(down[2], 30 + 500 * Math.sin(40 * Math.PI / 180)));
});

test('no orbit view is the mirror image of the top view: looking down along −Y, +X is right and +Y is down the screen', () => {
  const size = 1000;
  const view = viewOf({ kind: 'orbit', target: [500, 500, 0], yaw: 270, pitch: 89.9, distance: 3000, fovY: 35 }, SIZE);
  const top = viewOf({ kind: 'top', center: [0.5, 0.5], span: 2 }, SIZE);
  for (const v of [view, top]) {
    const origin = project(v, SIZE, [0, 0, 0], size)!, alongX = project(v, SIZE, [1000, 0, 0], size)!, alongY = project(v, SIZE, [0, 1000, 0], size)!;
    assert.ok(alongX.x > origin.x + 100 && Math.abs(alongX.y - origin.y) < 5, '+X runs to the right');
    assert.ok(alongY.y > origin.y + 100 && Math.abs(alongY.x - origin.x) < 5, '+Y runs down the screen');
  }
  // The top view shows the field as its image: uv (0, 0) at the top left of a span that the canvas shows across its width.
  const corner = project(viewOf({ kind: 'top', center: [0.5, 0.5], span: 1 }, { width: 1000, height: 1000 }), { width: 1000, height: 1000 }, [0, 0, 0], size)!;
  assert.ok(near(corner.x, 0) && near(corner.y, 0));
});

test('the ray of a pixel passes through every point that is drawn at that pixel, in both kinds of view', () => {
  const size = 4032;
  const cameras = [
    { kind: 'orbit', target: [2000, 1800, 240], yaw: 300, pitch: 32, distance: 7000, fovY: 35 },
    { kind: 'orbit', target: [500, 3000, 100], yaw: 47, pitch: -10, distance: 900, fovY: 60 },
    { kind: 'top', center: [0.4, 0.55], span: 1.3 },
  ] as const;
  for (const camera of cameras) {
    const view = viewOf(camera, SIZE);
    for (const point of [[1000, 2000, 300], [3900, 100, 0], [2016, 2016, 800]] as const) {
      const at = project(view, SIZE, point, size);
      assert.ok(at !== null);
      const ray = pixelRay(view, SIZE, at.x, at.y, size);
      const to = point.map((v, i) => v - ray.origin[i]!);
      const along = to[0]! * ray.direction[0] + to[1]! * ray.direction[1] + to[2]! * ray.direction[2];
      const off = Math.hypot(...to.map((v, i) => v - along * ray.direction[i]!));
      assert.ok(along > 0 && off < 1e-6 * along + 1e-3, `${camera.kind}: the ray misses ${point.join(' ')} by ${off} m`);
      assert.ok(near(Math.hypot(...ray.direction), 1));
    }
  }
});

test('the planes of a view hold a box in the picture and reject one beside or behind it', () => {
  const view = viewOf({ kind: 'orbit', target: [0, 0, 0], yaw: 0, pitch: 0, distance: 1000, fovY: 40 }, SIZE) as OrbitView;
  const planes = frustumPlanes(view);
  assert.equal(planes.length, 20);
  assert.equal(boxInFrustum(planes, -10, -10, -10, 10, 10, 10), true);
  assert.equal(boxInFrustum(planes, -3000, -10, -10, -2000, 10, 10), false, 'behind the camera');
  assert.equal(boxInFrustum(planes, -10, 5000, -10, 10, 5100, 10), false, 'far to the right');
  assert.equal(boxInFrustum(planes, -10, -10, 4000, 10, 10, 4100), false, 'far above');
  assert.equal(boxInFrustum(planes, 1e7, -1e5, -1e5, 2e7, 1e5, 1e5), true, 'there is no far plane');
  assert.equal(boxInFrustum(planes, -5000, -5000, -5000, 5000, 5000, 5000), true, 'a box around the camera');
});
