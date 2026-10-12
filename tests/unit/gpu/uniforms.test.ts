// Uniform packing against the WGSL layout rules (engine.md 3.10, testing.md 8.1). The GPU's own view of the
// same structs is checked in tests/engine/gpu/kernels.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UniformType } from '../../../src/core/gpu/kernel.ts';
import { FRAME_BYTES, packLayout, UNIFORM_SLOT_BYTES, WGSL_LAYOUT, writeFrame, writeParams } from '../../../src/core/gpu/uniforms.ts';

// The WGSL specification's alignment and size of each type, written out independently of WGSL_LAYOUT.
const SPEC: Readonly<Record<UniformType, { align: number; size: number }>> = {
  f32: { align: 4, size: 4 }, i32: { align: 4, size: 4 }, u32: { align: 4, size: 4 },
  vec2f: { align: 8, size: 8 }, vec2i: { align: 8, size: 8 }, vec2u: { align: 8, size: 8 },
  vec3f: { align: 16, size: 12 }, vec4f: { align: 16, size: 16 },
};
const TYPES = Object.keys(SPEC) as UniformType[];

test('WGSL_LAYOUT holds the alignment and size of every uniform type', () => {
  assert.deepEqual(Object.keys(WGSL_LAYOUT).sort(), [...TYPES].sort());
  for (const type of TYPES) assert.deepEqual([...WGSL_LAYOUT[type]], [SPEC[type].align, SPEC[type].size], type);
});

test('packLayout gives the offsets the contract prints', () => {
  assert.deepEqual(packLayout({ a: 'vec3f', b: 'f32' }), {
    fields: [{ name: 'a', type: 'vec3f', offset: 0 }, { name: 'b', type: 'f32', offset: 12 }], size: 16,
  });
  assert.deepEqual(packLayout({ a: 'f32', b: 'vec3f' }), {
    fields: [{ name: 'a', type: 'f32', offset: 0 }, { name: 'b', type: 'vec3f', offset: 16 }], size: 32,
  });
  assert.deepEqual(packLayout({ a: 'f32', b: 'vec2f', c: 'f32' }).fields.map((f) => f.offset), [0, 8, 16]);
  assert.equal(packLayout({ a: 'f32', b: 'vec2f', c: 'f32' }).size, 24);
  assert.deepEqual(packLayout({}), { fields: [], size: 0 });
  assert.deepEqual(packLayout({ talus: 'f32', rate: 'f32' }), {
    fields: [{ name: 'talus', type: 'f32', offset: 0 }, { name: 'rate', type: 'f32', offset: 4 }], size: 8,
  });
});

test('packLayout follows the WGSL struct rules for every pair and for long random structs', () => {
  const check = (types: readonly UniformType[]): void => {
    const params: Record<string, UniformType> = {};
    types.forEach((type, i) => { params[`p${i}`] = type; });
    const layout = packLayout(params);
    assert.deepEqual(layout.fields.map((f) => f.name), Object.keys(params), 'declaration order is kept');
    let end = 0, structAlign = 4;
    layout.fields.forEach((field, i) => {
      const { align, size } = SPEC[types[i]!];
      assert.equal(field.type, types[i]);
      assert.equal(field.offset % align, 0, `${field.type} at ${field.offset} is aligned to ${align}`);
      assert.ok(field.offset >= end, 'members do not overlap');
      assert.ok(field.offset - end < align, 'no padding beyond what the alignment needs');
      end = field.offset + size;
      structAlign = Math.max(structAlign, align);
    });
    assert.equal(layout.size % structAlign, 0, 'the size is a multiple of the largest alignment');
    assert.ok(layout.size >= end && layout.size - end < structAlign);
  };
  for (const a of TYPES) for (const b of TYPES) check([a, b]);
  let state = 12345;
  for (let round = 0; round < 500; round++) {
    const types: UniformType[] = [];
    const count = 1 + (round % 12);
    for (let i = 0; i < count; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      types.push(TYPES[(state >>> 16) % TYPES.length]!);
    }
    check(types);
  }
});

test('writeParams writes each value at its offset in the type of its member', () => {
  const layout = packLayout({ a: 'f32', b: 'vec3f', c: 'i32', d: 'vec2u', e: 'u32', f: 'vec4f', g: 'vec2i', h: 'vec2f', on: 'u32', off: 'i32' });
  const bytes = new ArrayBuffer(512);
  const view = new DataView(bytes);
  new Uint8Array(bytes).fill(0xee);
  const base = 256;
  writeParams(layout, {
    a: 1.5, b: [2, 3, 4], c: -7, d: [8, 4294967295], e: 4000000000, f: [0.25, 0.5, 0.75, 1], g: [-1, 2147483647], h: [9.5, -10.5],
    on: true, off: false,
  }, view, base);
  const at = (name: string): number => base + layout.fields.find((f) => f.name === name)!.offset;
  assert.equal(view.getFloat32(at('a'), true), 1.5);
  assert.deepEqual([0, 4, 8].map((o) => view.getFloat32(at('b') + o, true)), [2, 3, 4]);
  assert.equal(view.getInt32(at('c'), true), -7);
  assert.deepEqual([0, 4].map((o) => view.getUint32(at('d') + o, true)), [8, 4294967295]);
  assert.equal(view.getUint32(at('e'), true), 4000000000);
  assert.deepEqual([0, 4, 8, 12].map((o) => view.getFloat32(at('f') + o, true)), [0.25, 0.5, 0.75, 1]);
  assert.deepEqual([0, 4].map((o) => view.getInt32(at('g') + o, true)), [-1, 2147483647]);
  assert.deepEqual([0, 4].map((o) => view.getFloat32(at('h') + o, true)), [9.5, -10.5]);
  assert.equal(view.getUint32(at('on'), true), 1);
  assert.equal(view.getInt32(at('off'), true), 0);
  assert.ok(new Uint8Array(bytes, 0, base).every((b) => b === 0xee), 'nothing is written before the slot');
  assert.ok(new Uint8Array(bytes, base + layout.size).every((b) => b === 0xee), 'nothing is written after the struct');
});

test('writeFrame writes struct Frame at the offsets of engine.md section 2', () => {
  assert.equal(FRAME_BYTES, 40);
  assert.equal(UNIFORM_SLOT_BYTES, 256);
  const bytes = new ArrayBuffer(128);
  const view = new DataView(bytes);
  new Uint8Array(bytes).fill(0xee);
  writeFrame({
    res: [257, 129], tileOrigin: [3, 64], terrainSize: 4096, cellSize: 16, heightRange: 1024, seed: 4000000001, iteration: 4294967295, bound: 5,
  }, view, 16);
  assert.deepEqual([0, 4, 8, 12].map((o) => view.getUint32(16 + o, true)), [257, 129, 3, 64]);
  assert.deepEqual([16, 20, 24].map((o) => view.getFloat32(16 + o, true)), [4096, 16, 1024]);
  assert.deepEqual([28, 32, 36].map((o) => view.getUint32(16 + o, true)), [4000000001, 4294967295, 5]);
  assert.ok(new Uint8Array(bytes, 0, 16).every((b) => b === 0xee));
  assert.ok(new Uint8Array(bytes, 16 + FRAME_BYTES).every((b) => b === 0xee), 'a Frame is 40 bytes');
});
