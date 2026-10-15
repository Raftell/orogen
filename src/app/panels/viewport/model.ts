// What the viewport panel holds and how the pointer changes it: the two cameras, the display options, and the
// arithmetic of orbit, pan, dolly, fly, framing and the sun. No DOM and no React: the panel's unit tests run it.
//
// Angles are degrees and directions follow engine.md 1.8: a yaw or an azimuth of 0 points along +X, 90 along +Y,
// which is down the screen in the top view. The camera is the one of runtime.md 7.5.

import { portLabel, type CameraState, type GraphDoc, type NodeRegistry, type PortRef, type ViewportDisplay } from '../../../core/runtime.ts';

export type Vec3 = readonly [number, number, number];
export type OrbitCamera = Extract<CameraState, { kind: 'orbit' }>;
export type TopCamera = Extract<CameraState, { kind: 'top' }>;

export type Shading = 'material' | 'clay';
export type TopStyle = 'hillshade' | 'grey' | 'overlay';
export const PALETTES = ['red', 'blue', 'green', 'grey', 'viridis', 'magma', 'turbo'] as const;
export type Palette = (typeof PALETTES)[number];

/** `ViewportDisplay` with the members the renderer of src/viewport/ reads beside it (runtime.md 7.5). */
export interface DisplayOptions extends ViewportDisplay {
  readonly shading: Shading;
  readonly topStyle: TopStyle;
  readonly palette: Palette;
}

/** The sun stands to the left of the top view and over the left shoulder of the first 3D camera: relief reads in both. */
export const DEFAULT_DISPLAY: DisplayOptions = {
  verticalScale: 1, showSea: true, sunAzimuth: 195, sunElevation: 38, shading: 'material', topStyle: 'hillshade', palette: 'red',
};

export const SHADING_LABELS: Readonly<Record<Shading, string>> = { material: 'Material', clay: 'Clay' };
export const TOP_STYLE_LABELS: Readonly<Record<TopStyle, string>> = { hillshade: 'Hillshade', grey: 'Height', overlay: 'Overlay' };
export const PALETTE_LABELS: Readonly<Record<Palette, string>> = {
  red: 'Red', blue: 'Blue', green: 'Green', grey: 'Gray', viridis: 'Viridis', magma: 'Magma', turbo: 'Turbo',
};

export interface Terrain {
  readonly terrainSize: number;      // metres across
  readonly heightRange: number;      // metres of height 1
}

export interface ViewportModel {
  readonly mode: 'orbit' | 'top';
  readonly orbit: OrbitCamera;
  readonly top: TopCamera;
  readonly display: DisplayOptions;
  /** The terrain the cameras were framed for; a project of another size is framed anew. */
  readonly framed: Terrain | null;
  /**
   * The cameras as the last framing left them. A camera that is still that very one was not moved since, and
   * follows the panel when it gets another shape; one the user has moved is the user's.
   */
  readonly framedOrbit: OrbitCamera | null;
  readonly framedTop: TopCamera | null;
  /** Where the heights of the framed terrain lie, as a share of the height range, as the engine last said; null: not asked yet. */
  readonly framedMiddle: number | null;
}

const DEG = Math.PI / 180;
export const PITCH_MIN = -89;
export const PITCH_MAX = 89.9;
export const FOV_Y = 35;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const wrap = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** The camera's axes: where it looks, its right and its up (runtime.md 7.5). */
export function axes(yaw: number, pitch: number): { readonly forward: Vec3; readonly right: Vec3; readonly up: Vec3 } {
  const y = yaw * DEG, p = pitch * DEG;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return { forward: [cp * cy, cp * sy, -sp], right: [-sy, cy, 0], up: [sp * cy, sp * sy, cp] };
}

export function eyeOf(camera: OrbitCamera): Vec3 {
  const { forward } = axes(camera.yaw, camera.pitch);
  return [camera.target[0] - camera.distance * forward[0], camera.target[1] - camera.distance * forward[1], camera.target[2] - camera.distance * forward[2]];
}

