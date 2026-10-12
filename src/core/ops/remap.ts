import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import { FieldAccessError } from '../gpu/errors.ts';
import type { Field } from '../gpu/field.ts';
import { remapKernel, requireChannels, requireSquare } from './kernels.ts';

function pair(what: string, value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw byContext(new TypeError(`ops.remap: "${what}" is two finite numbers`));
  }
  return [value[0], value[1]];
}

export function remap(ctx: OpContext, src: Field<'field'>, opts: {
  from: readonly [number, number] | Field<'vec2'>;
  to?: readonly [number, number];
  clamp?: boolean;
}): Field<'field'> {
  requireChannels('ops.remap', 'the source', src, 1);
  requireSquare('ops.remap', 'the source', src);
  const to = pair('to', opts.to ?? [0, 1]);
  const limit = opts.clamp === true;
  const from = opts.from;
  if (Array.isArray(from)) {
    const span = pair('from', from);
    const out = ctx.alloc('field', { like: src });
    ctx.run(remapKernel, { in: { src, range: null }, out: { out }, params: { span, to, limit } });
    return out;
  }
  const range = from as Field<'vec2'>;
  if (range === null || typeof range !== 'object' || typeof range.kind !== 'string') {
    throw byContext(new TypeError('ops.remap: "from" is two finite numbers or the result of ops.minMax'));
  }
  requireChannels('ops.remap', '"from"', range, 2);
  if (range.width !== 1 || range.height !== 1) {
    throw new FieldAccessError(`ops.remap: "from" is field #${range.id}, which is ${range.width}x${range.height}; a range is a pair of numbers or the 1x1 result of ops.minMax`);
  }
  const out = ctx.alloc('field', { like: src });
  ctx.run(remapKernel, { in: { src, range }, out: { out }, params: { span: [0, 1], to, limit } });
  return out;
}
