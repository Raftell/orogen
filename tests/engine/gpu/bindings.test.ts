// ctx.run's checks (engine.md 3.11, 3.13 "At ctx.run()"): every row of the table with the message it prints,
// what the rules allow, and that a refused run encodes nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KernelBindingError } from '../../../src/core/gpu/errors.ts';
import type { AnyKernel } from '../../../src/core/gpu/kernel.ts';
import { defineKernel, MASK_INPUT } from '../../../src/core/gpu/kernel.ts';
import { createRig, type RunOverrides } from './rig.ts';
import { relax, step } from './worked.ts';

const lookup = defineKernel({
  name: 'test/lookup',
  inputs: { src: 'color', mask: MASK_INPUT, coarse: { kind: 'vec2', size: 'any' } },
  outputs: { out: 'color', extra: 'half' },
  luts: { ramp: 'vec4f', curve: 'f32' },
  params: { dir: 'vec2i', octaves: 'i32', on: 'u32', tint: 'vec4f', scale: 'vec2f', shift: 'vec3f', cells: 'vec2u' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let v = src_at(px + P.dir) * mask_at(px) + ramp_at(coarse_uv(uv).x) * curve_at(uv.y) + P.tint * P.scale.x + vec4f(P.shift, f32(P.cells.x));
  return Out(v * f32(P.octaves) * f32(P.on), v.r);
}`,
});
const bare = defineKernel({ name: 'test/bare', outputs: { out: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 1.0; }' });
const uncompiled = defineKernel({ name: 'test/uncompiled', outputs: { out: 'field' }, code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 1.0; }' });

const rig = await createRig();
await rig.compile(step, relax, lookup, bare);

const n = 16;
const h = rig.field('field', n, 0.5), next = rig.field('field', n, 0), moved = rig.field('field', n, 0);
const src = rig.field('color', n, 0), out = rig.field('color', n, 0), extra = rig.field('half', n, 0), coarse = rig.field('vec2', [5, 3], 0);
const ramp = rig.lut(new Float32Array(8), 'vec4f'), curve = rig.lut(new Float32Array(4), 'f32');
const STEP = { talus: 0.01, rate: 0.1 };
const LOOKUP = { dir: [1, 0], octaves: 3, on: true, tint: [0, 0, 0, 1], scale: [1, 1], shift: [0, 0, 0], cells: [4, 4] };
const stepRun = (): Record<string, unknown> => ({ in: { h }, out: { next }, rw: { moved }, params: { ...STEP } });
const lookupRun = (): Record<string, unknown> => ({ in: { src, coarse }, out: { out, extra }, luts: { ramp, curve }, params: { ...LOOKUP } });
await rig.stream.flush();

/** Asserts that the run is refused with exactly `kernel "<kernel>" (node <id>, <type>): <problem>` and that nothing was encoded. */
function refused(kernel: AnyKernel, bindings: unknown, problem: string, env?: RunOverrides): void {
  const submitted = rig.stream.submitted;
  assert.throws(() => rig.runUntyped(kernel, bindings, env), (thrown: unknown) => {
    assert.ok(thrown instanceof KernelBindingError, `KernelBindingError expected, got ${String(thrown)}`);
    assert.equal(thrown.name, 'KernelBindingError');
    assert.equal(thrown.message, `kernel "${kernel.name}" (node ${env?.nodeId ?? 'n1'}, ${env?.nodeType ?? 'test/node'}): ${problem}`);
    return true;
  });
  assert.equal(rig.stream.submitted, submitted);
}
const accepted = (kernel: AnyKernel, bindings: unknown): void => assert.doesNotThrow(() => rig.runUntyped(kernel, bindings));

test('a refused run encodes nothing', async () => {
  const before = rig.slices.length;
  refused(step, { ...stepRun(), params: { talus: NaN, rate: 0.1 } }, 'param "talus" is NaN');
  refused(step, { ...stepRun(), out: { next: h } }, `field #${h.id} is bound to input "h" and output "next". One run cannot read and write the same texture; write to another field and swap`);
  await rig.stream.flush();
  assert.equal(rig.slices.length, before, 'no slice: the stream was not touched');
  assert.ok((await rig.read(next)).every((v) => v === 0) && (await rig.read(moved)).every((v) => v === 0));
});

