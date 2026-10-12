// Graphs through the harness (testing.md 2.4): makeDoc, renderGraph on a spec, a document and a project file,
// and openGraph with its cache. Every evaluation is Engine.evaluate on the process's engine.
//
// Sizes: fields of at most 129 x 129; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import fbm from '../../../src/core/nodes/ref/fbm.ts';
import talus from '../../../src/core/nodes/ref/talus.ts';
import { parseDoc, serializeDoc, type GraphDoc } from '../../../src/core/runtime.ts';
import {
  at, channelOf, expectClose, expectIdentical, expectNoLeaks, expectStats, fieldOf, fixtures, getEngine, makeDoc, memorySource, openGraph,
  registryDoc, renderGraph, TEST_SETTINGS, useNodes, type FieldData, type GraphSpec,
} from '../../helpers/index.ts';
import { dim, firstByte, harnessNodes, splitCalls } from './nodes.ts';

useNodes(harnessNodes);

const times = (f: FieldData, factor: number): FieldData => fieldOf(f.width, (u, v) => at(f, Math.round(u * (f.width - 1)), Math.round(v * (f.height - 1))) * factor);
/** Build resolution 129 with previews at 65: small fields in both modes. */
const SMALL = { buildResolution: 129, previewLevel: 1 } as const;
const OUTPUT = process.env.OROGEN_TEST_OUTPUT ? path.resolve(process.env.OROGEN_TEST_OUTPUT) : path.resolve(import.meta.dirname, '../../../test-output');

const chain: GraphSpec = {
  settings: SMALL,
  sources: { land: 'terrain' },
  nodes: {
    double: { type: 'ref/h-scale', inputs: { in: 'land.out' } },
    triple: { type: 'ref/h-scale', params: { factor: 3 }, inputs: { in: 'double.out' } },
    parts: { type: 'ref/h-split', inputs: { in: 'triple.out' } },
  },
};

// ---- makeDoc -------------------------------------------------------------------------------------------------------

test('makeDoc builds the document with the commands: generated ids, stored defaults, normalised params, valid edges', () => {
  const doc = makeDoc({
    settings: { seed: 9, heightRange: 500 },
    sources: { land: fixtures.cone(65) },
    nodes: {
      a: { type: 'ref/h-scale', params: { factor: 1e6 }, inputs: { in: 'land.out', mask: 'land.out' } },
      b: { type: 'ref/h-split', inputs: { in: 'a.out' }, bypass: true },
      c: { type: 'ref/h-probe' },
    },
  });
  assert.deepEqual([doc.format, doc.version], ['orogen', 1]);
  assert.deepEqual(doc.settings, { ...TEST_SETTINGS, seed: 9, heightRange: 500 }, 'merged over the test settings');
  const nodes = Object.values(doc.nodes);
  assert.equal(nodes.length, 4, 'three nodes and the source');
  for (const node of nodes) assert.match(node.id, /^[0-9a-z]{10}$/, 'the commands generate the ids');
  const byType = (type: string): GraphDoc['nodes'][string] => nodes.find((node) => node.type === type)!;
  assert.deepEqual(byType('ref/h-scale').params, { factor: 100 }, 'stored through setParam: clamped to the hard limit');
  assert.deepEqual(byType('ref/h-probe').params, { what: 'value', value: 0.5 }, 'every default is stored');
  assert.equal(byType('ref/h-split').bypass, true);
  assert.equal(typeof byType('ref/harness-source').params.data, 'string');
  const edges = Object.values(doc.edges).map((edge) => `${doc.nodes[edge.from.node]!.type}.${edge.from.port} -> ${doc.nodes[edge.to.node]!.type}.${edge.to.port}`).sort();
  assert.deepEqual(edges, ['ref/h-scale.out -> ref/h-split.in', 'ref/harness-source.out -> ref/h-scale.in', 'ref/harness-source.out -> ref/h-scale.mask']);
  assert.deepEqual(JSON.parse(serializeDoc(doc)), doc, 'plain JSON');

  // A colour is fed by the colour source type.
  const colored = makeDoc({ sources: { paint: 'color' }, nodes: { dim: { type: 'ref/h-dim', inputs: { in: 'paint.out' } } } });
  assert.ok(Object.values(colored.nodes).some((node) => node.type === 'ref/harness-source-color'));
});