/**
 * The orbit camera that shows the whole terrain in a picture of the given aspect (width over height), from the
 * direction it has: as near as the terrain's box still fits the picture with a margin. `middle` is where most of
 * the terrain's heights lie, as a share of the height range.
 */
export function frameOrbit(
  terrain: Terrain, verticalScale: number, aspect: number, from: Pick<OrbitCamera, 'yaw' | 'pitch'> = { yaw: 300, pitch: 30 }, middle = 0.25, sea: number | null = null,
): OrbitCamera {
  const size = terrain.terrainSize;
  const relief = terrain.heightRange * verticalScale;
  const yaw = wrap(from.yaw), pitch = clamp(from.pitch, PITCH_MIN, PITCH_MAX);
  const { forward, right, up } = axes(yaw, pitch);
  const focal = 1 / Math.tan((FOV_Y * DEG) / 2);
  // A sea that is shown stands in the picture as well, as far as a picture can hold it: three height ranges.
  const water = sea !== null && Number.isFinite(sea) ? clamp(sea, 0, 3) : 0;
  const top = relief * Math.max(Math.min(1, Math.max(0.5, middle * 2.4)), water);
  const corners: Vec3[] = [];
  for (const x of [0, size]) for (const y of [0, size]) for (const z of [0, top]) corners.push([x, y, z]);
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const wide = Math.max(aspect, 0.1);
  /** Where the corners lie in the picture of a camera at `target` and `distance`: left, right, bottom, top, each −1 .. 1 at the picture's edge. */
  const extent = (target: Vec3, distance: number): readonly [number, number, number, number] | null => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const corner of corners) {
      const from: Vec3 = [corner[0] - target[0], corner[1] - target[1], corner[2] - target[2]];
      const depth = dot(from, forward) + distance;
      if (depth <= distance * 0.05) return null;
      const x = (dot(from, right) * focal) / wide / depth, y = (dot(from, up) * focal) / depth;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return [x0, x1, y0, y1];
  };
  // The least distance at which no corner reaches beyond the margin, found by halving in ratios: how far a
  // corner reaches falls as the camera backs away. Then the target moves across the picture so that the box
  // lies in its middle, and the distance is found again; perspective makes that a few rounds.
  const FILL = 0.88;
  let target: Vec3 = [size / 2, size / 2, relief * middle];
  let distance = size * 2;
  for (let round = 0; round < 4; round++) {
    let near = (size + relief) * 1e-3, far = (size + relief) * 1e3;
    for (let step = 0; step < 50; step++) {
      const between = Math.sqrt(near * far);
      const reach = extent(target, between);
      if (!reach || Math.max(-reach[0], reach[1], -reach[2], reach[3]) > FILL) near = between;
      else far = between;
    }
    distance = far;
    const reach = extent(target, distance);
    if (!reach) break;
    const across = (((reach[0] + reach[1]) / 2) * wide * distance) / focal, upwards = (((reach[2] + reach[3]) / 2) * distance) / focal;
    target = [target[0] + right[0] * across + up[0] * upwards, target[1] + right[1] * across + up[1] * upwards, target[2] + right[2] * across + up[2] * upwards];
  }
  return { kind: 'orbit', target, yaw, pitch, distance, fovY: FOV_Y };
}

/** The top camera that shows the whole terrain, with a margin, in a picture of the given aspect. */
export function frameTop(aspect: number): TopCamera {
  return { kind: 'top', center: [0.5, 0.5], span: 1.08 * Math.max(1, aspect) };
}

export function initialModel(): ViewportModel {
  return { mode: 'orbit', orbit: frameOrbit({ terrainSize: 4032, heightRange: 1008 }, 1, 1.6), top: frameTop(1.6), display: DEFAULT_DISPLAY, framed: null, framedOrbit: null, framedTop: null, framedMiddle: null };
}

