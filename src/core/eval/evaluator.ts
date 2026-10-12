import type { AnyFieldHandle } from '../gpu/pool.ts';
import type { GraphDoc, PortRef } from '../graph/doc.ts';
import type { NodeRegistry } from '../graph/registry.ts';
import type { ResultCache } from './cache.ts';
import type { NodeError } from './errors.ts';
import type { EvalEvent } from './events.ts';
import type { EngineParts } from './parts.ts';
import type { NodeTiming } from './progress.ts';
import type { Thumbnails } from './thumbnails.ts';

export type EvalTarget =
  | { readonly ref: PortRef; readonly as?: 'field' | 'color' }   // an output port, optionally converted (5.6)
  | { readonly node: string };                                   // run this node; no field is returned

export interface EvaluateOptions {
  readonly resolution: number;
  readonly mode: 'preview' | 'build';
  readonly requestId: number;
  readonly signal?: AbortSignal;
  readonly outputs?: 'all' | 'needed';
  readonly cache?: 'keep' | 'transient';
  readonly thumbnails?: boolean;
  readonly onEvent?: (e: EvalEvent) => void;                     // 5.10
  readonly onTarget?: (index: number, field: AnyFieldHandle | null) => Promise<void>;
  readonly onLoans?: (nodeId: string, loans: Readonly<Record<string, TextureRef>> | null) => void;   // 5.11
}

/** A texture as a viewer binds it: a loan (5.11) or published content (7.5). */
export interface TextureRef { readonly view: GPUTextureView; readonly width: number; readonly height: number; readonly kind: 'field' | 'color' }

export interface EvaluateResult {
  readonly requestId: number;
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly fields: readonly (AnyFieldHandle | null)[];           // fields[i] belongs to targets[i]
  readonly errors: readonly NodeError[];                         // 5.8; one per failed node, in plan order
  readonly timing: { readonly wallMs: number; readonly nodesRun: number; readonly nodesCached: number };
}

/** What the engine gives its evaluator. `parts()` is read at the start of every evaluation and after every await. */
export interface EvaluatorDeps {
  readonly registry: NodeRegistry;
  parts(): EngineParts;
  readonly cache: ResultCache;
  thumbnails(): Thumbnails;
}

/** runtime.md 5.2 to 5.13: one evaluation at a time; a call made while another runs starts when that one has settled. */
export interface Evaluator {
  evaluate(doc: GraphDoc, targets: readonly EvalTarget[], opts: EvaluateOptions): Promise<EvaluateResult>;
  keys(doc: GraphDoc): Promise<ReadonlyMap<string, string>>;
  lastTiming(nodeId: string): NodeTiming | null;
  /** Resolves when no evaluation runs or waits. Engine.trim, setFiles, replaceDevice and dispose await it. */
  idle(): Promise<void>;
  /** 5.9 rule 6: the node that was running when the device was lost, and its key; null when none was. */
  readonly lostAt: { readonly nodeId: string; readonly key: string } | null;
}

export function createEvaluator(deps: EvaluatorDeps): Evaluator {
  throw new Error('not implemented: createEvaluator');
}
