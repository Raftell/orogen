import type { NodeDef } from '../../src/core/api.ts';
import type { FieldData } from './field-data.ts';

/**
 * The harness's private node type `ref/harness-source` (testing.md 2.1): one output `out`, of the kind of the
 * data, which it uploads with ctx.write. The same definition on every call.
 */
export function harnessSource(): NodeDef {
  throw new Error('not implemented: harnessSource');
}

/** Stores CPU data for a source node of this process and returns the parameter values that make an instance upload it. */
export function sourceParams(data: FieldData): Readonly<Record<string, string>> {
  throw new Error('not implemented: sourceParams');
}
