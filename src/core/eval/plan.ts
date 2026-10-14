import { own, type GraphDoc, type NodeInstance, type PortRef } from '../graph/doc.ts';
import type { NodeDef } from '../graph/node.ts';
import type { ParamValue } from '../graph/param-types.ts';
import { normalizeParams } from '../graph/params.ts';
import { canBypass, inputsOf, type PortDef } from '../graph/ports.ts';
import type { NodeRegistry } from '../graph/registry.ts';
import { cycleNodes, inputKey, inputSources, missingInputs } from '../graph/validate.ts';
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
  /**
   * The inputs the evaluator reads: the declared inputs in order, then `mask` for a maskable node. For a
   * bypassed node inputs[0] alone, because its other inputs are not read (5.6).
   */
  readonly inputs: readonly PlanInput[];
  /** bypass is set and takes effect (5.6). */
  readonly bypassed: boolean;
  /** normalizeParams().values; null for a bypassed node and for one without a definition. */
  readonly params: Readonly<Record<string, ParamValue>> | null;
  /** The kind each output carries, `sameAs` resolved through the connection; 'field' where that cannot be told. */
  readonly outputKinds: Readonly<Record<string, 'field' | 'color'>>;
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

function conversionFor(port: PortDef, source: 'field' | 'color' | undefined): Conversion {
  if (source === undefined || port.type === 'any' || port.type === source) return '';
  return port.type === 'color' ? 'grey' : 'luma';
}

