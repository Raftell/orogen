// The TypeScript twins of the WGSL library `hash` and of the standard library's mixSeed (engine.md 3.9, 4.8).
// Each returns exactly the value its WGSL counterpart returns.

export function hashU32(x: number): number {                         // PCG, as hash_u32 (3.9)
  const s = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
export function hashCell(x: number, y: number, seed: number): number {
  // `| 0` is bitcast<u32> of an i32: the two's-complement bits of a negative coordinate.
  return hashU32(((x | 0) + hashU32(((y | 0) + hashU32(seed)) >>> 0)) >>> 0);
}
export function hashUnit(h: number): number {
  return (h >>> 8) * (1 / 16777216);
}
export function mixSeed(a: number, b: number): number {              // hashU32((hashU32(a) + b) >>> 0)
  return hashU32((hashU32(a) + (b >>> 0)) >>> 0);
}
