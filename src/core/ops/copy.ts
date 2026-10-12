import type { OpContext } from '../eval/context.ts';
import { FieldAccessError } from '../gpu/errors.ts';
import type { Field, FieldKind } from '../gpu/field.ts';
import { copyKernels, requireField, requireSameSize } from './kernels.ts';

export function copy<K extends FieldKind>(ctx: OpContext, src: Field<K>, dst: Field<NoInfer<K>>): void {
  requireField('ops.copy', 'the source', src);
  requireField('ops.copy', 'the destination', dst);
  if (src.kind !== dst.kind) {
    throw new FieldAccessError(`ops.copy: field #${src.id} is "${src.kind}" but field #${dst.id} is "${dst.kind}"; a copy is between two fields of one kind`);
  }
  if ((src as Field) === dst) throw new FieldAccessError(`ops.copy: field #${src.id} is both the source and the destination`);
  requireSameSize('ops.copy', 'the source', src, 'the destination', dst);
  if (dst.readOnly) {
    throw new FieldAccessError(`ops.copy: field #${dst.id} is read-only (a node input, or already passed to ctx.output()). Use ctx.clone()`);
  }
  // A field that is not square holds uploaded data and is never written by a kernel (engine.md 1.1).
  if (dst.width !== dst.height) {
    throw new FieldAccessError(`ops.copy: field #${dst.id} is ${dst.width}x${dst.height}; only square fields are written. ctx.clone() copies a field of any shape`);
  }
  ctx.run(copyKernels[dst.kind], { in: { src }, out: { out: dst } });
}