/** Steps 1 and 2 of runtime.md 5.3. No GPU work. TypeError for a target that names a node or an output the document lacks. */
export function buildPlan(doc: GraphDoc, registry: NodeRegistry, targets: readonly EvalTarget[]): EvalPlan {
  const roots: string[] = [];
  for (const target of targets) {
    const id = 'ref' in target ? target.ref?.node : target?.node;
    const instance = typeof id === 'string' ? own(doc.nodes, id) : undefined;
    if (!instance) throw new TypeError(`An evaluation target names the node "${String(id)}", which the document does not have`);
    if ('ref' in target) {
      if (target.as !== undefined && target.as !== 'field' && target.as !== 'color') {
        throw new TypeError(`An evaluation target asks for "${String(target.as)}"; a target is delivered as "field" or "color"`);
      }
      const def = registry.get(instance.type);
      if (def && !def.outputs.some((p) => p.name === target.ref.port)) {
        throw new TypeError(`An evaluation target names the output "${target.ref.port}", which node "${id}" (${def.type}) does not have`);
      }
    }
    roots.push(id as string);
  }

  const sourceOf = inputSources(doc, registry);
  const onCycle = cycleNodes(doc, registry);

  interface Draft {
    readonly nodeId: string;
    readonly instance: NodeInstance;
    readonly def: NodeDef | null;
    readonly bypassed: boolean;
    /** The ports read, with the source of each. */
    readonly reads: readonly { readonly port: PortDef; readonly from: PortRef | null }[];
  }
  const draft = (nodeId: string): Draft => {
    const instance = own(doc.nodes, nodeId)!;
    const def = registry.get(instance.type) ?? null;
    const bypassed = def !== null && instance.bypass === true && canBypass(def);
    const ports = def === null ? [] : bypassed ? [def.inputs[0]!] : inputsOf(def);
    return { nodeId, instance, def, bypassed, reads: ports.map((port) => ({ port, from: sourceOf.get(inputKey({ node: nodeId, port: port.name })) ?? null })) };
  };

  // Depth-first post-order without recursion: a chain of thousands of nodes must not exhaust the stack. A node
  // is entered once, so the walk ends after one round per node and one per edge, cycles included.
  const order: Draft[] = [];
  const entered = new Set<string>();
  for (const root of roots) {
    if (entered.has(root)) continue;
    entered.add(root);
    const path: { readonly node: Draft; at: number }[] = [{ node: draft(root), at: 0 }];
    for (let frame = path.at(-1); frame !== undefined; frame = path.at(-1)) {
      if (frame.at < frame.node.reads.length) {
        const from = frame.node.reads[frame.at++]!.from;
        // usedEdges only names existing nodes of known types.
        if (from && !entered.has(from.node)) {
          entered.add(from.node);
          path.push({ node: draft(from.node), at: 0 });
        }
        continue;
      }
      path.pop();
      order.push(frame.node);
    }
  }

  const byId = new Map<string, PlanNode>();
  const nodes: PlanNode[] = [];
  for (const d of order) {
    const { nodeId, instance, def } = d;
    const fail = (kind: NodeError['kind'], message: string): NodeError => ({ nodeId, nodeType: instance.type, kind, message });
    // A source later in the order is on a cycle with this node; its kind is not known and does not matter.
    const kindOf = (from: PortRef | null): 'field' | 'color' | undefined => (from ? byId.get(from.node)?.outputKinds[from.port] : undefined);
    const inputs: PlanInput[] = d.reads.map(({ port, from }) => ({ port: port.name, from, conversion: conversionFor(port, kindOf(from)) }));

    const outputKinds: Record<string, 'field' | 'color'> = {};
    for (const port of def?.outputs ?? []) {
      if (port.type === 'field' || port.type === 'color') outputKinds[port.name] = port.type;
      else if (typeof port.type === 'object') outputKinds[port.name] = kindOf(sourceOf.get(inputKey({ node: nodeId, port: port.type.sameAs })) ?? null) ?? 'field';
      else outputKinds[port.name] = 'field';
    }

    let error: NodeError | null = null;
    let params: Readonly<Record<string, ParamValue>> | null = null;
    // The checks in the order of 5.3 step 2. A bypassed node's params and other inputs are not read and not checked (5.6).
    const version = def?.version ?? 1;
    if (!def) {
      error = fail('unknown-type', `Unknown node type "${instance.type}"`);
    } else if (!d.bypassed && instance.version !== version) {
      error = fail('version', `Saved with version ${instance.version} of this node; this build has version ${version}`);
    } else if (onCycle.has(nodeId)) {
      error = fail('cycle', 'Part of a cycle');
    } else if (!d.bypassed) {
      const missing = missingInputs(doc, registry, nodeId, sourceOf)[0];
      if (missing) {
        error = fail('missing-input', `missing input "${missing.name}"`);
      } else {
        const normalized = normalizeParams(def, instance.params);
        if (normalized.error !== null) error = fail('param', normalized.error);
        else params = normalized.values;
      }
    }

    let upstream: string | null = null;
    if (!error) {
      for (const input of inputs) {
        const source = input.from ? byId.get(input.from.node) : undefined;
        if (!source) continue;
        if (source.error) upstream = source.nodeId;
        else if (source.upstream !== null) upstream = source.upstream;
        if (upstream !== null) break;
      }
    }
    const node: PlanNode = { nodeId, instance, def, inputs, bypassed: d.bypassed, params, outputKinds, error, upstream };
    byId.set(nodeId, node);
    nodes.push(node);
  }
  return { nodes, byId };
}

/** One texture's worth of content in a build: alive from the step that produces it to the step of its last reader or its delivery. */
export interface Lifetime { readonly bytes: number; readonly from: number; readonly to: number }

/**
 * Step 6: the largest sum of the bytes alive at one step of the plan, and the first step at which it occurs.
 * `steps` is the number of steps; lifetimes are clipped to them.
 */
export function outputPeak(lifetimes: readonly Lifetime[], steps: number): { readonly bytes: number; readonly step: number } {
  if (steps <= 0) return { bytes: 0, step: 0 };
  // The change of the sum on entering each step.
  const change = new Float64Array(steps + 1);
  for (const { bytes, from, to } of lifetimes) {
    const first = Math.max(0, Math.min(steps - 1, from));
    const last = Math.max(first, Math.min(steps - 1, to));
    change[first] += bytes;
    change[last + 1] -= bytes;
  }
  let alive = 0, peak = 0, step = 0;
  for (let s = 0; s < steps; s++) {
    alive += change[s]!;
    if (alive > peak) {
      peak = alive;
      step = s;
    }
  }
  return { bytes: peak, step };
}
