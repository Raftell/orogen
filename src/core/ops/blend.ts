import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import type { Img } from './types.ts';

export function blend<K extends Img>(ctx: OpContext, a: Field<K>, b: Field<NoInfer<K>>, mask: Field<'field'> | number): Field<K> {
  throw new Error('not implemented: ops.blend');
}
