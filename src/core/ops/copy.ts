import type { OpContext } from '../eval/context.ts';
import type { Field, FieldKind } from '../gpu/field.ts';

export function copy<K extends FieldKind>(ctx: OpContext, src: Field<K>, dst: Field<NoInfer<K>>): void {
  throw new Error('not implemented: ops.copy');
}