test('the message names the kernel, the node and its type', () => {
  refused(step, { ...stepRun(), params: {} }, 'missing param "talus"', { nodeId: 'k3f9', nodeType: 'simulate/talus' });
});

test('a kernel that NodeDef.kernels does not list', () => {
  refused(step, stepRun(), 'is not listed in NodeDef.kernels', { listed: false });
  // It is the first check: nothing else about the run is looked at.
  refused(step, { nonsense: true }, 'is not listed in NodeDef.kernels', { listed: false });
});

test('unknown names', () => {
  refused(step, { ...stepRun(), in: { h, height: h } }, 'unknown binding in.height; the kernel declares inputs: h');
  refused(step, { ...stepRun(), out: { next, result: next } }, 'unknown binding out.result; the kernel declares outputs: next');
  refused(step, { ...stepRun(), rw: { moved, acc: moved } }, 'unknown binding rw.acc; the kernel declares rw targets: moved');
  refused(step, { ...stepRun(), luts: { ramp } }, 'unknown binding luts.ramp; the kernel declares no luts');
  refused(bare, { out: { out: next }, in: { h } }, 'unknown binding in.h; the kernel declares no inputs');
  refused(lookup, { ...lookupRun(), luts: { ramp, curve, table: curve } }, 'unknown binding luts.table; the kernel declares luts: ramp, curve');
  refused(step, { ...stepRun(), inputs: { h } }, 'unknown slot "inputs"; a run has in, out, rw, params, luts, iteration and cost');
});

test('missing entries', () => {
  refused(step, { ...stepRun(), out: {} }, 'missing binding out.next. Pass a field, or null to discard the output');
  refused(step, { in: { h }, rw: { moved }, params: STEP }, 'missing binding out.next. Pass a field, or null to discard the output');
  refused(step, { ...stepRun(), in: {} }, 'missing binding in.h. The input has no default; pass a field');
  refused(step, { ...stepRun(), in: { h: null } }, 'missing binding in.h. The input has no default; pass a field');
  refused(step, { ...stepRun(), rw: {} }, 'missing binding rw.moved. Pass a field, or null to discard the target');
  refused(relax, { rw: { g: null }, params: { parity: 0 } }, 'missing binding rw.g. An unsafeReadWrite target cannot be discarded; pass a field');
  refused(relax, { params: { parity: 0 } }, 'missing binding rw.g. An unsafeReadWrite target cannot be discarded; pass a field');
  refused(lookup, { ...lookupRun(), luts: { ramp } }, 'missing binding luts.curve. Pass a Lut made by ctx.lut()');
  refused(step, { ...stepRun(), in: { h: 'h' } }, 'binding in.h is not a field');
  refused(step, { ...stepRun(), out: { next: {} } }, 'binding out.next is not a field');
});

test('what may be left out: an input with a default, a discarded output, a discarded in-place target', () => {
  accepted(lookup, lookupRun());
  accepted(lookup, { ...lookupRun(), in: { src, coarse, mask: null } });
  accepted(lookup, { ...lookupRun(), in: { src, coarse, mask: undefined } });
  accepted(lookup, { ...lookupRun(), out: { out, extra: null } });
  accepted(step, { ...stepRun(), rw: { moved: null } });
  accepted(step, { ...stepRun(), out: { next: null } });
  accepted(bare, { out: { out: next } });
  accepted(bare, { out: { out: next }, in: {}, params: {}, luts: {}, rw: {}, iteration: 4294967295, cost: 0.5 });
});

