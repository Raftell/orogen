import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';

export function normal(ctx: OpContext, height: Field<'field'>): Field<'color'> {
  throw new Error('not implemented: ops.normal');
}