test('makeDoc refuses what a spec gets wrong, and keeps a node of a type the registry lacks', () => {
  assert.throws(() => makeDoc({ nodes: { Bad: { type: 'ref/h-probe' } } }), /The id "Bad" of a node does not match/);
  assert.throws(() => makeDoc({ sources: { 'a-b': 'one' }, nodes: {} }), /The id "a-b" of a source does not match/);
  assert.throws(() => makeDoc({ sources: { a: 'one' }, nodes: { a: { type: 'ref/h-probe' } } }), /The id "a" is used twice/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-scale', inputs: { in: 'ghost.out' } } } }), /names "ghost", which is neither a node nor a source/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-scale', inputs: { in: 'a' } } } }), /is '<node or source id>\.<output port>'/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-scale', params: { gain: 1 } } } }), /has no parameter "gain"/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-probe' }, b: { type: 'ref/h-scale', inputs: { in: 'a.half' } } } }), /has no output "half"/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-probe' }, b: { type: 'ref/h-scale', inputs: { input: 'a.out' } } } }), /has no input "input"/);
  assert.throws(() => makeDoc({ nodes: { a: { type: 'ref/h-scale', inputs: { in: 'b.out' } }, b: { type: 'ref/h-scale', inputs: { in: 'a.out' } } } }), /cycle/);
  assert.throws(() => makeDoc({ sources: { a: { kind: 'field', width: 3, height: 3, channels: 1, data: new Float32Array(4) } }, nodes: {} }), RangeError);

  const doc = makeDoc({ nodes: { old: { type: 'legacy/unknown', params: { foo: 1, bar: 'x' } }, after: { type: 'ref/h-scale', inputs: { in: 'old.out' } } } });
  const old = Object.values(doc.nodes).find((node) => node.type === 'legacy/unknown')!;
  assert.deepEqual([old.params, old.version], [{ foo: 1, bar: 'x' }, 1]);
  assert.equal(Object.keys(doc.edges).length, 1, 'its edge is kept, as a file would hold it');
});

// ---- renderGraph ---------------------------------------------------------------------------------------------------

test('renderGraph: one preview evaluation of a spec, with targets, fields and report under the ids of the spec', async () => {
  splitCalls.count = splitCalls.halves = 0;
  const { fields, report } = await renderGraph(chain, ['parts.out', 'double.out', 'triple']);
  assert.deepEqual(Object.keys(fields).sort(), ['double.out', 'parts.out'], 'a node target returns no field');
  assert.equal(fields['parts.out']!.width, 65, 'the preview resolution of the settings');
  const land = fixtures.terrain(65);
  expectIdentical(fields['double.out']!, times(land, 2));
  expectClose(fields['parts.out']!, times(land, 6), { max: 1e-6 });
  assert.equal(report.status, 'ok');
  assert.deepEqual(Object.keys(report.nodes).sort(), ['double', 'land', 'parts', 'triple']);
  assert.ok(Object.values(report.nodes).every((node) => node.state === 'done'));
  assert.deepEqual([report.nodesRun, report.nodesCached], [4, 0]);
  const start = report.events[0]!;
  assert.ok(start.type === 'eval-start' && start.mode === 'preview' && start.resolution === 65);
  // `outputs` is 'needed' unless asked otherwise: nobody reads `half`.
  assert.deepEqual(splitCalls, { count: 1, halves: 0 });
  await renderGraph(chain, ['parts.out'], { outputs: 'all' });
  assert.deepEqual(splitCalls, { count: 2, halves: 1 }, 'each call is one evaluation on an emptied cache');
  await expectNoLeaks();
});

