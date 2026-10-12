import type { NodeDef, ParamValue } from '../../src/core/api.ts';
import type { ProjectSettings } from '../../src/core/runtime.ts';
import type { FixtureName } from './fixtures.ts';

export type SkippableCheck = 'generator-range' | 'resolution' | 'seed' | 'alpha' | 'budget';

export interface ConformanceOptions {
  /** Merged over the node's defaults in every check. For a node whose defaults cannot run: an import node's file. */
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** Replaces the default fixture of an input. A FixtureName other than 'fbm' and 'impulse'. */
  readonly inputs?: Readonly<Record<string, FixtureName>>;
  readonly settings?: Partial<ProjectSettings>;
  /** Replaces the default tolerance of the `resolution` check. 0 < value <= 0.5. */
  readonly resolutionTol?: { readonly value: number; readonly reason: string };
  /** Checks not run, each with the reason. */
  readonly skip?: Partial<Record<SkippableCheck, string>>;
}

export function conformance(def: NodeDef, opts?: ConformanceOptions): void {
  throw new Error('not implemented: conformance');
}
