import type { Engine } from '../engine.ts';
import type { FieldStats } from '../eval/context.ts';
import type { EvalEvent } from '../eval/events.ts';
import type { BuildEvent, BuildResult } from '../export-decl.ts';
import type { GpuContext } from '../gpu/device.ts';
import type { GraphDoc, PortRef } from '../graph/doc.ts';
import type { FileSource } from '../io/files.ts';
import type { EngineEvent } from './events.ts';
import type { ViewportHost, ViewportRenderer } from './viewport.ts';

export interface EnginePreferences {
  readonly vramBytes: number | null;        // null: use caps.vramBytes, else 4 GiB (2.4)
  readonly budgetFraction: number;          // 0.3 .. 0.85
}

export interface BuildRequest {
  readonly doc: GraphDoc;                   // built at doc.settings.buildResolution
  readonly outDir: string;                  // absolute folder; created when missing. It belongs to the build: export-unreal.md 3.8
}

export interface EngineSession {
  setProject(project: { readonly path: string | null }): void;
  setDocument(doc: GraphDoc, revision: number): void;
  beginGesture(): void;
  endGesture(): void;
  setPaused(paused: boolean): void;
  requestThumbnails(nodeIds: readonly string[]): void;
  inspect(ref: PortRef): Promise<FieldStats | null>;
  build(request: BuildRequest): Promise<BuildResult>;
  cancelBuild(): void;
  setPreferences(prefs: EnginePreferences): void;
  retryDevice(): void;
  subscribe(listener: (e: EngineEvent) => void): () => void;
  readonly viewport: ViewportHost;          // 7.5
  dispose(): Promise<void>;
}

/** What the session passes to the build function it was given (7.6). */
export interface SessionBuildOptions {
  readonly doc: GraphDoc;
  readonly outDir: string;
  readonly requestId: number;
  readonly signal: AbortSignal;
  readonly onEvent: (e: EvalEvent | BuildEvent) => void;
}

export function createSession(opts: {
  readonly engine: Engine;
  readonly reopenGpu: () => Promise<GpuContext>;                         // a new openGpu call, for recovery (7.8)
  readonly createFiles: (projectPath: string | null) => FileSource;
  readonly build: (engine: Engine, opts: SessionBuildOptions) => Promise<BuildResult>;   // 7.6; never rejects for a failed build
  readonly renderer: ViewportRenderer | null;                            // null: no viewport; `viewport` then ignores calls and `pick` resolves null
}): EngineSession {
  throw new Error('not implemented: createSession');
}
