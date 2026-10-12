// ops.blend (engine.md section 5): mix(a, b, saturate(mask)) per channel, with a field or a constant as the mask,
// on both kinds and at sizes other than the evaluation's.
//
// Sizes: fields of at most 65 x 65 texels with up to four floats each. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, ops, type Field } from '../../../src/core/api.ts';
import { assertClose, assertIdentical, grid, speckle, startOps, upload } from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

const saturate = (v: number): number => Math.min(Math.max(v, 0), 1);

test('blend with a mask field is a + (b - a) * saturate(mask) on every texel; 0 gives a and 1 gives b bit for bit', async () => {
  const n = 33;   // another size than the evaluation's 65
  const a = grid(n, n, (x, y) => 3 * speckle(x, y, 1) - 1);
  const b = grid(n, n, (x, y) => 1e3 * speckle(x, y, 2));
  // Masks from -0.5 to 1.5: a third of the texels are below 0 or above 1.
  const mask = grid(n, n, (x, y) => 2 * speckle(x, y, 3) - 0.5);
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const fa = upload(ctx, 'field', n, a), fb = upload(ctx, 'field', n, b), fm = upload(ctx, 'field', n, mask);
    const result = ops.blend(ctx, fa, fb, fm);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', n, n, false]);
    assert.ok(result.id !== fa.id && result.id !== fb.id, 'the result is a new field');
    out = await ctx.read(result);
  });
  assertClose(out!, (i) => a[i]! + (b[i]! - a[i]!) * saturate(mask[i]!), 1e-4, 'against the mix');   // values up to 1000
  let below = 0, above = 0;
  for (let i = 0; i < n * n; i++) {
    if (mask[i]! <= 0) {
      below++;
      assert.ok(Object.is(out![i], a[i]), `texel ${i}: mask ${mask[i]} gives ${out![i]}, a is ${a[i]}`);
    } else if (mask[i]! >= 1) {
      above++;
      assert.ok(Object.is(out![i], b[i]), `texel ${i}: mask ${mask[i]} gives ${out![i]}, b is ${b[i]}`);
    }
  }
  assert.ok(below > 100 && above > 100, `${below} texels at or below 0, ${above} at or above 1`);
});

test('blend with a constant: the same mask on every texel, saturated', async () => {
  const n = 65;
  const a = grid(n, n, (x, y) => speckle(x, y, 4));
  const b = grid(n, n, (x, y) => 5 + speckle(x, y, 5));
  const results = new Map<number, Float32Array>();
  await rig.run(async (ctx) => {
    const fa = upload(ctx, 'field', n, a), fb = upload(ctx, 'field', n, b);
    for (const mask of [0, 0.25, 1, -3, 7]) results.set(mask, await ctx.read(ops.blend(ctx, fa, fb, mask)));
    // A 1 x 1 field is a constant too.
    results.set(0.75, await ctx.read(ops.blend(ctx, fa, fb, ctx.alloc('field', { size: 1, clear: 0.75 }))));
  });
  assertIdentical(results.get(0)!, a, 'a constant 0');
  assertIdentical(results.get(-3)!, a, 'a constant below 0');
  assertIdentical(results.get(1)!, b, 'a constant 1');
  assertIdentical(results.get(7)!, b, 'a constant above 1');
  assertClose(results.get(0.25)!, (i) => 0.75 * a[i]! + 0.25 * b[i]!, 1e-6, 'a constant 0.25');
  assertClose(results.get(0.75)!, (i) => 0.25 * a[i]! + 0.75 * b[i]!, 1e-6, 'a 1 x 1 field of 0.75');
});

