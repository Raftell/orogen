import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import { requireChannels, requireSquare, slopeKernel } from './kernels.ts';

export function slope(ctx: OpContext, height: Field<'field'>): Field<'field'> {
  requireChannels('ops.slope', 'the height', height, 1);
  requireSquare('ops.slope', 'the height', height);
  const out = ctx.alloc('field', { like: height });
  ctx.run(slopeKernel, { in: { height }, out: { out } });
  return out;
}
