// engine.md section 5: all operations but coarseToFine are synchronous and may be called inside a ctx.loop body.
// Every one of them is called there, and gives what it gives outside a loop.
//
// Sizes: fields of 65 x 65 texels. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { ops, type EvalContext, type Field } from '../../../src/core/api.ts';
import { assertIdentical, hills, sampled, startOps, upload } from './rig.ts';

// Every iteration is a batch boundary: what the body allocates and releases crosses submissions.
const rig = await startOps({ hooks: { sliceTargetMs: 1e-6 } });
after(() => rig.dispose());

/** Every synchronous op once, each on the result of the one before where the kinds allow. The fields the caller reads. */
function chain(ctx: EvalContext, src: Field<'field'>): { height: Field<'field'>; normal: Field<'color'>; range: Field<'vec2'> } {
  const small = ops.resample(ctx, src, { size: 33 });
  const back = ops.resample(ctx, small, { size: 65, filter: 'bspline' });
  ctx.release(small);
  const soft = ops.blur(ctx, back, 0.03);
  const mixed = ops.blend(ctx, src, soft, 0.5);
  ctx.release(back);
  ctx.release(soft);
  const slope = ops.slope(ctx, mixed);
  const range = ops.minMax(ctx, slope);
  const mask = ops.remap(ctx, slope, { from: range, clamp: true });
  ctx.release(slope);
  const masked = ops.blend(ctx, src, mixed, mask);
  ctx.release(mask);
  const height = ctx.alloc('field', { like: masked });
  ops.copy(ctx, masked, height);
  ctx.release(masked);
  const normal = ops.normal(ctx, height);
  ctx.release(mixed);
  return { height, normal, range };
}

test('every synchronous op inside a ctx.loop body gives what it gives outside', async () => {
  const data = sampled(65, hills);
  const read: Record<string, Float32Array> = {};
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', 65, data);
    const outside = chain(ctx, src);
    read.height = await ctx.read(outside.height);
    read.normal = await ctx.read(outside.normal);
    read.range = await ctx.read(outside.range);

    const inside: ReturnType<typeof chain>[] = [];
    await ctx.loop(3, () => {
      inside.push(chain(ctx, src));
    });
    assert.equal(inside.length, 3);
    for (const [i, result] of inside.entries()) {
      read[`height${i}`] = await ctx.read(result.height);
      read[`normal${i}`] = await ctx.read(result.normal);
      read[`range${i}`] = await ctx.read(result.range);
    }
  });
  assert.equal(read.height!.length, 65 * 65);
  assert.ok(read.range![1]! > read.range![0]! && read.range![0]! >= 0, `the slopes span ${[...read.range!]}`);
  for (let i = 0; i < 3; i++) {
    assertIdentical(read[`height${i}`]!, read.height!, `the heights of iteration ${i}`);
    assertIdentical(read[`normal${i}`]!, read.normal!, `the normals of iteration ${i}`);
    assertIdentical(read[`range${i}`]!, read.range!, `the range of iteration ${i}`);
  }
});
