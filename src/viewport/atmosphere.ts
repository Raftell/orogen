// The sky: single scattering in an Earth atmosphere of Rayleigh air, Mie haze and ozone (the coefficients of
// Hillaire, EGSR 2020), with one isotropic term standing in for the light scattered more than once. The GPU
// marches it into the sky map the frame looks up (ATMOSPHERE_WGSL); this file marches the same integral for
// the few numbers a frame needs as uniforms: the colour of the sun and the light of the sky on the ground.

import { DEG, type Vec3 } from './camera.ts';

export const ATMOSPHERE = {
  groundRadius: 6_360_000,
  topRadius: 6_460_000,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6] as Vec3,       // scattering per metre at sea level
  rayleighHeight: 8000,
  mieScattering: 3.996e-6,
  mieExtinction: 8.396e-6,
  mieHeight: 1200,
  mieG: 0.8,
  ozone: [0.65e-6, 1.881e-6, 0.085e-6] as Vec3,           // absorption per metre at 25 km
  /** The eye's height above sea level for the sky map, in metres. */
  observer: 400,
  /** How much of the singly scattered light comes back from further scattering, as an isotropic source. */
  multiple: 1.4,
  /** What the ground beyond the terrain reflects. */
  groundAlbedo: 0.045,
} as const;

/** Half the height of the sun's disc as the shadows and the sky draw it, in degrees. The real disc is 0.27. */
export const SUN_DISC = 1.2;

/** How much of its hue the sky's light keeps on the ground. */
const SKY_HUE = 0.5;

const A = ATMOSPHERE;

/** The distance along a ray from `o` (|o| = r, o·d = mu·r) to the sphere of radius R, the far crossing; −1 when it misses. */
function farCrossing(r: number, mu: number, R: number): number {
  const disc = r * r * (mu * mu - 1) + R * R;
  return disc < 0 ? -1 : -r * mu + Math.sqrt(disc);
}

/** Whether the ray meets the ground, and where: the near crossing, or −1. */
function groundCrossing(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + A.groundRadius * A.groundRadius;
  if (disc < 0 || mu >= 0) return -1;
  return -r * mu - Math.sqrt(disc);
}

function densities(altitude: number): Vec3 {
  const h = Math.max(0, altitude);
  return [Math.exp(-h / A.rayleighHeight), Math.exp(-h / A.mieHeight), Math.max(0, 1 - Math.abs(h - 25_000) / 15_000)];
}

function extinction(depth: Vec3): Vec3 {
  return [0, 1, 2].map((c) => Math.exp(-(A.rayleigh[c]! * depth[0] + A.mieExtinction * depth[1] + A.ozone[c]! * depth[2]))) as unknown as Vec3;
}

/** The optical depths (air, haze, ozone) from the point at radius r along the direction whose cosine to the zenith is mu, to the top. */
function depthToTop(r: number, mu: number, steps: number): Vec3 {
  const length = farCrossing(r, mu, A.topRadius);
  if (length <= 0) return [0, 0, 0];
  const dt = length / steps;
  const sum = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const d = densities(Math.sqrt(r * r + t * t + 2 * r * mu * t) - A.groundRadius);
    for (let c = 0; c < 3; c++) sum[c]! += d[c]! * dt;
  }
  return sum as unknown as Vec3;
}

/** What reaches the eye of the sun's light, per channel: 1 is the sun above the atmosphere. 0 below the horizon. */
export function sunTransmittance(elevationDegrees: number): Vec3 {
  const r = A.groundRadius + A.observer;
  const mu = Math.sin(elevationDegrees * DEG);
  if (groundCrossing(r, mu) > 0) return [0, 0, 0];
  return extinction(depthToTop(r, mu, 48));
}

const rayleighPhase = (cos: number): number => (3 / (16 * Math.PI)) * (1 + cos * cos);
function miePhase(cos: number): number {
  const g = A.mieG;
  return ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + cos * cos))) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * cos, 1.5));
}

/**
 * The radiance of the sky in a direction, for a sun of irradiance 1 per channel at azimuth 0. The direction is
 * given by its elevation and its azimuth from the sun, in degrees. Below the horizon it is the ground seen through the air.
 */
