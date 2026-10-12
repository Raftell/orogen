// Everything code outside src/core/ imports of the engine: every type, function and constant runtime.md
// names in sections 1 to 7, and the build types of export-decl.ts. Node metadata comes from api.ts and the
// product's node list from nodes/index.ts; this module imports nothing from src/core/nodes/.

// 1. Device
export { DeviceLostError, GpuUnavailableError, openGpu } from './gpu/device.ts';
export type { GpuContext, GpuLostInfo, GpuProfile } from './gpu/device.ts';
export type { GpuCaps } from './gpu/caps.ts';

// 2. The texture pool
export { BudgetExceededError } from './gpu/pool.ts';
export type { AnyFieldHandle, FieldHandle, MemoryReport, PoolTexture, TexturePool } from './gpu/pool.ts';

// 3. The command stream
export { HARD_CEILING_MS, RATE_INITIAL } from './gpu/tuning.ts';

// 4. The document
export type { Edge, GraphDoc, NodeGroup, NodeInstance, PortRef, ProjectSettings, ViewBinding } from './graph/doc.ts';
export { previewResolution } from './graph/settings.ts';
export { outputKind, validateConnection } from './graph/validate.ts';
export { normalizeParams } from './graph/params.ts';
export { DocFormatError, newDoc, newId, parseDoc, serializeDoc } from './graph/serialize.ts';
export type { DocProblem } from './graph/serialize.ts';
export {
  addNode, connect, copyNodes, disconnect, moveNodes, pasteNodes, removeGroups, removeNodes, resetParam, setGraphViewport,
  setGroup, setNodeFlags, setParam, setSettings, setView,
} from './graph/commands.ts';
export type { DocDraft, DocFragment, Mutable } from './graph/commands.ts';

// 5. The evaluator
export { createRegistry } from './graph/registry.ts';
export type { NodeRegistry } from './graph/registry.ts';
export { createEngine } from './engine.ts';
export type { Engine, EngineOptions, SliceOverrun } from './engine.ts';
export type { EvalTarget, EvaluateOptions, EvaluateResult, TextureRef } from './eval/evaluator.ts';
export { KEY_VERSION } from './eval/keys.ts';
export type { NodeError, NodeErrorKind } from './eval/errors.ts';
export type { WgslDiagnostic } from './gpu/pipelines.ts';
export type { EvalEvent } from './eval/events.ts';
export type { Thumbnail } from './eval/thumbnails.ts';
export type { EngineTestHooks } from './eval/hooks.ts';

// 6. Files and CPU tasks
export { FileError } from './io/files.ts';
export type { FileSink, FileSource, FileWriter } from './io/files.ts';
export type { CpuRunner } from './cpu/runner.ts';
export { serveCpuTasks } from './cpu/serve.ts';
export type { CpuTaskPort } from './cpu/serve.ts';
export type { CpuTaskReply, CpuTaskRequest } from './cpu/protocol.ts';

// 7. EngineSession
export { createSession } from './session/session.ts';
export type { BuildRequest, EnginePreferences, EngineSession, SessionBuildOptions } from './session/session.ts';
export { budgetBytes, DEFAULT_PREFERENCES } from './session/budget.ts';
export { createSessionClient, serveSession } from './session/protocol.ts';
export type { ClientMessage, SessionPort, WorkerMessage } from './session/protocol.ts';
export { viewAfterSelect } from './graph/view.ts';
export type {
  CameraState, PickResult, ViewportContent, ViewportDisplay, ViewportHost, ViewportRenderer, ViewportSize,
} from './session/viewport.ts';
export type { EngineEvent } from './session/events.ts';

// The build types of export-unreal.md and the types they are made of (runtime.md, Imports).
export type {
  BuildEvent, BuildPlan, BuildProblem, BuildProblemCode, BuildResult, ExportItem, ExportSource, FileEncoding, HeightRange,
  ImageItem, LandscapeItem, LandscapeLayout, LayerItem, PlannedFile, PlannedLayer, TextureItem,
} from './export-decl.ts';
