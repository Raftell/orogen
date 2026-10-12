import type { EvalTarget } from '../eval/evaluator.ts';
import { DRAFT_LEVEL_THRESHOLD_MS } from '../gpu/tuning.ts';
import { own, type GraphDoc, type PortRef, type ViewBinding } from '../graph/doc.ts';
import { ladder, ladderLevel } from '../graph/ladder.ts';
import type { NodeRegistry } from '../graph/registry.ts';
import { previewResolution } from '../graph/settings.ts';

// The policy of runtime.md 7.3 and 7.4 as pure functions and one small state machine. It makes no evaluation
// and holds no handle: session.ts does both.

export type RequestPurpose = 'view' | 'draft' | 'thumbnails';

/** Which target of a view request is which part of the view (7.4 rule 1). */
export interface ViewParts {
  readonly targets: readonly EvalTarget[];
  /** The index of the height target and the port it names; null without one. */
  readonly height: { readonly index: number; readonly ref: PortRef } | null;
  readonly overlay: { readonly index: number; readonly ref: PortRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number } | null;
}

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
  readonly view?: ViewParts;
}

/** Whether the document has the node and, when its type is known, the output. A node of an unknown type is kept: its error says why nothing is shown. */
function refExists(doc: GraphDoc, registry: NodeRegistry, ref: PortRef | undefined): ref is PortRef {
  if (!ref || typeof ref.node !== 'string' || typeof ref.port !== 'string') return false;
  const node = own(doc.nodes, ref.node);
  if (!node) return false;
  const def = registry.get(node.type);
  return !def || def.outputs.some((port) => port.name === ref.port);
}

/** 7.4 rule 1, with the place of each target. */
export function viewParts(doc: GraphDoc, registry: NodeRegistry): ViewParts {
  const view: ViewBinding | undefined = doc.ui?.view;
  const targets: EvalTarget[] = [];
  let height: ViewParts['height'] = null;
  let overlay: ViewParts['overlay'] = null;
  if (view && refExists(doc, registry, view.height)) {
    const ref: PortRef = { node: view.height.node, port: view.height.port };
    height = { index: targets.length, ref };
    targets.push({ ref, as: 'field' });
  }
  const over = view?.overlay;
  if (over && refExists(doc, registry, over.ref) && (over.as === 'color' || over.as === 'mask' || over.as === 'heat')) {
    const ref: PortRef = { node: over.ref.node, port: over.ref.port };
    overlay = { index: targets.length, ref, as: over.as, opacity: Number.isFinite(over.opacity) ? over.opacity : 1 };
    targets.push({ ref, as: over.as === 'color' ? 'color' : 'field' });
  }
  return { targets, height, overlay };
}

/**
 * 7.4 rule 1: `{ ref: view.height, as: 'field' }` and, with an overlay, its target; a reference to a node or
 * port that does not exist is left out. Empty without a view.
 */
export function viewTargets(doc: GraphDoc, registry: NodeRegistry): EvalTarget[] {
  return [...viewParts(doc, registry).targets];
}

/** A node's thumbnail above this predicted time is left to a view evaluation (7.3 rule 9). */
export const THUMBNAIL_NODE_LIMIT_MS = 100;
const THUMBNAIL_MIN_RESOLUTION = 128;

/** 7.3 rule 9: the coarsest ladder level of buildResolution that is at least 128, or level 0 when none is. */
export function thumbnailResolution(buildResolution: number): number {
  const levels = ladder(buildResolution);
  for (let k = levels.length - 1; k > 0; k--) {
    if (levels[k]! >= THUMBNAIL_MIN_RESOLUTION) return levels[k]!;
  }
  return buildResolution;
}

/** 7.3 rule 4: the resolution of a draft `d` levels (1 or 2) below the preview level; the coarsest defined level when the ladder has no such level. */
export function draftResolution(doc: GraphDoc, d: 1 | 2): number {
  const { buildResolution, previewLevel } = doc.settings;
  const level = ladderLevel(buildResolution, previewLevel + d);
  if (level !== null) return level;
  const levels = ladder(buildResolution);
  return levels.length > 0 ? levels[levels.length - 1]! : previewResolution(doc.settings);
}

