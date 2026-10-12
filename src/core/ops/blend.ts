import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import { FieldAccessError } from '../gpu/errors.ts';
import type { Field } from '../gpu/field.ts';
import { blendKernels, requireChannels, requireImage, requireSameSize, requireSquare } from './kernels.ts';
import type { Img } from './types.ts';

export function blend<K extends Img>(ctx: OpContext, a: Field<K>, b: Field<NoInfer<K>>, mask: Field<'field'> | number): Field<K> {
  requireImage('ops.blend', 'a', a);
  requireImage('ops.blend', 'b', b);
  if (a.kind !== b.kind) {
    throw new FieldAccessError(`ops.blend: field #${a.id} is "${a.kind}" but field #${b.id} is "${b.kind}"; a blend is between two fields of one kind`);
  }
  requireSquare('ops.blend', 'a', a);
  requireSameSize('ops.blend', 'a', a, 'b', b);
  const kernel = blendKernels[a.kind];
  if (typeof mask === 'number') {
    if (!Number.isFinite(mask)) throw byContext(new TypeError(`ops.blend: the mask is ${mask}; it is a field or a finite number`));
    const out = ctx.alloc(a.kind, { like: a });
    ctx.run(kernel, { in: { a, b, mask: null }, out: { out }, params: { amount: Math.min(Math.max(mask, 0), 1) } });
    return out;
  }
  requireChannels('ops.blend', 'the mask', mask, 1);
  if (mask.width !== 1 || mask.height !== 1) requireSameSize('ops.blend', 'a', a, 'the mask', mask);
  const out = ctx.alloc(a.kind, { like: a });
  ctx.run(kernel, { in: { a, b, mask }, out: { out }, params: { amount: 1 } });
  return out;
}
