// src/core/nodes/generate/shape.ts
import { defineKernel, defineNode, param } from '../../api.ts';

/** The most sides a polygon has: the constant bound of the kernel's loop and the hard maximum of `count`. */
const MAX_SIDES = 16;

const shape = defineKernel({
  name: 'generate/shape',
  outputs: { out: 'field' },
  // axis: the shape's own x axis on the terrain. turn: the step from one polygon corner to the next, as (cos, sin).
  params: { center: 'vec2f', extent: 'vec2f', axis: 'vec2f', turn: 'vec2f', feather: 'f32', count: 'i32', mode: 'u32' },
  cost: 8,
  code: /* wgsl */ `
const MAX_SIDES = ${MAX_SIDES};

// Each function returns the distance from p to the outline, negative inside.

// The nearest point of an ellipse has no closed form. Each round moves a point on the ellipse to where the
// circle of curvature at that point is nearest to p. Four rounds leave a distance wrong by less than 1e-6 of
// the terrain width for a shape up to twelve times as long as wide, and by 2e-5 at forty-five times.
fn ellipseDistance(p: vec2f, ab: vec2f) -> f32 {
  let q = abs(p);
  let evolute = vec2f((ab.x * ab.x - ab.y * ab.y) / ab.x, (ab.y * ab.y - ab.x * ab.x) / ab.y);
  var t = vec2f(0.70710678);
  for (var k = 0; k < 4; k++) {
    let c = evolute * t * t * t;                      // centre of the circle of curvature
    let w = q - c;
    let reach = length(w);
    if (reach < 1.0e-12) { break; }                   // p is that centre: every point of the circle is nearest
    let u = clamp((w * (length(ab * t - c) / reach) + c) / ab, vec2f(0.0), vec2f(1.0));
    let norm = length(u);
    if (norm < 1.0e-12) { break; }
    t = u / norm;
  }
  let d = length(q - ab * t);
  let scaled = q / ab;
  return select(d, -d, dot(scaled, scaled) < 1.0);
}

fn rectangleDistance(p: vec2f, half: vec2f) -> f32 {
  let q = abs(p) - half;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

// A regular polygon stretched to the extent: corner k lies at extent * (the unit vector turned k steps from straight up).
fn polygonDistance(p: vec2f, extent: vec2f, sides: i32, turn: vec2f) -> f32 {
  let n = clamp(sides, 3, MAX_SIDES);
  var dir = vec2f(0.0, -1.0);
  let first = extent * dir;
  var a = first;
  var nearest = 1.0e30;                               // squared
  var inside = true;
  for (var k = 0; k < MAX_SIDES; k++) {
    if (k >= n) { break; }
    dir = vec2f(dir.x * turn.x - dir.y * turn.y, dir.x * turn.y + dir.y * turn.x);
    var b = extent * dir;
    if (k == n - 1) { b = first; }                    // the last side closes on the first corner itself, not on a rounded copy
    let e = b - a;
    let w = p - a;
    let r = w - e * saturate(dot(w, e) / max(dot(e, e), 1.0e-20));
    nearest = min(nearest, dot(r, r));
    if (e.x * w.y - e.y * w.x < 0.0) { inside = false; }   // the polygon is convex: inside is the same side of every edge
    a = b;
  }
  return select(sqrt(nearest), -sqrt(nearest), inside);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = uv - P.center;
  let p = vec2f(d.x * P.axis.x + d.y * P.axis.y, d.y * P.axis.x - d.x * P.axis.y);   // in the shape's own frame
  var sd = 0.0;
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { sd = rectangleDistance(p, P.extent); }
    case 2u: { sd = polygonDistance(p, P.extent, P.count, P.turn); }
    default: { sd = ellipseDistance(p, P.extent); }
  }
  if (P.feather <= 0.0) { return select(0.0, 1.0, sd <= 0.0); }
  // The soft edge is centred on the outline: 1 half a feather inside it, 0 half a feather outside, 0.5 on it.
  let t = saturate(0.5 - sd / P.feather);
  return t * t * (3.0 - 2.0 * t);
}`,
});

export default defineNode({
  type: 'generate/shape',
  title: 'Shape',
  category: 'generate',
  description: 'Generates the mask of an ellipse, a rectangle or a regular polygon with a soft edge.',
  keywords: ['ellipse', 'circle', 'rectangle', 'square', 'box', 'polygon', 'hexagon', 'triangle', 'disc', 'mask'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'ellipse',
      options: [
        { value: 'ellipse', label: 'Ellipse' },
        { value: 'rectangle', label: 'Rectangle' },
        { value: 'polygon', label: 'Polygon' },
      ],
      help: 'The outline that is filled. A polygon has its first corner at the top and fits the ellipse of the same extent.',
    },
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'Where the middle of the shape lies on the terrain.',
    },
    {
      kind: 'vec2', name: 'extent', label: 'Extent', unit: 'length', default: [0.3, 0.2], min: 0, max: 1, soft: true,
      help: 'Half the width and half the height of the shape. Larger values make it bigger.',
    },
    param.angle({ label: 'Angle', help: 'Larger values turn the shape clockwise in the top view.' }),
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'length', default: 0.02, min: 0.001, max: 0.5, scale: 'log', soft: true,
      help: 'Larger values fade the edge over a wider band, centered on the outline.',
    },
    {
      kind: 'int', name: 'count', label: 'Sides', default: 6, min: 3, max: MAX_SIDES,
      visibleWhen: { param: 'mode', equals: 'polygon' },
      help: 'Larger values give the polygon more corners.',
    },
  ],
  kernels: [shape],
  evaluate(ctx) {
    const { center, extent, angle, feather, count } = ctx.params;
    const r = (angle * Math.PI) / 180;
    const step = (2 * Math.PI) / count;
    const out = ctx.alloc('field');
    ctx.run(shape, {
      out: { out },
      params: {
        center,
        // The extent is soft: 0 and negative values arrive. The smallest shape is a point, which has an outline to fade from.
        extent: [Math.max(extent[0], 1e-6), Math.max(extent[1], 1e-6)],
        axis: [Math.cos(r), Math.sin(r)],
        turn: [Math.cos(step), Math.sin(step)],
        feather: Math.max(feather, 0),            // 0 is a hard edge
        count,
        mode: ctx.enumIndex('mode'),
      },
      cost: 8 + 2 * count,
    });
    ctx.output('out', out);
  },
});
