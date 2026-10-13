import fs from 'node:fs';
import path from 'node:path';

import { parseDoc, type BuildEvent, type BuildPlan, type BuildProblem, type BuildResult, type FileSource, type GraphDoc } from '../../src/core/runtime.ts';
import { buildProject } from '../../src/export/build.ts';
import { NodeFileSource } from '../../src/platform/node/files.ts';
import { currentRegistry, exclusive, nextRequestId, obtainEngine, REPOSITORY, TEST_FILES } from './engine.ts';
import { identityIds, sessionsOpen, type IdMap } from './evaluate.ts';
import { fixtures } from './fixtures.ts';
import { buildSpec, type BuiltGraph, type GraphSpec } from './graph.ts';
import { checkLeaks } from './leaks.ts';
import { memorySink, type MemorySink } from './memory-files.ts';

interface Opened {
  readonly doc: GraphDoc;
  readonly ids: IdMap;
  /** The sources of a spec: made for this call, fed at the build resolution and released with it. */
  readonly sources: BuiltGraph['sources'] | null;
  /** The files of a project file's folder; undefined: those under tests/. */
  readonly files: FileSource | undefined;
}

function open(graph: GraphDoc | GraphSpec | string): Opened {
  if (typeof graph === 'string') {
    // A relative path is taken from the repository root, whatever the working directory of the test process.
    const file = path.resolve(REPOSITORY, graph);
    const { doc } = parseDoc(fs.readFileSync(file, 'utf8'), currentRegistry());
    return { doc, ids: identityIds(doc), sources: null, files: NodeFileSource(path.dirname(file)) };
  }
  if (typeof graph !== 'object' || graph === null) throw new TypeError('A graph is a document, a GraphSpec or the path of a project file');
  if ('format' in graph) return { doc: graph, ids: identityIds(graph), sources: null, files: undefined };
  const made = buildSpec(graph);
  return { doc: made.doc, ids: made.ids, sources: made.sources, files: undefined };
}

/** The node ids of a build's problems, plan and events as the caller wrote them: those of a GraphSpec, or the document's own. */
function renamed(ids: IdMap) {
  const id = <T extends string | null | undefined>(value: T): T => (typeof value === 'string' ? ids.fromDoc(value) as T : value);
  const problem = (p: BuildProblem): BuildProblem => (p.nodeId === undefined ? p : { ...p, nodeId: id(p.nodeId) });
  const plan = (p: BuildPlan): BuildPlan => ({
    ...p,
    items: p.items.map((entry) => ({ nodeId: id(entry.nodeId), item: { ...entry.item, source: { ...entry.item.source, node: id(entry.item.source.node) } } })),
    targets: p.targets.map((target) => ({ ...target, node: id(target.node) })),
    layers: p.layers.map((layer) => ({ ...layer, nodeId: id(layer.nodeId) })),
    files: p.files.map((file) => ({ ...file, nodeId: id(file.nodeId) })),
    problems: p.problems.map(problem),
  });
  const result = (r: BuildResult): BuildResult => ({ ...r, problems: r.problems.map(problem) });
  const event = (e: BuildEvent): BuildEvent => {
    switch (e.type) {
      case 'build-plan': return { ...e, plan: plan(e.plan) };
      case 'build-target': return { ...e, nodeId: id(e.nodeId) };
      case 'build-problem': return { ...e, problem: problem(e.problem) };
      case 'build-result': return { ...e, result: result(e.result) };
      default: return e;
    }
  };
  return { result, event };
}

const BUILD_EVENTS: ReadonlySet<string> = new Set<BuildEvent['type']>(['build-plan', 'build-target', 'build-progress', 'build-problem', 'build-result']);

/**
 * buildProject (export-unreal.md 3.1) with the process's engine as host and a new MemorySink. The build starts
 * on an emptied cache unless a GraphSession is open, and ends with the leak check of testing.md 2.8. Node ids in
 * the result and the events are those of the spec. A document made by makeDoc is built as it is: its fixture
 * sources hold data at the resolutions it was evaluated at, so a graph with sources is given as its spec.
 */
export function buildGraph(graph: GraphDoc | GraphSpec | string, opts?: {
  readonly resolution?: number;
  readonly files?: FileSource;
  readonly signal?: AbortSignal;
}): Promise<{ readonly result: BuildResult; readonly sink: MemorySink; readonly events: readonly BuildEvent[] }> {
  const opened = open(graph);
  const release = (): void => {
    for (const source of opened.sources?.values() ?? []) source.handle.release();
  };
  const resolution = opts?.resolution ?? opened.doc.settings.buildResolution;
  const names = renamed(opened.ids);

  return exclusive(async () => {
    const { engine } = await obtainEngine('auto');
    for (const [id, source] of opened.sources ?? []) {
      if (source.handle.dataAt(resolution)) continue;
      if (source.fixture === null) throw new RangeError(`The source "${id}" holds no field of ${resolution} x ${resolution}: a literal field feeds a build at its own size only`);
      source.handle.provide(await fixtures.byName(source.fixture, resolution));
    }
    if (sessionsOpen() === 0) await engine.trim();
    const cacheBefore = engine.memory().cacheBytes;
    const files = opts?.files ?? opened.files;
    if (files) engine.setFiles(files);

    const sink = memorySink();
    const events: BuildEvent[] = [];
    let result: BuildResult;
    try {
      result = await buildProject(engine, {
        doc: opened.doc, sink, requestId: nextRequestId(),
        ...(opts?.resolution !== undefined ? { resolution: opts.resolution } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        onEvent(event) {
          if (BUILD_EVENTS.has(event.type)) events.push(names.event(event as BuildEvent));
        },
      });
    } finally {
      if (files) engine.setFiles(TEST_FILES);
    }
    // A build neither reads nor writes the cache; while a GraphSession is open its entries are the cache.
    checkLeaks(engine, sessionsOpen() === 0 || engine.memory().cacheBytes > cacheBefore);
    return { result: names.result(result), sink, events };
  }).finally(release);
}
