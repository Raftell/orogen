import type { OpContext } from '../eval/context.ts';
import type { LadderLevel } from './types.ts';

/** simulation.md section 2 defines level selection, the call sequence and the share of work per level. */
export function coarseToFine<S>(ctx: OpContext, opts: {
  coarsestCell: number;
  begin(level: LadderLevel): S;
  simulate(level: LadderLevel, state: S): Promise<void>;
  refine(coarse: LadderLevel, fine: LadderLevel, state: S): S;
}): Promise<S> {
  throw new Error('not implemented: ops.coarseToFine');
}