export function skyRadiance(elevation: number, azimuth: number, sunElevation: number, steps = 24): Vec3 {
  const r0 = A.groundRadius + A.observer;
  const ce = Math.cos(elevation * DEG), se = Math.sin(elevation * DEG);
  const dir: Vec3 = [ce * Math.cos(azimuth * DEG), ce * Math.sin(azimuth * DEG), se];
  const sun: Vec3 = [Math.cos(sunElevation * DEG), 0, Math.sin(sunElevation * DEG)];
  const cos = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const ground = groundCrossing(r0, se);
  const length = ground > 0 ? ground : farCrossing(r0, se, A.topRadius);
  const out = [0, 0, 0];
  if (length <= 0) return [0, 0, 0];
  const dt = length / steps;
  const depth = [0, 0, 0];
  const pr = rayleighPhase(cos), pm = miePhase(cos), iso = A.multiple / (4 * Math.PI);
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    // The sample, in a frame whose origin is the planet's centre: the eye is at (0, 0, r0).
    const p: Vec3 = [dir[0] * t, dir[1] * t, r0 + dir[2] * t];
    const r = Math.hypot(p[0], p[1], p[2]);
    const d = densities(r - A.groundRadius);
    for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
    const mu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
    if (groundCrossing(r, mu) < 0) {
      const toSun = depthToTop(r, mu, 6);
      const through = extinction([depth[0]! + toSun[0], depth[1]! + toSun[1], depth[2]! + toSun[2]]);
      for (let c = 0; c < 3; c++) {
        const air = A.rayleigh[c]! * d[0], haze = A.mieScattering * d[1];
        out[c]! += through[c]! * (air * pr + haze * pm + (air + haze) * iso) * dt;
      }
    }
    for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
  }
  if (ground > 0) {
    // The ground beyond the terrain, lit by the sun and seen through the air in between.
    const through = extinction(depth as unknown as Vec3);
    const lit = sunTransmittance(sunElevation);
    const cosSun = Math.max(0, sun[2]);
    for (let c = 0; c < 3; c++) out[c]! += (through[c]! * A.groundAlbedo * (lit[c]! * cosSun + 0.03)) / Math.PI;
  }
  return out as unknown as Vec3;
}

export interface SkyLight {
  /** The sun's irradiance on a surface facing it, per channel; the part of its disc above the horizon counted. */
  readonly sun: Vec3;
  /** The sky's irradiance over π on level ground, and on a wall averaged over the directions it may face. */
  readonly up: Vec3;
  readonly side: Vec3;
}

/** The light of a sun at an elevation, in degrees. */
export function skyLight(sunElevation: number): SkyLight {
  const up = [0, 0, 0], side = [0, 0, 0];
  const ELEVATIONS = 6, AZIMUTHS = 8;
  let upWeight = 0, sideWeight = 0;
  for (let i = 0; i < ELEVATIONS; i++) {
    const elevation = ((i + 0.5) / ELEVATIONS) * 90;
    const solid = Math.cos(elevation * DEG);
    for (let j = 0; j < AZIMUTHS; j++) {
      const azimuth = ((j + 0.5) / AZIMUTHS) * 360;
      const radiance = skyRadiance(elevation, azimuth, sunElevation, 12);
      const wUp = solid * Math.sin(elevation * DEG);
      // A wall facing the azimuth a sees this direction with the cosine cos(elevation) · cos(azimuth − a); its mean over a is cos(elevation) / π.
      const wSide = (solid * Math.cos(elevation * DEG)) / Math.PI;
      for (let c = 0; c < 3; c++) {
        up[c]! += radiance[c]! * wUp;
        side[c]! += radiance[c]! * wSide;
      }
      upWeight += wUp;
      sideWeight += wSide;
    }
  }
  // Σ L cos dω over the hemisphere, divided by π: with weights that sum to those of a uniform sky of radiance 1.
  for (let c = 0; c < 3; c++) {
    up[c] = up[c]! / upWeight;
    side[c] = (side[c]! / sideWeight) * 0.5;
  }
  // The march scatters once, and what is scattered once is bluer than a sky is: light that was scattered again,
  // and the eye that has adapted to it, leave a shadow about half as blue. To calibrate against a sky that is
  // scattered more than once.
  for (const light of [up, side]) {
    const grey = luminance(light as unknown as Vec3);
    for (let c = 0; c < 3; c++) light[c] = grey + SKY_HUE * (light[c]! - grey);
  }
  // The disc sets: what is above the horizontal still lights.
  const above = Math.max(0, Math.min(1, (sunElevation + SUN_DISC) / (2 * SUN_DISC)));
  const through = sunTransmittance(Math.max(sunElevation, 0.05));
  return { sun: [through[0] * above, through[1] * above, through[2] * above], up: up as unknown as Vec3, side: side as unknown as Vec3 };
}

export const luminance = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The factor that brings sunlit ground of the albedo 0.18 to the middle of the display's range. It follows the
 * light most of the way, so that a low sun still shows the terrain, and not all of it, so that evening is darker
 * than noon.
 */