export const cameraOf = (model: ViewportModel): CameraState => (model.mode === 'top' ? model.top : model.orbit);

// ---- what a drag does ------------------------------------------------------------------------------------------------

export type DragKind = 'orbit' | 'pan' | 'dolly' | 'fly' | 'sun';

export interface Modifiers { readonly alt: boolean; readonly shift: boolean; readonly ctrl: boolean }

/**
 * What a press begins. Both conventions are served: Alt with the left, middle and right button orbits, pans and
 * dollies, and the middle button alone orbits, with Shift it pans. The left button alone orbits as well. The
 * right button alone flies. Shift with the left button turns the sun. In the top view every drag pans.
 */
export function dragKind(mode: ViewportModel['mode'], button: number, mods: Modifiers): DragKind | null {
  if (button < 0 || button > 2) return null;
  if (button === 0 && mods.shift && !mods.alt) return 'sun';
  if (mode === 'top') return button === 2 && mods.alt ? 'dolly' : 'pan';
  if (button === 0) return 'orbit';
  if (button === 1) return mods.alt || mods.shift ? 'pan' : 'orbit';
  return mods.alt ? 'dolly' : 'fly';
}

/** Degrees of yaw or pitch per pixel of an orbit drag. */
const ORBIT_SPEED = 0.3;
const LOOK_SPEED = 0.15;
const DOLLY_SPEED = 0.006;
export const WHEEL_SPEED = 0.0015;

/** Turns the camera about its target: dragging right brings the near side of the terrain to the right, dragging down shows more of its top. */
export function orbit(camera: OrbitCamera, dx: number, dy: number): OrbitCamera {
  return { ...camera, yaw: wrap(camera.yaw + dx * ORBIT_SPEED), pitch: clamp(camera.pitch + dy * ORBIT_SPEED, PITCH_MIN, PITCH_MAX) };
}

/** Moves camera and target across the picture's plane, so that what is under the pointer stays under it at the target's distance. */
export function pan(camera: OrbitCamera, dx: number, dy: number, viewportHeight: number): OrbitCamera {
  const { right, up } = axes(camera.yaw, camera.pitch);
  const metres = (2 * camera.distance * Math.tan((camera.fovY * DEG) / 2)) / Math.max(1, viewportHeight);
  const target: Vec3 = [
    camera.target[0] + (-right[0] * dx + up[0] * dy) * metres,
    camera.target[1] + (-right[1] * dx + up[1] * dy) * metres,
    camera.target[2] + (-right[2] * dx + up[2] * dy) * metres,
  ];
  return { ...camera, target };
}

/** Brings a point to the middle of the picture, from the direction and the distance the camera has: the point is what it turns about from then on. */
export function centerOrbit(camera: OrbitCamera, point: Vec3): OrbitCamera {
  return { ...camera, target: [point[0], point[1], point[2]] };
}

export function centerTop(camera: TopCamera, uv: readonly [number, number]): TopCamera {
  return { ...camera, center: [clamp(uv[0], -1, 2), clamp(uv[1], -1, 2)] };
}

/** Scales the distance; with a point given, towards that point, which keeps its place in the picture. */
export function dolly(camera: OrbitCamera, factor: number, towards?: Vec3 | null, limits: { readonly min: number; readonly max: number } = { min: 0.5, max: 1e7 }): OrbitCamera {
  const distance = clamp(camera.distance * factor, limits.min, limits.max);
  const scale = distance / camera.distance;
  if (!towards) return { ...camera, distance };
  const target: Vec3 = [
    towards[0] + (camera.target[0] - towards[0]) * scale,
    towards[1] + (camera.target[1] - towards[1]) * scale,
    towards[2] + (camera.target[2] - towards[2]) * scale,
  ];
  return { ...camera, target, distance };
}