test('renderGraph: mode, res and the resolution the settings give; a fixture source is made at each', async () => {
  const build = await renderGraph(chain, ['double.out'], { mode: 'build' });
  assert.equal(build.fields['double.out']!.width, 129, 'the build resolution of the settings');
  const start = build.report.events[0]!;
  assert.ok(start.type === 'eval-start' && start.mode === 'build');
  expectIdentical(build.fields['double.out']!, times(fixtures.terrain(129), 2));
  assert.equal((await getEngine()).engine.memory().cacheBytes, 0, 'a build leaves nothing in the cache');
  const at33 = await renderGraph(chain, ['double.out'], { res: 33 });
  expectIdentical(at33.fields['double.out']!, times(fixtures.terrain(33), 2));

  // A literal field feeds evaluations at its own size only.
  const literal: GraphSpec = { settings: SMALL, sources: { land: fixtures.cone(65) }, nodes: { double: { type: 'ref/h-scale', inputs: { in: 'land.out' } } } };
  expectIdentical((await renderGraph(literal, ['double.out'])).fields['double.out']!, times(fixtures.cone(65), 2));
  await assert.rejects(renderGraph(literal, ['double.out'], { mode: 'build' }), /The source "land" holds no field of 129 x 129/);
  await assert.rejects(renderGraph(chain, ['double.out'], { res: 100000 }), RangeError);
});

test('renderGraph resolves whatever the status, and describes every node; it rejects only for a malformed call', async () => {
  const broken: GraphSpec = {
    settings: SMALL,
    sources: { land: 'cone' },
    nodes: {
      good: { type: 'ref/h-scale', inputs: { in: 'land.out' } },
      bad: { type: 'ref/h-fail', params: { message: 'Reference failure' }, inputs: { in: 'land.out' } },
      down: { type: 'ref/h-scale', inputs: { in: 'bad.out' } },
      ghost: { type: 'legacy/unknown', params: { foo: 1 }, inputs: { in: 'land.out' } },
      after: { type: 'ref/h-scale', inputs: { in: 'ghost.out' } },
      open: { type: 'ref/h-scale' },
      idle: { type: 'ref/h-scale', params: { factor: 7 }, inputs: { in: 'good.out' }, bypass: true },
    },
  };
  const { fields, report } = await renderGraph(broken, ['good.out', 'down.out', 'after.out', 'idle.out', 'ghost', 'open']);
  assert.equal(report.status, 'errors');
  assert.deepEqual(Object.keys(fields).sort(), ['good.out', 'idle.out'], 'a failed or skipped target is absent');
  expectIdentical(fields['idle.out']!, fields['good.out']!);
  const state = (id: string): string => {
    const node = report.nodes[id]!;
    return node.state === 'error' ? `error:${node.error!.kind}` : node.state === 'skipped' ? `skipped:${node.skipReason}:${node.upstream}` : node.state;
  };
  assert.deepEqual(
    ['land', 'good', 'bad', 'down', 'ghost', 'after', 'open', 'idle'].map((id) => `${id} ${state(id)}`),
    ['land done', 'good done', 'bad error:node-exception', 'down skipped:upstream:bad', 'ghost error:unknown-type', 'after error:missing-input', 'open error:missing-input', 'idle bypassed'],
  );
  assert.deepEqual([report.nodes.bad!.error!.message, report.nodes.bad!.error!.nodeId, report.nodes.open!.error!.message], ['Reference failure', 'bad', 'missing input "in"']);
  await expectNoLeaks();

  await assert.rejects(renderGraph(broken, ['nobody.out']), /The target "nobody.out" names no node of the graph/);
  await assert.rejects(renderGraph(broken, ['good.half']), TypeError, 'an output the node lacks');
  await assert.rejects(renderGraph(broken, 'good.out' as never), TypeError);
  await assert.rejects(renderGraph(7 as never, []), TypeError);
});

