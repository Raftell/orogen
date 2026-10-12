import type { EvalPlan } from './plan.ts';

/** The last measured duration of a node's evaluate(), as Engine.lastTiming returns it. */
export interface NodeTiming { readonly resolution: number; readonly wallMs: number }

/** `elapsed × (1 − f) / f` once `f >= 0.05` and `elapsed >= minElapsedMs`; else null (runtime.md 5.10, Estimates). */
export function etaMs(elapsedMs: number, fraction: number, minElapsedMs: number): number | null {
  throw new Error('not implemented: etaMs');
}

/**
 * A node's weight in an evaluation at `resolution`, for every node of the plan: 0 for a node in `settled`
 * (cached, bypassed or blocked), else the last timing scaled by texel count, else the median of the weights
 * that have one, else 1.
 */
export function nodeWeights(
  plan: EvalPlan, settled: ReadonlySet<string>, resolution: number, lastTiming: (nodeId: string) => NodeTiming | null,
): ReadonlyMap<string, number> {
  throw new Error('not implemented: nodeWeights');
}
