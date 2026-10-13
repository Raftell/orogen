import fs from 'node:fs';
import path from 'node:path';

import type { NodeDef, ParamValue } from '../../src/core/api.ts';
import { previewResolution } from '../../src/core/graph/settings.ts';
import {
  addNode, connect, newDoc, newId, parseDoc, setNodeFlags, setParam, setSettings, setView,
  type DocDraft, type FileSource, type GraphDoc, type PortRef, type ProjectSettings,
} from '../../src/core/runtime.ts';
import { feedSource, inputFeeds, type FeedNode } from '../../src/cli/document.ts';
import { NodeFileSource } from '../../src/platform/node/files.ts';
import { currentRegistry, exclusive, liveEngine, REPOSITORY, TEST_SETTINGS, useNodes, type Slices } from './engine.ts';
import { evaluate, identityIds, sessionClosed, sessionOpened, sessionsOpen, type EvalReport, type IdMap, type SliceListener } from './evaluate.ts';
import { checkFieldData, type FieldData } from './field-data.ts';
import { fixtureKind, fixtures, isFixtureName, type FixtureName } from './fixtures.ts';
import { checkLeaks } from './leaks.ts';
import { createSource, type SourceHandle } from './source-node.ts';

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

interface SpecSource {
  readonly handle: SourceHandle;
  /** The fixture the source was named as: made at each resolution it is evaluated at. null: a literal field. */
  readonly fixture: FixtureName | null;
}

/** A document with the ids its caller uses and the data of its sources. */
export interface BuiltGraph {
  readonly doc: GraphDoc;
  readonly ids: IdMap;
  readonly sources: ReadonlyMap<string, SpecSource>;
}

const SPEC_ID = /^[a-z][a-z0-9]*$/;
const built = new WeakMap<GraphDoc, BuiltGraph>();

function specRef(text: unknown, what: string): { readonly id: string; readonly port: string } {
  const dot = typeof text === 'string' ? text.indexOf('.') : -1;
  if (typeof text !== 'string' || dot <= 0 || dot === text.length - 1) {
    throw new TypeError(`${what} is '<node or source id>.<output port>', not ${JSON.stringify(text)}`);
  }
  return { id: text.slice(0, dot), port: text.slice(dot + 1) };
}

/** The document of a spec, made with newDoc() and the commands of runtime.md 4.6, and what the harness remembers of it. */
export function buildSpec(spec: GraphSpec): BuiltGraph {
  if (typeof spec !== 'object' || spec === null || typeof spec.nodes !== 'object' || spec.nodes === null) throw new TypeError('A GraphSpec has `nodes`');
  const registry = currentRegistry();
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { ...TEST_SETTINGS, ...spec.settings });

  const docIds = new Map<string, string>();
  const specIds = new Map<string, string>();
  const sources = new Map<string, SpecSource>();
  const claim = (id: string, docId: string, what: string): void => {
    if (!SPEC_ID.test(id)) throw new TypeError(`The id "${id}" of a ${what} does not match /^[a-z][a-z0-9]*$/`);
    if (docIds.has(id)) throw new TypeError(`The id "${id}" is used twice: a source and a node cannot share one`);
    docIds.set(id, docId);
    specIds.set(docId, id);
  };

  try {
    let row = 0;
    for (const [id, value] of Object.entries(spec.sources ?? {})) {
      let source: SpecSource;
      if (isFixtureName(value)) source = { handle: createSource(fixtureKind(value), `The source "${id}" (the fixture "${value}")`), fixture: value };
      else {
        checkFieldData(value, `The source "${id}"`);
        source = { handle: createSource(value.kind, `The source "${id}"`, value), fixture: null };
      }
      sources.set(id, source);
      const docId = addNode(draft, registry, source.handle.type, { x: 0, y: 160 * row++ });
      for (const [name, key] of Object.entries(source.handle.params)) setParam(draft, registry, docId, name, key);
      claim(id, docId, 'source');
    }

    let column = 0;
    for (const [id, node] of Object.entries(spec.nodes)) {
      const position = { x: 280 * ++column, y: 0 };
      let docId: string;
      if (registry.get(node.type)) {
        docId = addNode(draft, registry, node.type, position);
        for (const [name, value] of Object.entries(node.params ?? {})) setParam(draft, registry, docId, name, value);
        if (node.bypass) setNodeFlags(draft, docId, { bypass: true });
      } else {
        // No command makes a node of a type the registry lacks; a document can hold one (runtime.md 4.3 rule 5).
        docId = newId();
        draft.nodes[docId] = {
          id: docId, type: String(node.type), version: 1, position,
          params: structuredClone({ ...node.params }) as Record<string, unknown>, ...(node.bypass ? { bypass: true } : {}),
        };
      }
      claim(id, docId, 'node');
    }

    for (const [id, node] of Object.entries(spec.nodes)) {
      for (const [port, text] of Object.entries(node.inputs ?? {})) {
        const from = specRef(text, `The input "${port}" of "${id}"`);
        const source = docIds.get(from.id);
        if (source === undefined) throw new TypeError(`The input "${port}" of "${id}" names "${from.id}", which is neither a node nor a source of the spec`);
        const edge = { from: { node: source, port: from.port }, to: { node: docIds.get(id)!, port } };
        const known = registry.get(draft.nodes[edge.from.node]!.type) && registry.get(draft.nodes[edge.to.node]!.type);
        if (known) connect(draft, registry, edge.from, edge.to);
        else {
          // The evaluator ignores an edge at a node of unknown type; the document keeps it.
          const edgeId = newId();
          draft.edges[edgeId] = { id: edgeId, ...edge };
        }
      }
    }
  } catch (thrown) {
    for (const source of sources.values()) source.handle.release();
    throw thrown;
  }

  const doc = draft as GraphDoc;
  return {
    doc, sources,
    ids: { toDoc: (id) => docIds.get(id), fromDoc: (id) => specIds.get(id) ?? id },
  };
}