test('a released field', () => {
  const gone = rig.field('field', n);
  rig.release(gone);
  refused(step, { ...stepRun(), in: { h: gone } }, `field #${gone.id} bound to input "h" was released`);
  refused(step, { ...stepRun(), out: { next: gone } }, `field #${gone.id} bound to output "next" was released`);
  refused(step, { ...stepRun(), rw: { moved: gone } }, `field #${gone.id} bound to rw "moved" was released`);
});

test('an input takes any field with its channel count', () => {
  const half = rig.field('half', n, 0), mask8 = rig.field('mask8', n, 0), half2 = rig.field('half2', [5, 3], 0), aux = rig.field('aux', n, 0);
  accepted(step, { ...stepRun(), in: { h: half } });
  accepted(step, { ...stepRun(), in: { h: mask8 } });
  accepted(lookup, { ...lookupRun(), in: { src: aux, coarse: half2, mask: mask8 } });
  refused(step, { ...stepRun(), in: { h: src } }, `input "h" is declared "field" (1 channel) but field #${src.id} is "color" (4 channels)`);
  refused(step, { ...stepRun(), in: { h: half2 } }, `input "h" is declared "field" (1 channel) but field #${half2.id} is "half2" (2 channels)`);
  refused(lookup, { ...lookupRun(), in: { src: h, coarse } }, `input "src" is declared "color" (4 channels) but field #${h.id} is "field" (1 channel)`);
  refused(lookup, { ...lookupRun(), in: { src, coarse: h } }, `input "coarse" is declared "vec2" (2 channels) but field #${h.id} is "field" (1 channel)`);
  for (const field of [half, mask8, half2, aux]) rig.release(field);
});

test('a target has exactly the declared kind', () => {
  const half = rig.field('half', n, 0), aux = rig.field('aux', n, 0);
  refused(step, { ...stepRun(), out: { next: out } }, `output "next" is declared "field" but field #${out.id} is "color"`);
  refused(step, { ...stepRun(), out: { next: half } }, `output "next" is declared "field" but field #${half.id} is "half"`);
  refused(step, { ...stepRun(), rw: { moved: half } }, `rw "moved" is declared "field" but field #${half.id} is "half"`);
  refused(lookup, { ...lookupRun(), out: { out: aux, extra } }, `output "out" is declared "color" but field #${aux.id} is "aux"`);
  refused(lookup, { ...lookupRun(), out: { out, extra: next } }, `output "extra" is declared "half" but field #${next.id} is "field"`);
  refused(relax, { rw: { g: half }, params: { parity: 0 } }, `rw "g" is declared "field" but field #${half.id} is "half"`);
  rig.release(half);
  rig.release(aux);
});

test('a read-only field is not a target', () => {
  const input = rig.readOnly(next), published = rig.readOnly(moved);
  const remedy = 'which is read-only (a node input, or already passed to ctx.output()). Use ctx.clone()';
  refused(step, { ...stepRun(), out: { next: input } }, `output "next" is bound to field #${input.id}, ${remedy}`);
  refused(step, { ...stepRun(), rw: { moved: published } }, `rw "moved" is bound to field #${published.id}, ${remedy}`);
  refused(relax, { rw: { g: input }, params: { parity: 1 } }, `rw "g" is bound to field #${input.id}, ${remedy}`);
  accepted(step, { ...stepRun(), in: { h: rig.readOnly(h) } });
});

test('aliasing: no field twice among the targets, none of them among the inputs', () => {
  refused(step, { ...stepRun(), in: { h: next } }, `field #${next.id} is bound to input "h" and output "next". One run cannot read and write the same texture; write to another field and swap`);
  refused(step, { ...stepRun(), in: { h: moved } }, `field #${moved.id} is bound to input "h" and rw "moved". One run cannot read and write the same texture; write to another field and swap`);
  refused(step, { ...stepRun(), rw: { moved: next } }, `field #${next.id} is bound to output "next" and rw "moved". One run cannot write the same texture twice; bind another field`);
  // The same field on several inputs is legal, and an output of one run is an input of the next.
  const mask = rig.field('field', n, 1);
  accepted(lookup, { ...lookupRun(), in: { src, coarse, mask } });
  accepted(step, { in: { h: mask }, out: { next }, rw: { moved: null }, params: STEP });
  accepted(step, { in: { h: next }, out: { next: mask }, rw: { moved: null }, params: STEP });
  rig.release(mask);
});

