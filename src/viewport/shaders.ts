// The WGSL of the viewport. Fields of the engine are read with textureLoad and interpolated by hand (runtime.md
// 7.5 rule 3); only the renderer's own textures (light maps, the sky map, the palette) go through a sampler.

import { ATMOSPHERE_WGSL, SUN_DISC } from './atmosphere.ts';
import { MORPH_START } from './lod.ts';

/** Floats of the Frame uniform. */
export const FRAME_FLOATS = 96;
/** Where each member begins, in floats. renderer.ts fills the buffer by these. */
export const FRAME = {
  viewProj: 0, eye: 16, right: 20, up: 24, forward: 28, sunDir: 32, sunColor: 36, skyUp: 40, skySide: 44, misc: 48, canvas: 52,
  terrain: 56, heightTex: 60, overlayTex: 64, overlayRange: 68, lod: 72, lod2: 76, light: 80, flags: 84, top: 88, bounds: 92,
} as const;

/** Behind the terrain: --og-bg-canvas of src/app/shell/theme.css (#161616), the colour of the panel around the canvas. */
export const BACKGROUND = 22 / 255;

const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  eye: vec4f,          // xyz metres; w: near
  right: vec4f,        // the camera's right, scaled so that forward + ndc.x * right + ndc.y * up is the ray of a pixel
  up: vec4f,
  forward: vec4f,
  sunDir: vec4f,       // xyz towards the sun; w: its azimuth in radians
  sunColor: vec4f,     // rgb: irradiance on a surface facing the sun; w: exposure
  skyUp: vec4f,        // rgb: the sky's irradiance over pi on level ground
  skySide: vec4f,      // rgb: the same on a wall
  misc: vec4f,         // x: 1 when there are light maps to read; y: metres from the eye to the terrain's box; z: the scale of the air
  canvas: vec4f,       // width, height in pixels, and their inverses
  terrain: vec4f,      // terrainSize; metres of display height per unit; heightRange; seaLevel (normalised)
  heightTex: vec4f,    // the last texel (x, y) of the height field; z: 1 when a height is bound
  overlayTex: vec4f,   // the last texel (x, y) of the overlay; z: opacity; w: 0 none, 1 colour, 2 mask, 3 data
  overlayRange: vec4f, // x: the lowest value of a data overlay; y: 1 / (highest - lowest)
  lod: vec4f,          // camera x, y in metres; z: squared height above the slab of heights; w: range of level 0
  lod2: vec4f,         // x: the coarsest level; y: uv per fine quad
  light: vec4f,        // x, y: the finest valid level of the shadow and the occlusion map; z: their size; w: levels of the pyramid
  flags: vec4f,        // x: 0 material, 1 clay; y: 1 sea shown; z: top style 0 hillshade, 1 grey, 2 overlay
  top: vec4f,          // centre (uv), span, height over width
  bounds: vec4f,       // lowest and highest normalised height; z: the base of the slab in metres
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var overlayTex: texture_2d<f32>;
@group(0) @binding(3) var pyramid: texture_2d<f32>;
@group(0) @binding(4) var shadowTex: texture_2d<f32>;
@group(0) @binding(5) var aoTex: texture_2d<f32>;
@group(0) @binding(6) var skyTex: texture_2d<f32>;
@group(0) @binding(7) var paletteTex: texture_2d<f32>;
@group(0) @binding(8) var lightSampler: sampler;
@group(0) @binding(9) var skySampler: sampler;

const PI = 3.14159265358979;
const BETA_R = vec3f(0.000005802, 0.000013558, 0.0000331);
const BETA_ME = 0.000008396;

fn loadHeight(p: vec2i) -> f32 {
  return textureLoad(heightTex, clamp(p, vec2i(0), vec2i(F.heightTex.xy)), 0).r;
}
// The height at texel coordinates, bilinear by hand; a + t * (b - a) is a where both are equal.
fn heightTexel(t: vec2f) -> f32 {
  let c = clamp(t, vec2f(0.0), F.heightTex.xy);
  let base = floor(c);
  let f = c - base;
  let p = vec2i(base);
  let h00 = loadHeight(p);
  let h10 = loadHeight(p + vec2i(1, 0));
  let h01 = loadHeight(p + vec2i(0, 1));
  let h11 = loadHeight(p + vec2i(1, 1));
  let top = h00 + f.x * (h10 - h00);
  let bottom = h01 + f.x * (h11 - h01);
  return top + f.y * (bottom - top);
}
fn heightUv(uv: vec2f) -> f32 {
  return heightTexel(uv * F.heightTex.xy);
}

// The slope of the displayed surface in metres per metre, from heights 'stride' texels to either side.
fn slopeFine(t: vec2f, stride: f32) -> vec2f {
  let last = F.heightTex.xy;
  let x1 = min(t.x + stride, last.x);
  let x0 = max(t.x - stride, 0.0);
  let y1 = min(t.y + stride, last.y);
  let y0 = max(t.y - stride, 0.0);
  let dx = heightTexel(vec2f(x1, t.y)) - heightTexel(vec2f(x0, t.y));
  let dy = heightTexel(vec2f(t.x, y1)) - heightTexel(vec2f(t.x, y0));
  let cell = vec2f(F.terrain.x) / max(last, vec2f(1.0));
  return vec2f(dx / max((x1 - x0) * cell.x, 1e-6), dy / max((y1 - y0) * cell.y, 1e-6)) * F.terrain.y;
}

