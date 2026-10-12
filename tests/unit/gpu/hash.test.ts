// The TypeScript hashes and mixSeed against fixed vectors (testing.md 8.1). The vectors come from the WGSL
// text of engine.md 3.9 evaluated in exact integer arithmetic; tests/engine/gpu/hash.test.ts checks the
// same functions against the GPU.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashCell, hashU32, hashUnit, mixSeed } from '../../../src/core/gpu/hash.ts';

const MASK = (1n << 32n) - 1n;
/** hash_u32 of engine.md 3.9, in arithmetic that cannot overflow. */
function reference(x: bigint): bigint {
  const s = (x * 747796405n + 2891336453n) & MASK;
  const w = (((s >> ((s >> 28n) + 4n)) ^ s) * 277803737n) & MASK;
  return ((w >> 22n) ^ w) & MASK;
}
const bits = (i: number): bigint => BigInt.asUintN(32, BigInt(i));

test('hashU32 returns the fixed vectors', () => {
  const vectors: readonly (readonly [number, number])[] = [
    [0, 129708002], [1, 2831084092], [2, 2055130248], [12345, 4099845390], [2147483647, 3919530446],
    [2147483648, 566699590], [4294967295, 3861530882], [747796405, 2358745740],
  ];
  for (const [x, expected] of vectors) assert.equal(hashU32(x), expected, `hashU32(${x})`);
});

test('hashU32 is unsigned and agrees with exact arithmetic on 5000 inputs', () => {
  let x = 0x9e3779b9;
  for (let i = 0; i < 5000; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const h = hashU32(x);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    assert.equal(BigInt(h), reference(BigInt(x)), `hashU32(${x})`);
  }
});

test('hashU32 reads its argument as a u32', () => {
  assert.equal(hashU32(-1), hashU32(4294967295));
  assert.equal(hashU32(4294967296 + 7), hashU32(7));
});

test('hashCell returns the fixed vectors, negative coordinates included', () => {
  const vectors: readonly (readonly [number, number, number, number])[] = [
    [0, 0, 0, 2145236065], [1, 0, 0, 3375797271], [0, 1, 0, 3414907750], [0, 0, 1, 594548367], [-1, -1, 7, 36211542],
    [-2147483648, 2147483647, 4294967295, 364750458], [123, -456, 789, 27329044],
  ];
  for (const [x, y, seed, expected] of vectors) assert.equal(hashCell(x, y, seed), expected, `hashCell(${x}, ${y}, ${seed})`);
});

test('hashCell is hash_u32(bitcast(x) + hash_u32(bitcast(y) + hash_u32(seed)))', () => {
  for (let i = 0; i < 2000; i++) {
    const x = (hashU32(i) | 0) >> (i % 20), y = (hashU32(i + 7919) | 0) >> (i % 13), seed = hashU32(i * 31);
    const expected = reference((bits(x) + reference((bits(y) + reference(bits(seed))) & MASK)) & MASK);
    assert.equal(BigInt(hashCell(x, y, seed)), expected, `hashCell(${x}, ${y}, ${seed})`);
  }
});

test('hashUnit is the top 24 bits over 2^24: exact, in [0, 1)', () => {
  assert.equal(hashUnit(0), 0);
  assert.equal(hashUnit(255), 0);
  assert.equal(hashUnit(256), 1 / 16777216);
  assert.equal(hashUnit(0x80000000), 0.5);
  assert.equal(hashUnit(0xffffffff), 16777215 / 16777216);
  for (let i = 0; i < 1000; i++) {
    const v = hashUnit(hashU32(i));
    assert.ok(v >= 0 && v < 1);
    assert.equal(Math.fround(v), v, 'a float32 holds the value exactly');
  }
});

test('mixSeed returns the fixed vectors and is hashU32((hashU32(a) + b) >>> 0)', () => {
  const vectors: readonly (readonly [number, number, number])[] = [
    [0, 0, 817759070], [1, 0, 3911864714], [0, 1, 1583546800], [1, 2, 3752912895], [4294967295, 4294967295, 84801872],
    [305419896, 2596069104, 1405478905],
  ];
  for (const [a, b, expected] of vectors) {
    assert.equal(mixSeed(a, b), expected, `mixSeed(${a}, ${b})`);
    assert.equal(mixSeed(a, b), hashU32((hashU32(a) + b) >>> 0));
  }
  assert.notEqual(mixSeed(1, 2), mixSeed(2, 1), 'the two seeds are not interchangeable');
});
