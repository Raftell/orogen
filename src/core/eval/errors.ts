import { FieldAccessError, KernelBindingError } from '../gpu/errors.ts';
import { KernelCompileError, type WgslDiagnostic } from '../gpu/pipelines.ts';
import { BudgetExceededError } from '../gpu/pool.ts';
import { GpuOutOfMemoryError, GpuValidationError, WatchdogError } from '../gpu/stream.ts';
import { FileError } from '../io/files.ts';

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

/** A rule of the evaluation context that is neither a binding nor a field handle was broken (runtime.md 5.8, kind 'binding'). */
export class ContextError extends Error {
  override name = 'ContextError';
}

/** A conversion, a mask blend or a constant failed (runtime.md 5.8, kind 'internal'). */
export class InternalError extends Error {
  override name = 'InternalError';
}

// A RangeError or TypeError that a context method raised for its own arguments. The same class thrown by a
// node's own code is a 'node-exception'; only the object tells the two apart.
const contextRaised = new WeakSet<object>();

/** Marks `error` as raised by a rule of the evaluation context, so that it fails the node with kind 'binding'. */
export function byContext<E extends Error>(error: E): E {
  contextRaised.add(error);
  return error;
}

const MIB = 1048576;
const megabytes = (bytes: number): string => String(Math.round(bytes / MIB));
/**
 * A byte count for a person: whole megabytes from 1 MB up and whole kilobytes below, where megabytes would read
 * "0 MB" for the fields of a preview. `up` rounds up, for an amount that is lacking.
 */
function size(bytes: number, up = false): string {
  const round = up ? Math.ceil : Math.round;
  if (!(bytes > 0)) return '0 MB';
  if (bytes >= MIB) return `${round(bytes / MIB)} MB`;
  return `${Math.max(1, round(bytes / 1024))} KB`;
}
const firstLine = (text: string): string => text.split('\n')[0]!;
const kernelIn = (message: string): string | undefined => /^kernel "([^"]+)"/.exec(message)?.[1];

/** runtime.md 5.8: the message of kind 'budget'. `neededBytes` is what the budget lacks. */
export function budgetMessage(neededBytes: number, resolution: number, budgetBytes: number, workingBytes: number, pinnedBytes: number): string {
  return `Needs ${size(Math.max(1, neededBytes), true)} more GPU memory at ${resolution} × ${resolution}: `
    + `budget ${size(budgetBytes)}, ${size(workingBytes)} in use by this node, ${size(pinnedBytes)} pinned`;
}

/** runtime.md 5.8: the message of kind 'out-of-memory'. */
export function outOfMemoryMessage(resolution: number, budgetBytes: number): string {
  return `Out of GPU memory at ${resolution} × ${resolution} (budget ${megabytes(budgetBytes)} MB). Lower the resolution or raise the GPU memory budget`;
}

/**
 * The NodeError for whatever a node invocation threw or rejected with, by the table of runtime.md 5.8:
 * KernelBindingError, FieldAccessError and a broken rule of the context give 'binding', GpuValidationError
 * 'validation', BudgetExceededError 'budget', GpuOutOfMemoryError 'out-of-memory', WatchdogError 'watchdog',
 * FileError 'io', KernelCompileError 'shader-compile', InternalError 'internal', anything else 'node-exception'.
 * `resolution` and `budgetBytes` are for the memory messages.
 */
export function nodeErrorFrom(thrown: unknown, node: { readonly id: string; readonly type: string }, resolution: number, budgetBytes: number): NodeError {
  const base = { nodeId: node.id, nodeType: node.type };
  if (thrown instanceof KernelCompileError) {
    return {
      ...base, kind: 'shader-compile', message: thrown.message, detail: thrown.detail, kernel: thrown.kernel,
      ...(thrown.diagnostic ? { wgsl: thrown.diagnostic } : {}),
    };
  }
  if (thrown instanceof KernelBindingError) {
    const kernel = kernelIn(thrown.message);
    return { ...base, kind: 'binding', message: thrown.message, ...(kernel !== undefined ? { kernel } : {}) };
  }
  if (thrown instanceof FieldAccessError || thrown instanceof ContextError) {
    return { ...base, kind: 'binding', message: thrown.message };
  }
  if (thrown instanceof GpuValidationError) {
    return { ...base, kind: 'validation', message: thrown.message, detail: thrown.detail };
  }
  if (thrown instanceof BudgetExceededError) {
    const { report, requestedBytes } = thrown;
    const committed = report.workingBytes + report.pinnedBytes + report.reservedBytes;
    return {
      ...base, kind: 'budget', detail: thrown.message,
      message: budgetMessage(committed + requestedBytes - report.budgetBytes, resolution, report.budgetBytes, report.workingBytes, report.pinnedBytes),
    };
  }
  if (thrown instanceof GpuOutOfMemoryError) {
    return { ...base, kind: 'out-of-memory', message: outOfMemoryMessage(resolution, budgetBytes), detail: thrown.message };
  }
  if (thrown instanceof WatchdogError) {
    const kernel = kernelIn(thrown.message);
    return { ...base, kind: 'watchdog', message: thrown.message, ...(kernel !== undefined ? { kernel } : {}) };
  }
  if (thrown instanceof FileError) return { ...base, kind: 'io', message: thrown.message };
  if (thrown instanceof InternalError) return { ...base, kind: 'internal', message: thrown.message };
  if (thrown instanceof Error) {
    const message = firstLine(thrown.message) || thrown.name;
    if (contextRaised.has(thrown)) return { ...base, kind: 'binding', message };
    return { ...base, kind: 'node-exception', message, ...(typeof thrown.stack === 'string' ? { detail: thrown.stack } : {}) };
  }
  return { ...base, kind: 'node-exception', message: firstLine(String(thrown)) };
}
