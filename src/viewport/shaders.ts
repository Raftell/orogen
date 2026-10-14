// The WGSL of the viewport. Fields of the engine are read with textureLoad and interpolated by hand (runtime.md
// 7.5 rule 3); only the renderer's own textures (light maps, the sky map, the palette) go through a sampler.

import { ATMOSPHERE, ATMOSPHERE_WGSL, MS_SAMPLES, SUN_DISC } from './atmosphere.ts';
import { MORPH_START } from './lod.ts';

/** Floats of the Frame uniform. */
export const FRAME_FLOATS = 96;
/** Where each member begins, in floats. renderer.ts fills the buffer by these. */
export const FRAME = {
  viewProj: 0, eye: 16, right: 20, up: 24, forward: 28, sunDir: 32, sunColor: 36, skyUp: 40, skySide: 44, misc: 48, canvas: 52,
  terrain: 56, heightTex: 60, overlayTex: 64, overlayRange: 68, lod: 72, lod2: 76, light: 80, flags: 84, top: 88, bounds: 92,
} as const;

/** Where the tone curve leaves the straight line: a colour whose brightest channel is below this is shown as it is. */
export const TONE_SHOULDER = 0.7;
/** Floats of the sky map's uniform: the sun, the sky's light on the ground, and the table of the multiple scattering. */
export const SKY_FLOATS = 8 + 4 * MS_SAMPLES;

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
  misc: vec4f,         // x: 1 when there are light maps to read; z: texels of the height field a pixel covers, per metre of distance; w: 1 when the picture is smooth from near
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
const BETA_R = vec3f(${ATMOSPHERE.rayleigh.join(', ')});
const BETA_ME = ${ATMOSPHERE.mieExtinction};
const H_R = ${ATMOSPHERE.rayleighHeight}.0;
const H_M = ${ATMOSPHERE.mieHeight}.0;

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

