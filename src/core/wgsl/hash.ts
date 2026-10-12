import { defineLib, type WgslLib } from '../gpu/lib.ts';

// The text of engine.md 3.9, which is normative. src/core/gpu/hash.ts holds the TypeScript twins.
const code = /* wgsl */ `fn hash_u32(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Hash of an integer lattice cell and a seed. Negative coordinates are valid.
fn hash_cell(c: vec2i, seed: u32) -> u32 {
  return hash_u32(bitcast<u32>(c.x) + hash_u32(bitcast<u32>(c.y) + hash_u32(seed)));
}
// Uniform float in [0, 1) from the top 24 bits; exact.
fn hash_unit(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
// Two independent uniform floats in [0, 1).
fn hash_unit2(h: u32) -> vec2f { return vec2f(hash_unit(h), hash_unit(hash_u32(h))); }`;

/** Integer hashing (PCG). */
export const hash: WgslLib = defineLib({ name: 'hash', code });