/** Builds the document with newDoc() and the commands of runtime.md 4.6. */
export function makeDoc(spec: GraphSpec): GraphDoc {
  const made = buildSpec(spec);
  built.set(made.doc, made);
  return made.doc;
}

/**
 * A document with one instance of every given node, for whole-registry tests (8.4), each wired as the connected
 * variant of `orogen render` wires it (inputFeeds and feedSource): every input connected, each height from a
 * terrain of its own, an input the wiring knows by name from what it is named for. The document holds nodes of
 * every category, so its first terrain is one for all of them: the eroded noise. A wiring type the registry
 * lacks is left out: its inputs take the terrain itself, and without `ref/combine` there is no chain and no view.
 */
export function registryDoc(defs: readonly NodeDef[]): GraphDoc {
  useNodes(defs);
  const registry = currentRegistry();
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, TEST_SETTINGS);

  const hasFile = (def: NodeDef): boolean => def.params.some((param) => param.kind === 'file');
  const withOutputs = [...new Set(defs)].filter((def) => def.outputs.length > 0);
  // A node whose file is not selected fails, and so does every link of the chain after it: such nodes come last.
  const ordered = [...withOutputs.filter((def) => !hasFile(def)), ...withOutputs.filter(hasFile)];
  const instances = new Map<string, string>();
  ordered.forEach((def, i) => instances.set(def.type, addNode(draft, registry, def.type, { x: 320, y: 160 * i })));

  let wiringRows = 0;
  const made = new Map<string, string>();
  /**
   * The node behind one feed. The instance of the wiring type stands in for the feed it equals: the type of the
   * first terrain at its defaults is that terrain, and a type whose one input the rule below wires from that
   * terrain is the feed made of it. A second node there would have the instance's key: one result, and the
   * second a cache hit.
   */
  const feedNode = (node: FeedNode): string => {
    let id = made.get(node.key);
    if (id !== undefined) return id;
    const read = Object.entries(node.reads).map(([port, from]) => ({ port, key: from.key, from: { node: feedNode(from), port: from.port } }));
    const def = registry.get(node.type)!;
    const instance = instances.get(node.type);
    const only = def.inputs.length === 1 ? inputFeeds(def, true)[def.inputs[0]!.name] : undefined;
    const same = Object.keys(node.params).length === 0 && (read.length === 0
      ? def.inputs.length === 0
      : read.length === 1 && only?.kind === 'terrain' && only.index === 0 && only.named === undefined && read[0]!.key === 'terrain 0');
    if (instance !== undefined && same) id = instance;
    else {
      id = addNode(draft, registry, node.type, { x: 0, y: 160 * wiringRows++ });
      for (const [name, value] of Object.entries(node.params)) setParam(draft, registry, id, name, value);
      for (const { port, from } of read) connect(draft, registry, from, { node: id, port });
    }
    made.set(node.key, id);
    return id;
  };

  for (const def of ordered) {
    const id = instances.get(def.type)!;
    for (const [port, feed] of Object.entries(inputFeeds(def, true))) {
      if (feed === null) continue;
      const { node } = feedSource(registry, feed, null);
      const from = feedNode(node);
      if (from !== id) connect(draft, registry, { node: from, port: node.port }, { node: id, port });
    }
  }

  let end: PortRef | null = null;
  for (const [i, def] of ordered.entries()) {
    const output: PortRef = { node: instances.get(def.type)!, port: def.outputs[0]!.name };
    if (end === null || !registry.get('ref/combine')) {
      end ??= output;
      continue;
    }
    const link = addNode(draft, registry, 'ref/combine', { x: 640, y: 160 * i });
    connect(draft, registry, end, { node: link, port: 'a' });
    connect(draft, registry, output, { node: link, port: 'b' });
    end = { node: link, port: 'out' };
  }
  if (end !== null && (ordered.length === 1 || registry.get('ref/combine'))) setView(draft, { height: end });
  return draft as GraphDoc;
}

export interface GraphOptions {
  readonly res?: number;                       // default: the resolution the document's settings give for `mode`
  readonly mode?: 'preview' | 'build';         // default 'preview'
  readonly outputs?: 'all' | 'needed';         // default 'needed'
  readonly files?: FileSource;                 // default: files under tests/, or under the project file's folder
  readonly signal?: AbortSignal;
  readonly slices?: Slices;
  readonly fieldBudgetBytes?: number;
  readonly onSlice?: SliceListener;
}
export interface GraphRender {
  readonly fields: Readonly<Record<string, FieldData>>;   // by target, for the targets that were produced
  readonly report: EvalReport;
}