fn loadPyramid(p: vec2i, level: i32) -> f32 {
  let size = vec2i(textureDimensions(pyramid, level));
  return textureLoad(pyramid, clamp(p, vec2i(0), size - vec2i(1)), level).r;
}
fn pyramidAt(uv: vec2f, level: i32) -> f32 {
  let size = vec2f(textureDimensions(pyramid, level));
  let t = uv * size - vec2f(0.5);
  let base = floor(t);
  let f = t - base;
  let p = vec2i(base);
  let h00 = loadPyramid(p, level);
  let h10 = loadPyramid(p + vec2i(1, 0), level);
  let h01 = loadPyramid(p + vec2i(0, 1), level);
  let h11 = loadPyramid(p + vec2i(1, 1), level);
  let top = h00 + f.x * (h10 - h00);
  let bottom = h01 + f.x * (h11 - h01);
  return top + f.y * (bottom - top);
}
fn slopePyramid(uv: vec2f, level: i32) -> vec2f {
  let e = vec2f(1.0) / vec2f(textureDimensions(pyramid, level));
  let dx = pyramidAt(uv + vec2f(e.x, 0.0), level) - pyramidAt(uv - vec2f(e.x, 0.0), level);
  let dy = pyramidAt(uv + vec2f(0.0, e.y), level) - pyramidAt(uv - vec2f(0.0, e.y), level);
  return vec2f(dx, dy) / (2.0 * e * F.terrain.x) * F.terrain.y;
}

// The slope a pixel shows. 'footprint' is how many texels of the height field one pixel covers. Up close it is
// the field's own slope, texel by texel; where a pixel covers several texels it is the slope of the terrain
// averaged over as many, from the pyramid, so that distant ground neither sparkles nor loses its form.
fn surfaceSlope(uv: vec2f, footprint: f32) -> vec2f {
  let t = uv * F.heightTex.xy;
  let stride = max(footprint, 1.0);
  if (F.misc.x < 0.5) { return slopeFine(t, stride); }
  let ratio = max(F.heightTex.x, 1.0) / F.light.z;
  let lodSource = log2(stride);
  let lodPyramid = lodSource - log2(max(ratio, 0.001));
  let w = saturate(min(lodSource, lodPyramid + 1.0));
  if (w <= 0.0) { return slopeFine(t, stride); }
  let level = clamp(lodPyramid, 0.0, F.light.w - 1.0);
  let l0 = i32(floor(level));
  let l1 = min(l0 + 1, i32(F.light.w) - 1);
  let coarse = mix(slopePyramid(uv, l0), slopePyramid(uv, l1), fract(level));
  if (w >= 1.0) { return coarse; }
  return mix(slopeFine(t, stride), coarse, w);
}

fn loadOverlay(p: vec2i) -> vec4f {
  return textureLoad(overlayTex, clamp(p, vec2i(0), vec2i(F.overlayTex.xy)), 0);
}
fn overlayAt(uv: vec2f) -> vec4f {
  let c = clamp(uv, vec2f(0.0), vec2f(1.0)) * F.overlayTex.xy;
  let base = floor(c);
  let f = c - base;
  let p = vec2i(base);
  let a = loadOverlay(p);
  let b = loadOverlay(p + vec2i(1, 0));
  let d = loadOverlay(p + vec2i(0, 1));
  let e = loadOverlay(p + vec2i(1, 1));
  let top = a + f.x * (b - a);
  let bottom = d + f.x * (e - d);
  return top + f.y * (bottom - top);
}
fn paletteAt(t: f32) -> vec3f {
  return textureSampleLevel(paletteTex, lightSampler, vec2f((saturate(t) * 255.0 + 0.5) / 256.0, 0.5), 0.0).rgb;
}
// rgb: the overlay's colour (linear); a: how much of it lies over what is below.
fn overlayColor(uv: vec2f) -> vec4f {
  let kind = F.overlayTex.w;
  if (kind < 0.5) { return vec4f(0.0); }
  let o = overlayAt(uv);
  let opacity = F.overlayTex.z;
  if (kind < 1.5) { return vec4f(max(o.rgb, vec3f(0.0)), saturate(o.a) * opacity); }
  if (kind < 2.5) {
    let v = saturate(o.r);
    return vec4f(paletteAt(v), v * opacity);
  }
  return vec4f(paletteAt((o.r - F.overlayRange.x) * F.overlayRange.y), opacity);
}

fn skyUv(dir: vec3f) -> vec2f {
  let azimuth = atan2(dir.y, dir.x) - F.sunDir.w;
  let elevation = asin(clamp(dir.z, -1.0, 1.0));
  let v = 0.5 + 0.5 * sign(elevation) * sqrt(abs(elevation) / (0.5 * PI));
  return vec2f(azimuth / (2.0 * PI) + 0.5, 1.0 - v);
}
fn skyColor(dir: vec3f) -> vec3f {
  return textureSampleLevel(skyTex, skySampler, skyUv(dir), 0.0).rgb;
}

