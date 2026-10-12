// ops.copy (engine.md section 5): every kind, any square size, call order, and what it refuses.
//
// Sizes: fields of at most 65 x 65 texels with up to four floats each; no list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, KernelBindingError, ops, type Field, type FieldKind } from '../../../src/core/api.ts';
import { assertIdentical, grid, speckle, startOps, upload } from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

const CHANNELS: Readonly<Record<FieldKind, number>> = { field: 1, vec2: 2, color: 4, aux: 4, half: 1, half2: 2, mask8: 1 };

test('a copy holds the source bit for bit, for every kind and at a size other than the evaluation resolution', async () => {
  const size = 33;
  for (const kind of Object.keys(CHANNELS) as FieldKind[]) {
    const count = CHANNELS[kind];
    // Multiples of 1/255 below 1: every format a kind resolves to holds them as its own nearest value.
    const data = grid(size, size, (x, y) => Array.from({ length: count }, (_, c) => Math.floor(speckle(x, y, c + 1) * 256) / 255));
    let source: Float32Array | null = null, copied: Float32Array | null = null;
    await rig.run(async (ctx) => {
      assert.equal(ctx.res, 65);
      const src = upload(ctx, kind, size, data);
      const dst = ctx.alloc(kind, { size, clear: 0.5 });
      ops.copy(ctx, src, dst);
      source = await ctx.read(src);
      copied = await ctx.read(dst);
      assert.equal(dst.readOnly, false);
    });
    assert.equal(copied!.length, size * size * count, kind);
    assertIdentical(copied!, source!, `the copy of a ${kind}`);
    // What was uploaded is what the copy holds, to the precision of the kind's format.
    const worst = copied!.reduce((w, v, i) => Math.max(w, Math.abs(v - data[i]!)), 0);
    assert.ok(worst <= 1 / 2048, `${kind}: the copy differs from the uploaded data by ${worst}`);
  }
});

test('a copy takes effect in call order: a later change of the source does not reach it, and an input is a valid source', async () => {
  let first: Float32Array | null = null, second: Float32Array | null = null, fromInput: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    assert.equal(input.readOnly, true);
    const src = ctx.alloc('field', { clear: 1 });
    const dst = ctx.alloc('field', { clear: 9 });
    ops.copy(ctx, src, dst);
    ctx.clear(src, 2);
    const later = ctx.alloc('field');
    ops.copy(ctx, src, later);
    const copyOfInput = ctx.alloc('field');
    ops.copy(ctx, input, copyOfInput);
    first = await ctx.read(dst);
    second = await ctx.read(later);
    fromInput = await ctx.read(copyOfInput);
  }, { sources: { level: { type: 'ref/constant', params: { value: 0.25 } } }, inputs: { in: 'level.out' } });
  assert.ok(first!.every((v) => v === 1), 'the copy made before the clear holds 1');
  assert.ok(second!.every((v) => v === 2), 'the copy made after the clear holds 2');
  assert.ok(fromInput!.every((v) => v === 0.25), 'the copy of the input holds the input');
});

test('a copy is a synchronous op: inside a ctx.loop body it moves a field along a chain', async () => {
  let end: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const chain = [0, 1, 2, 3].map((i) => ctx.alloc('field', { size: 17, clear: i }));
    // Each iteration copies link i + 1 into link i: after three, link 0 holds what link 3 held.
    await ctx.loop(3, () => {
      for (let i = 0; i < 3; i++) ops.copy(ctx, chain[i + 1]!, chain[i]!);
    });
    end = await ctx.read(chain[0]!);
  });
  assert.ok(end!.every((v) => v === 3));
});

test('what a copy refuses: two kinds, two sizes, a read-only destination, one field twice, a field that is not square', async () => {
  await rig.run((ctx) => {
    const field = ctx.alloc('field', { size: 9, clear: 0 });
    const other = ctx.alloc('field', { size: 9, clear: 0 });
    const color = ctx.alloc('color', { size: 9, clear: 0 });
    const large = ctx.alloc('field', { size: 17, clear: 0 });
    const wide = ctx.alloc('field', { size: [9, 5], clear: 0 });
    const wideToo = ctx.alloc('field', { size: [9, 5], clear: 0 });

    assert.throws(() => ops.copy(ctx, field, color as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /is "field" but field #\d+ is "color"/.test(e.message));
    assert.throws(() => ops.copy(ctx, field, large), (e: Error) => e instanceof FieldAccessError && /9x9, but the destination is field #\d+, which is 17x17/.test(e.message));
    assert.throws(() => ops.copy(ctx, field, field), (e: Error) => e instanceof FieldAccessError && /both the source and the destination/.test(e.message));
    assert.throws(() => ops.copy(ctx, wide, wideToo), (e: Error) => e instanceof FieldAccessError && /is 9x5; only square fields are written/.test(e.message));
    assert.throws(() => ops.copy(ctx, field, null as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /the destination is not a field/.test(e.message));

    const input = ctx.input('in') as Field<'field'>;
    const same = ctx.alloc('field', { clear: 0 });
    assert.throws(() => ops.copy(ctx, same, input), (e: Error) => e instanceof FieldAccessError && /is read-only .*Use ctx\.clone\(\)/.test(e.message));

    ctx.release(other);
    assert.throws(() => ops.copy(ctx, other, field), (e: Error) => e instanceof KernelBindingError && /was released/.test(e.message));
  }, { sources: { level: { type: 'ref/constant', params: { value: 0.25 } } }, inputs: { in: 'level.out' } });
});

test('a refused copy fails the node as a binding error', async () => {
  const error = await rig.fail((ctx) => {
    ops.copy(ctx, ctx.alloc('field', { size: 9 }), ctx.alloc('field', { size: 17 }));
  });
  assert.equal(error.kind, 'binding');
  assert.match(error.message, /^ops\.copy: the source is field #\d+, which is 9x9/);
});
