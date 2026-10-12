import type { NodeDef, ParamValue } from '../../src/core/api.ts';
import type { FileSource, GraphDoc, ProjectSettings } from '../../src/core/runtime.ts';
import type { Slices } from './engine.ts';
import type { FieldData } from './field-data.ts';
import type { FixtureName } from './fixtures.ts';
import type { EvalReport, RenderOptions } from './render.ts';

export interface GraphSpec {
  readonly settings?: Partial<ProjectSettings>;                            // merged over TEST_SETTINGS
  readonly sources?: Readonly<Record<string, FieldData | FixtureName>>;    // literal fields, addressed as '<id>.out'
  readonly nodes: Readonly<Record<string, {
    readonly type: string;
    readonly params?: Readonly<Record<string, ParamValue>>;
    readonly inputs?: Readonly<Record<string, string>>;                    // input port -> '<node or source id>.<output port>'
    readonly bypass?: boolean;
  }>>;
}
/** Builds the document with newDoc() and the commands of runtime.md 4.6. */
export function makeDoc(spec: GraphSpec): GraphDoc {
  throw new Error('not implemented: makeDoc');
}
/** A document with one instance of every given node, for whole-registry tests (8.4). */
export function registryDoc(defs: readonly NodeDef[]): GraphDoc {
  throw new Error('not implemented: registryDoc');
}

export interface GraphOptions {
  readonly res?: number;                       // default: the resolution the document's settings give for `mode`
  readonly mode?: 'preview' | 'build';         // default 'preview'
  readonly outputs?: 'all' | 'needed';         // default 'needed'
  readonly files?: FileSource;                 // default: files under tests/, or under the project file's folder
  readonly signal?: AbortSignal;
  readonly slices?: Slices;
  readonly fieldBudgetBytes?: number;
  readonly onSlice?: RenderOptions['onSlice'];
}
export interface GraphRender {
  readonly fields: Readonly<Record<string, FieldData>>;   // by target, for the targets that were produced
  readonly report: EvalReport;
}

/** `graph` is a document, a spec, or the path of a project file. A target is '<node id>.<output port>', or '<node id>' to run a node. */
export function renderGraph(graph: GraphDoc | GraphSpec | string, targets: readonly string[], opts?: GraphOptions): Promise<GraphRender> {
  throw new Error('not implemented: renderGraph');
}

export interface GraphSession {
  readonly doc: GraphDoc;
  evaluate(targets: readonly string[], opts?: GraphOptions): Promise<GraphRender>;
  setParam(node: string, name: string, value: ParamValue): void;
  setSettings(patch: Partial<ProjectSettings>): void;
  close(): Promise<void>;
}
export function openGraph(graph: GraphDoc | GraphSpec | string): Promise<GraphSession> {
  throw new Error('not implemented: openGraph');
}
