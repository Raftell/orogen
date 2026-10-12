// The kernels engine.md prints: the generator and the simulation step of section 6, the red-black half-step of
// 3.5 and the variant factory of 3.6. The first two are the kernels of the reference nodes themselves, taken
// from their definitions: a kernel name is defined once per process (engine.md, Module scope), and a process
// that loads the reference nodes, as every process of the harness does, already holds 'ref/fbm' and
// 'ref/talus.step'. Not a test file.

import { defineKernel, MASK_INPUT, type AnyKernel, type Kernel } from '../../../src/core/gpu/kernel.ts';
import fbmNode from '../../../src/core/nodes/ref/fbm.ts';
import talusNode from '../../../src/core/nodes/ref/talus.ts';

function kernelOf(kernels: readonly AnyKernel[], name: string): AnyKernel {
  const kernel = kernels.find((k) => k.name === name);
  if (!kernel) throw new Error(`The reference nodes define no kernel "${name}"`);
  return kernel;
}

/** engine.md 6.1. */
export const fbm = kernelOf(fbmNode.kernels, 'ref/fbm') as Kernel<
  {}, { readonly out: 'field' }, {}, {}, { readonly cells: 'f32'; readonly octaves: 'i32'; readonly gain: 'f32' }, {}
>;

/** engine.md 6.2. */
export const step = kernelOf(talusNode.kernels, 'ref/talus.step') as Kernel<
  { readonly h: 'field' }, { readonly next: 'field' }, { readonly moved: 'field' }, {}, { readonly talus: 'f32'; readonly rate: 'f32' }, {}
>;

export const relax = defineKernel({
  name: 'ref/relax.half',
  mode: 'raw',
  unsafeReadWrite: { g: 'field' },
  raceFree: 'red-black: an invocation stores only where (x + y + parity) is even and loads only where it is odd',
  params: { parity: 'u32' },
  code: /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  if (((u32(px.x) + u32(px.y) + P.parity) & 1u) != 0u) { return; }
  let e = textureLoad(g, clampToGrid(px + vec2i(1, 0))).r;
  let w = textureLoad(g, clampToGrid(px - vec2i(1, 0))).r;
  let n = textureLoad(g, clampToGrid(px + vec2i(0, 1))).r;
  let s = textureLoad(g, clampToGrid(px - vec2i(0, 1))).r;
  textureStore(g, px, vec4f(0.25 * (e + w + n + s), 0.0, 0.0, 1.0));
}`,
});

const box3 = (kind: 'field' | 'color') => defineKernel({
  name: `ref/box3#${kind}`,
  inputs: { src: kind, mask: MASK_INPUT },
  outputs: { out: kind },
  params: { dir: 'vec2i' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let blurred = (src_at(px - P.dir) + src_at(px) + src_at(px + P.dir)) / 3.0;
  return mix(src_at(px), blurred, mask_at(px));
}`,
});
export const box3Kernels = { field: box3('field'), color: box3('color') };
