// The harness of testing.md section 2 and 3. Tests import it through this module only.

export { TEST_SETTINGS, getEngine, useNodes } from './engine.ts';
export type { Slices, TestEngine } from './engine.ts';

export { at, channelOf, colorOf, fieldOf } from './field-data.ts';
export type { FieldData } from './field-data.ts';
export { fixtures } from './fixtures.ts';
export type { FixtureName } from './fixtures.ts';

export { NodeFailure, renderNode, traceNode } from './render.ts';
export type { EvalReport, NodeReport, RenderOptions } from './render.ts';

export { makeDoc, openGraph, registryDoc, renderGraph } from './graph.ts';
export type { GraphOptions, GraphRender, GraphSession, GraphSpec } from './graph.ts';
export { memorySink, memorySource } from './memory-files.ts';
export type { MemorySink, MemorySource } from './memory-files.ts';
export { buildGraph } from './build.ts';

export { diff, expectClose, expectFinite, expectIdentical, expectMask, expectStats, stats } from './stats.ts';
export type { Bound, Diff, StatName, Stats } from './stats.ts';

export { compareLadder, decimate, expectLadder, renderLadder } from './ladder.ts';
export type { LadderDiff } from './ladder.ts';

export { writePreview } from './preview.ts';
export type { PreviewOptions, PreviewStyle } from './preview.ts';

export { expectNoLeaks } from './leaks.ts';

export { launchApp } from './app.ts';
export type { AppDriver } from './app.ts';

export { conformance } from './conformance.ts';
export type { ConformanceOptions, SkippableCheck } from './conformance.ts';