test('renderGraph: conversions, a mask as an input, the budget, slices and an abort', async () => {
  const mixed: GraphSpec = {
    settings: SMALL,
    sources: { land: 'terrain', paint: 'color', half: fieldOf(65, () => 0.5) },
    nodes: {
      grey: { type: 'ref/h-dim', inputs: { in: 'land.out' } },                               // a field on a colour input
      luma: { type: 'ref/h-scale', params: { factor: 1 }, inputs: { in: 'paint.out' } },     // a colour on a field input
      soft: { type: 'ref/h-scale', inputs: { in: 'land.out', mask: 'half.out' } },
      climb: { type: 'ref/h-climb', inputs: { in: 'land.out' } },
    },
  };
  const { fields } = await renderGraph(mixed, ['grey.out', 'luma.out', 'soft.out']);
  const land = fixtures.terrain(65), paint = fixtures.color(65);
  expectClose(channelOf(fields['grey.out']!, 1), times(land, 0.5), { max: 2e-3 });
  expectStats(fields['grey.out']!, { min: 1, max: 1 }, 3);
  const luma = fieldOf(65, (u, v) => {
    const x = Math.round(u * 64), y = Math.round(v * 64);
    return 0.2126 * at(paint, x, y, 0) + 0.7152 * at(paint, x, y, 1) + 0.0722 * at(paint, x, y, 2);
  });
  expectClose(fields['luma.out']!, luma, { max: 2e-3 });
  expectClose(fields['soft.out']!, times(land, 1.5), { max: 1e-6 });

  // Too little memory for the fields: the node reports `budget`, and the call resolves.
  const tight = await renderGraph(mixed, ['climb.out'], { fieldBudgetBytes: 2 * 65 * 65 * 4 });
  assert.deepEqual([tight.report.status, tight.report.nodes.climb!.state, tight.report.nodes.climb!.error?.kind], ['errors', 'error', 'budget']);
  assert.equal((await getEngine()).engine.memory().budgetBytes, 1_073_741_824);

  const heard: (string | null)[] = [];
  const controller = new AbortController();
  const aborted = await renderGraph(mixed, ['climb.out'], {
    slices: 'small', signal: controller.signal,
    onSlice: (slice) => {
      heard.push(slice.nodeId);
      if (slice.nodeId === 'climb') controller.abort();
    },
  });
  assert.deepEqual([aborted.report.status, aborted.report.nodes.climb!.state, aborted.report.nodes.climb!.skipReason], ['aborted', 'skipped', 'aborted']);
  assert.deepEqual(Object.keys(aborted.fields), []);
  assert.ok(heard.includes('climb'));
  await expectNoLeaks();
});

test('renderGraph takes a document of makeDoc with the ids of its spec, any other document with its own, and a project file', async () => {
  const made = makeDoc(chain);
  const fromSpecIds = await renderGraph(made, ['triple.out']);
  expectClose(fromSpecIds.fields['triple.out']!, times(fixtures.terrain(65), 6), { max: 1e-6 });
  assert.ok(fromSpecIds.report.nodes.triple && fromSpecIds.report.nodes.land);

  // A document that did not come from makeDoc: a copy, as a file read back would be.
  const { doc } = parseDoc(serializeDoc(makeDoc({ settings: SMALL, nodes: { level: { type: 'ref/h-probe', params: { value: 0.75 } } } })), (await getEngine()).engine.registry);
  const id = Object.keys(doc.nodes)[0]!;
  const own = await renderGraph(doc, [`${id}.out`, id]);
  expectStats(own.fields[`${id}.out`]!, { min: 0.75, max: 0.75 });
  assert.deepEqual(Object.keys(own.report.nodes), [id]);

  // A project file: its ids, and files beside it.
  const folder = path.join(OUTPUT, 'harness', 'graph');
  mkdirSync(path.join(folder, 'assets'), { recursive: true });
  writeFileSync(path.join(folder, 'assets', 'level.bin'), new Uint8Array([51, 0]));
  const project = {
    format: 'orogen', version: 1, settings: { ...TEST_SETTINGS, ...SMALL },
    nodes: {
      'byte.1': { id: 'byte.1', type: 'ref/h-byte', version: 1, position: { x: 0, y: 0 }, params: { file: 'assets/level.bin' } },
      twice: { id: 'twice', type: 'ref/h-scale', version: 1, position: { x: 200, y: 0 }, params: { factor: 2 } },
    },
    edges: { e1: { id: 'e1', from: { node: 'byte.1', port: 'out' }, to: { node: 'twice', port: 'in' } } },
    groups: {}, ui: {},
  };
  const file = path.join(folder, 'project.orogen');
  writeFileSync(file, serializeDoc(project as unknown as GraphDoc));
  const fromFile = await renderGraph(file, ['twice.out', 'byte.1.out', 'byte.1']);
  assert.deepEqual(Object.keys(fromFile.report.nodes).sort(), ['byte.1', 'twice'], 'the ids of the file, also one with a dot');
  expectStats(fromFile.fields['byte.1.out']!, { min: 0.2, max: 0.2 });
  expectStats(fromFile.fields['twice.out']!, { min: 0.4, max: 0.4 });
  // A relative path is taken from the repository root.
  const relative = await renderGraph(path.relative(path.resolve(import.meta.dirname, '../../..'), file), ['twice.out']);
  expectStats(relative.fields['twice.out']!, { min: 0.4, max: 0.4 });

  // For a spec or a document a relative file is one under tests/; `files` replaces them for one evaluation.
  const bytes: GraphSpec = { settings: SMALL, nodes: { byte: { type: 'ref/h-byte', params: { file: 'env/max.env' } } } };
  const firstOfMaxEnv = 'O'.charCodeAt(0) / 255;
  expectClose((await renderGraph(bytes, ['byte.out'])).fields['byte.out']!, fieldOf(65, () => firstOfMaxEnv), { max: 0 });
  const memory = memorySource({ 'env/max.env': new Uint8Array([255]) });
  expectStats((await renderGraph(bytes, ['byte.out'], { files: memory })).fields['byte.out']!, { min: 1, max: 1 });
  expectClose((await renderGraph(bytes, ['byte.out'])).fields['byte.out']!, fieldOf(65, () => firstOfMaxEnv), { max: 0 });
  const missing = await renderGraph({ settings: SMALL, nodes: { byte: { type: 'ref/h-byte', params: { file: 'env/none.bin' } } } }, ['byte.out']);
  assert.deepEqual([missing.report.nodes.byte!.state, missing.report.nodes.byte!.error?.kind], ['error', 'io']);
});

