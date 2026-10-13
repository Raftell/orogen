// The status a node shows: what the engine last reported of it (engineStore, runtime.md 8.5) together with
// what the document says without the engine. The engine sends no event for a node outside the plan it
// evaluates (5.3), so a missing input, a bypass and an unknown type are read off the document. Pure.

import type { NodeRuntime } from '../../state/engine-store.ts';
import type { NodeView } from './flow.ts';

export type NodeStatusState = 'idle' | 'waiting' | 'running' | 'done' | 'cached' | 'skipped' | 'bypassed' | 'missing' | 'error';

export interface NodeStatus {
  readonly state: NodeStatusState;
  /** The status line of the node: one short sentence, or '' for nothing to say. */
  readonly text: string;
  /** What the pointer shows on the status beyond the line itself; null when the line says it all. */
  readonly detail: string | null;
  /** 0 .. 1 while running; else null. */
  readonly fraction: number | null;
  /**
   * The node itself is at fault: it failed, its type is unknown, it lies on a cycle. Drawn as an error. A node
   * that only waits for a wire, or for a node before it that failed, is not: it says so in its status line.
   */
  readonly failed: boolean;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1) return '< 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export const CYCLE_TEXT = 'Part of a cycle';

const plain = (state: NodeStatusState, text: string, detail: string | null = null): NodeStatus => ({ state, text, detail, fraction: null, failed: false });
const failure = (state: NodeStatusState, text: string, detail: string | null = null): NodeStatus => ({ state, text, detail, fraction: null, failed: true });

/**
 * `runtime` is the engine's record of the node, `current` whether that record is of the evaluation that runs
 * now, and `upstreamTitle` the title of the failed node a skipped node waits for.
 */
export function nodeStatus(view: NodeView, runtime: NodeRuntime | undefined, current: boolean, upstreamTitle: string | null = null): NodeStatus {
  if (!view.known) return failure('error', `Unknown node type "${view.type}"`);
  // The engine says this of a node only once it is asked for the node (5.8); the wires say it at once, in the engine's words.
  if (view.cycle) return failure('error', CYCLE_TEXT, 'The wires lead from this node back into it, so it can never be computed');
  if (view.bypassed) return plain('bypassed', 'Bypassed');
  // The document knows of a missing input at once and for every node; the engine's own report of it may be of
  // an evaluation before the input was connected.
  // Not an error of the node: every node is in this state between being added and being wired.
  if (view.missing.length > 0) return plain('missing', `Missing input: ${view.missing.join(', ')}`);
  if (!runtime) return plain('idle', '');
  switch (runtime.state) {
    case 'error': {
      const error = runtime.error;
      if (error?.kind === 'missing-input') return plain('idle', '');
      // The one sentence of the error (5.8). Its detail, a stack or the GPU's whole message, is for the list of
      // errors and the inspector: on a node it would cover the graph.
      return failure('error', error?.message ?? 'Failed');
    }
    case 'running': {
      const fraction = Math.min(1, Math.max(0, runtime.fraction));
      const what = runtime.label ?? 'Computing';
      const eta = runtime.etaMs !== null && runtime.etaMs >= 1000 ? `, ${formatDuration(runtime.etaMs)} left` : '';
      return { state: 'running', text: `${what} ${Math.round(fraction * 100)}%${eta}`, detail: null, fraction, failed: false };
    }
    case 'skipped':
      return plain('skipped', upstreamTitle ? `Skipped: ${upstreamTitle} failed` : 'Skipped: an input failed');
    case 'done':
      if (runtime.cached) return plain('cached', 'Cached', runtime.wallMs !== null ? `Cached; computed in ${formatDuration(runtime.wallMs)}` : null);
      return plain('done', runtime.wallMs !== null ? formatDuration(runtime.wallMs) : 'Done');
    default:
      return current ? plain('waiting', 'Waiting') : plain('idle', '');
  }
}