interface Opened extends BuiltGraph {
  /** The files of a project file's folder; undefined: those under tests/. */
  readonly files: FileSource | undefined;
  /** The sources were made for this call and are released with it. */
  readonly owned: boolean;
}

const NO_SOURCES: ReadonlyMap<string, SpecSource> = new Map();

function open(graph: GraphDoc | GraphSpec | string): Opened {
  if (typeof graph === 'string') {
    // A relative path is taken from the repository root, whatever the working directory of the test process.
    const file = path.resolve(REPOSITORY, graph);
    const { doc } = parseDoc(fs.readFileSync(file, 'utf8'), currentRegistry());
    return { doc, ids: identityIds(doc), sources: NO_SOURCES, files: NodeFileSource(path.dirname(file)), owned: false };
  }
  if (typeof graph !== 'object' || graph === null) throw new TypeError('A graph is a document, a GraphSpec or the path of a project file');
  if ('format' in graph) {
    const made = built.get(graph);
    return made ? { ...made, files: undefined, owned: false } : { doc: graph, ids: identityIds(graph), sources: NO_SOURCES, files: undefined, owned: false };
  }
  return { ...buildSpec(graph), files: undefined, owned: true };
}

function release(opened: Opened): void {
  if (opened.owned) for (const source of opened.sources.values()) source.handle.release();
}

async function run(opened: Opened, doc: GraphDoc, targets: readonly string[], opts: GraphOptions, cache: 'empty' | 'keep'): Promise<GraphRender> {
  if (!Array.isArray(targets)) throw new TypeError('The targets are a list of \'<node id>.<output port>\' and \'<node id>\'');
  const mode = opts.mode ?? 'preview';
  const res = opts.res ?? (mode === 'build' ? doc.settings.buildResolution : previewResolution(doc.settings));
  for (const [id, source] of opened.sources) {
    if (source.handle.dataAt(res)) continue;
    if (source.fixture === null) throw new RangeError(`The source "${id}" holds no field of ${res} x ${res}: a literal field feeds evaluations at its own size only`);
    source.handle.provide(await fixtures.byName(source.fixture, res));
  }
  const files = opts.files ?? opened.files;
  const { fields, report } = await evaluate({
    doc, ids: opened.ids, targets, resolution: res, mode, outputs: opts.outputs ?? 'needed', slices: opts.slices ?? 'auto',
    cache, requireEmptyCache: mode === 'build',
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.fieldBudgetBytes !== undefined ? { fieldBudgetBytes: opts.fieldBudgetBytes } : {}),
    ...(files ? { files } : {}),
    ...(opts.onSlice ? { onSlice: opts.onSlice } : {}),
  });
  return { fields, report };
}

/** `graph` is a document, a spec, or the path of a project file. A target is '<node id>.<output port>', or '<node id>' to run a node. */
export async function renderGraph(graph: GraphDoc | GraphSpec | string, targets: readonly string[], opts: GraphOptions = {}): Promise<GraphRender> {
  const opened = open(graph);
  try {
    return await run(opened, opened.doc, targets, opts, 'empty');
  } finally {
    release(opened);
  }
}

export interface GraphSession {
  readonly doc: GraphDoc;
  evaluate(targets: readonly string[], opts?: GraphOptions): Promise<GraphRender>;
  setParam(node: string, name: string, value: ParamValue): void;
  setSettings(patch: Partial<ProjectSettings>): void;
  close(): Promise<void>;
}

export async function openGraph(graph: GraphDoc | GraphSpec | string): Promise<GraphSession> {
  const opened = open(graph);
  let doc = opened.doc;
  let closed = false;
  // The first evaluation meets an empty cache, unless another session is at work in it.
  await exclusive(async () => {
    if (sessionsOpen() === 0) await liveEngine()?.trim();
  });
  sessionOpened();
  const edit = (change: (draft: DocDraft) => void): void => {
    if (closed) throw new Error('The GraphSession is closed');
    const draft = structuredClone(doc) as DocDraft;
    change(draft);
    doc = draft as GraphDoc;
  };

  return {
    get doc() { return doc; },
    evaluate(targets, opts = {}) {
      if (closed) return Promise.reject(new Error('The GraphSession is closed'));
      return run(opened, doc, targets, opts, 'keep');
    },
    setParam(node, name, value) {
      const id = opened.ids.toDoc(node);
      if (id === undefined) throw new Error(`The graph has no node "${node}"`);
      edit((draft) => setParam(draft, currentRegistry(), id, name, value));
    },
    setSettings(patch) {
      edit((draft) => setSettings(draft, patch));
    },
    async close() {
      if (closed) return;
      closed = true;
      sessionClosed();
      try {
        await exclusive(async () => {
          const engine = liveEngine();
          if (!engine) return;
          await engine.trim();
          checkLeaks(engine, true);
        });
      } finally {
        release(opened);
      }
    },
  };
}