/** 7.3 rule 4: the `d` of the next draft after one at `d` that took `tookMs`. */
export function nextDraftLevel(d: 1 | 2, tookMs: number): 1 | 2 {
  if (d === 2) return 4 * tookMs <= DRAFT_LEVEL_THRESHOLD_MS ? 1 : 2;
  return tookMs > DRAFT_LEVEL_THRESHOLD_MS ? 2 : 1;
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
  /** The device is lost (true) or was replaced (false): nothing starts in between, and what was evaluated is gone. */
  setDeviceLost(lost: boolean): void;
  /** The requested nodes whose thumbnails are stale and worth an idle evaluation, in the order requested. */
  setThumbnails(stale: readonly string[]): void;
  /** A cause of a full request that is not a document change: a watched file changed, the device was replaced, the preview resolution changed. */
  requestFull(): void;
  /** The request to start now, when nothing runs and one is due; null otherwise. The session calls it whenever something changed. */
  next(): ScheduledRequest | null;
  /** True when the running request must be aborted (7.3, the table's last column). */
  shouldAbort(): boolean;
  /** The running request has settled. `completed`: its status was 'ok' or 'errors'. `tookMs` feeds the draft level. */
  settled(request: ScheduledRequest, outcome: { readonly tookMs: number; readonly completed: boolean }): void;
  /** The latest document and revision; null before the first setDocument. */
  readonly latest: { readonly doc: GraphDoc; readonly revision: number } | null;
}

export function createScheduler(registry: NodeRegistry): Scheduler {
  let latest: { readonly doc: GraphDoc; readonly revision: number } | null = null;
  let pending: 'full' | 'draft' | null = null;
  let running: ScheduledRequest | null = null;
  /** The running request is to be aborted whatever comes next: endGesture found a draft running. */
  let abort = false;
  let gesture = false;
  let d: 1 | 2 = 2;
  let paused = false;
  let building = false;
  let deviceLost = false;
  /** The last full evaluation that completed: endGesture asks for no other of the same revision (7.3, the table of causes). */
  let fullOf: number | null = null;
  let stale: readonly string[] = [];

  const full = (): void => {
    if (latest) pending = 'full';
  };

  function thumbnailRequest(doc: GraphDoc, revision: number): ScheduledRequest | null {
    const targets: EvalTarget[] = [];
    for (const id of stale) {
      const node = own(doc.nodes, id);
      const port = node && registry.get(node.type)?.outputs[0];
      if (port) targets.push({ ref: { node: id, port: port.name } });
    }
    if (targets.length === 0) return null;
    return {
      purpose: 'thumbnails', doc, revision, targets, cache: 'keep', outputs: 'needed',
      resolution: thumbnailResolution(doc.settings.buildResolution),
    };
  }

  return {
    get latest() { return latest; },

    setDocument(doc, revision) {
      latest = { doc, revision };
      pending = gesture ? 'draft' : 'full';
    },

    beginGesture() {
      if (gesture) return;
      gesture = true;
      d = 2;
    },

    endGesture() {
      if (!gesture) return;
      gesture = false;
      if (!latest) return;
      if (running?.purpose === 'draft') abort = true;
      const evaluated = fullOf === latest.revision && pending === null;
      const evaluating = running !== null && running.purpose === 'view' && running.revision === latest.revision && pending === null;
      if (!evaluated && !evaluating) pending = 'full';
    },

    setPaused(next) {
      if (paused === next) return;
      paused = next;
      if (!paused) full();
    },

    setBuilding(next) {
      if (building === next) return;
      building = next;
      if (!building) full();
    },

    setDeviceLost(lost) {
      deviceLost = lost;
      if (lost) fullOf = null;
    },

    setThumbnails(list) {
      stale = list;
    },

    requestFull: full,

    next() {
      if (running || paused || building || deviceLost || !latest) return null;
      const { doc, revision } = latest;
      if (pending) {
        const view = viewParts(doc, registry);
        // A view that names nothing has nothing to draft: the request is the full one, which shows the empty content.
        const draft = pending === 'draft' && view.targets.length > 0;
        pending = null;
        running = {
          purpose: draft ? 'draft' : 'view', doc, revision, view, targets: view.targets,
          resolution: draft ? draftResolution(doc, d) : previewResolution(doc.settings),
          cache: draft ? 'transient' : 'keep', outputs: 'all',
        };
        return running;
      }
      if (gesture || stale.length === 0) return null;
      running = thumbnailRequest(doc, revision);
      return running;
    },

    shouldAbort() {
      if (!running) return false;
      if (abort || paused || building) return true;
      // A running draft finishes whatever is edited meanwhile (7.3 rule 3).
      return running.purpose !== 'draft' && pending !== null;
    },

    settled(request, outcome) {
      if (running === request) {
        running = null;
        abort = false;
      }
      if (!outcome.completed) return;
      if (request.purpose === 'draft') d = nextDraftLevel(d, outcome.tookMs);
      if (request.purpose === 'view') fullOf = request.revision;
    },
  };
}