export const dollyDrag = (camera: OrbitCamera, dx: number, dy: number): OrbitCamera => dolly(camera, Math.exp(-(dx - dy) * DOLLY_SPEED));
export const wheelFactor = (deltaY: number): number => Math.exp(clamp(deltaY, -600, 600) * WHEEL_SPEED);

/** With Ctrl held a drag moves the camera, or the sun, a quarter as far: for the last degree of a view. */
export const FINE = 0.25;
export const dragScale = (mods: Pick<Modifiers, 'ctrl'>): number => (mods.ctrl ? FINE : 1);

// ---- the wheel, and the two fingers of a trackpad ---------------------------------------------------------------------
// A browser has one event for all of it. A pinch on a trackpad arrives as a wheel event with ctrlKey set, by
// Chromium's own convention, and so does the wheel of a mouse with Ctrl held: both zoom. Two fingers that move
// over a trackpad arrive as wheel events without it, and so does the wheel of a mouse; the picture should follow
// the fingers and be dollied by the wheel, and nothing in the event says which it is. What tells them apart:
// a wheel turns in notches, each a large step along one axis (100 pixels in Chromium on Windows, 53 or more on
// Linux), or counts in lines; fingers begin slowly, in pixels, and seldom along one axis alone.

export type WheelKind = 'pinch' | 'pan' | 'wheel';
export interface WheelLike { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number; readonly ctrlKey: boolean; readonly shiftKey?: boolean }
/** The gesture a wheel event belongs to: events less than WHEEL_STREAM_MS apart are one. */
export interface WheelStream { readonly kind: WheelKind; readonly time: number }
export const WHEEL_STREAM_MS = 180;
/** A step along the wheel's axis that is at least this many pixels is a notch of a wheel. */
export const WHEEL_NOTCH_PX = 40;

/**
 * What a wheel event is: a pinch, two fingers that move, or the wheel of a mouse. Within one gesture it stays
 * what its first event was, so that the fast middle of a swipe, or its coasting to a stop, is not taken for a
 * wheel, and a wheel that is turned gently between two notches is not taken for fingers. A pinch is known by
 * every one of its events and may begin or end in the middle of another gesture.
 */
export function wheelKind(event: WheelLike, stream: WheelStream | null, now: number): WheelKind {
  if (event.ctrlKey) return 'pinch';
  if (stream && stream.kind !== 'pinch' && now - stream.time < WHEEL_STREAM_MS) return stream.kind;
  // Lines or pages: a wheel.
  if (event.deltaMode !== 0) return 'wheel';
  // Shift turns a wheel's notch into a step across: still a notch.
  const along = event.shiftKey && event.deltaY === 0 ? event.deltaX : event.deltaY;
  const across = along === event.deltaY ? event.deltaX : 0;
  if (across !== 0) return 'pan';
  return Math.abs(along) >= WHEEL_NOTCH_PX ? 'wheel' : 'pan';
}

/** The step of a wheel's notch, whichever axis it came on. */
export const wheelStep = (event: WheelLike): number => (event.deltaY !== 0 ? event.deltaY : event.deltaX);

/**
 * The factor of a pinch: the distance, or the span of the top view, is multiplied by it. Chromium sends a pinch
 * as steps of a hundred times the change of the fingers' spread, so a step of −10 is a tenth nearer; the wheel
 * of a mouse with Ctrl held sends whole notches, which count as a step of 30.
 */
export const pinchFactor = (deltaY: number): number => Math.exp(clamp(deltaY, -30, 30) * 0.01);

/** Turns the camera about its own position, as a head turns: the target swings round the eye. */
export function look(camera: OrbitCamera, dx: number, dy: number): OrbitCamera {
  const eye = eyeOf(camera);
  const yaw = wrap(camera.yaw + dx * LOOK_SPEED), pitch = clamp(camera.pitch + dy * LOOK_SPEED, PITCH_MIN, PITCH_MAX);
  const { forward } = axes(yaw, pitch);
  return { ...camera, yaw, pitch, target: [eye[0] + camera.distance * forward[0], eye[1] + camera.distance * forward[1], eye[2] + camera.distance * forward[2]] };
}

