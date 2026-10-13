// The camera of the viewport (runtime.md 7.5): what a CameraState means as a projection, and back from a pixel to
// a ray. Pure arithmetic, shared by the renderer and its tests.
//
// The frame is that of engine.md 1.8, presented left-handed: +X right and +Y down the screen in a top view, +Z up.
// An orbit camera with yaw 0 looks along +X and has +Y on its right.

import type { CameraState, ViewportSize } from '../core/runtime.ts';

export type Vec3 = readonly [number, number, number];

export const DEG = Math.PI / 180;

export interface OrbitView {
  readonly kind: 'orbit';
  readonly eye: Vec3;
  /** Unit vectors of the camera: where it looks, its right and its up. */
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** 1 / tan(fovY / 2). */
  readonly focal: number;
  /** Width over height of the picture. */
  readonly aspect: number;
  readonly near: number;
  /** World to clip, column-major: reverse depth with the far plane at infinity. */
  readonly viewProj: Float32Array;
}

export interface TopView {
  readonly kind: 'top';
  readonly center: readonly [number, number];
  /** The width of the canvas in uv. */
  readonly span: number;
  /** Height over width of the picture: the canvas shows span × aspect of uv from top to bottom. */
  readonly aspect: number;
}

export type View = OrbitView | TopView;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The pitch a camera may have. The contract's orbit looks down; a camera that flies looks up as well. */
export const PITCH_LIMIT = 89.9;

export function orbitAxes(yawDegrees: number, pitchDegrees: number): { forward: Vec3; right: Vec3; up: Vec3 } {
  const y = yawDegrees * DEG;
  const p = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchDegrees)) * DEG;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return { forward: [cp * cy, cp * sy, -sp], right: [-sy, cy, 0], up: [sp * cy, sp * sy, cp] };
}

/** The position of an orbit camera: target − distance × forward (7.5). */
export function orbitEye(camera: Extract<CameraState, { kind: 'orbit' }>): Vec3 {
  const { forward } = orbitAxes(camera.yaw, camera.pitch);
  return [camera.target[0] - camera.distance * forward[0], camera.target[1] - camera.distance * forward[1], camera.target[2] - camera.distance * forward[2]];
}

export function viewOf(camera: CameraState, size: Pick<ViewportSize, 'width' | 'height'>): View {
  const width = Math.max(1, size.width), height = Math.max(1, size.height);
  if (camera.kind === 'top') {
    return { kind: 'top', center: [camera.center[0], camera.center[1]], span: Math.max(1e-6, camera.span), aspect: height / width };
  }
  const { forward, right, up } = orbitAxes(camera.yaw, camera.pitch);
  const distance = Math.max(1e-3, camera.distance);
  const eye: Vec3 = [camera.target[0] - distance * forward[0], camera.target[1] - distance * forward[1], camera.target[2] - distance * forward[2]];
  const fov = Math.max(1, Math.min(150, camera.fovY)) * DEG;
  const focal = 1 / Math.tan(fov / 2);
  const aspect = width / height;
  const near = Math.max(0.05, distance * 0.002);
  const fx = focal / aspect;
  // Rows: x = right · (p − eye) · fx, y = up · (p − eye) · focal, z = near, w = forward · (p − eye).
  const m = new Float32Array(16);
  m[0] = right[0] * fx; m[4] = right[1] * fx; m[8] = right[2] * fx; m[12] = -dot(eye, right) * fx;
  m[1] = up[0] * focal; m[5] = up[1] * focal; m[9] = up[2] * focal; m[13] = -dot(eye, up) * focal;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = near;
  m[3] = forward[0]; m[7] = forward[1]; m[11] = forward[2]; m[15] = -dot(eye, forward);
  return { kind: 'orbit', eye, forward, right, up, focal, aspect, near, viewProj: m };
}

/** The ray through a pixel, CSS pixels from the canvas's top-left. For a top view it comes straight down. */
export function pixelRay(view: View, size: Pick<ViewportSize, 'width' | 'height'>, x: number, y: number, terrainSize: number): { origin: Vec3; direction: Vec3 } {
  const nx = (x / Math.max(1, size.width)) * 2 - 1;
  const ny = 1 - (y / Math.max(1, size.height)) * 2;
  if (view.kind === 'top') {
    const u = view.center[0] + 0.5 * nx * view.span;
    const v = view.center[1] - 0.5 * ny * view.span * view.aspect;
    return { origin: [u * terrainSize, v * terrainSize, 1e9], direction: [0, 0, -1] };
  }
  const a = (nx * view.aspect) / view.focal, b = ny / view.focal;
  const d: [number, number, number] = [
    view.forward[0] + a * view.right[0] + b * view.up[0],
    view.forward[1] + a * view.right[1] + b * view.up[1],
    view.forward[2] + a * view.right[2] + b * view.up[2],
  ];
  const length = Math.hypot(d[0], d[1], d[2]);
  return { origin: view.eye, direction: [d[0] / length, d[1] / length, d[2] / length] };
}

/** Where a point in metres lands on the canvas, in CSS pixels; null when it is behind an orbit camera. */
export function project(view: View, size: Pick<ViewportSize, 'width' | 'height'>, point: Vec3, terrainSize: number): { x: number; y: number } | null {
  if (view.kind === 'top') {
    const nx = ((point[0] / terrainSize - view.center[0]) / view.span) * 2;
    const ny = -((point[1] / terrainSize - view.center[1]) / (view.span * view.aspect)) * 2;
    return { x: (nx + 1) * 0.5 * size.width, y: (1 - ny) * 0.5 * size.height };
  }
  const m = view.viewProj;
  const w = m[3]! * point[0] + m[7]! * point[1] + m[11]! * point[2] + m[15]!;
  if (w <= view.near) return null;
  const cx = (m[0]! * point[0] + m[4]! * point[1] + m[8]! * point[2] + m[12]!) / w;
  const cy = (m[1]! * point[0] + m[5]! * point[1] + m[9]! * point[2] + m[13]!) / w;
  return { x: (cx + 1) * 0.5 * size.width, y: (1 - cy) * 0.5 * size.height };
}

/**
 * The five planes of an orbit view, each (a, b, c, d) with a·x + b·y + c·z + d ≥ 0 inside: left, right, bottom,
 * top, near. There is no far plane.
 */
export function frustumPlanes(view: OrbitView): Float64Array {
  const m = view.viewProj;
  const row = (r: number): [number, number, number, number] => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!];
  const x = row(0), y = row(1), w = row(3);
  const planes = new Float64Array(20);
  const put = (i: number, p: readonly number[]): void => { for (let k = 0; k < 4; k++) planes[i * 4 + k] = p[k]!; };
  put(0, w.map((v, k) => v + x[k]!));
  put(1, w.map((v, k) => v - x[k]!));
  put(2, w.map((v, k) => v + y[k]!));
  put(3, w.map((v, k) => v - y[k]!));
  put(4, [w[0], w[1], w[2], w[3] - view.near]);
  return planes;
}

/** Whether a box may be inside the planes: false only when it lies wholly outside one of them. */
export function boxInFrustum(planes: Float64Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let i = 0; i < planes.length; i += 4) {
    const a = planes[i]!, b = planes[i + 1]!, c = planes[i + 2]!, d = planes[i + 3]!;
    if (a * (a >= 0 ? x1 : x0) + b * (b >= 0 ? y1 : y0) + c * (c >= 0 ? z1 : z0) + d < 0) return false;
  }
  return true;
}
