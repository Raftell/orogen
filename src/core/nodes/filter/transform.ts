// src/core/nodes/filter/transform.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { CUBIC_LOADS, EDGE, filterSample } from './_sample.ts';

// What lies outside the terrain under the edge rule "constant": the fill level, as an opaque gray for a color.
const FILL = { field: 'vec4f(P.fill)', color: 'vec4f(vec3f(P.fill), 1.0)' } as const;
const CHANNELS = { field: '.r', color: '' } as const;

const place = (kind: 'field' | 'color') => defineKernel({
  name: `filter/transform#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  // In texels: where the centre of the picture lands, the centre itself, and the two rows of the matrix that
  // takes a step in the output to the step in the source.
  params: { landing: 'vec2f', centre: 'vec2f', row0: 'vec2f', row1: 'vec2f', edge: 'u32', fill: 'f32' },
  includes: [filterSample],
  cost: CUBIC_LOADS,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  // Texel positions, never uv * size - 0.5: with no offset, no angle and a zoom of 1 the position is px itself,
  // and the picture is read at its own vertices.
  let q = vec2f(px) - P.landing;
  let pos = P.centre + vec2f(dot(P.row0, q), dot(P.row1, q));
  return filterSample_cubic(src, pos, P.edge, ${FILL[kind]})${CHANNELS[kind]};
}`,
});
const kernels = { field: place('field'), color: place('color') };

/** Taps on each side of one pass of the Gaussian that precedes a shrinking: the zoom is at least 0.1, 3 sigma at most 14.9 texels. */
const SOFTEN_TAPS = 15;

// One axis of a Gaussian that reads beyond the border what the edge rule puts there: a picture that repeats or
// is mirrored is softened across its seams as it is anywhere else.
const soften = (kind: 'field' | 'color') => defineKernel({
  name: `filter/transform.soften#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { dir: 'vec2i', taps: 'i32', falloff: 'f32', edge: 'u32', fill: 'f32' },
  includes: [filterSample],
  cost: 2 * SOFTEN_TAPS + 1,
  code: /* wgsl */ `
const MAX_TAPS = ${SOFTEN_TAPS};

fn tap(i: vec2i) -> out_t {
  return filterSample_tap(src, i, P.edge, ${FILL[kind]})${CHANNELS[kind]};
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let taps = clamp(P.taps, 0, MAX_TAPS);
  let centre = src_at(px);
  // Summed as differences from the centre: a constant stays that constant and an opaque color opaque.
  var sum = out_t(0.0);
  var weight = 1.0;
  for (var i = 1; i <= taps; i++) {
    let w = exp(-P.falloff * f32(i * i));
    sum += w * ((tap(px - i * P.dir) - centre) + (tap(px + i * P.dir) - centre));
    weight += 2.0 * w;
  }
  return centre + sum / weight;
}`,
});
const softeners = { field: soften('field'), color: soften('color') };

const EDGES = ['clamp', 'mirror', 'repeat', 'constant'] as const;

export default defineNode({
  type: 'filter/transform',
  title: 'Transform',
  category: 'filter',
  description: 'Moves a terrain or a color map, turns it and scales it about its center.',
  keywords: ['move', 'translate', 'rotate', 'scale', 'zoom', 'offset', 'pan'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'vec2', name: 'offset', label: 'Offset', unit: 'length', default: [0, 0], min: -1, max: 1, soft: true,
      help: 'How far the picture is moved, to the right and down in the top view.',
    },
    param.angle({ label: 'Angle', default: 30, help: 'Larger values turn the picture further clockwise in the top view.' }),
    {
      kind: 'float', name: 'zoom', label: 'Zoom', unit: 'none', default: 1, min: 0.1, max: 10, scale: 'log',
      help: 'Larger values enlarge the picture about its center; values below 1 shrink it.',
    },
    {
      kind: 'enum', name: 'edge', label: 'Edge', default: 'clamp',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'clamp', label: 'Clamp' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'repeat', label: 'Repeat' },
        { value: 'constant', label: 'Constant' },
      ],
      help: 'What fills the area the picture no longer covers: its border stretched outward, its mirror image, its repetition, or one level.',
    },
    param.height({
      label: 'Fill level', default: 0, visibleWhen: { param: 'edge', equals: 'constant' },
      help: 'The height of the area the picture no longer covers. A color map is filled with the gray of this level.',
    }),
  ],
  kernels: [kernels.field, kernels.color, softeners.field, softeners.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const { offset, angle, zoom, edge, height } = ctx.params;
    // Nothing to do: the input itself is the output, under every edge rule.
    if (offset[0] === 0 && offset[1] === 0 && angle % 360 === 0 && zoom === 1) {
      ctx.output('out', src);
      return;
    }

    const edgeRule = EDGE[EDGES[ctx.enumIndex('edge')]!];

    // A picture shrunk to 1/k of its size is read every k texels. What is finer than that is removed first, or
    // it would come out as noise: by a Gaussian that, with the texel's own width, makes up the width of k texels.
    const k = 1 / zoom;
    const sigma = k > 1 ? 0.5 * Math.sqrt(k * k - 1) : 0;
    const taps = Math.min(Math.floor(3 * sigma), SOFTEN_TAPS);
    let read: typeof src | null = null;
    if (taps >= 1) {
      const params = { taps, falloff: 1 / (2 * sigma * sigma), edge: edgeRule, fill: height };
      const rows = ctx.alloc(src.kind);
      ctx.run(softeners[src.kind], { in: { src }, out: { out: rows }, params: { dir: [1, 0], ...params }, cost: 2 * taps + 1 });
      read = ctx.alloc(src.kind);
      ctx.run(softeners[src.kind], { in: { src: rows }, out: { out: read }, params: { dir: [0, 1], ...params }, cost: 2 * taps + 1 });
      ctx.release(rows);
    }

    const last = ctx.res - 1;
    const centre = [last / 2, last / 2] as const;
    // A quarter turn is a whole number of texels: Math.cos of 90 degrees is 6e-17, not 0.
    const exact = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : v);
    const r = (angle * Math.PI) / 180;
    const c = exact(Math.cos(r)), s = exact(Math.sin(r));
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], {
      in: { src: read ?? src },
      out: { out },
      params: {
        landing: [centre[0] + offset[0] * last, centre[1] + offset[1] * last],
        centre,
        // The source of an output step: turned back by the angle and shrunk by the zoom.
        row0: [c / zoom, s / zoom],
        row1: [-s / zoom, c / zoom],
        edge: edgeRule,
        fill: height,
      },
    });
    if (read) ctx.release(read);
    ctx.output('out', out);
  },
});
