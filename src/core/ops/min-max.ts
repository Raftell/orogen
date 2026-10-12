import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import { minMaxFirstKernel, minMaxNextKernel, MINMAX_BLOCK, requireChannels } from './kernels.ts';

export function minMax(ctx: OpContext, src: Field<'field'>): Field<'vec2'> {
  requireChannels('ops.minMax', 'the source', src, 1);
  // Each pass reduces blocks of 8 x 8 texels to one (min, max): 8192 texels a side are 1 x 1 after five passes.
  let side = Math.ceil(Math.max(src.width, src.height) / MINMAX_BLOCK);
  let current = ctx.alloc('vec2', { size: side });
  ctx.run(minMaxFirstKernel, { in: { src }, out: { out: current }, params: { last: side === 1 } });
  while (side > 1) {
    side = Math.ceil(side / MINMAX_BLOCK);
    const next = ctx.alloc('vec2', { size: side });
    ctx.run(minMaxNextKernel, { in: { src: current }, out: { out: next }, params: { last: side === 1 } });
    ctx.release(current);
    current = next;
  }
  return current;
}
