import type { OpContext } from '../eval/context.ts';
import { byContext, ContextError } from '../eval/errors.ts';
import type { LadderLevel } from './types.ts';

const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

/**
 * The levels of a run, coarsest first (simulation.md 2.1 and 2.3): from the coarsest level of `ctx.ladder` whose
 * cell is at most `coarsestCell` up to `ctx.res`, each with its share of the node's progress by texel count.
 */
function levelsOf(ctx: OpContext, coarsestCell: number): LadderLevel[] {
  const ladder = ctx.ladder;
  let base = 0;
  for (let j = 0; j < ladder.length; j++) {
    if (1 / (ladder[j]! - 1) <= coarsestCell) base = j;
  }
  const sizes: number[] = [];
  for (let j = base; j >= 0; j--) sizes.push(ladder[j]!);
  const total = sizes.reduce((sum, res) => sum + res * res, 0);
  const levels: LadderLevel[] = [];
  let done = 0;
  sizes.forEach((res, index) => {
    const from = done / total;
    done += res * res;
    levels.push(Object.freeze({
      res,
      cellSize: ctx.terrainSize / Math.max(res - 1, 1),
      index,
      count: sizes.length,
      progress: Object.freeze([from, index === sizes.length - 1 ? 1 : done / total] as const),
    }));
  });
  return levels;
}

/** simulation.md section 2 defines level selection, the call sequence and the share of work per level. */
export function coarseToFine<S>(ctx: OpContext, opts: {
  coarsestCell: number;
  begin(level: LadderLevel): S;
  simulate(level: LadderLevel, state: S): Promise<void>;
  refine(coarse: LadderLevel, fine: LadderLevel, state: S): S;
}): Promise<S> {
  const coarsestCell = opts?.coarsestCell;
  if (typeof coarsestCell !== 'number' || !Number.isFinite(coarsestCell) || !(coarsestCell > 0)) {
    throw byContext(new RangeError(`ops.coarseToFine: coarsestCell is ${String(coarsestCell)}; it is a length above 0`));
  }
  const { begin, simulate, refine } = opts;
  if (typeof begin !== 'function' || typeof simulate !== 'function' || typeof refine !== 'function') {
    throw byContext(new TypeError('ops.coarseToFine: begin, simulate and refine are functions'));
  }
  const levels = levelsOf(ctx, coarsestCell);
  // The start of the first level. Inside a ctx.loop body the context refuses this call, as it would the loops of
  // simulate: the driver then fails here, where the node made the mistake, and not in a promise nobody awaits.
  try {
    ctx.progress(levels[0]!.progress[0]);
  } catch (thrown) {
    throw thrown instanceof ContextError ? new ContextError(`ops.coarseToFine: ${thrown.message}`) : thrown;
  }
  const check = (): void => {
    if (ctx.signal.aborted) throw ctx.signal.reason;
  };
  /** begin and refine are synchronous: a state that is a promise is one whose work the driver would not wait for. */
  const synchronous = (state: S, callback: string): S => {
    if (isThenable(state)) {
      (state as unknown as PromiseLike<unknown>).then(undefined, () => undefined);
      throw byContext(new TypeError(`ops.coarseToFine: ${callback} returned a promise; begin and refine are synchronous`));
    }
    return state;
  };

  const run = (async (): Promise<S> => {
    check();
    let state = synchronous(begin(levels[0]!), 'begin');
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      check();
      await simulate(level, state);
      check();
      // A level without iterations has reported nothing through ctx.loop.
      ctx.progress(level.progress[1]);
      if (i < levels.length - 1) state = synchronous(refine(level, levels[i + 1]!, state), 'refine');
    }
    return state;
  })();
  // A node that does not await the driver must not end the process when it rejects; whoever awaits it still sees the rejection.
  run.catch(() => undefined);
  return run;
}