export interface FlyKeys { readonly forward: number; readonly right: number; readonly up: number }

/**
 * Whether a key pressed on the picture brings the camera nearer (1), takes it away (-1) or neither (0). By the
 * character the key types, as a shortcut's letter (runtime.md 8.8 rule 2), and not by its place as the fly keys:
 * on AZERTY minus is the key of 6 and the US place of minus types `)`; on QWERTZ plus lies right of Ü. `=` and `_`
 * count where they share the key of plus or of minus, as on a US keyboard; the keypad's two always do.
 */
export function zoomKey(event: { readonly code: string; readonly key: string }): 1 | -1 | 0 {
  if (event.code === 'NumpadAdd' || event.key === '+' || (event.key === '=' && event.code === 'Equal')) return 1;
  if (event.code === 'NumpadSubtract' || event.key === '-' || (event.key === '_' && event.code === 'Minus')) return -1;
  return 0;
}

/** The movement the held keys ask for, by KeyboardEvent.code: W and S along the view, A and D across it, E and Q up and down. */
export function flyKeys(held: ReadonlySet<string>): FlyKeys {
  const axis = (plus: string, minus: string): number => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
  return { forward: axis('KeyW', 'KeyS'), right: axis('KeyD', 'KeyA'), up: axis('KeyE', 'KeyQ') };
}

/** Moves camera and target together for `seconds` of flight at `speed` metres per second. */
export function fly(camera: OrbitCamera, keys: FlyKeys, speed: number, seconds: number): OrbitCamera {
  if (keys.forward === 0 && keys.right === 0 && keys.up === 0) return camera;
  const { forward, right } = axes(camera.yaw, camera.pitch);
  const step = speed * seconds;
  const target: Vec3 = [
    camera.target[0] + (forward[0] * keys.forward + right[0] * keys.right) * step,
    camera.target[1] + (forward[1] * keys.forward + right[1] * keys.right) * step,
    camera.target[2] + (forward[2] * keys.forward + keys.up) * step,
  ];
  return { ...camera, target };
}

/** Metres per second of flight: the terrain is crossed in about four seconds; Shift is three times as fast, Ctrl a third. */
export function flySpeed(terrain: Terrain, mods: Pick<Modifiers, 'shift' | 'ctrl'>, gear = 1): number {
  return (terrain.terrainSize / 4) * gear * (mods.shift ? 3 : 1) * (mods.ctrl ? 1 / 3 : 1);
}

// ---- the top view ----------------------------------------------------------------------------------------------------

/** The uv under a point of the canvas (CSS pixels from its top-left). */
export function topUv(camera: TopCamera, x: number, y: number, width: number, height: number): readonly [number, number] {
  const w = Math.max(1, width), h = Math.max(1, height);
  return [camera.center[0] + (x / w - 0.5) * camera.span, camera.center[1] + (y / h - 0.5) * camera.span * (h / w)];
}

export function panTop(camera: TopCamera, dx: number, dy: number, width: number): TopCamera {
  const perPixel = camera.span / Math.max(1, width);
  return { ...camera, center: [clamp(camera.center[0] - dx * perPixel, -1, 2), clamp(camera.center[1] - dy * perPixel, -1, 2)] };
}

/** Scales the span about the point under the pointer, which stays where it is. */
export function zoomTop(camera: TopCamera, factor: number, x: number, y: number, width: number, height: number): TopCamera {
  const span = clamp(camera.span * factor, 0.002, 16);
  const scale = span / camera.span;
  const at = topUv(camera, x, y, width, height);
  return { ...camera, span, center: [at[0] + (camera.center[0] - at[0]) * scale, at[1] + (camera.center[1] - at[1]) * scale] };
}

// ---- the sun ---------------------------------------------------------------------------------------------------------

