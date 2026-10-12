import type { OpContext } from '../eval/context.ts';
import type { Field } from '../gpu/field.ts';
import type { Img, ResampleFilter } from './types.ts';

export function resample<K extends Img>(ctx: OpContext, src: Field<K>, opts: { size: number; filter?: ResampleFilter }): Field<K> {
  throw new Error('not implemented: ops.resample');
}