// ---- openGraph -----------------------------------------------------------------------------------------------------

test('openGraph keeps the cache between evaluations: an unchanged node is a hit, an edit runs it and what reads it', async () => {
  const session = await openGraph(chain);
  const states = (report: Awaited<ReturnType<typeof session.evaluate>>['report']): string => ['land', 'double', 'triple', 'parts'].map((id) => report.nodes[id]?.state ?? '-').join(' ');
  const first = await session.evaluate(['parts.out']);
  assert.equal(states(first.report), 'done done done done');
  const second = await session.evaluate(['parts.out']);
  assert.equal(states(second.report), 'cached cached cached cached');
  assert.deepEqual([second.report.nodesRun, second.report.nodesCached], [0, 4]);
  expectIdentical(second.fields['parts.out']!, first.fields['parts.out']!);

  const before = session.doc;
  session.setParam('triple', 'factor', 5);
  assert.notEqual(session.doc, before, 'the document is replaced, not changed');
  assert.deepEqual(Object.values(before.nodes).find((node) => node.params.factor === 3)?.type, 'ref/h-scale');
  const third = await session.evaluate(['parts.out']);
  assert.equal(states(third.report), 'cached cached done done');
  expectClose(third.fields['parts.out']!, times(fixtures.terrain(65), 10), { max: 1e-6 });

  // Another resolution is other content; the sources of a fixture follow.
  const coarse = await session.evaluate(['parts.out'], { res: 33 });
  assert.equal(states(coarse.report), 'done done done done');
  expectClose(coarse.fields['parts.out']!, times(fixtures.terrain(33), 10), { max: 1e-6 });
  assert.equal(states((await session.evaluate(['parts.out'])).report), 'cached cached cached cached', 'the entries at 65 are still there');

  assert.throws(() => session.setParam('nobody', 'factor', 1), /The graph has no node "nobody"/);
  assert.throws(() => session.setParam('triple', 'gain', 1), /has no parameter "gain"/);
  assert.ok((await getEngine()).engine.memory().cacheBytes > 0);
  await session.close();
  await session.close();
  assert.equal((await getEngine()).engine.memory().cacheBytes, 0, 'close() empties the cache');
  await assert.rejects(session.evaluate(['parts.out']), /closed/);
  assert.throws(() => session.setParam('triple', 'factor', 1), /closed/);
  await expectNoLeaks();
});