// Aerial perspective: the air between the eye and a point takes its light away and adds the sky's. The air is
// that of a terrain a few kilometres wide (AIR_WIDTH of renderer.ts), whatever the terrain's own size, and only
// the air beyond the terrain's near edge counts: far ground is paler than near ground at every scale, and a
// terrain seen whole from afar is not lost in haze. F.misc.y is the distance to that edge and F.misc.z the scale.
// What the air adds is the horizon's light with half its hue: a shadow five kilometres away is hazy, not violet.
fn aerial(color: vec3f, world: vec3f, coverage: f32) -> vec3f {
  let v = world - F.eye.xyz;
  let dist = length(v);
  let dir = v / max(dist, 1e-3);
  let altitude = max(0.5 * (world.z + F.eye.z), 0.0) * F.misc.z;
  let beta = BETA_R * exp(-altitude / 8000.0) + vec3f(BETA_ME * exp(-altitude / 1200.0));
  let through = exp(-beta * max(dist - F.misc.y, 0.0) * F.misc.z);
  let sky = skyColor(normalize(vec3f(dir.xy, max(dir.z, 0.0) + 0.04)));
  let haze = mix(vec3f(dot(sky, vec3f(0.2126, 0.7152, 0.0722))), sky, 0.5);
  return color * through + haze * (vec3f(1.0) - through) * coverage;
}

const SEA_DEEP = vec3f(0.004, 0.028, 0.055);
const SEA_SHALLOW = vec3f(0.02, 0.15, 0.15);

struct Surface {
  albedo: vec3f,
  normal: vec3f,
  shadow: f32,
  occlusion: f32,
}

// The terrain's own colours where no colour map is draped: rock on steep ground; on gentle ground grass, dry
// grass and scree from low to high, bare soil where it tilts; darker in hollows; sand along a shown sea.
fn materialColor(height: f32, steepness: f32, occlusion: f32) -> vec3f {
  let span = max(F.bounds.y - F.bounds.x, 1e-5);
  let t = saturate((height - F.bounds.x) / span);
  var ground = mix(vec3f(0.066, 0.09, 0.04), vec3f(0.15, 0.142, 0.072), smoothstep(0.1, 0.5, t));
  ground = mix(ground, vec3f(0.2, 0.186, 0.156), smoothstep(0.5, 0.92, t));
  // 6 to 24 degrees: the turf thins out and the soil shows.
  ground = mix(ground, vec3f(0.135, 0.105, 0.07), 0.6 * smoothstep(0.105, 0.445, steepness));
  ground *= mix(vec3f(0.7, 0.8, 0.68), vec3f(1.0), smoothstep(0.45, 0.95, occlusion));
  var rock = mix(vec3f(0.128, 0.108, 0.09), vec3f(0.2, 0.19, 0.18), smoothstep(0.3, 1.0, t));
  rock *= mix(0.78, 1.0, smoothstep(0.3, 0.9, occlusion));
  rock *= mix(1.0, 0.8, smoothstep(1.4, 2.7, steepness));
  // 30 to 44 degrees: talus lies below, rock stands above.
  var albedo = mix(ground, rock, smoothstep(0.577, 0.966, steepness));
  if (F.flags.y > 0.5) {
    let above = (height - F.terrain.w) * F.terrain.z;
    let beach = (1.0 - smoothstep(0.0, 0.012 * F.terrain.z, above)) * (1.0 - smoothstep(0.25, 0.6, steepness));
    albedo = mix(albedo, vec3f(0.36, 0.31, 0.21), beach * step(0.0, above));
    albedo = mix(albedo, vec3f(0.2, 0.19, 0.14), (1.0 - step(0.0, above)) * 0.7);
  }
  return albedo;
}

fn surfaceAt(uv: vec2f, footprint: f32, lightLod: f32) -> Surface {
  var s: Surface;
  let slope = surfaceSlope(uv, footprint);
  s.normal = normalize(vec3f(-slope, 1.0));
  s.shadow = 1.0;
  s.occlusion = 1.0;
  if (F.misc.x > 0.5) {
    // Half a level above the finest: a shadow's edge is then a texel softer than the march found it, which keeps
    // a ridge one texel sharp from casting a comb of shadows.
    s.shadow = textureSampleLevel(shadowTex, lightSampler, uv, max(lightLod, F.light.x) + 0.6).r;
    s.occlusion = textureSampleLevel(aoTex, lightSampler, uv, max(lightLod, F.light.y) + 0.3).r;
  }
  // The steepness of the ground itself: the display's vertical scale is not the terrain's.
  let steepness = length(slope) * F.terrain.z / max(F.terrain.y, 1e-6);
  var base = vec3f(0.21, 0.2, 0.185);
  if (F.flags.x < 0.5) { base = materialColor(heightUv(uv), steepness, s.occlusion); }
  let over = overlayColor(uv);
  s.albedo = mix(base, over.rgb, over.a);
  return s;
}

fn litColor(s: Surface) -> vec3f {
  let sun = F.sunDir.xyz;
  let direct = F.sunColor.rgb * (max(dot(s.normal, sun), 0.0) * s.shadow / PI);
  let up = s.normal.z;
  let sky = mix(F.skySide.rgb, F.skyUp.rgb, saturate(up * up));
  // What the lit ground around throws back onto a slope.
  let bounce = F.sunColor.rgb * (max(sun.z, 0.0) * 0.36 / PI) * (1.0 - 0.6 * up);
  // A hollow is never without light: what its own walls throw back keeps a third of it.
  return s.albedo * (direct + (sky + bounce) * mix(0.3, 1.0, s.occlusion));
}
`;

// ---- the 3D view -----------------------------------------------------------------------------------------------------

export const SCENE_WGSL = /* wgsl */ `${FRAME_WGSL}
struct TerrainOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
}

