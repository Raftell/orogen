import type { NodeError } from './errors.ts';
import type { EvaluateResult } from './evaluator.ts';

export type EvalEvent =
  | { readonly type: 'eval-start'; readonly requestId: number; readonly resolution: number; readonly mode: 'preview' | 'build';
      readonly plan: readonly { readonly nodeId: string; readonly state: 'cached' | 'run' | 'bypassed' | 'blocked' | 'unused' }[];
      readonly outputPeakBytes: number | null }                                 // build only
  | { readonly type: 'node-start'; readonly requestId: number; readonly nodeId: string }
  | { readonly type: 'node-progress'; readonly requestId: number; readonly nodeId: string;
      readonly fraction: number; readonly label?: string; readonly etaMs: number | null }
  | { readonly type: 'node-preview'; readonly requestId: number; readonly nodeId: string; readonly ports: readonly string[] }
  | { readonly type: 'node-done'; readonly requestId: number; readonly nodeId: string; readonly cached: boolean;
      readonly resolution: number;                                              // of the evaluation: what the three figures were measured at
      readonly wallMs: number; readonly gpuMs: number | null; readonly peakBytes: number }
  | { readonly type: 'node-error'; readonly requestId: number; readonly error: NodeError }
  | { readonly type: 'node-skipped'; readonly requestId: number; readonly nodeId: string;
      readonly reason: 'upstream' | 'aborted' | 'device-lost'; readonly upstream?: string }
  | { readonly type: 'eval-progress'; readonly requestId: number; readonly fraction: number; readonly etaMs: number | null }
  | { readonly type: 'eval-end'; readonly requestId: number; readonly status: EvaluateResult['status']; readonly wallMs: number };
