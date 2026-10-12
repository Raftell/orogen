// The arithmetic of runtime.md 3.3 and 3.4, apart from the stream so that every rule can be tested without a GPU.

import { HARD_CEILING_MS, RATE_CAP_FACTOR, RATE_FLOOR_FACTOR, RATE_INITIAL } from './tuning.ts';

/**
 * The rate of a kernel after work of it estimated at `estimateMs` measured `measuredMs` (3.3 rules 2, 3, 6 and 7).
 * `mayRaise` is false for a wall time that is only an upper bound of the duration (3.5 rule 2).
 * `ceilingMs` is the hard ceiling of the slice's owner (5.9 rule 6 halves it). `over` says whether the slice
 * exceeded it, where the two durations are a kernel's share of a slice and not the slice.
 */
export function nextRate(
  rate: number, estimateMs: number, measuredMs: number, mayRaise: boolean, ceilingMs: number = HARD_CEILING_MS,
  over: boolean = measuredMs > ceilingMs,
): number {
  if (!(estimateMs > 0) || !(measuredMs >= 0)) return rate;
  let factor = Math.max(0.5, measuredMs / estimateMs);
  if (!over) factor = Math.min(2, factor);
  if (!mayRaise) factor = Math.min(1, factor);
  let next = rate * factor;
  // Rule 6: only a slice above the hard ceiling takes a rate past the cap; a rate already past it may only fall.
  if (!over) next = Math.min(next, Math.max(rate, RATE_INITIAL * RATE_CAP_FACTOR));
  return Math.max(next, RATE_INITIAL * RATE_FLOOR_FACTOR);
}

/**
 * Rows of one tile of a run (3.4): a whole number of workgroup rows, because a dispatch runs whole workgroups
 * and a row shared by two tiles would be written twice. `maxTileRows` is the test hook of 5.14.
 */
export function rowsPerTile(
  targetMs: number, width: number, height: number, cost: number, rate: number, workgroupY: number, maxTileRows?: number,
): number {
  const rowMs = width * cost * rate;
  let rows = Math.floor(targetMs / rowMs / workgroupY) * workgroupY;
  if (maxTileRows !== undefined) rows = Math.min(rows, Math.floor(maxTileRows / workgroupY) * workgroupY);
  // Not Math.max(rows, workgroupY) alone: a NaN from a zero or infinite operand must not reach the tile loop.
  if (!(rows >= workgroupY)) rows = workgroupY;
  return Math.max(1, Math.min(rows, height));
}