/** A drag of the sun: across turns it, upwards raises it. */
export function dragSun(display: DisplayOptions, dx: number, dy: number): DisplayOptions {
  return { ...display, sunAzimuth: wrap(display.sunAzimuth + dx * 0.4), sunElevation: clamp(display.sunElevation - dy * 0.25, 0, 90) };
}

// ---- what the panel says of the view ---------------------------------------------------------------------------------

export type ViewStatus = 'starting' | 'lost' | 'failed' | 'bare' | 'empty' | 'waiting' | 'error' | 'overlayError' | 'unwired' | 'updating' | 'paused' | 'stale' | 'draft' | 'shown';
/** A node's state in engineStore, and 'unwired' for one whose error is that an input is not connected. */
export type NodeState = 'idle' | 'running' | 'done' | 'error' | 'skipped' | 'unwired';

export interface ViewFacts {
  readonly device: 'starting' | 'ready' | 'lost' | 'failed';
  /** Whether the view names a node and port the document holds. */
  readonly bound: boolean;
  /** The state of the node whose output is the terrain shown, from engineStore; of the overlay's node when the view has no terrain. */
  readonly node: NodeState | null;
  /** The state of the overlay's node, when the view has a terrain and an overlay. */
  readonly overlay: NodeState | null;
  readonly shown: { readonly revision: number; readonly resolution: number; readonly draft: boolean } | null;
  /**
   * Whether what is shown has anything in it. A view that names nothing is shown too, as nothing (7.4 rule 5):
   * a project that comes after it has no picture yet, whatever `shown` says. Default true.
   */
  readonly pictured?: boolean;
  /** The revision the engine was last sent. */
  readonly sent: number;
  readonly evaluating: boolean;
  /** Previews are paused (engineStore `paused`). Default false. */
  readonly paused?: boolean;
  /** A build runs: nothing is previewed until it has ended (7.6 rule 2), and that stands in the way before a pause does (8.7 rule 10). Default false. */
  readonly building?: boolean;
  /** How many nodes the project has. Default: some. */
  readonly nodes?: number;
}

const failed = (state: NodeState | null): boolean => state === 'error' || state === 'skipped';

/**
 * What is to be said of the picture: the first that holds, from the device down to the result. A view whose
 * terrain or overlay failed shows nothing new (runtime.md 7.3 rule 6), so either failure is said, and which. A
 * draft is a draft while its gesture lasts, whether or not the next one is being computed: the word does not
 * come and go with every evaluation. A picture of an earlier document, or none, while nothing computes the
 * next: 'paused' when that is because previews are paused, which is no fault and is said as what it is;
 * 'stale' and 'waiting' otherwise, as while a build runs. A view that names nothing is 'empty', and 'bare' in a
 * project that has no node to name.
 */
export function viewStatus(facts: ViewFacts): ViewStatus {
  if (facts.device === 'starting') return 'starting';
  if (facts.device === 'lost') return 'lost';
  if (facts.device === 'failed') return 'failed';
  if (!facts.bound) return facts.nodes === 0 ? 'bare' : 'empty';
  // A node that waits for a wire is unfinished, not failed: the graph and the inspector say so, and so does this.
  if (!facts.evaluating && (facts.node === 'unwired' || (!failed(facts.node) && facts.overlay === 'unwired'))) return 'unwired';
  if (!facts.evaluating && failed(facts.node)) return 'error';
  if (!facts.evaluating && failed(facts.overlay)) return 'overlayError';
  const paused = facts.paused === true && facts.building !== true;
  if (!facts.shown || facts.pictured === false) return facts.evaluating ? 'updating' : paused ? 'paused' : 'waiting';
  if (facts.shown.draft) return 'draft';
  if (facts.evaluating) return 'updating';
  if (facts.shown.revision >= facts.sent) return 'shown';
  return paused ? 'paused' : 'stale';
}