// ---- the surface up close ----
// Between four texels the field is a bilinear patch, and a ridge one texel wide that runs across the grid is a
// row of such patches, each with a notch: seen from near it has a sawtooth for a crest and facets for slopes.
// Where a texel covers several pixels the picture is therefore of a smooth surface through the same field, a
// cubic B-spline over four by four texels, and the mesh has vertices between the texels to draw it with
// (lod.ts). It is the picture alone: what the pointer reads is the field (PICK_WGSL).
fn splineWeights(f: f32) -> vec4f {
  let g = 1.0 - f;
  return vec4f(g * g * g, 3.0 * f * f * f - 6.0 * f * f + 4.0, -3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0, f * f * f) / 6.0;
}
fn splineSlopes(f: f32) -> vec4f {
  let g = 1.0 - f;
  return vec4f(-g * g, 3.0 * f * f - 4.0 * f, -3.0 * f * f + 2.0 * f + 1.0, f * f) * 0.5;
}
// x: the height at texel coordinates; y, z: how it changes per texel along x and y.
fn smoothTexel(t: vec2f) -> vec3f {
  let c = clamp(t, vec2f(0.0), F.heightTex.xy);
  let base = floor(c);
  let f = c - base;
  let p = vec2i(base);
  let wx = splineWeights(f.x);
  let wy = splineWeights(f.y);
  let sx = splineSlopes(f.x);
  let sy = splineSlopes(f.y);
  var out = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    var row = 0.0;
    var rowSlope = 0.0;
    for (var i = 0; i < 4; i++) {
      let h = loadHeight(p + vec2i(i - 1, j - 1));
      row += wx[i] * h;
      rowSlope += sx[i] * h;
    }
    out += vec3f(wy[j] * row, wy[j] * rowSlope, sy[j] * row);
  }
  return out;
}
// How much of the smooth surface a point shows, by its distance from the eye: none where a texel covers little
// more than a pixel, all of it from three pixels a texel. Between the two a crest's teeth are two or three pixels
// high, which is when they are seen as a comb.
fn smoothShare(footprint: f32) -> f32 {
  return 1.0 - smoothstep(0.35, 0.85, footprint);
}
fn smoothness(world: vec3f) -> f32 {
  if (F.heightTex.z < 0.5 || F.misc.z <= 0.0) { return 0.0; }
  return smoothShare(distance(world, F.eye.xyz) * F.misc.z);
}
// The height the picture has at a uv, normalised.
fn shownHeight(uv: vec2f, smoothing: f32) -> f32 {
  let t = uv * F.heightTex.xy;
  let plain = heightTexel(t);
  if (smoothing <= 0.0) { return plain; }
  return mix(plain, smoothTexel(t).x, smoothing);
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
// the slope of the smooth surface ('smoothing', above); then the field's own, texel by texel; where a pixel covers
// several texels it is the slope of the terrain averaged over as many, from the pyramid, so that distant ground
// neither sparkles nor loses its form.
fn surfaceSlope(uv: vec2f, footprint: f32, smoothing: f32) -> vec2f {
  let t = uv * F.heightTex.xy;
  let stride = max(footprint, 1.0);
  var fine = slopeFine(t, stride);
  let near = smoothing * (1.0 - saturate(2.0 * (stride - 1.0)));
  if (near > 0.0) {
    let cell = vec2f(F.terrain.x) / max(F.heightTex.xy, vec2f(1.0));
    fine = mix(fine, smoothTexel(t).yz / cell * F.terrain.y, near);
  }
  if (F.misc.x < 0.5) { return fine; }
  let ratio = max(F.heightTex.x, 1.0) / F.light.z;
  let lodSource = log2(stride);
  let lodPyramid = lodSource - log2(max(ratio, 0.001));
  let w = saturate(min(lodSource, lodPyramid + 1.0));
  if (w <= 0.0) { return fine; }
  let level = clamp(lodPyramid, 0.0, F.light.w - 1.0);
  let l0 = i32(floor(level));
  let l1 = min(l0 + 1, i32(F.light.w) - 1);
  let coarse = mix(slopePyramid(uv, l0), slopePyramid(uv, l1), fract(level));
  if (w >= 1.0) { return coarse; }
  return mix(fine, coarse, w);
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

// Aerial perspective: the air between the eye and a point takes its light away and adds its own. The air is the
// sky's (atmosphere.ts), metre for metre, and what counts of it is what lies within the terrain's own box, from
// its lowest ground to its highest: the picture is of the terrain and of the air over it, and an eye that backs
// away to see the whole does not put more air before it. Seen from above, a valley lies under a little more air
// than the peaks beside it; seen from the ground, the far side of a terrain four kilometres wide is paler than
// the near side, and that of one forty wide is lost in haze. What a path through the air adds is the sky at the
// horizon in that direction, which is such a path made long.
fn aerial(color: vec3f, world: vec3f, coverage: f32) -> vec3f {
  let v = world - F.eye.xyz;
  let dist = length(v);
  let dir = v / max(dist, 1e-3);
  // Where the ray enters the box, by its three pairs of planes.
  let low = vec3f(0.0, 0.0, F.bounds.x * F.terrain.y);
  let high = vec3f(F.terrain.x, F.terrain.x, max(F.bounds.y, F.terrain.w * F.flags.y) * F.terrain.y);
  let safe = select(vec3f(1e-9), dir, abs(dir) > vec3f(1e-9));
  let a = (low - F.eye.xyz) / safe;
  let b = (high - F.eye.xyz) / safe;
  let near = min(a, b);
  let path = dist - clamp(max(near.x, max(near.y, near.z)), 0.0, dist);
  let altitude = max(0.5 * (world.z + clamp(F.eye.z, low.z, high.z)), 0.0);
  let beta = BETA_R * exp(-altitude / H_R) + vec3f(BETA_ME * exp(-altitude / H_M));
  let through = exp(-beta * path);
  let sky = skyColor(normalize(vec3f(dir.xy, max(dir.z, 0.0) + 0.04)));
  return color * through + sky * (vec3f(1.0) - through) * coverage;
}

// ---- noise for the default material: values on a lattice, from whole numbers alone, so that every adapter makes the same ----
fn lattice(p: vec2i) -> f32 {
  var h = (u32(p.x) * 0x9E3779B1u) ^ (u32(p.y) * 0x85EBCA77u + 0x7F4A7C15u);
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn valueNoise(p: vec2f) -> f32 {
  let base = floor(p);
  let f = p - base;
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(base);
  let top = mix(lattice(i), lattice(i + vec2i(1, 0)), u.x);
  let bottom = mix(lattice(i + vec2i(0, 1)), lattice(i + vec2i(1, 1)), u.x);
  return mix(top, bottom, u.y);
}
// Noise of one wavelength, in metres, at a place in metres; it fades to its mean where a pixel is as wide as it.
fn patches(at: vec2f, wavelength: f32, pixel: f32) -> f32 {
  let shown = 1.0 - smoothstep(0.25, 0.7, pixel / wavelength);
  if (shown <= 0.0) { return 0.5; }
  return mix(0.5, valueNoise(at / wavelength), shown);
}

// What clear sea water takes from light per metre of its way, and the colour of deep water under white light.
const WATER_ABSORB = vec3f(0.36, 0.066, 0.042);
const WATER_DEEP = vec3f(0.009, 0.05, 0.088);

struct Surface {
  albedo: vec3f,
  normal: vec3f,
  shadow: f32,
  occlusion: f32,
}

// The terrain's own colours where no colour map is draped. Gentle ground is turf, greener low down and in
// hollows, drier and paler higher up, in patches of three sizes so that level ground is not one colour; where
// it tilts the soil shows, and steep ground is rock, greyer with height. Along a shown sea lies sand. 'pixel' is
// the width of a pixel on the ground, in metres.
fn materialColor(uv: vec2f, height: f32, steepness: f32, occlusion: f32, pixel: f32) -> vec3f {
  let span = max(F.bounds.y - F.bounds.x, 1e-5);
  let t = saturate((height - F.bounds.x) / span);
  let size = F.terrain.x;
  let at = uv * size;
  let broad = patches(at + vec2f(0.37 * size), size / 7.0, pixel);
  let middle = patches(at + vec2f(0.11 * size, 0.73 * size), size / 29.0, pixel);
  let small = patches(at, size / 113.0, pixel);
  let grain = patches(at, size / 900.0, pixel);
  let mottle = 0.5 * broad + 0.3 * middle + 0.2 * small;
  // Where the ground lies in its climb from the lowest to the highest, moved a little by the patches.
  let climb = t + 0.22 * (mottle - 0.5);
  // Turf of a dry country: olive where it is greenest, never the green of a lawn. A terrain may be a desert.
  var turf = mix(vec3f(0.105, 0.128, 0.062), vec3f(0.165, 0.162, 0.085), smoothstep(0.3, 0.7, mottle));
  turf = mix(turf, vec3f(0.225, 0.2, 0.125), smoothstep(0.22, 0.62, climb));
  turf = mix(turf, vec3f(0.245, 0.232, 0.195), smoothstep(0.6, 0.95, climb));
  // Hollows keep their water: darker and greener.
  turf *= mix(vec3f(0.72, 0.84, 0.7), vec3f(1.0), smoothstep(0.45, 0.95, occlusion));
  // 8 to 27 degrees: the turf thins out and the soil shows.
  let soil = mix(vec3f(0.19, 0.152, 0.11), vec3f(0.228, 0.2, 0.162), smoothstep(0.3, 0.9, climb));
  var ground = mix(turf, soil, 0.62 * smoothstep(0.14, 0.51, steepness + 0.1 * (small - 0.5)));
  ground *= 0.94 + 0.12 * grain;
  // Rock without a hue: under the blue of the sky a warm rock has violet shadows.
  var rock = mix(vec3f(0.158, 0.154, 0.142), vec3f(0.262, 0.262, 0.252), smoothstep(0.2, 1.0, climb));
  rock *= (0.86 + 0.28 * middle) * (0.93 + 0.14 * grain);
  rock *= mix(0.8, 1.0, smoothstep(0.3, 0.9, occlusion));
  rock *= mix(1.0, 0.82, smoothstep(1.4, 2.7, steepness));
  // 30 to 44 degrees: talus lies below, rock stands above.
  var albedo = mix(ground, rock, smoothstep(0.577, 0.966, steepness + 0.14 * (small - 0.5)));
  if (F.flags.y > 0.5) {
    // Metres above the sea. Sand lies along it on gentle ground, darker where the last wave wetted it, and under it.
    let above = (height - F.terrain.w) * F.terrain.z;
    let reach = max(0.004 * size, 2.5 * pixel * max(steepness, 0.02));
    let gentle = 1.0 - smoothstep(0.3, 0.7, steepness);
    let sand = vec3f(0.46, 0.4, 0.29) * (0.93 + 0.14 * small);
    let beach = (1.0 - smoothstep(0.35 * reach, reach, above)) * gentle;
    albedo = mix(albedo, sand, beach);
    albedo *= mix(0.72, 1.0, smoothstep(0.0, 0.12 * reach, above));
    let bed = mix(sand * 0.8, vec3f(0.16, 0.15, 0.12), smoothstep(0.0, 12.0, -above));
    albedo = mix(albedo, bed, step(above, 0.0) * mix(0.45, 0.85, gentle));
  }
  return albedo;
}

fn surfaceAt(uv: vec2f, footprint: f32, lightLod: f32, smoothing: f32, pixel: f32) -> Surface {
  var s: Surface;
  let slope = surfaceSlope(uv, footprint, smoothing);
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
  var base = vec3f(0.26, 0.252, 0.238);
  if (F.flags.x < 0.5) { base = materialColor(uv, heightUv(uv), steepness, s.occlusion, pixel); }
  let over = overlayColor(uv);
  s.albedo = mix(base, over.rgb, over.a);
  return s;
}

// The sun's light on a surface, and the light of everything else: the sky, and what the lit ground around
// throws back. Ground reflects three tenths of the sun; a wall has that ground before it, and level ground has
// a quarter of it, from whatever of the terrain stands higher. A hollow is never without light: what its own
// walls throw back keeps a quarter.
fn sunLight(s: Surface) -> vec3f {
  return F.sunColor.rgb * (max(dot(s.normal, F.sunDir.xyz), 0.0) * s.shadow / PI);
}
fn skyLight(s: Surface) -> vec3f {
  let up = saturate(s.normal.z);
  let sky = mix(F.skySide.rgb, F.skyUp.rgb, up * up);
  let bounce = F.sunColor.rgb * (max(F.sunDir.z, 0.0) * 0.3 / PI) * mix(1.0, 0.25, up);
  return (sky + bounce) * mix(0.25, 1.0, s.occlusion);
}
fn litColor(s: Surface) -> vec3f {
  return s.albedo * (sunLight(s) + skyLight(s));
}

// The sea over a bed 'depth' metres down: what the eye gets from the direction 'view' (towards the eye) of a
// surface with the normal 'normal'. The bed is seen through the water, which takes the red of its light first on
// the way down and on the way up; deep water has a colour of its own; and the surface mirrors the sky, little
// seen from above and nearly all of it at a glance.
fn seaColor(bed: Surface, depth: f32, view: vec3f, normal: vec3f, shadow: f32) -> vec3f {
  let sun = F.sunDir.xyz;
  // The cosines of the sun's and the eye's rays under the water, which bends them (n = 1.33).
  let down = sqrt(1.0 - (1.0 - sun.z * sun.z) / 1.77);
  let up = sqrt(1.0 - (1.0 - view.z * view.z) / 1.77);
  let d = max(depth, 0.0);
  let rise = exp(-WATER_ABSORB * d / max(up, 0.2));
  let direct = sunLight(bed) * exp(-WATER_ABSORB * d / max(down, 0.2));
  let ambient = skyLight(bed) * exp(-WATER_ABSORB * d * 1.2);
  let seen = bed.albedo * (direct + ambient) * rise;
  let light = F.sunColor.rgb * (max(sun.z, 0.0) * shadow / PI) + F.skyUp.rgb;
  let body = WATER_DEEP * light * (vec3f(1.0) - exp(-WATER_ABSORB * d * (1.0 / max(down, 0.2) + 1.0 / max(up, 0.2))));
  var mirrored = reflect(-view, normal);
  mirrored.z = abs(mirrored.z);
  let fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
  let glint = F.sunColor.rgb * shadow * pow(max(dot(mirrored, sun), 0.0), 700.0) * 6.0;
  // In a hand's depth of water the mirror is broken by what washes over the sand.
  let calm = smoothstep(0.0, 0.4, d);
  return (1.0 - fresnel * calm) * (seen + body) + calm * (fresnel * skyColor(mirrored) + glint);
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
  // The smooth surface is shown by the distance of the field's own: a vertex and the fragments around it agree on it.
  let plain = vec3f(uv * F.terrain.x, heightUv(uv) * F.terrain.y);
  out.world = vec3f(plain.xy, shownHeight(uv, smoothness(plain)) * F.terrain.y);
  out.uv = uv;
  out.position = F.viewProj * vec4f(out.world, 1.0);
  return out;
}

@fragment fn fsTerrain(in: TerrainOut) -> @location(0) vec4f {
  let uv = clamp(in.uv, vec2f(0.0), vec2f(1.0));
  let du = max(length(dpdx(in.uv)), length(dpdy(in.uv)));
  let footprint = du * max(F.heightTex.x, 1.0);
  let lightLod = log2(max(du * F.light.z, 1e-6));
  let s = surfaceAt(uv, footprint, lightLod, smoothness(in.world), du * F.terrain.x);
  return vec4f(aerial(litColor(s), in.world, 1.0), 1.0);
}

// ---- the sky, and the table the terrain stands on ----
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
// How far a point of the table lies outside the slab's square, in metres.
fn outsideSlab(p: vec2f) -> f32 {
  return length(max(max(-p, p - vec2f(F.terrain.x)), vec2f(0.0)));
}
@fragment fn fsSky(in: SkyOut) -> @location(0) vec4f {
  let dir = normalize(F.forward.xyz + in.ndc.x * F.right.xyz + in.ndc.y * F.up.xyz);
  var color = skyColor(dir);
  // The disc, with the edge a real sun's limb has; its light is what the terrain is lit with.
  let angle = acos(clamp(dot(dir, F.sunDir.xyz), -1.0, 1.0));
  let radius = ${(SUN_DISC * Math.PI / 180).toFixed(6)};
  let disc = 1.0 - smoothstep(radius * 0.82, radius, angle);
  color += F.sunColor.rgb * disc * step(0.0, dir.z) * min(1.0 / (PI * radius * radius), 60.0 / max(F.sunColor.w, 1e-3));
  // Below the horizon lies the ground beyond the terrain, and the slab stands on it at the level of its base.
  // It keeps the sun off the ground behind it and the sky off the ground around it: without either the terrain
  // floats before a picture of a horizon.
  let base = F.bounds.z;
  if (dir.z < -1e-4 && F.eye.z > base) {
    let p = F.eye.xy + dir.xy * ((base - F.eye.z) / dir.z);
    let size = F.terrain.x;
    let sun = F.sunDir.xyz;
    // The slab is solid up to the lowest ground: the shadow of that box, which reaches as far as the box is tall
    // over the tangent of the sun's elevation, with an edge a hundredth of the terrain wide.
    let tall = max(F.bounds.x * F.terrain.y - base, 0.0);
    let reach = tall * length(sun.xy) / max(sun.z, 0.08);
    let towards = sun.xy / max(length(sun.xy), 1e-6);
    var behind = 1e30;
    for (var i = 0; i < 9; i++) {
      behind = min(behind, outsideSlab(p + towards * reach * f32(i) * 0.125));
    }
    let sunny = smoothstep(0.0, 0.012 * size, behind);
    let skyShare = dot(F.skyUp.rgb, vec3f(0.2126, 0.7152, 0.0722)) / max(dot(F.sunColor.rgb, vec3f(0.2126, 0.7152, 0.0722)) * max(sun.z, 0.0) / PI + dot(F.skyUp.rgb, vec3f(0.2126, 0.7152, 0.0722)), 1e-6);
    // And the sky it hides from the ground beside it: half of it at its foot, none a tenth of its width away.
    let open = 1.0 - 0.5 * exp(-outsideSlab(p) / max(0.035 * size + 0.5 * tall, 1e-3));
    // Never black: the sides of the slab throw some of their own light down.
    color *= max(mix(skyShare, 1.0, sunny) * open, 0.18);
  }
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
  let smoothing = smoothness(in.world);
  // Metres of water over the ground as the picture has it.
  let depth = (F.terrain.w - shownHeight(in.uv, smoothing)) * F.terrain.z;
  let edge = max(fwidth(depth), 1e-6);
  let du = max(length(dpdx(in.uv)), length(dpdy(in.uv)));
  // The water ends within a pixel of where the ground rises through it.
  let cover = saturate(depth / edge + 0.5);
  if (cover <= 0.0) { discard; }
  let toEye = F.eye.xyz - in.world;
  let view = toEye / max(length(toEye), 1e-3);
  // Small waves, faded out where a pixel is wider than they are.
  let pixel = du * F.terrain.x;
  let wave = F.terrain.x / 260.0;
  let rough = 1.0 - smoothstep(0.06, 0.3, pixel / wave);
  var tilt = ripple(in.world.xy, vec2f(0.8, 0.6), wave) + ripple(in.world.xy, vec2f(-0.35, 0.94), wave * 0.61)
    + ripple(in.world.xy, vec2f(0.97, -0.26), wave * 1.7) + ripple(in.world.xy, vec2f(-0.71, -0.7), wave * 0.37);
  tilt *= 0.012 * rough;
  let normal = normalize(vec3f(tilt, 1.0));
  let lightLod = log2(max(du * F.light.z, 1e-6));
  // The bed, as the terrain's own fragment draws it.
  let bed = surfaceAt(in.uv, du * max(F.heightTex.x, 1.0), lightLod, smoothing, pixel);
  // The light maps were made with the sea for ground (lighting.ts): where it is shown, they hold what falls on its surface.
  var color = seaColor(bed, depth, view, normal, bed.shadow);
  // Where the water is thinnest it washes over the ground: a pale fringe that fades into the open water, at
  // least a pixel and a half wide and never a line.
  let wash = 1.0 - smoothstep(0.0, max(1.5 * edge, 0.35), max(depth, 0.0));
  let light = F.sunColor.rgb * (max(F.sunDir.z, 0.0) * bed.shadow / PI) + F.skyUp.rgb;
  color = mix(color, vec3f(0.62, 0.66, 0.64) * light, 0.3 * wash * wash);
  return vec4f(aerial(color, in.world, 1.0) * cover, cover);
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
  // Above the highest ground by what the smooth surface can never exceed: the fragment cuts the wall where the ground is.
  let high = max(F.bounds.y, F.terrain.w) * F.terrain.y;
  var out: WallOut;
  out.uv = uv;
  out.normal = normal;
  out.world = vec3f(uv * F.terrain.x, mix(F.bounds.z, high, corner.y));
  out.position = F.viewProj * vec4f(out.world, 1.0);
  return out;
}
// The ground and the sea at a fragment of the wall, in metres of the picture's heights.
fn wallGround(in: WallOut) -> f32 {
  return shownHeight(in.uv, smoothness(in.world)) * F.terrain.y;
}
// The colour of the wall at a fragment: the cut through the ground, and above the ground the sea seen from the side.
fn wallColor(in: WallOut, ground: f32, sea: f32) -> vec3f {
  let sun = F.sunDir.xyz;
  var s: Surface;
  s.normal = in.normal;
  s.shadow = 1.0;
  s.occlusion = 1.0;
  let size = F.terrain.x;
  // The cut: earth without a hue of its own, a little lighter under the surface, where the ground's own colour
  // would be, and darker down to the base, in faint layers. It is lit as any surface is, so that the slab has
  // a lit side and a side in its own shade.
  let below = max(ground - in.world.z, 0.0) / size;
  let layers = valueNoise(vec2f((in.world.x + in.world.y) / (0.7 * size), in.world.z / (0.004 * size)));
  s.albedo = mix(vec3f(0.062, 0.055, 0.048), vec3f(0.03, 0.029, 0.028), smoothstep(0.0, 0.035, below)) * (0.88 + 0.24 * layers);
  // The ground beside the slab shades its foot.
  s.occlusion = mix(0.45, 1.0, smoothstep(0.0, 0.03 * size, in.world.z - F.bounds.z));
  var color = litColor(s);
  // The topmost fragments of a wall have their middle above the ground and some of their samples below it. Only
  // under a sea that is shown and stands above the ground is that the sea's side: elsewhere it is still the cut,
  // and a depth below zero would let the water glow (the dotted bright line along a rim above the sea).
  if (F.flags.y > 0.5 && sea > ground && in.world.z > ground) {
    // The sea, seen from the side: its own colour, darker with every metre under the surface.
    let under = max(sea - in.world.z, 0.0) / max(F.terrain.y, 1e-6) * F.terrain.z;
    let light = F.sunColor.rgb * (max(sun.z, 0.0) / PI) + F.skyUp.rgb;
    color = (WATER_DEEP * 1.6 + vec3f(0.0, 0.03, 0.03) * exp(-under / 6.0)) * light * exp(-WATER_ABSORB * under * 0.12);
  }
  return aerial(color, in.world, 1.0);
}
// The wall ends at the terrain's edge: its coverage falls over one pixel there.
fn wallCover(in: WallOut, top: f32) -> f32 {
  return saturate((top - in.world.z) / max(fwidth(in.world.z), 1e-5) + 0.5);
}
@fragment fn fsWall(in: WallOut) -> @location(0) vec4f {
  let ground = wallGround(in);
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
  let ground = wallGround(in);
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
    // A texel that covers several pixels is shaded as the smooth surface of the 3D view.
    let slope = surfaceSlope(at, footprint, F.misc.w * smoothShare(footprint));
    let normal = normalize(vec3f(-slope, 1.0));
    var occlusion = 1.0;
    if (F.misc.x > 0.5) { occlusion = textureSampleLevel(aoTex, lightSampler, at, max(log2(max(perPixel * F.light.z, 1e-6)), F.light.y)).r; }
    var albedo = mix(vec3f(0.4), over.rgb, over.a);
    let depth = (F.terrain.w - height) * F.terrain.z;
    if (F.flags.y > 0.5 && depth > 0.0) {
      // The sea as a map has it: the ground through the water down to a few metres, then the water's own blue,
      // and a paler fringe where it is thinnest, at least two pixels wide.
      let through = exp(-WATER_ABSORB * depth * 2.0);
      let perStep = length(slope) * F.terrain.z / max(F.terrain.y, 1e-6) * perPixel * F.terrain.x;
      let shore = 1.0 - smoothstep(0.0, max(2.0 * perStep, 0.35), depth);
      albedo = mix(albedo * through + vec3f(0.03, 0.115, 0.19) * (vec3f(1.0) - through), vec3f(0.6), shore * 0.3);
    }
    color = encode(albedo * (0.22 + 1.05 * max(dot(normal, F.sunDir.xyz), 0.0)) * mix(0.72, 1.0, occlusion));
  }
  return vec4f(mix(background, color, inside), 1.0);
}
`;

// ---- from the lit picture to the canvas ------------------------------------------------------------------------------

export const POST_WGSL = /* wgsl */ `
struct Post { gain: vec4f }      // rgb: the exposure times the white balance (atmosphere.ts)
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var lit: texture_2d<f32>;

@vertex fn vsPost(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}
// From light to the display's range. Below ${TONE_SHOULDER} a colour is shown as it is, so that a draped colour map and the
// palettes are judged as they were made; what is brighter is brought into range by its brightest channel, which
// keeps its hue, and gives way to white as it gets there, as film does. It is the curve of the Khronos PBR
// Neutral tone mapper with a longer shoulder and without its offset, which is for the gloss of a product on a
// white ground and takes the lowest channel out of every dark colour.
fn tonemap(color: vec3f) -> vec3f {
  let peak = max(color.r, max(color.g, color.b));
  if (peak < ${TONE_SHOULDER}) { return color; }
  let d = ${(1 - TONE_SHOULDER).toFixed(4)};
  let newPeak = 1.0 - d * d / (peak + d - ${TONE_SHOULDER});
  let c = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (0.25 * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}
fn encode(x: vec3f) -> vec3f {
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - vec3f(0.055), x * 12.92, x <= vec3f(0.0031308));
}
@fragment fn fsPost(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = max(textureLoad(lit, vec2i(position.xy), 0).rgb, vec3f(0.0)) * P.gain.rgb;
  // Half a step of noise takes the bands out of the sky's gradients.
  let noise = fract(52.9829189 * fract(dot(position.xy, vec2f(0.06711056, 0.00583715)))) - 0.5;
  return vec4f(encode(clamp(tonemap(color), vec3f(0.0), vec3f(1.0))) + vec3f(noise / 255.0), 1.0);
}
`;

// ---- the sky map -----------------------------------------------------------------------------------------------------
// x: the azimuth from the sun, all the way round. y: the elevation, with most texels at the horizon.

export const SKY_MAP_WGSL = /* wgsl */ `
struct Sky {
  sun: vec4f,                              // x: the sun's elevation in radians; z, w: the size of the map
  up: vec4f,                               // rgb: the sky's irradiance over pi on level ground
  table: array<vec4f, ${MS_SAMPLES}>,     // multipleScattering of atmosphere.ts
}
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
    radiance = mix(radiance, skyMarch(above, sun), exp(elevation / 0.05));
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