// CDLOD: a vertex is a whole number on the grid of the finest quads; beyond the start of its level's morph range
// the odd ones slide onto their even neighbours, where the next level's vertices are.
@vertex fn vsTerrain(@location(0) grid: vec2f, @location(1) inst: vec4f) -> TerrainOut {
  let stride = inst.z;
  let level = inst.w;
  let fine = inst.xy + grid * stride;
  let at = fine * F.lod2.y * F.terrain.x - F.lod.xy;
  let d = sqrt(dot(at, at) + F.lod.z);
  let range = F.lod.w * exp2(level);
  let start = range * ${MORPH_START};
  var k = clamp((d - start) / (range - start), 0.0, 1.0);
  if (level >= F.lod2.x) { k = 0.0; }
  let odd = fract(grid * 0.5) * 2.0;
  let uv = (fine - odd * stride * k) * F.lod2.y;
  var out: TerrainOut;
  out.world = vec3f(uv * F.terrain.x, heightUv(uv) * F.terrain.y);
  out.uv = uv;
  out.position = F.viewProj * vec4f(out.world, 1.0);
  return out;
}

@fragment fn fsTerrain(in: TerrainOut) -> @location(0) vec4f {
  let uv = clamp(in.uv, vec2f(0.0), vec2f(1.0));
  let du = max(length(dpdx(in.uv)), length(dpdy(in.uv)));
  let footprint = du * max(F.heightTex.x, 1.0);
  let lightLod = log2(max(du * F.light.z, 1e-6));
  let s = surfaceAt(uv, footprint, lightLod);
  return vec4f(aerial(litColor(s), in.world, 1.0), 1.0);
}

// ---- the sky ----
struct SkyOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@vertex fn vsSky(@builtin(vertex_index) i: u32) -> SkyOut {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: SkyOut;
  out.ndc = corners[i];
  out.position = vec4f(corners[i], 0.0, 1.0);
  return out;
}
@fragment fn fsSky(in: SkyOut) -> @location(0) vec4f {
  let dir = normalize(F.forward.xyz + in.ndc.x * F.right.xyz + in.ndc.y * F.up.xyz);
  var color = skyColor(dir);
  // The disc, with the edge a real sun's limb has; its light is what the terrain is lit with.
  let angle = acos(clamp(dot(dir, F.sunDir.xyz), -1.0, 1.0));
  let radius = ${(SUN_DISC * Math.PI / 180).toFixed(6)};
  let disc = 1.0 - smoothstep(radius * 0.82, radius, angle);
  color += F.sunColor.rgb * disc * step(0.0, dir.z) * min(1.0 / (PI * radius * radius), 60.0 / max(F.sunColor.w, 1e-3));
  return vec4f(color, 1.0);
}