/** A status as a sentence: the title of what covers the canvas when there is no picture, and the tooltip of the toolbar's word. */
export const STATUS_TEXT: Readonly<Record<ViewStatus, string>> = {
  starting: 'Starting the engine',
  lost: 'The graphics device was lost',
  failed: 'No graphics device',
  bare: 'This project has no nodes yet',
  empty: 'Nothing is shown',
  waiting: 'Not computed yet',
  error: 'The shown node failed',
  overlayError: 'The overlay failed; the picture is the last one',
  unwired: 'The shown node lacks an input',
  updating: 'Updating',
  paused: 'Previews are paused',
  stale: 'The picture is of an earlier state of the project',
  draft: 'A coarser draft, while a value is being changed',
  shown: '',
};

/**
 * What a person can do about a status, or what happens next: the second line of the cover. The commands are
 * named as the menus name them (src/app/shell/app-commands.ts); tests/ui/viewport/states.test.ts holds the two
 * to each other.
 */
export const STATUS_HINT: Readonly<Record<ViewStatus, string>> = {
  starting: 'The graphics device is being opened',
  lost: 'It is being recovered, and the picture comes back by itself',
  failed: 'Engine › Retry Graphics Device tries again. The status bar says what the device reported',
  bare: 'Drag a node in from the Library, or open one of its examples',
  empty: 'Select a node in the graph to see its terrain',
  waiting: 'The terrain is shown as soon as it is computed',
  error: 'View › Show Errors lists what failed and why',
  overlayError: 'View › Show Errors lists what failed and why',
  unwired: 'Connect its input in the graph to see its terrain',
  updating: '',
  paused: 'Engine › Pause or Resume Previews computes what the project is now',
  stale: 'A build is running, or the newer state could not be computed',
  draft: '',
  shown: '',
};
/** The hint of 'waiting' and 'stale' while a build runs: nothing is previewed until it has ended (7.6 rule 2). */
export const HINT_WHILE_BUILDING = 'A build is running: the terrain is computed when it has ended';

/** A status as the toolbar says it: a word or two beside the resolution. */
export const STATUS_WORD: Readonly<Record<ViewStatus, string>> = {
  starting: 'Starting',
  lost: 'Device lost',
  failed: 'No device',
  bare: '',
  empty: '',
  waiting: 'Waiting',
  error: 'Node failed',
  overlayError: 'Overlay failed',
  unwired: 'Missing input',
  updating: 'Updating',
  paused: 'Paused',
  stale: 'Out of date',
  draft: 'Draft',
  shown: '',
};

/** Whether a status leaves the canvas without a picture to trust: it is covered, and the status said there. */
export function isBlank(status: ViewStatus, shown: boolean): boolean {
  if (status === 'bare' || status === 'empty' || status === 'starting' || status === 'failed' || status === 'waiting') return true;
  return (status === 'lost' || status === 'error' || status === 'unwired' || status === 'paused') && !shown;
}

/**
 * What an output is called where the panel names it: the node's own title, or its type's, and the output's label
 * when it is not the node's first. Null for a node the document does not hold.
 */
export function outputTitle(doc: GraphDoc, registry: NodeRegistry, ref: PortRef | undefined): string | null {
  if (!ref || !Object.hasOwn(doc.nodes, ref.node)) return null;
  const node = doc.nodes[ref.node]!;
  const def = registry.get(node.type);
  const title = node.title !== undefined && node.title.trim() !== '' ? node.title.trim() : def?.title ?? node.type;
  const outputs = def?.outputs ?? [];
  const port = outputs.find((output) => output.name === ref.port);
  if (!port || outputs[0] === port) return title;
  // As every panel names a port (runtime.md 8.7 rule 9).
  return `${title} · ${portLabel(port)}`;
}

/** A length in metres as the readout writes it: three significant digits below a hundred metres, whole metres above. */
export function metres(value: number): string {
  if (!Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (size >= 100) return `${Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')} m`;
  return `${Number(value.toPrecision(3))} m`;
}
