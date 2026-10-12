// The framework-owned 1 x 1 textures and the LUT buffers (engine.md 3.11, 4.9; runtime.md 2.4, 3.2 rule 5):
// what an unbound input and a discarded target are bound to, and what a kernel reads from a table.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { createLutBuffer } from '../../../src/core/gpu/lut.ts';
import { createRig, texel } from './rig.ts';

const table = defineKernel({
  name: 'test/table',
  outputs: { out: 'aux' },
  luts: { values: 'f32' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> vec4f { return vec4f(values_item(u32(px.x)), values_item(u32(px.x) + 4096u), f32(values_len()), values_at(uv.x)); }',
});

const rig = await createRig();
await rig.compile(table);

test('a default is one texture per value; a number fills every channel', () => {
  const { defaults, pool } = rig;
  const before = pool.report().reservedBytes;
  const one = defaults.input(1);
  assert.equal(defaults.input(1), one, 'cached by value');
  assert.equal(defaults.input([1, 1, 1, 1]), one, 'a number is the same default as four of it');
  assert.notEqual(defaults.input(0), one);
  assert.notEqual(defaults.input([1, 1, 1, 0]), one);
  assert.equal(pool.report().reservedBytes - before, 3 * 16, 'three 1 x 1 textures of 16 bytes in the ledger');
  assert.equal(defaults.takeScopes().length, 3, 'one pair of scopes per texture made');
  assert.equal(defaults.takeScopes().length, 0, 'handed over once');
});

test('a sink is distinct per slot of the run and per format', () => {
  const { defaults, gpu } = rig;
  const first = defaults.sink('field', 0);
  assert.equal(defaults.sink('field', 0), first);
  assert.notEqual(defaults.sink('field', 1), first, 'two discarded targets of one run never share a texture');
  assert.notEqual(defaults.sink('color', 0), first);
  assert.equal(defaults.sink('half', 0) === first, gpu.caps.formats.half === gpu.caps.formats.field, 'kinds with one format share their sinks');
  for (const scopes of defaults.takeScopes()) rig.stream.track(scopes);
});

test('a LUT buffer holds its data from creation, for tables from one element to many', async () => {
  const n = 16;
  for (const length of [1, 2, 5, 4096, 1_048_576]) {
    const data = Float32Array.from({ length }, (_, i) => 1 + i * 0.5);
    const lut = rig.lut(data, 'f32');
    assert.deepEqual([lut.type, lut.length], ['f32', length]);
    const out = rig.field('aux', n);
    rig.run(table, { out: { out }, luts: { values: lut } });
    const got = await rig.read(out);
    for (const x of [0, 1, 7, 15]) {
      const [item, last, len, at] = texel(got, n, x, 0, 4);
      assert.equal(item, data[Math.min(x, length - 1)], `values_item(${x}) of ${length}`);
      assert.equal(last, data[Math.min(x + 4096, length - 1)], 'an index past the end reads the last element');
      assert.equal(len, length);
      const position = (x / 15) * (length - 1), i = Math.min(Math.floor(position), length - 1);
      const expected = data[i]! + (data[Math.min(i + 1, length - 1)]! - data[i]!) * (position - i);
      assert.ok(Math.abs(at! - expected) <= 1e-6 * Math.max(1, Math.abs(expected)) * Math.max(1, length / 1024), `values_at(${x / 15}) of ${length}: ${at} against ${expected}`);
    }
    rig.release(out);
  }
  await rig.owner.settle();
});

test('createLutBuffer returns the scopes of its creation for the owner', async () => {
  const made = createLutBuffer(rig.gpu.device, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), 'vec4f');
  assert.equal(made.buffer.size, 32);
  assert.equal(made.buffer.usage & GPUBufferUsage.STORAGE, GPUBufferUsage.STORAGE);
  assert.deepEqual([await made.scopes.validation, await made.scopes.outOfMemory], [null, null]);
  made.buffer.destroy();
});