// ---- the sea ----
struct PlaneOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
}
@vertex fn vsSea(@builtin(vertex_index) i: u32) -> PlaneOut {
  let corners = array(vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  var out: PlaneOut;
  out.uv = corners[i];
  out.world = vec3f(out.uv * F.terrain.x, F.terrain.w * F.terrain.y);
  out.position = F.viewProj * vec4f(out.world, 1.0);
  return out;
}
fn ripple(p: vec2f, direction: vec2f, wavelength: f32) -> vec2f {
  let phase = dot(p, direction) * (2.0 * PI / wavelength);
  return direction * cos(phase);
}
@fragment fn fsSea(in: PlaneOut) -> @location(0) vec4f {
  let depth = (F.terrain.w - heightUv(in.uv)) * F.terrain.z;
  let line = fwidth(depth);
  let du = max(length(dpdx(in.uv)), length(dpdy(in.uv)));
  if (depth <= 0.0) { discard; }
  let toEye = F.eye.xyz - in.world;
  let dist = length(toEye);
  let view = toEye / max(dist, 1e-3);
  // Small waves, faded out where a pixel is wider than they are.
  let pixel = du * F.terrain.x;
  let wave = F.terrain.x / 260.0;
  let calm = 1.0 - smoothstep(0.06, 0.3, pixel / wave);
  var tilt = ripple(in.world.xy, vec2f(0.8, 0.6), wave) + ripple(in.world.xy, vec2f(-0.35, 0.94), wave * 0.61)
    + ripple(in.world.xy, vec2f(0.97, -0.26), wave * 1.7) + ripple(in.world.xy, vec2f(-0.71, -0.7), wave * 0.37);
  tilt *= 0.012 * calm;
  let normal = normalize(vec3f(tilt, 1.0));
  var mirrored = reflect(-view, normal);
  mirrored.z = abs(mirrored.z);
  let sky = skyColor(mirrored);
  let fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
  // The tint develops over a depth that is a share of the height range, so that a coast reads at any scale.
  let through = exp(-depth / (0.025 * F.terrain.z) * vec3f(1.7, 0.6, 0.4));
  let clear = (through.r + through.g + through.b) / 3.0;
  var shadow = 1.0;
  if (F.misc.x > 0.5) { shadow = textureSampleLevel(shadowTex, lightSampler, in.uv, max(log2(max(du * F.light.z, 1e-6)), F.light.x)).r; }
  let sun = F.sunDir.xyz;
  let light = F.sunColor.rgb * (max(sun.z, 0.0) * shadow / PI) + F.skyUp.rgb;
  let body = mix(SEA_DEEP, SEA_SHALLOW, clear) * light;
  let glint = F.sunColor.rgb * shadow * pow(max(dot(mirrored, sun), 0.0), 700.0) * 6.0;
  var color = (1.0 - fresnel) * (1.0 - clear) * body + fresnel * sky + glint;
  var alpha = 1.0 - (1.0 - fresnel) * clear;
  // The shoreline: a pale line where the water is thinnest, at least two pixels wide.
  let shore = (1.0 - smoothstep(0.0, max(2.0 * line, 0.0035 * F.terrain.z), depth)) * 0.55;
  color = mix(color, vec3f(0.7, 0.74, 0.72) * light, shore);
  alpha = max(alpha, shore);
  return vec4f(aerial(color, in.world, alpha), alpha);
}

// ---- the sides of the slab ----
struct WallOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
}
@vertex fn vsWall(@builtin(vertex_index) i: u32) -> WallOut {
  let side = i / 6u;
  let corners = array(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let corner = corners[i % 6u];
  var uv = vec2f(corner.x, 0.0);
  var normal = vec3f(0.0, -1.0, 0.0);
  if (side == 1u) { uv = vec2f(1.0, corner.x); normal = vec3f(1.0, 0.0, 0.0); }
  if (side == 2u) { uv = vec2f(corner.x, 1.0); normal = vec3f(0.0, 1.0, 0.0); }
  if (side == 3u) { uv = vec2f(0.0, corner.x); normal = vec3f(-1.0, 0.0, 0.0); }
  let high = max(F.bounds.y, F.terrain.w) * F.terrain.y;
  var out: WallOut;
  out.uv = uv;
  out.normal = normal;
  out.world = vec3f(uv * F.terrain.x, mix(F.bounds.z, high, corner.y));
  out.position = F.viewProj * vec4f(out.world, 1.0);
  return out;
}
// The colour of the wall at a fragment, and how much of the pixel it covers where it ends at the ground.
fn wallColor(in: WallOut, ground: f32, sea: f32) -> vec3f {
  // The cut through the ground: dark and without a hue of its own, lit just enough to be read as a side.
  let sun = F.sunDir.xyz;
  let key = dot(F.sunColor.rgb, vec3f(0.2126, 0.7152, 0.0722)) / PI;
  let fill = dot(F.skySide.rgb, vec3f(0.2126, 0.7152, 0.0722));
  var color = vec3f(0.04, 0.039, 0.037) * (key * (0.12 + 0.3 * max(dot(in.normal, sun), 0.0)) + fill);
  // The topmost fragments of a wall have their middle above the ground and some of their samples below it. Only
  // under a sea that is shown and stands above the ground is that the sea's side: elsewhere it is still the cut,
  // and a depth below zero would let the water glow (the dotted bright line along a rim above the sea).
  if (F.flags.y > 0.5 && sea > ground && in.world.z > ground) {
    // The sea, seen from the side.
    let depth = max(sea - in.world.z, 0.0) / max(F.terrain.y, 1e-6) * F.terrain.z;
    let through = exp(-depth / (0.025 * F.terrain.z) * vec3f(1.7, 0.6, 0.4));
    color = mix(SEA_DEEP, SEA_SHALLOW, 0.35 * (through.r + through.g + through.b) / 3.0) * (F.sunColor.rgb * max(sun.z, 0.0) / PI + F.skyUp.rgb) * 0.7;
  }
  return aerial(color, in.world, 1.0);
}
// The wall ends at the terrain's edge: its coverage falls over one pixel there.
fn wallCover(in: WallOut, top: f32) -> f32 {
  return saturate((top - in.world.z) / max(fwidth(in.world.z), 1e-5) + 0.5);
}
@fragment fn fsWall(in: WallOut) -> @location(0) vec4f {
  let ground = heightUv(in.uv) * F.terrain.y;
  let sea = F.terrain.w * F.terrain.y;
  var top = ground;
  if (F.flags.y > 0.5) { top = max(ground, sea); }
  let cover = wallCover(in, top);
  if (cover <= 0.0) { discard; }
  return vec4f(wallColor(in, ground, sea), cover);
}
// With four samples a pixel the wall's upper edge is cut sample by sample, as the rasteriser cuts the edge of the
// sea's plane that meets it: a coverage made from one alpha leaves other samples open than the plane fills, and
// the ground behind shows through as a dotted line along the water.
struct WallSamples {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
}
@fragment fn fsWallSamples(in: WallOut) -> WallSamples {
  let ground = heightUv(in.uv) * F.terrain.y;
  let sea = F.terrain.w * F.terrain.y;
  var top = ground;
  if (F.flags.y > 0.5) { top = max(ground, sea); }
  // How far the wall's end is above the middle of the pixel, and how that changes across it.
  let room = top - in.world.z;
  let slope = vec2f(dpdx(room), dpdy(room));
  // The places of the four samples in a pixel, from its middle (WebGPU fixes them).
  let places = array(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));
  var out: WallSamples;
  out.mask = 0u;
  for (var i = 0u; i < 4u; i++) {
    if (room + dot(slope, places[i]) >= 0.0) { out.mask |= 1u << i; }
  }
  if (out.mask == 0u) { discard; }
  out.color = vec4f(wallColor(in, ground, sea), 1.0);
  return out;
}
`;

// ---- the top view ----------------------------------------------------------------------------------------------------
// Drawn straight to the canvas: texel (0, 0) at the top left, +X right, +Y down (engine.md 1.8).

export const TOP_WGSL = /* wgsl */ `${FRAME_WGSL}
@vertex fn vsTop(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}
fn encode(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - vec3f(0.055), x * 12.92, x <= vec3f(0.0031308));
}
@fragment fn fsTop(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let perPixel = F.top.z * F.canvas.z;                     // uv per pixel
  let uv = F.top.xy + (position.xy * F.canvas.zw - vec2f(0.5)) * vec2f(F.top.z, F.top.z * F.top.w);
  let background = vec3f(${BACKGROUND});
  let border = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) / perPixel;
  let inside = saturate(border + 0.5);
  if (inside <= 0.0) { return vec4f(background, 1.0); }
  let at = clamp(uv, vec2f(0.0), vec2f(1.0));
  let height = heightUv(at);
  let over = overlayColor(at);
  let style = F.flags.z;
  var color: vec3f;
  if (style > 1.5 && F.overlayTex.w > 0.5) {
    // The overlay as the image it is.
    color = encode(over.rgb);
    if (F.overlayTex.w > 1.5 && F.overlayTex.w < 2.5) { color = encode(paletteAt(saturate(overlayAt(at).r))); }
  } else if (style > 0.5) {
    color = mix(vec3f(saturate(height)), encode(over.rgb), over.a);
  } else {
    let footprint = perPixel * max(F.heightTex.x, 1.0);
    let slope = surfaceSlope(at, footprint);
    let normal = normalize(vec3f(-slope, 1.0));
    var occlusion = 1.0;
    if (F.misc.x > 0.5) { occlusion = textureSampleLevel(aoTex, lightSampler, at, max(log2(max(perPixel * F.light.z, 1e-6)), F.light.y)).r; }
    var albedo = mix(vec3f(0.4), over.rgb, over.a);
    let depth = (F.terrain.w - height) * F.terrain.z;
    if (F.flags.y > 0.5 && depth > 0.0) {
      let through = exp(-depth / (0.025 * F.terrain.z) * vec3f(1.7, 0.6, 0.4));
      let water = mix(vec3f(0.03, 0.12, 0.2), vec3f(0.12, 0.42, 0.44), (through.r + through.g + through.b) / 3.0);
      // How much the depth changes from one pixel to the next: the line is at least two pixels wide.
      let perStep = length(slope) * F.terrain.z / max(F.terrain.y, 1e-6) * perPixel * F.terrain.x;
      let shore = 1.0 - smoothstep(0.0, max(2.0 * perStep, 0.0035 * F.terrain.z), depth);
      albedo = mix(mix(albedo, water, 0.82), vec3f(0.62), shore * 0.5);
    }
    color = encode(albedo * (0.22 + 1.05 * max(dot(normal, F.sunDir.xyz), 0.0)) * mix(0.72, 1.0, occlusion));
  }
  return vec4f(mix(background, color, inside), 1.0);
}
`;

// ---- from the lit picture to the canvas ------------------------------------------------------------------------------

export const POST_WGSL = /* wgsl */ `
struct Post { exposure: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var lit: texture_2d<f32>;

@vertex fn vsPost(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}
// The Khronos PBR Neutral tone mapper: a colour below 0.76 is shown as it is, so that a draped colour map and the
// palettes are judged as they were made, and what is brighter is brought into range towards white without a
// change of hue.
fn tonemap(color: vec3f) -> vec3f {
  let low = min(color.r, min(color.g, color.b));
  let offset = select(0.04, low - 6.25 * low * low, low < 0.08);
  var c = color - vec3f(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < 0.76) { return c; }
  let d = 0.24;
  let newPeak = 1.0 - d * d / (peak + d - 0.76);
  c *= newPeak / peak;
  let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}
fn encode(x: vec3f) -> vec3f {
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - vec3f(0.055), x * 12.92, x <= vec3f(0.0031308));
}
@fragment fn fsPost(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = max(textureLoad(lit, vec2i(position.xy), 0).rgb, vec3f(0.0)) * P.exposure;
  // Half a step of noise takes the bands out of the sky's gradients.
  let noise = fract(52.9829189 * fract(dot(position.xy, vec2f(0.06711056, 0.00583715)))) - 0.5;
  return vec4f(encode(clamp(tonemap(color), vec3f(0.0), vec3f(1.0))) + vec3f(noise / 255.0), 1.0);
}
`;

// ---- the sky map -----------------------------------------------------------------------------------------------------
// x: the azimuth from the sun, all the way round. y: the elevation, with most texels at the horizon.

export const SKY_MAP_WGSL = /* wgsl */ `
struct Sky { sun: vec4f }
@group(0) @binding(0) var<uniform> S: Sky;
${ATMOSPHERE_WGSL}
@vertex fn vsMap(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}
@fragment fn fsMap(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / S.sun.zw;
  let azimuth = (uv.x - 0.5) * 2.0 * PI;
  let s = (1.0 - uv.y) * 2.0 - 1.0;
  let elevation = sign(s) * s * s * 0.5 * PI;
  let dir = vec3f(cos(elevation) * cos(azimuth), cos(elevation) * sin(azimuth), sin(elevation));
  let sun = vec3f(cos(S.sun.x), 0.0, sin(S.sun.x));
  var radiance = skyMarch(dir, sun);
  if (elevation < 0.0) {
    // Just below the horizon the far ground is lost in the same haze as the sky just above it: the two meet
    // without an edge, and the dark ground begins a few degrees further down.
    let above = vec3f(cos(0.004) * cos(azimuth), cos(0.004) * sin(azimuth), sin(0.004));
    radiance = mix(radiance, skyMarch(above, sun), exp(elevation / 0.035));
  }
  return vec4f(radiance, 1.0);
}
`;

// ---- the light maps --------------------------------------------------------------------------------------------------
// The renderer's own grid: a power of two texels a side, texel centres at (px + 0.5) / size, with every mip.

export const BAKE_WGSL = /* wgsl */ `
struct Bake {
  a: vec4f,   // xy: the last texel of the source field; z: the size of the grid written; w: a level
  b: vec4f,   // xy: one step towards the sun in texels; z: the steps this pass looks ahead; w: metres per step
  c: vec4f,   // x: metres the ray falls per step; y: the tangent of the ray; z, w: the lower and upper edge of the strip, radians
  d: vec4f,   // x: the strip's share of the disc; y: metres per unit of height; z: metres per texel; w: octaves
}
@group(0) @binding(0) var<uniform> B: Bake;
@group(0) @binding(1) var first: texture_2d<f32>;
@group(0) @binding(2) var second: texture_2d<f32>;

