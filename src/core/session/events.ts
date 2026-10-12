import type { EvalEvent } from '../eval/events.ts';
import type { BuildEvent } from '../export-decl.ts';
import type { GpuCaps } from '../gpu/caps.ts';
import type { MemoryReport } from '../gpu/pool.ts';

export type EngineEvent =
  | EvalEvent                                                    // 5.10
  | BuildEvent                                                   // export-unreal.md
  | { readonly type: 'request-start'; readonly requestId: number; readonly revision: number;
      readonly purpose: 'view' | 'draft' | 'thumbnails' | 'build' }
  | { readonly type: 'keys'; readonly revision: number; readonly keys: Readonly<Record<string, string>> }   // node id → contentKey
  | { readonly type: 'view-updated'; readonly requestId: number; readonly revision: number;
      readonly resolution: number; readonly draft: boolean; readonly height: boolean; readonly overlay: boolean }
  | { readonly type: 'thumbnail'; readonly nodeId: string; readonly contentKey: string;
      readonly resolution: number; readonly rgba: Uint8ClampedArray }
  | ({ readonly type: 'memory' } & MemoryReport)
  | { readonly type: 'build-start'; readonly requestId: number; readonly resolution: number; readonly outDir: string }
  | { readonly type: 'build-end'; readonly requestId: number; readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost' }
  | { readonly type: 'device-ready'; readonly epoch: number; readonly caps: GpuCaps; readonly budgetBytes: number }
  | { readonly type: 'device-lost'; readonly reason: 'destroyed' | 'unknown'; readonly message: string; readonly nodeId?: string }
  | { readonly type: 'engine-error'; readonly message: string; readonly fatal: boolean };
