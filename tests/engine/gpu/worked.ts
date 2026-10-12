// The kernels engine.md prints, word for word: the generator and the simulation step of section 6, the
// red-black half-step of 3.5 and the variant factory of 3.6. Test files of this folder import them; a kernel
// name is defined once per process. Not a test file.

import { defineKernel, MASK_INPUT } from '../../../src/core/gpu/kernel.ts';
import { noise } from '../../../src/core/wgsl/noise.ts';

export const fbm = defineKernel({
  name: 'ref/fbm',
  outputs: { out: 'field' },
  params: { cells: 'f32', octaves: 'i32', gain: 'f32' },
  includes: [noise],
  code: /* wgsl */ `
const SPREAD = 1.6;   // fixed normalisation constant; to calibrate against the generator range rule (1.7)

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let n = noise_fbm(uv * P.cells, seedFor(0u), clamp(P.octaves, 1, 16), 2.0, P.gain);
  return 0.5 + 0.5 * SPREAD * n;
}`,
});

export const step = defineKernel({
  name: 'ref/talus.step',
  inputs: { h: 'field' },          // current heights: read with neighbours
  outputs: { next: 'field' },      // new heights: the other half of the ping-pong pair
  inPlace: { moved: 'field' },     // accumulator: read and written at the own texel only
  params: { talus: 'f32', rate: 'f32' },
  code: /* wgsl */ `
// Height this texel receives from neighbour q (negative: gives). The amount
// depends only on the two heights, so both texels compute the same magnitude
// with opposite sign and the total is conserved.
fn exchange(hp: f32, q: vec2i, dist: f32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  let d = h_at(q) - hp;
  return sign(d) * max(abs(d) - P.talus * dist, 0.0) * P.rate / dist;
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  var net = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i != 0 || j != 0) {
        net += exchange(hp, px + vec2i(i, j), length(vec2f(vec2i(i, j))));
      }
    }
  }
  return Out(hp + net, cur.moved + abs(net));
}`,
});

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
