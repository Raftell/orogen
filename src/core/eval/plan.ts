import type { GraphDoc, NodeInstance, PortRef } from '../graph/doc.ts';
import type { NodeDef } from '../graph/node.ts';
import type { ParamValue } from '../graph/param-types.ts';
import type { NodeRegistry } from '../graph/registry.ts';
import type { NodeError } from './errors.ts';
import type { EvalTarget } from './evaluator.ts';

/** '' when the source has the kind the reader takes (runtime.md 5.6). */
export type Conversion = '' | 'grey' | 'luma';

export interface PlanInput {
  readonly port: string;
  /** The edge the evaluator uses for the input (4.3 rule 5); null: unconnected. */
  readonly from: PortRef | null;
  readonly conversion: Conversion;
}

export interface PlanNode {
  readonly nodeId: string;
  readonly instance: NodeInstance;
  /** null: the registry has no such type. */
  readonly def: NodeDef | null;
  /** The declared inputs in order, then `mask` for a maskable node. */
  readonly inputs: readonly PlanInput[];
  /** bypass is set and takes effect (5.6). */
  readonly bypassed: boolean;
  /** normalizeParams().values; null for a bypassed node and for one without a definition. */
  readonly params: Readonly<Record<string, ParamValue>> | null;
  /** The check of 5.3 step 2 that the node itself fails. */
  readonly error: NodeError | null;
  /** The failed node this one reads, directly or not, when it has no error of its own. */
  readonly upstream: string | null;
}

export interface EvalPlan {
  /** Depth-first post-order from the targets (5.3 step 1). */
  readonly nodes: readonly PlanNode[];
  readonly byId: ReadonlyMap<string, PlanNode>;
}

/** Steps 1 and 2 of runtime.md 5.3. No GPU work. TypeError for a target that names a node or an output the document lacks. */
export function buildPlan(doc: GraphDoc, registry: NodeRegistry, targets: readonly EvalTarget[]): EvalPlan {
  throw new Error('not implemented: buildPlan');
}

/** Step 4: for every node of the plan, the outputs this evaluation wants. */
export function wantedOutputs(plan: EvalPlan, targets: readonly EvalTarget[], outputs: 'all' | 'needed'): ReadonlyMap<string, ReadonlySet<string>> {
  throw new Error('not implemented: wantedOutputs');
}

/**
 * Step 6: the largest sum of the bytes of all wanted outputs, conversions and mask blends alive at one step
 * of the plan, and the node at whose step it occurs. `bytesOf` gives the bytes of one texture of a kind at
 * the evaluation resolution.
 */
export function outputPeak(
  plan: EvalPlan, targets: readonly EvalTarget[], wanted: ReadonlyMap<string, ReadonlySet<string>>,
  bytesOf: (kind: 'field' | 'color') => number,
): { readonly bytes: number; readonly nodeId: string | null } {
  throw new Error('not implemented: outputPeak');
}
