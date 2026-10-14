// The sky: an Earth atmosphere of Rayleigh air, Mie haze and ozone, scattered once along the ray of a pixel and,
// for the light that was scattered more than once, with the transfer function of Hillaire (EGSR 2020, section
// 5.5): what a point of the air receives from the rest of it, taken as isotropic. The GPU marches it into the
// sky map the frame looks up (ATMOSPHERE_WGSL); this file marches the same integrals for the few numbers a frame
// needs as uniforms: the colour of the sun, the light of the sky on the ground, the exposure and the white
// balance, and the table of the multiple scattering that the GPU's march reads.
//
// Nothing here is tuned to a picture. What is chosen is named: how hazy the day is (`visibility`), how dark the
// ground beyond the terrain lies (`groundAlbedo`), and where sunlit ground lands in the display's range (`KEY`).

import { DEG, type Vec3 } from './camera.ts';

/** How far one sees through the haze of the day, in metres (Koschmieder: 3.912 over the extinction at 550 nm). A clear day. */
const VISIBILITY = 80_000;
const RAYLEIGH: Vec3 = [5.802e-6, 13.558e-6, 33.1e-6];
/** The haze that gives that visibility beside the air; nine parts in ten of what it takes from a ray it scatters. */
const MIE_EXTINCTION = 3.912 / VISIBILITY - RAYLEIGH[1];

export const ATMOSPHERE = {
  groundRadius: 6_360_000,
  topRadius: 6_460_000,
  rayleigh: RAYLEIGH,                                      // scattering per metre at sea level
  rayleighHeight: 8000,
  mieScattering: 0.9 * MIE_EXTINCTION,
  mieExtinction: MIE_EXTINCTION,
  mieHeight: 1200,
  mieG: 0.8,
  ozone: [0.65e-6, 1.881e-6, 0.085e-6] as Vec3,           // absorption per metre at 25 km
  /** The eye's height above sea level for the sky map, in metres. */
  observer: 400,
  /** What the ground beyond the terrain reflects: dark, so that the terrain stands before it as on a table. */
  groundAlbedo: 0.06,
} as const;

/** Half the height of the sun's disc as the shadows and the sky draw it, in degrees. The real disc is 0.27. */
export const SUN_DISC = 1.2;

/** Altitudes the multiple scattering is tabulated at: `altitudeOf(i)`, closer together near the ground. */
export const MS_SAMPLES = 12;

const A = ATMOSPHERE;
const DEPTH = A.topRadius - A.groundRadius;

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

/**
 * Where the samples of a march lie: `steps` of them over `length`, closer together at its beginning, where the
 * air is dense and the ray still strong. Sample i is at length · ((i + 0.5) / steps)², and stands for the
 * stretch between the squares of i and i + 1.
 */
const stretch = (i: number, steps: number, length: number): { readonly t: number; readonly dt: number } =>
  ({ t: length * ((i + 0.5) / steps) ** 2, dt: (length * (2 * i + 1)) / (steps * steps) });

