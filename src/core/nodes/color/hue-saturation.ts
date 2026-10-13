// src/core/nodes/color/hue-saturation.ts
import { convert, defineKernel, defineNode, param } from '../../api.ts';
import { colorStore } from './_wgsl.ts';

/** The most a typed saturation multiplies by: the slider ends at 2, and any finite number can be typed. */
const MAX_SATURATION = 16;

const adjust = defineKernel({
  name: 'color/hue-saturation',
  inputs: { src: 'color' },
  outputs: { out: 'color' },
  // hue: the turn in sixths of the color wheel, 0 to 6.
  params: { hue: 'f32', saturation: 'f32', lightness: 'f32', contrast: 'f32' },
  includes: [convert, colorStore],
  cost: 1,
  code: /* wgsl */ `
const PIVOT = 0.18;   // middle gray in linear light: what the contrast leaves where it is

// One channel of the color wheel's hexagon at the hue h, in sixths: the largest channel hi less the share of
// the chroma this channel lacks there.
fn wheel(n: f32, hi: f32, chroma: f32) -> f32 {
  let k = n - 6.0 * floor(n / 6.0);
  return hi - chroma * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

// The color turned around the wheel. Its largest and its smallest channel stay what they are, so a gray stays
// that gray and a color of the range 0..1 stays inside it.
fn turned(c: vec3f, sixths: f32) -> vec3f {
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let chroma = hi - lo;
  if (chroma <= 0.0) { return c; }
  var h = 4.0 + (c.r - c.g) / chroma;
  if (hi == c.r) {
    h = (c.g - c.b) / chroma;
  } else if (hi == c.g) {
    h = 2.0 + (c.b - c.r) / chroma;
  }
  h += sixths;
  return vec3f(wheel(5.0 + h, hi, chroma), wheel(3.0 + h, hi, chroma), wheel(1.0 + h, hi, chroma));
}

// The distance from the gray of the same brightness, multiplied. A color is made more vivid only until its
// smallest channel reaches 0 or its largest reaches 1, whichever comes first: beyond that it would be stored
// outside the range a picture shows, and shown with another hue and another brightness. A color that already
// has a channel above 1 is not held to that end.
fn vivid(c: vec3f, saturation: f32) -> vec3f {
  let y = convert_luma(vec4f(c, 1.0));
  let lo = min(c.r, min(c.g, c.b));
  let hi = max(c.r, max(c.g, c.b));
  var s = saturation;
  if (s > 1.0 && y > lo && s * (y - lo) > y) { s = max(y / (y - lo), 1.0); }
  if (s > 1.0 && hi > y && hi <= 1.0 && s * (hi - y) > 1.0 - y) { s = max((1.0 - y) / (hi - y), 1.0); }
  return max(vec3f(y) + (c - vec3f(y)) * s, vec3f(0.0));
}

// The ratio to middle gray raised to the contrast. Black has no ratio: it stays black, and with a contrast of 0
// it is the gray everything becomes.
fn tone(x: f32, contrast: f32) -> f32 {
  if (x <= 0.0) { return select(0.0, PIVOT, contrast == 0.0); }
  return PIVOT * pow(x / PIVOT, contrast);
}

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let src = src_at(px);
  var c = src.rgb;
  // A step whose parameter is neutral is left out, not computed: the color passes through bit for bit.
  if (P.hue != 0.0) { c = turned(c, P.hue); }
  if (P.saturation != 1.0) { c = vivid(c, P.saturation); }
  if (P.lightness >= 1.0) {
    c = vec3f(1.0);
  } else if (P.lightness <= -1.0) {
    c = vec3f(0.0);
  } else if (P.lightness > 0.0) {
    c += (vec3f(1.0) - c) * P.lightness;
  } else if (P.lightness < 0.0) {
    c *= 1.0 + P.lightness;
  }
  if (P.contrast != 1.0) { c = vec3f(tone(c.r, P.contrast), tone(c.g, P.contrast), tone(c.b, P.contrast)); }
  return colorStore_rgb(c, src.a);
}`,
});

export default defineNode({
  type: 'color/hue-saturation',
  title: 'Hue / Saturation',
  category: 'color',
  description: 'Shifts the hue of a color and changes its saturation, lightness and contrast.',
  keywords: ['hsl', 'hsv', 'tint', 'vibrance', 'desaturate', 'grayscale', 'brightness', 'color correction', 'grade'],
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    param.angle({
      name: 'hue', label: 'Hue shift',
      help: 'Turns every color around the color wheel by this angle: 120 turns red into green, green into blue and blue into red.',
    }),
    {
      kind: 'float', name: 'saturation', label: 'Saturation', unit: 'none', default: 1.5, min: 0, max: 2, soft: true,
      help: 'Larger values make colors more vivid, up to the pure color of the same brightness. 1 leaves them as they are and 0 leaves gray.',
    },
    {
      kind: 'float', name: 'lightness', label: 'Lightness', unit: 'none', default: 0, min: -1, max: 1,
      help: 'Positive values blend every color towards white, negative values towards black. 0 leaves them as they are.',
    },
    {
      kind: 'float', name: 'contrast', label: 'Contrast', unit: 'none', default: 1, min: 0, max: 2,
      help: 'Larger values push colors away from middle gray, the dark ones darker and the light ones lighter. 1 leaves them as they are.',
    },
  ],
  kernels: [adjust],
  maskable: true,
  evaluate(ctx) {
    const { hue, saturation, lightness, contrast } = ctx.params;
    const src = ctx.input('in');
    const out = ctx.alloc('color');
    ctx.run(adjust, {
      in: { src },
      out: { out },
      params: {
        // A whole turn is no turn.
        hue: (hue % 360) / 60,
        saturation: Math.min(Math.max(saturation, 0), MAX_SATURATION),   // soft: any finite number can arrive
        lightness,
        contrast,
      },
    });
    ctx.output('out', out);
  },
});
