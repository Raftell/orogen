import type { WgslDiagnostic } from '../gpu/pipelines.ts';

export type NodeErrorKind =
  | 'unknown-type' | 'version' | 'param' | 'missing-input' | 'cycle'
  | 'shader-compile' | 'binding' | 'validation' | 'budget' | 'out-of-memory' | 'watchdog'
  | 'io' | 'node-exception' | 'device-lost' | 'internal';

export interface NodeError {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly kind: NodeErrorKind;
  readonly message: string;            // one sentence, shown on the node
  readonly detail?: string;            // full GPU message, or a stack
  readonly kernel?: string;            // kernel name, when one is involved
  readonly wgsl?: WgslDiagnostic;      // for 'shader-compile'
}

/**
 * The NodeError for whatever a node invocation threw or rejected with, by the table of runtime.md 5.8:
 * KernelBindingError and FieldAccessError give 'binding', GpuValidationError 'validation', BudgetExceededError
 * 'budget', GpuOutOfMemoryError 'out-of-memory', WatchdogError 'watchdog', FileError 'io', KernelCompileError
 * 'shader-compile', anything else 'node-exception'. `resolution` and `budgetBytes` are for the memory messages.
 */
export function nodeErrorFrom(thrown: unknown, node: { readonly id: string; readonly type: string }, resolution: number, budgetBytes: number): NodeError {
  throw new Error('not implemented: nodeErrorFrom');
}
