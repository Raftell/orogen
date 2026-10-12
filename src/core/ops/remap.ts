import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';

export function remap(ctx: OpContext, src: Field<'field'>, opts: {
  from: readonly [number, number] | Field<'vec2'>;
  to?: readonly [number, number];
  clamp?: boolean;
}): Field<'field'> {
  throw new Error('not implemented: ops.remap');
}
