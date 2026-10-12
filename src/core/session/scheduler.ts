import type { EvalTarget } from '../eval/evaluator.ts';
import type { GraphDoc, ViewBinding } from '../graph/doc.ts';
import type { NodeRegistry } from '../graph/registry.ts';

// The policy of runtime.md 7.3 and 7.4 as pure functions and one small state machine. It makes no evaluation
// and holds no handle: session.ts does both.

export type RequestPurpose = 'view' | 'draft' | 'thumbnails';

/** What the scheduler asks the session to evaluate next. All three purposes use mode 'preview'. */
export interface ScheduledRequest {
  readonly purpose: RequestPurpose;
  readonly doc: GraphDoc;
  readonly revision: number;
  readonly resolution: number;
  readonly targets: readonly EvalTarget[];
  readonly cache: 'keep' | 'transient';
  readonly outputs: 'all' | 'needed';
  /** The view the targets were made from; undefined for thumbnails. */
  readonly view?: ViewBinding;
}

/**
 * 7.4 rule 1: `{ ref: view.height, as: 'field' }` and, with an overlay, its target; a reference to a node or
 * port that does not exist is left out. Empty without a view.
 */
export function viewTargets(doc: GraphDoc, registry: NodeRegistry): EvalTarget[] {
  throw new Error('not implemented: viewTargets');
}

/** 7.3 rule 9: the coarsest ladder level of buildResolution that is at least 128, or level 0 when none is. */
export function thumbnailResolution(buildResolution: number): number {
  throw new Error('not implemented: thumbnailResolution');
}

/** 7.3 rule 4: the resolution of a draft `d` levels (1 or 2) below the preview level; the coarsest defined level when the ladder has no such level. */
export function draftResolution(doc: GraphDoc, d: 1 | 2): number {
  throw new Error('not implemented: draftResolution');
}

/** 7.3 rule 4: the `d` of the next draft after one at `d` that took `tookMs`. */
export function nextDraftLevel(d: 1 | 2, tookMs: number): 1 | 2 {
  throw new Error('not implemented: nextDraftLevel');
}

/**
 * Latest wins (7.3 rules 1 to 5): at most one running and one pending request. The session reports what
 * happens; the scheduler answers with what to start and what to abort.
 */
export interface Scheduler {
  /** The current document. Schedules a full request, or a draft during a gesture. */
  setDocument(doc: GraphDoc, revision: number): void;
  beginGesture(): void;
  endGesture(): void;
  setPaused(paused: boolean): void;
  /** A build has started (true) or ended (false). */
  setBuilding(building: boolean): void;
  /** The node ids whose thumbnails the graph shows, and those among them that are stale. */
  setThumbnails(stale: readonly string[]): void;
  /** A cause of a full request that is not a document change: a watched file changed, the device was replaced, the preview resolution changed. */
  requestFull(): void;
  /** The request to start now, when nothing runs and one is due; null otherwise. The session calls it whenever something changed. */
  next(): ScheduledRequest | null;
  /** True when the running request must be aborted (7.3, the table's last column). */
  shouldAbort(running: ScheduledRequest): boolean;
  /** The running request has settled. `tookMs` feeds the draft level; `shown` says whether its result was shown. */
  settled(request: ScheduledRequest, outcome: { readonly tookMs: number; readonly shown: boolean }): void;
}

export function createScheduler(registry: NodeRegistry): Scheduler {
  throw new Error('not implemented: createScheduler');
}