@vertex fn vsBake(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

fn sourceAt(t: vec2f) -> f32 {
  let last = B.a.xy;
  let c = clamp(t, vec2f(0.0), last);
  let base = floor(c);
  let f = c - base;
  let p = vec2i(base);
  let q = min(p + vec2i(1), vec2i(last));
  let h00 = textureLoad(first, p, 0).r;
  let h10 = textureLoad(first, vec2i(q.x, p.y), 0).r;
  let h01 = textureLoad(first, vec2i(p.x, q.y), 0).r;
  let h11 = textureLoad(first, q, 0).r;
  let top = h00 + f.x * (h10 - h00);
  let bottom = h01 + f.x * (h11 - h01);
  return top + f.y * (bottom - top);
}
// The height field on the renderer's grid: each texel the mean of the field over its square.
@fragment fn fsBase(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / B.a.z;
  let quarter = 0.25 / B.a.z;
  // Where a sea is shown the light falls on its surface: B.a.w is its level, or far below everything.
  var sum = 0.0;
  sum += max(sourceAt((uv + vec2f(-quarter, -quarter)) * B.a.xy), B.a.w);
  sum += max(sourceAt((uv + vec2f(quarter, -quarter)) * B.a.xy), B.a.w);
  sum += max(sourceAt((uv + vec2f(-quarter, quarter)) * B.a.xy), B.a.w);
  sum += max(sourceAt((uv + vec2f(quarter, quarter)) * B.a.xy), B.a.w);
  let mean = 0.25 * sum;
  // A height that is no number would spread through every level above it.
  if (!(mean > -1e30 && mean < 1e30)) { return vec4f(0.0); }
  return vec4f(mean, 0.0, 0.0, 1.0);
}
// One level from the level below: the mean of four texels.
@fragment fn fsDown(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy) * 2;
  let sum = textureLoad(first, p, 0) + textureLoad(first, p + vec2i(1, 0), 0) + textureLoad(first, p + vec2i(0, 1), 0) + textureLoad(first, p + vec2i(1, 1), 0);
  return 0.25 * sum;
}