test('openGraph: settings enter the keys of the nodes that read them; a file is re-read when its identity changes', async () => {
  const files = memorySource({ 'level.bin': new Uint8Array([51]) });
  const session = await openGraph({
    settings: SMALL,
    nodes: {
      byte: { type: 'ref/h-byte', params: { file: 'level.bin' } },
      sea: { type: 'ref/h-probe', params: { what: 'sea' } },
      fixed: { type: 'ref/fbm' },
    },
  });
  const states = (report: Awaited<ReturnType<typeof session.evaluate>>['report']): string => ['byte', 'sea', 'fixed'].map((id) => report.nodes[id]!.state).join(' ');
  const targets = ['byte.out', 'sea.out', 'fixed.out'];
  const first = await session.evaluate(targets, { files });
  assert.equal(states(first.report), 'done done done');
  expectStats(first.fields['sea.out']!, { min: 0.25, max: 0.25 });
  assert.equal(states((await session.evaluate(targets, { files })).report), 'cached cached cached');

  session.setSettings({ seaLevel: 0.5 });
  assert.equal(session.doc.settings.seaLevel, 0.5);
  const second = await session.evaluate(targets, { files });
  assert.equal(states(second.report), 'cached done cached', 'only the node that declares the setting');
  expectStats(second.fields['sea.out']!, { min: 0.5, max: 0.5 });

  // The same bytes put again are a newer file (runtime.md 6.1 rule 5); other bytes at the same time are not seen.
  files.put('level.bin', new Uint8Array([102]));
  const third = await session.evaluate(targets, { files });
  assert.equal(states(third.report), 'done cached cached');
  expectStats(third.fields['byte.out']!, { min: 0.4, max: 0.4 });
  assert.equal(states((await session.evaluate(targets, { files })).report), 'cached cached cached', 'an untouched file leaves the node cached');
  await session.close();
});

// ---- registryDoc and the wiring types the registry has ---------------------------------------------------------------

test('registryDoc: a wiring type the registry lacks is left out, and without ref/combine there is no chain and no view', async () => {
  // registry-doc.test.ts tests the wiring with all three types. This process registers none of its own, so it
  // sees what src/core/nodes/ref/ holds: each expectation below follows from whether the type is there.
  const { engine } = await getEngine();
  const has = (type: string): boolean => engine.registry.get(type) !== undefined;
  const doc = registryDoc([firstByte, fbm, talus, dim]);
  const count = (type: string): number => Object.values(doc.nodes).filter((node) => node.type === type).length;
  assert.deepEqual([count('ref/fbm'), count('ref/talus'), count('ref/h-dim'), count('ref/h-byte')], [1, 1, 1, 1], 'one instance each');
  assert.equal(count('ref/colorize'), has('ref/colorize') ? 1 : 0);
  assert.equal(count('ref/combine'), has('ref/combine') ? 3 : 0, 'a link for every instance after the first, or none');
  assert.equal(doc.ui.view !== undefined, has('ref/combine'), 'the view is the end of the chain');

  const feed = (type: string, port: string): string | undefined => {
    const edge = Object.values(doc.edges).find((e) => doc.nodes[e.to.node]!.type === type && e.to.port === port);
    return edge && doc.nodes[edge.from.node]!.type;
  };
  assert.equal(feed('ref/talus', 'in'), 'ref/fbm');
  assert.equal(feed('ref/h-dim', 'in'), has('ref/colorize') ? 'ref/colorize' : 'ref/fbm', 'without ref/colorize a colour input takes the fbm itself: the evaluator converts');

  // Naming every node as a target evaluates the document with or without a chain (tests/graphs/registry.test.ts).
  const { report } = await renderGraph(doc, Object.keys(doc.nodes), { res: 129, outputs: 'all' });
  const states = Object.fromEntries(Object.values(report.nodes).map((node) => [doc.nodes[node.nodeId]!.type, node.state]));
  assert.deepEqual([states['ref/fbm'], states['ref/talus'], states['ref/h-dim'], states['ref/h-byte']], ['done', 'done', 'done', 'error']);
  assert.equal(Object.keys(report.nodes).length, Object.keys(doc.nodes).length);
});
