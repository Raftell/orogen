import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';

export function minMax(ctx: OpContext, src: Field<'field'>): Field<'vec2'> {
  throw new Error('not implemented: ops.minMax');
}