test('a color field is blended per channel, alpha included, by a field mask', async () => {
  const n = 33;
  // Multiples of 1/256: exact in the 16-bit floats of a color field.
  const q = (v: number): number => Math.floor(v * 256) / 256;
  const a = grid(n, n, (x, y) => [0, 1, 2, 3].map((c) => q(speckle(x, y, c))));
  const b = grid(n, n, (x, y) => [0, 1, 2, 3].map((c) => q(speckle(x, y, c + 10))));
  const mask = grid(n, n, (x, y) => (x < 8 ? 0 : x > 24 ? 1 : 2 * speckle(x, y, 7) - 0.5));
  let out: Float32Array | null = null, half: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const fa = upload(ctx, 'color', n, a), fb = upload(ctx, 'color', n, b);
    const result = ops.blend(ctx, fa, fb, upload(ctx, 'field', n, mask));
    assert.equal(result.kind, 'color');
    out = await ctx.read(result);
    half = await ctx.read(ops.blend(ctx, fa, fb, 0.5));
  });
  assertClose(out!, (i) => a[i]! + (b[i]! - a[i]!) * saturate(mask[i >> 2]!), 1 / 1024, 'against the mix');
  assertClose(half!, (i) => 0.5 * (a[i]! + b[i]!), 1 / 1024, 'a constant 0.5');
  // The columns the mask leaves alone hold a, and the columns it covers hold b, in all four channels.
  for (let y = 0; y < n; y++) {
    for (let c = 0; c < 4; c++) {
      assert.equal(out![(y * n + 3) * 4 + c], a[(y * n + 3) * 4 + c]);
      assert.equal(out![(y * n + 30) * 4 + c], b[(y * n + 30) * 4 + c]);
    }
  }
});

test('blend leaves its inputs unchanged and takes an input of the node; it is a synchronous op', async () => {
  let before: Float32Array | null = null, after_: Float32Array | null = null, out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    before = await ctx.read(input);
    let current = ctx.alloc('field', { clear: 1 });
    // Three steps of a quarter of the way from the current field to the input.
    await ctx.loop(3, () => {
      const next = ops.blend(ctx, current, input, 0.25);
      ctx.release(current);
      current = next;
    });
    out = await ctx.read(current);
    after_ = await ctx.read(input);
  }, { sources: { ramp: { type: 'ref/ramp', params: { gainX: 1, gainY: 0, base: 0 } } }, inputs: { in: 'ramp.out' } });
  assertIdentical(after_!, before!, 'the input after the op');
  assertClose(out!, (i) => before![i]! + (1 - before![i]!) * 0.75 ** 3, 1e-6, 'three blends of a quarter');
});

test('what blend refuses: two kinds, two sizes, a mask of another size or kind, a mask that is no number', async () => {
  await rig.run((ctx) => {
    const a = ctx.alloc('field', { size: 9, clear: 0 });
    const b = ctx.alloc('field', { size: 9, clear: 0 });
    const color = ctx.alloc('color', { size: 9, clear: 0 });
    const large = ctx.alloc('field', { size: 17, clear: 0 });
    assert.throws(() => ops.blend(ctx, a, color as unknown as Field<'field'>, 0.5), (e: Error) => e instanceof FieldAccessError && /is "field" but field #\d+ is "color"/.test(e.message));
    assert.throws(() => ops.blend(ctx, a, large, 0.5), (e: Error) => e instanceof FieldAccessError && /a is field #\d+, which is 9x9, but b is field #\d+, which is 17x17/.test(e.message));
    assert.throws(() => ops.blend(ctx, a, b, large), (e: Error) => e instanceof FieldAccessError && /but the mask is field #\d+, which is 17x17/.test(e.message));
    assert.throws(() => ops.blend(ctx, a, b, color as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /the mask is field #\d+ of kind "color"; it needs 1 channel/.test(e.message));
    assert.throws(() => ops.blend(ctx, a, b, Number.NaN), (e: Error) => e instanceof TypeError && /the mask is NaN/.test(e.message));
    const pair = ctx.alloc('vec2', { size: 9, clear: 0 });
    assert.throws(() => ops.blend(ctx, pair as unknown as Field<'field'>, pair as unknown as Field<'field'>, 0.5), (e: Error) => e instanceof FieldAccessError && /of kind "vec2"; it must be a "field" or a "color"/.test(e.message));
    const wide = ctx.alloc('field', { size: [9, 5], clear: 0 });
    assert.throws(() => ops.blend(ctx, wide, wide, 0.5), (e: Error) => e instanceof FieldAccessError && /which is 9x5/.test(e.message));
  });
});
