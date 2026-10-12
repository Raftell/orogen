import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import { normalKernel, requireChannels, requireSquare } from './kernels.ts';

export function normal(ctx: OpContext, height: Field<'field'>): Field<'color'> {
  requireChannels('ops.normal', 'the height', height, 1);
  requireSquare('ops.normal', 'the height', height);
  const out = ctx.alloc('color', { like: height });
  ctx.run(normalKernel, { in: { height }, out: { out } });
  return out;
}
