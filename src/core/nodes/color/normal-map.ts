// src/core/nodes/color/normal-map.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';

const encode = defineKernel({
  name: 'color/normal-map',
  inputs: { height: 'field' },
  outputs: { out: 'color' },
  params: { strength: 'f32' },
  cost: 5,
  code: /* wgsl */ `
const STEEPEST = 1e6;   // a slope as a tangent beyond which a normal lies level anyway: its square stays a float

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  // The slope is physical: metres per metre, from the terrain size and the height range, and of second order
  // on the border, so the map has no frame there.
  let g = clamp(slopeAt(height, px), vec2f(-STEEPEST), vec2f(STEEPEST)) * P.strength;
  // The normal in the terrain's own axes: red is its +X component, green its +Y component, which points down
  // the picture as Unreal reads a normal map (the DirectX convention), and blue its +Z component.
  let n = normalize(vec3f(-g.x, -g.y, 1.0));
  return vec4f(n * 0.5 + vec3f(0.5), 1.0);
}`,
});

export default defineNode({
  type: 'color/normal-map',
  title: 'Normal Map',
  category: 'color',
  description: 'Encodes the surface normals of a terrain as a normal map in the convention Unreal Engine reads, from its physical slopes.',
  keywords: ['normals', 'tangent space', 'bump', 'directx', 'unreal', 'relief', 'shading'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    param.strength({ help: 'Scales the slopes the normals are made from: 1 gives the normals of the terrain as it is, smaller values a flatter map, and 0 a level one.' }),
    param.radius({
      default: 0.002,
      help: 'Smooths the terrain before its normals are taken: larger values keep the broad shape and leave out small detail.',
    }),
  ],
  kernels: [encode],
  evaluate(ctx) {
    const { strength, radius } = ctx.params;
    const height = ops.smooth(ctx, ctx.input('in'), Math.max(radius, 0));   // soft: any finite number can arrive
    const out = ctx.alloc('color');
    ctx.run(encode, { in: { height }, out: { out }, params: { strength } });
    ctx.release(height);
    ctx.output('out', out);
  },
});
