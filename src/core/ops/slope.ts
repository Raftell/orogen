import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';

export function slope(ctx: OpContext, height: Field<'field'>): Field<'field'> {
  throw new Error('not implemented: ops.slope');
}