// Cast shadows, as ops.shadow of the engine finds them (engine.md section 5): a texel is in the shadow of a ray
// of slope s when max over the distance d of z(p + d) - d * s exceeds z(p), and that maximum is taken in passes
// that double the distance. A texel holds the height of the ray's shadow and how far away the ground stands
// that casts it.
@fragment fn fsStart(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(first, vec2i(position.xy), 0).r * B.d.y, 0.0, 0.0, 1.0);
}
@fragment fn fsMarch(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let px = vec2i(position.xy);
  var best = textureLoad(first, px, 0).rg;
  let q = vec2f(px) + B.b.xy * B.b.z;
  if (all(q >= vec2f(0.0)) && all(q <= vec2f(B.a.z - 1.0))) {
    let whole = floor(q);
    let part = q - whole;
    let a = vec2i(whole);
    let b = a + vec2i(part > vec2f(0.0));
    let t = max(part.x, part.y);
    let ra = textureLoad(first, a, 0).rg;
    let far = ra + t * (textureLoad(first, b, 0).rg - ra);
    let lifted = far.x - B.b.z * B.c.x;
    if (lifted > best.x) { best = vec2f(lifted, far.y + B.b.z * B.b.w); }
  }
  return vec4f(best, 0.0, 1.0);
}
// The share of one strip of the sun's disc a texel sees, times the strip's share of the disc.
@fragment fn fsGather(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let px = vec2i(position.xy);
  let z = textureLoad(second, px, 0).r * B.d.y;
  let lower = textureLoad(first, px, 0).rg;
  var share = 1.0;
  if (lower.x > z + 1e-5 * B.d.y && lower.y > 0.0) {
    share = 0.0;
    if (B.c.w > B.c.z) { share = saturate((B.c.w - atan(B.c.y + (lower.x - z) / lower.y)) / (B.c.w - B.c.z)); }
  }
  return vec4f(share * B.d.x);
}
// 0 where the upper edge of the disc is hidden: nothing of the sun is seen there. Multiplied onto the shares.
@fragment fn fsHidden(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let px = vec2i(position.xy);
  let z = textureLoad(second, px, 0).r * B.d.y;
  let lower = textureLoad(first, px, 0).rg;
  return vec4f(select(1.0, 0.0, lower.x > z + 1e-5 * B.d.y && lower.y > 0.0));
}

