import type { NodeDef, ParamValue } from '../../src/core/api.ts';
import type { EvalEvent, NodeError, ProjectSettings } from '../../src/core/runtime.ts';
import type { Slices } from './engine.ts';
import type { FieldData } from './field-data.ts';
import type { FixtureName } from './fixtures.ts';

export interface RenderOptions {
  readonly res?: number;                                                      // default 257
  readonly params?: Readonly<Record<string, ParamValue>>;
  readonly inputs?: Readonly<Record<string, FieldData | FixtureName | null>>;
  readonly mask?: FieldData | FixtureName;                                    // maskable nodes only
  readonly wants?: readonly string[];                                         // default: every output
  readonly settings?: Partial<ProjectSettings>;                               // merged over TEST_SETTINGS
  readonly signal?: AbortSignal;
  readonly slices?: Slices;                                                   // default 'auto'
  readonly fieldBudgetBytes?: number;                                         // default: the engine's budget is left alone
  readonly onSlice?: (s: { readonly nodeId: string | null; readonly kernels: readonly string[]; readonly measuredMs: number }) => void;
}

export interface NodeReport {
  readonly nodeId: string;
  readonly state: 'done' | 'cached' | 'bypassed' | 'error' | 'skipped';
  readonly error: NodeError | null;            // for 'error'
  readonly skipReason: 'upstream' | 'aborted' | 'device-lost' | null;   // for 'skipped'
  readonly upstream: string | null;            // for 'skipped' because of a failed node: that node's id
  readonly wallMs: number;                     // node-done.wallMs; 0 unless 'done'
  readonly peakBytes: number;                  // node-done.peakBytes; 0 unless 'done'
  readonly progress: readonly number[];        // the fraction of every node-progress event, in order
  readonly slices: number;                     // slices completed while the node ran
}
export interface EvalReport {
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly events: readonly EvalEvent[];       // everything the evaluation emitted, in order
  readonly nodes: Readonly<Record<string, NodeReport>>;
  readonly nodesRun: number;
  readonly nodesCached: number;
  readonly slices: number;
  readonly longestSliceMs: number;
}

/** Its message is the message of the first NodeError. */
export class NodeFailure extends Error {
  override name = 'NodeFailure';
  readonly error: NodeError;
  readonly report: EvalReport;

  constructor(error: NodeError, report: EvalReport) {
    super(error.message);
    this.error = error;
    this.report = report;
  }
}

export function renderNode(def: NodeDef, opts?: RenderOptions): Promise<Readonly<Record<string, FieldData>>> {
  throw new Error('not implemented: renderNode');
}
export function traceNode(def: NodeDef, opts?: RenderOptions): Promise<{
  readonly outputs: Readonly<Record<string, FieldData>>;
  readonly report: EvalReport;                 // the node under test has the id 'node'
}> {
  throw new Error('not implemented: traceNode');
}