/** The optical depths (air, haze, ozone) from the point at radius r along the direction whose cosine to the zenith is mu, to the top. */
function depthToTop(r: number, mu: number, steps: number): Vec3 {
  const length = farCrossing(r, mu, A.topRadius);
  if (length <= 0) return [0, 0, 0];
  const sum = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const { t, dt } = stretch(i, steps, length);
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

/** The altitude of sample i of the table of multiple scattering, in metres. */
export const altitudeOf = (i: number): number => DEPTH * (i / (MS_SAMPLES - 1)) ** 2;

/**
 * The light a point of the air gets from light that was scattered before, for a sun of irradiance 1 per channel
 * at `sunElevation`: Ψ of Hillaire 2020, MS_SAMPLES altitudes of four floats each (r, g, b and a zero). It is
 * what is scattered twice, gathered from all directions as from an isotropic medium, times 1 / (1 − f) for every
 * later order, f being the share of light a point gives that comes back to it. The sun stands at one elevation
 * for the whole table: over the reach of a sky map the Earth's curve turns it by a degree or two.
 */
export function multipleScattering(sunElevation: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(MS_SAMPLES * 4);
  const sun: Vec3 = [Math.cos(sunElevation * DEG), 0, Math.sin(sunElevation * DEG)];
  const BANDS = 6, AROUND = 8, STEPS = 14;
  for (let s = 0; s < MS_SAMPLES; s++) {
    const r0 = A.groundRadius + Math.max(1, Math.min(altitudeOf(s), DEPTH - 1));
    const second = [0, 0, 0], back = [0, 0, 0];
    for (let b = 0; b < BANDS; b++) {
      // Bands of equal solid angle: the cosine to the zenith is spread evenly.
      const mu = -1 + (2 * (b + 0.5)) / BANDS;
      const across = Math.sqrt(1 - mu * mu);
      for (let a = 0; a < AROUND; a++) {
        const azimuth = ((a + 0.5) / AROUND) * 2 * Math.PI;
        const dir: Vec3 = [across * Math.cos(azimuth), across * Math.sin(azimuth), mu];
        const ground = groundCrossing(r0, mu);
        const length = ground > 0 ? ground : farCrossing(r0, mu, A.topRadius);
        if (length <= 0) continue;
        const depth = [0, 0, 0];
        for (let i = 0; i < STEPS; i++) {
          const { t, dt } = stretch(i, STEPS, length);
          const p: Vec3 = [dir[0] * t, dir[1] * t, r0 + dir[2] * t];
          const r = Math.hypot(p[0], p[1], p[2]);
          const d = densities(r - A.groundRadius);
          for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
          const through = extinction(depth as unknown as Vec3);
          const muSun = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
          const lit = groundCrossing(r, muSun) < 0 ? extinction(depthToTop(r, muSun, 6)) : null;
          for (let c = 0; c < 3; c++) {
            const scattered = (A.rayleigh[c]! * d[0] + A.mieScattering * d[1]) * through[c]! * dt;
            back[c]! += scattered;
            if (lit) second[c]! += (scattered * lit[c]!) / (4 * Math.PI);
          }
          for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
        }
        if (ground > 0) {
          // The ground at the ray's end, lit by the sun.
          const p: Vec3 = [dir[0] * ground, dir[1] * ground, r0 + dir[2] * ground];
          const muSun = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / A.groundRadius;
          if (muSun > 0) {
            const through = extinction(depth as unknown as Vec3), lit = extinction(depthToTop(A.groundRadius, muSun, 6));
            for (let c = 0; c < 3; c++) second[c]! += (through[c]! * lit[c]! * muSun * A.groundAlbedo) / Math.PI;
          }
        }
      }
    }
    const directions = BANDS * AROUND;
    for (let c = 0; c < 3; c++) out[s * 4 + c] = second[c]! / directions / Math.max(1 - back[c]! / directions, 0.05);
  }
  return out;
}

/** The table's value at an altitude: between its samples, which lie evenly in the root of the altitude. */
function tableAt(table: Float32Array, altitude: number): Vec3 {
  const at = Math.sqrt(Math.min(1, Math.max(0, altitude / DEPTH))) * (MS_SAMPLES - 1);
  const i = Math.min(MS_SAMPLES - 2, Math.floor(at)), f = at - i;
  return [0, 1, 2].map((c) => table[i * 4 + c]! + f * (table[(i + 1) * 4 + c]! - table[i * 4 + c]!)) as unknown as Vec3;
}

/**
 * The radiance of the sky in a direction, for a sun of irradiance 1 per channel at azimuth 0. The direction is
 * given by its elevation and its azimuth from the sun, in degrees. Below the horizon it is the ground seen
 * through the air. `light`: the table and the sky's light of that sun (`skyLight`), made when not given.
 */
export function skyRadiance(elevation: number, azimuth: number, sunElevation: number, steps = 24, light: Pick<SkyLight, 'table' | 'up'> = skyLight(sunElevation)): Vec3 {
  const r0 = A.groundRadius + A.observer;
  const ce = Math.cos(elevation * DEG), se = Math.sin(elevation * DEG);
  const dir: Vec3 = [ce * Math.cos(azimuth * DEG), ce * Math.sin(azimuth * DEG), se];
  const sun: Vec3 = [Math.cos(sunElevation * DEG), 0, Math.sin(sunElevation * DEG)];
  const cos = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const ground = groundCrossing(r0, se);
  const length = ground > 0 ? ground : farCrossing(r0, se, A.topRadius);
  const out = [0, 0, 0];
  if (length <= 0) return [0, 0, 0];
  const depth = [0, 0, 0];
  const pr = rayleighPhase(cos), pm = miePhase(cos);
  for (let i = 0; i < steps; i++) {
    const { t, dt } = stretch(i, steps, length);
    // The sample, in a frame whose origin is the planet's centre: the eye is at (0, 0, r0).
    const p: Vec3 = [dir[0] * t, dir[1] * t, r0 + dir[2] * t];
    const r = Math.hypot(p[0], p[1], p[2]);
    const d = densities(r - A.groundRadius);
    for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
    const seen = extinction(depth as unknown as Vec3);
    const mu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
    const lit = groundCrossing(r, mu) < 0 ? extinction(depthToTop(r, mu, 6)) : [0, 0, 0];
    const again = tableAt(light.table, r - A.groundRadius);
    for (let c = 0; c < 3; c++) {
      const air = A.rayleigh[c]! * d[0], haze = A.mieScattering * d[1];
      out[c]! += seen[c]! * (lit[c]! * (air * pr + haze * pm) + (air + haze) * again[c]!) * dt;
    }
    for (let c = 0; c < 3; c++) depth[c]! += d[c]! * dt * 0.5;
  }
  if (ground > 0) {
    // The ground beyond the terrain, lit by the sun and the sky and seen through the air in between.
    const through = extinction(depth as unknown as Vec3);
    const lit = sunTransmittance(sunElevation);
    const cosSun = Math.max(0, sun[2]);
    for (let c = 0; c < 3; c++) out[c]! += through[c]! * A.groundAlbedo * ((lit[c]! * cosSun) / Math.PI + light.up[c]!);
  }
  return out as unknown as Vec3;
}

export interface SkyLight {
  /** The sun's irradiance on a surface facing it, per channel; the part of its disc above the horizon counted. */
  readonly sun: Vec3;
  /** The sky's irradiance over π on level ground, and on a wall averaged over the directions it may face. */
  readonly up: Vec3;
  readonly side: Vec3;
  /** `multipleScattering` of this elevation, as the sky map's march reads it. */
  readonly table: Float32Array<ArrayBuffer>;
}

/** The light of each elevation asked for, the last asked last: a sun that is dragged up and down passes the same elevations again. */
const lights = new Map<number, SkyLight>();
const LIGHTS_KEPT = 256;

/** The light of a sun at an elevation, in degrees. Some six milliseconds of arithmetic the first time an elevation is asked for. */
export function skyLight(sunElevation: number): SkyLight {
  const kept = lights.get(sunElevation);
  if (kept) {
    lights.delete(sunElevation);
    lights.set(sunElevation, kept);
    return kept;
  }
  const light = computeSkyLight(sunElevation);
  lights.set(sunElevation, light);
  if (lights.size > LIGHTS_KEPT) lights.delete(lights.keys().next().value!);
  return light;
}

function computeSkyLight(sunElevation: number): SkyLight {
  const table = multipleScattering(sunElevation);
  const up = [0, 0, 0], side = [0, 0, 0];
  const ELEVATIONS = 8, AZIMUTHS = 12;
  let upWeight = 0, sideWeight = 0;
  for (let i = 0; i < ELEVATIONS; i++) {
    const elevation = ((i + 0.5) / ELEVATIONS) * 90;
    const solid = Math.cos(elevation * DEG);
    for (let j = 0; j < AZIMUTHS; j++) {
      const azimuth = ((j + 0.5) / AZIMUTHS) * 360;
      // Above the horizon no ray ends on the ground, whose light is what is being summed here.
      const radiance = skyRadiance(elevation, azimuth, sunElevation, 12, { table, up: [0, 0, 0] });
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
  // The disc sets: what is above the horizontal still lights.
  const above = Math.max(0, Math.min(1, (sunElevation + SUN_DISC) / (2 * SUN_DISC)));
  const through = sunTransmittance(Math.max(sunElevation, 0.05));
  return { sun: [through[0] * above, through[1] * above, through[2] * above], up: up as unknown as Vec3, side: side as unknown as Vec3, table };
}

export const luminance = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** What white, level ground sends back of the sun and the sky together, per channel: the light the picture is balanced and exposed for. */
export function keyLight(light: SkyLight, sunElevation: number): Vec3 {
  const cos = Math.sin(Math.max(sunElevation, 0) * DEG) / Math.PI;
  return [light.sun[0] * cos + light.up[0], light.sun[1] * cos + light.up[1], light.sun[2] * cos + light.up[2]];
}

/**
 * Where sunlit, level ground of the albedo 0.18 lands in the display's range with a sun at 45 degrees: at 0.18,
 * a photograph's middle grey. Level ground in the sun is then shown with the colour it has, which is how a
 * draped colour map is judged; what faces the sun is brighter than its colour and what lies in shade darker.
 */
const KEY = 0.18;
/** How much of the light's own colour the balance takes out. Not all: an evening stays warm. */
const BALANCE = 0.85;

/**
 * The factor that brings sunlit ground of the albedo 0.18 to the middle of the display's range. It follows the
 * light most of the way, so that a low sun still shows the terrain, and not all of it, so that evening is darker
 * than noon.
 */
export function exposureFor(light: SkyLight, sunElevation: number): number {
  const key = 0.18 * luminance(keyLight(light, sunElevation));
  const reference = REFERENCE_KEY ??= 0.18 * luminance(keyLight(skyLight(45), 45));
  return KEY / (Math.pow(Math.max(key, 1e-5), 0.85) * Math.pow(reference, 0.15));
}
let REFERENCE_KEY: number | null = null;

/**
 * The gains that show the light of the day as white, as an eye or a camera set for daylight sees it: sunlit
 * level ground then has the colour of what it is made of, shadows are lit by the blue of the sky and slopes
 * that face a low sun by its red. The gains leave the luminance of that light as it is.
 */
export function whiteBalance(light: SkyLight, sunElevation: number): Vec3 {
  const key = keyLight(light, sunElevation);
  const grey = luminance(key);
  if (!(grey > 0)) return [1, 1, 1];
  const gains = key.map((c) => 1 + BALANCE * (grey / Math.max(c, grey * 0.05) - 1)) as unknown as Vec3;
  const kept = luminance([key[0] * gains[0], key[1] * gains[1], key[2] * gains[2]]);
  return [(gains[0] * grey) / kept, (gains[1] * grey) / kept, (gains[2] * grey) / kept];
}

/** WGSL: the same atmosphere, marched for the sky map. `skyMarch(dir, sun)` returns radiance for a sun of irradiance 1; `S.table` holds `multipleScattering` and `S.up` the sky's light on level ground. */
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
  var sum = vec3f(0.0);
  for (var i = 0; i < 6; i++) {
    let t = len * (f32(i) + 0.5) * (f32(i) + 0.5) / 36.0;
    let dt = len * (2.0 * f32(i) + 1.0) / 36.0;
    sum += densities(sqrt(r * r + t * t + 2.0 * r * mu * t) - RG) * dt;
  }
  return sum;
}
// What a point of the air gets from light that was scattered before (multipleScattering of atmosphere.ts).
fn scatteredAgain(altitude: f32) -> vec3f {
  let at = sqrt(clamp(altitude / (RT - RG), 0.0, 1.0)) * ${MS_SAMPLES - 1}.0;
  let i = min(i32(floor(at)), ${MS_SAMPLES - 2});
  return mix(S.table[i].rgb, S.table[i + 1].rgb, at - f32(i));
}
fn skyMarch(dir: vec3f, sun: vec3f) -> vec3f {
  let r0 = RG + OBSERVER;
  let ground = groundCrossing(r0, dir.z);
  var len = farCrossing(r0, dir.z, RT);
  if (ground > 0.0) { len = ground; }
  if (len <= 0.0) { return vec3f(0.0); }
  let STEPS = 32;
  let cosine = dot(dir, sun);
  let pr = 3.0 / (16.0 * PI) * (1.0 + cosine * cosine);
  let g = MIE_G;
  let pm = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + cosine * cosine)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * cosine, 1e-4), 1.5));
  var depth = vec3f(0.0);
  var sum = vec3f(0.0);
  for (var i = 0; i < STEPS; i++) {
    // Closer together where the ray begins (stretch of atmosphere.ts).
    let t = len * (f32(i) + 0.5) * (f32(i) + 0.5) / f32(STEPS * STEPS);
    let dt = len * (2.0 * f32(i) + 1.0) / f32(STEPS * STEPS);
    let p = vec3f(dir.x * t, dir.y * t, r0 + dir.z * t);
    let r = length(p);
    let d = densities(r - RG);
    depth += d * dt * 0.5;
    let mu = dot(p, sun) / r;
    var lit = vec3f(0.0);
    if (groundCrossing(r, mu) < 0.0) { lit = extinction(depthToTop(r, mu)); }
    let air = BETA_R * d.x;
    let haze = BETA_MS * d.y;
    sum += extinction(depth) * (lit * (air * pr + vec3f(haze * pm)) + (air + vec3f(haze)) * scatteredAgain(r - RG)) * dt;
    depth += d * dt * 0.5;
  }
  if (ground > 0.0) {
    var lit = vec3f(0.0);
    if (groundCrossing(r0, sun.z) < 0.0) { lit = extinction(depthToTop(r0, sun.z)); }
    sum += extinction(depth) * GROUND_ALBEDO * (lit * max(sun.z, 0.0) / PI + S.up.rgb);
  }
  return sum;
}
`;