fn levelAt(uv: vec2f, level: i32) -> f32 {
  let size = vec2i(textureDimensions(first, level));
  let t = uv * vec2f(size) - vec2f(0.5);
  let base = floor(t);
  let f = t - base;
  let p = clamp(vec2i(base), vec2i(0), size - vec2i(1));
  let q = clamp(vec2i(base) + vec2i(1), vec2i(0), size - vec2i(1));
  let h00 = textureLoad(first, p, level).r;
  let h10 = textureLoad(first, vec2i(q.x, p.y), level).r;
  let h01 = textureLoad(first, vec2i(p.x, q.y), level).r;
  let h11 = textureLoad(first, q, level).r;
  let top = h00 + f.x * (h10 - h00);
  let bottom = h01 + f.x * (h11 - h01);
  return top + f.y * (bottom - top);
}
// How far the ground at both ends of one axis stands above the texel, as the tangent of the hollow it lies in:
// the greatest over distances that double, each read from the level of the pyramid whose texels are that wide.
// A plane is no hollow at any tilt, so a slope is not darkened for being steep.
fn hollow(uv: vec2f, z: f32, axis: vec2f, level: i32, octaves: i32) -> f32 {
  let levels = i32(textureNumLevels(first));
  let texel = 1.0 / B.a.z;
  var deepest = 0.0;
  for (var o = 0; o < octaves; o++) {
    let reach = 1.5 * exp2(f32(o));
    let d = axis * reach * texel;
    let l = min(level + o, levels - 1);
    let rise = (0.5 * (levelAt(uv + d, l) + levelAt(uv - d, l)) - z) * B.d.y / (reach * B.d.z);
    deepest = max(deepest, rise / (1.0 + 0.12 * f32(o)));
  }
  return deepest / sqrt(1.0 + deepest * deepest);
}
@fragment fn fsOcclusion(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let level = i32(B.a.w);
  let octaves = i32(B.d.w);
  let uv = position.xy / B.a.z;
  let z = textureLoad(first, vec2i(position.xy), level).r;
  var sum = hollow(uv, z, vec2f(1.0, 0.0), level, octaves);
  sum += hollow(uv, z, vec2f(0.0, 1.0), level, octaves);
  sum += hollow(uv, z, vec2f(0.7071, 0.7071), level, octaves);
  sum += hollow(uv, z, vec2f(0.7071, -0.7071), level, octaves);
  let open = 1.0 - 0.25 * sum;
  return vec4f(open * open);
}
`;

// ---- the lowest and the highest value of a field ---------------------------------------------------------------------

export const REDUCE_WGSL = /* wgsl */ `
struct Reduce { last: vec2i, first: u32, pad: u32 }
@group(0) @binding(0) var<uniform> R: Reduce;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rg32float, write>;

// Each texel written is (lowest, highest) over a block of 8 x 8 texels; a block without a finite value is (1e30, -1e30).
@compute @workgroup_size(8, 8) fn reduce(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  var lo = 1e30;
  var hi = -1e30;
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let p = vec2i(id.xy) * 8 + vec2i(x, y);
      if (p.x > R.last.x || p.y > R.last.y) { continue; }
      let v = textureLoad(src, p, 0);
      var a = v.r;
      var b = v.g;
      if (R.first == 1u) { b = a; }
      if (a > -1e30 && a < 1e30 && b > -1e30 && b < 1e30) {
        lo = min(lo, a);
        hi = max(hi, b);
      }
    }
  }
  textureStore(dst, vec2i(id.xy), vec4f(lo, hi, 0.0, 1.0));
}
`;

// ---- what lies under a pixel -----------------------------------------------------------------------------------------

export const PICK_WGSL = /* wgsl */ `
struct Pick {
  origin: vec4f,   // metres, display heights
  dir: vec4f,      // unit
  a: vec4f,        // terrainSize; metres of display height per unit; the last texel x, y
  b: vec4f,        // the ray's first and last distance inside the terrain's box; the step; the number of steps
}
@group(0) @binding(0) var<uniform> P: Pick;
@group(0) @binding(1) var heights: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32, 8>;

fn texel(p: vec2i) -> f32 {
  return textureLoad(heights, clamp(p, vec2i(0), vec2i(P.a.zw)), 0).r;
}
fn heightAt(uv: vec2f) -> f32 {
  let c = clamp(uv, vec2f(0.0), vec2f(1.0)) * P.a.zw;
  let base = floor(c);
  let f = c - base;
  let p = vec2i(base);
  let top = texel(p) + f.x * (texel(p + vec2i(1, 0)) - texel(p));
  let bottom = texel(p + vec2i(0, 1)) + f.x * (texel(p + vec2i(1, 1)) - texel(p + vec2i(0, 1)));
  return top + f.y * (bottom - top);
}
// How far the ray is above the ground at the distance t, in metres.
fn above(t: f32) -> f32 {
  let p = P.origin.xyz + t * P.dir.xyz;
  return p.z - heightAt(p.xy / P.a.x) * P.a.y;
}
@compute @workgroup_size(1) fn pick() {
  var hit = -1.0;
  var before = P.b.x;
  // A ray that begins under the ground came through the side of the slab: that is no terrain.
  if (above(before) >= 0.0) {
    let steps = i32(P.b.w);
    for (var i = 1; i <= steps; i++) {
      let t = min(P.b.x + f32(i) * P.b.z, P.b.y);
      if (above(t) <= 0.0) {
        var lo = before;
        var hi = t;
        for (var k = 0; k < 20; k++) {
          let mid = 0.5 * (lo + hi);
          if (above(mid) > 0.0) { lo = mid; } else { hi = mid; }
        }
        hit = hi;
        break;
      }
      before = t;
    }
  }
  let p = P.origin.xyz + max(hit, 0.0) * P.dir.xyz;
  let uv = p.xy / P.a.x;
  result[0] = hit;
  result[1] = uv.x;
  result[2] = uv.y;
  result[3] = heightAt(uv);
}
`;
