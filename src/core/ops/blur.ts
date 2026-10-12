import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import type { Img } from './types.ts';

export function blur<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number): Field<K> {
  throw new Error('not implemented: ops.blur');
}
