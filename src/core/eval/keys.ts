import type { GraphDoc } from '../graph/doc.ts';
import type { NodeDef } from '../graph/node.ts';
import type { ParamValue } from '../graph/param-types.ts';
import type { FileSource } from '../io/files.ts';
import type { EvalPlan } from './plan.ts';

/** Raised when a change to the core alters the result of unchanged nodes (runtime.md 5.4). */
export const KEY_VERSION = 1;

export interface NodeKeys {
  /** K(n). */
  readonly key: string;
  /** contentKey(n). */
  readonly contentKey: string;
  /** JSON.stringify(O(n, port)): the cache address of what readers of that output receive. */
  output(port: string): string;
}

/**
 * Step 3 of runtime.md 5.3: the keys of every node of the plan that is not blocked, awaiting each
 * externalKey at most once. A FileError of an externalKey fails that node only: it is absent from the
 * result and reported in `errors` by node id.
 */
export function computeKeys(plan: EvalPlan, doc: GraphDoc, files: FileSource, signal?: AbortSignal): Promise<{
  readonly keys: ReadonlyMap<string, NodeKeys>;
  readonly errors: ReadonlyMap<string, unknown>;
}> {
  throw new Error('not implemented: computeKeys');
}

/** runtime.md 6.1 rule 4: for each `file` param in order, [resolve(path), size, mtimeMs] or [resolve(path), null], joined into one string. */
export function defaultExternalKey(def: NodeDef, params: Readonly<Record<string, ParamValue>>, files: FileSource): Promise<string> {
  throw new Error('not implemented: defaultExternalKey');
}
