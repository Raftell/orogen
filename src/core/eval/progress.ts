import type { EvalPlan } from './plan.ts';

/** The last measured duration of a node's evaluate(), as Engine.lastTiming returns it. */
export interface NodeTiming { readonly resolution: number; readonly wallMs: number }

/** `elapsed × (1 − f) / f` once `f >= 0.05` and `elapsed >= minElapsedMs`; else null (runtime.md 5.10, Estimates). */
export function etaMs(elapsedMs: number, fraction: number, minElapsedMs: number): number | null {
  if (!(fraction >= 0.05) || !(elapsedMs >= minElapsedMs)) return null;
  return elapsedMs * (1 - Math.min(fraction, 1)) / Math.min(fraction, 1);
}

/**
 * A node's weight in an evaluation at `resolution`, for every node of the plan: 0 for a node in `settled`
 * (cached, bypassed or blocked), else the last timing scaled by texel count, else the median of the weights
 * that have one, else 1.
 */
export function nodeWeights(
  plan: EvalPlan, settled: ReadonlySet<string>, resolution: number, lastTiming: (nodeId: string) => NodeTiming | null,
): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  const timed: number[] = [];
  const untimed: string[] = [];
  for (const { nodeId } of plan.nodes) {
    if (settled.has(nodeId)) {
      weights.set(nodeId, 0);
      continue;
    }
    const timing = lastTiming(nodeId);
    if (timing && timing.resolution > 0) {
      const weight = timing.wallMs * (resolution / timing.resolution) ** 2;
      weights.set(nodeId, weight);
      timed.push(weight);
    } else {
      untimed.push(nodeId);
    }
  }
  let fallback = 1;
  if (timed.length > 0) {
    timed.sort((a, b) => a - b);
    const mid = timed.length >> 1;
    fallback = timed.length % 2 === 1 ? timed[mid]! : (timed[mid - 1]! + timed[mid]!) / 2;
  }
  for (const nodeId of untimed) weights.set(nodeId, fallback);
  return weights;
}