test('the written grid: one size, square', () => {
  const small = rig.field('field', 8, 0), wide = rig.field('field', [12, 8], 0), wideToo = rig.field('field', [12, 8], 0);
  refused(step, { ...stepRun(), rw: { moved: small } }, 'output "next" is 16x16 but rw "moved" is 8x8. All writable targets of a run have the same size');
  refused(step, { in: { h: wideToo }, out: { next: wide }, rw: { moved: null }, params: STEP }, 'output "next" is 12x8. Kernels write square grids');
  refused(step, { in: { h }, out: { next: null }, rw: { moved: wide }, params: STEP }, 'rw "moved" is 12x8. Kernels write square grids');
  refused(step, { in: { h }, out: { next: wide }, rw: { moved: wideToo }, params: STEP }, 'output "next" is 12x8. Kernels write square grids');
  refused(step, { ...stepRun(), out: { next: null }, rw: { moved: null } }, 'every writable target is null. Skip the run');
  refused(lookup, { ...lookupRun(), out: { out: null, extra: null } }, 'every writable target is null. Skip the run');
  for (const field of [small, wide, wideToo]) rig.release(field);
});

test('input sizes: the grid, 1 x 1, or any size for an input declared so', () => {
  const small = rig.field('field', 8, 0), constant = rig.field('field', 1, 0), strip = rig.field('field', [16, 4], 0);
  refused(step, { ...stepRun(), in: { h: small } }, 'input "h" is 8x8 but the run writes 16x16. Declare the input with size: "any" and read it with h_uv(uv), or resample it first');
  refused(step, { ...stepRun(), in: { h: strip } }, 'input "h" is 16x4 but the run writes 16x16. Declare the input with size: "any" and read it with h_uv(uv), or resample it first');
  refused(lookup, { ...lookupRun(), in: { src, coarse, mask: small } }, 'input "mask" is 8x8 but the run writes 16x16. Declare the input with size: "any" and read it with mask_uv(uv), or resample it first');
  accepted(step, { ...stepRun(), in: { h: constant } });
  accepted(lookup, { ...lookupRun(), in: { src, coarse, mask: constant } });
  // coarse is 5 x 3 and declared size: 'any'; the grid is the first target that is not null.
  accepted(lookup, lookupRun());
  const big = rig.field('half', 32);
  refused(lookup, { ...lookupRun(), out: { out: null, extra: big } }, 'input "src" is 16x16 but the run writes 32x32. Declare the input with size: "any" and read it with src_uv(uv), or resample it first');
  for (const field of [small, constant, strip, big]) rig.release(field);
});