export function exposureFor(light: SkyLight, sunElevation: number): number {
  const key = 0.18 * ((luminance(light.sun) * Math.sin(Math.max(sunElevation, 0) * DEG)) / Math.PI + luminance(light.up));
  const REFERENCE = 0.04;      // the key of a sun at 45 degrees
  return 0.3 / (Math.pow(Math.max(key, 1e-5), 0.85) * Math.pow(REFERENCE, 0.15));
}

/** WGSL: the same atmosphere, marched for the sky map. `skyMarch(dir, sun)` returns radiance for a sun of irradiance 1. */
export const ATMOSPHERE_WGSL = /* wgsl */ `
const RG = ${A.groundRadius}.0;
const RT = ${A.topRadius}.0;
const BETA_R = vec3f(${A.rayleigh.join(', ')});
const H_R = ${A.rayleighHeight}.0;
const BETA_MS = ${A.mieScattering};
const BETA_ME = ${A.mieExtinction};
const H_M = ${A.mieHeight}.0;
const MIE_G = ${A.mieG};
const BETA_O = vec3f(${A.ozone.join(', ')});
const OBSERVER = ${A.observer}.0;
const MULTIPLE = ${A.multiple};
const GROUND_ALBEDO = ${A.groundAlbedo};
const PI = 3.14159265358979;

fn farCrossing(r: f32, mu: f32, radius: f32) -> f32 {
  let disc = r * r * (mu * mu - 1.0) + radius * radius;
  if (disc < 0.0) { return -1.0; }
  return -r * mu + sqrt(disc);
}
fn groundCrossing(r: f32, mu: f32) -> f32 {
  let disc = r * r * (mu * mu - 1.0) + RG * RG;
  if (disc < 0.0 || mu >= 0.0) { return -1.0; }
  return -r * mu - sqrt(disc);
}
fn densities(altitude: f32) -> vec3f {
  let h = max(altitude, 0.0);
  return vec3f(exp(-h / H_R), exp(-h / H_M), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}
fn extinction(depth: vec3f) -> vec3f {
  return exp(-(BETA_R * depth.x + vec3f(BETA_ME * depth.y) + BETA_O * depth.z));
}
fn depthToTop(r: f32, mu: f32) -> vec3f {
  let len = farCrossing(r, mu, RT);
  if (len <= 0.0) { return vec3f(0.0); }
  let dt = len / 6.0;
  var sum = vec3f(0.0);
  for (var i = 0; i < 6; i++) {
    let t = (f32(i) + 0.5) * dt;
    sum += densities(sqrt(r * r + t * t + 2.0 * r * mu * t) - RG) * dt;
  }
  return sum;
}
fn skyMarch(dir: vec3f, sun: vec3f) -> vec3f {
  let r0 = RG + OBSERVER;
  let ground = groundCrossing(r0, dir.z);
  var len = farCrossing(r0, dir.z, RT);
  if (ground > 0.0) { len = ground; }
  if (len <= 0.0) { return vec3f(0.0); }
  let STEPS = 32;
  let dt = len / f32(STEPS);
  let cosine = dot(dir, sun);
  let pr = 3.0 / (16.0 * PI) * (1.0 + cosine * cosine);
  let g = MIE_G;
  let pm = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + cosine * cosine)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * cosine, 1e-4), 1.5));
  let iso = MULTIPLE / (4.0 * PI);
  var depth = vec3f(0.0);
  var sum = vec3f(0.0);
  for (var i = 0; i < STEPS; i++) {
    let t = (f32(i) + 0.5) * dt;
    let p = vec3f(dir.x * t, dir.y * t, r0 + dir.z * t);
    let r = length(p);
    let d = densities(r - RG);
    depth += d * dt * 0.5;
    let mu = dot(p, sun) / r;
    if (groundCrossing(r, mu) < 0.0) {
      let through = extinction(depth + depthToTop(r, mu));
      let air = BETA_R * d.x;
      let haze = BETA_MS * d.y;
      sum += through * (air * pr + vec3f(haze * pm) + (air + vec3f(haze)) * iso) * dt;
    }
    depth += d * dt * 0.5;
  }
  if (ground > 0.0) {
    var lit = vec3f(0.0);
    if (groundCrossing(r0, sun.z) < 0.0) { lit = extinction(depthToTop(r0, sun.z)); }
    sum += extinction(depth) * GROUND_ALBEDO * (lit * max(sun.z, 0.0) + vec3f(0.03)) / PI;
  }
  return sum;
}
`;