test('params: exactly the declared names, each a value of its type', () => {
  const with_ = (params: Record<string, unknown>): Record<string, unknown> => ({ ...lookupRun(), params: { ...LOOKUP, ...params } });
  refused(step, { ...stepRun(), params: { ...STEP, strenght: 1 } }, 'unknown param "strenght"; the kernel declares talus, rate');
  refused(step, { ...stepRun(), params: { talus: 0.01 } }, 'missing param "rate"');
  refused(step, { in: { h }, out: { next }, rw: { moved } }, 'missing param "talus"');
  refused(bare, { out: { out: next }, params: { gain: 1 } }, 'unknown param "gain"; the kernel declares no params');
  refused(step, { ...stepRun(), params: { talus: NaN, rate: 0.1 } }, 'param "talus" is NaN');
  refused(step, { ...stepRun(), params: { talus: 1 / 0, rate: 0.1 } }, 'param "talus" (f32) is Infinity');
  refused(step, { ...stepRun(), params: { talus: 1e39, rate: 0.1 } }, 'param "talus" (f32) is 1e+39');
  refused(step, { ...stepRun(), params: { talus: true, rate: 0.1 } }, 'param "talus" (f32) is true');
  refused(step, { ...stepRun(), params: { talus: '0.5', rate: 0.1 } }, 'param "talus" (f32) is "0.5"');
  refused(step, { ...stepRun(), params: { talus: [0.5], rate: 0.1 } }, 'param "talus" (f32) is [0.5]');
  refused(step, { ...stepRun(), params: { talus: null, rate: 0.1 } }, 'param "talus" (f32) is null');

  refused(lookup, with_({ dir: [1, 0, 0] }), 'param "dir" needs 2 numbers, got 3');
  refused(lookup, with_({ dir: [1] }), 'param "dir" needs 2 numbers, got 1');
  refused(lookup, with_({ dir: 1 }), 'param "dir" needs 2 numbers, got a number');
  refused(lookup, with_({ tint: [0, 0, 0] }), 'param "tint" needs 4 numbers, got 3');
  refused(lookup, with_({ shift: [0, 0, 0, 0] }), 'param "shift" needs 3 numbers, got 4');
  refused(lookup, with_({ dir: [1, 0.5] }), 'param "dir" (vec2i) is [1, 0.5]');
  refused(lookup, with_({ dir: [1, NaN] }), 'param "dir" is NaN');
  refused(lookup, with_({ dir: [true, 0] }), 'param "dir" (vec2i) is [true, 0]');
  refused(lookup, with_({ dir: [2147483648, 0] }), 'param "dir" (vec2i) is [2147483648, 0]');
  refused(lookup, with_({ cells: [4, -1] }), 'param "cells" (vec2u) is [4, -1]');
  refused(lookup, with_({ scale: [1, Infinity] }), 'param "scale" (vec2f) is [1, Infinity]');
  refused(lookup, with_({ octaves: 2.5 }), 'param "octaves" (i32) is 2.5');
  refused(lookup, with_({ octaves: -2147483649 }), 'param "octaves" (i32) is -2147483649');
  refused(lookup, with_({ on: -1 }), 'param "on" (u32) is -1');
  refused(lookup, with_({ on: 4294967296 }), 'param "on" (u32) is 4294967296');

  accepted(lookup, with_({ octaves: -2147483648, on: 4294967295, dir: [-2147483648, 2147483647], cells: [0, 4294967295] }));
  accepted(lookup, with_({ octaves: true, on: false }));
  accepted(step, { ...stepRun(), params: { talus: -3.4e38, rate: 0 } });
});

test('luts: the declared type, made in this evaluation', () => {
  refused(lookup, { ...lookupRun(), luts: { ramp: curve, curve } }, 'lut "ramp" is declared vec4f but the Lut is f32');
  refused(lookup, { ...lookupRun(), luts: { ramp, curve: ramp } }, 'lut "curve" is declared f32 but the Lut is vec4f');
  refused(lookup, { ...lookupRun(), luts: { ramp: { type: 'vec4f', length: 2 }, curve } }, 'lut "ramp" was not created in this evaluation');
});

test('iteration and cost of a run', () => {
  for (const iteration of [-1, 4294967296, 1.5, NaN, true, '3']) {
    refused(bare, { out: { out: next }, iteration }, `iteration is ${typeof iteration === 'string' ? '"3"' : iteration}; it is an integer 0 .. 4294967295`);
  }
  for (const cost of [0, -8, NaN, Infinity]) refused(bare, { out: { out: next }, cost }, `cost is ${cost}; it is a positive number`);
});

test('a kernel must be compiled before it runs', () => {
  assert.throws(() => rig.runUntyped(uncompiled, { out: { out: next } }), /kernel "test\/uncompiled" is not compiled/);
});

test('everything this file accepted is valid on the device', async () => {
  // The accepted runs above were encoded; no error scope of the owner may have caught anything.
  await rig.owner.settle();
});
