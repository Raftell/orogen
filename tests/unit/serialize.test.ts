// Project files (runtime.md 4.5): parseDoc row by row of its table, serializeDoc, round trips, migration
// (engine.md 4.6) and the ids of newId.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadNode, migrateNode } from '../../src/core/graph/migrate.ts';
import {
  DocFormatError, newDoc, newId, parseDoc, serializeDoc,
  type DocProblem, type Edge, type GraphDoc, type NodeInstance,
} from '../../src/core/runtime.ts';
import { combine, node, registry } from './graph-fixtures.ts';
import { createRegistry } from '../../src/core/api.ts';

const SETTINGS = { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25 };

type Loose = Record<string, unknown>;
const file = (over: Loose = {}): Loose => ({ format: 'orogen', version: 1, settings: SETTINGS, nodes: {}, edges: {}, groups: {}, ui: {}, ...over });
const instance = (id: string, type: string, params: Loose = {}, over: Loose = {}): Loose => ({ id, type, version: 1, position: { x: 0, y: 0 }, params, ...over });
const edge = (id: string, from: string, to: string): Edge => {
  const [fn, fp] = from.split('.') as [string, string];
  const [tn, tp] = to.split('.') as [string, string];
  return { id, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
};
const parse = (content: Loose): { doc: GraphDoc; problems: readonly DocProblem[] } => parseDoc(JSON.stringify(content), registry);
const messages = (problems: readonly DocProblem[]): string[] => problems.map((p) => p.message);

// ---- what is no project file -----------------------------------------------------------------------------------

test('parseDoc throws DocFormatError for text that is no project of this version', () => {
  const fails = (text: string, message: RegExp): void => {
    assert.throws(() => parseDoc(text, registry), (error: unknown) => {
      assert.ok(error instanceof DocFormatError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'DocFormatError');
      assert.match(error.message, message);
      return true;
    });
  };
  fails('', /not JSON/);
  fails('{ "format": "orogen", ', /not JSON/);
  fails('null', /"format" is not "orogen"/);
  fails('[]', /"format" is not "orogen"/);
  fails('"orogen"', /"format" is not "orogen"/);
  fails('{}', /"format" is not "orogen"/);
  fails(JSON.stringify(file({ format: 'gaea' })), /"format" is not "orogen"/);
  fails(JSON.stringify(file({ version: 2 })), /written by a newer version of Orogen/);
  fails(JSON.stringify(file({ version: 1.5 })), /written by a newer version of Orogen/);
});

// ---- serializeDoc and round trips ------------------------------------------------------------------------------

test('serializeDoc: JSON.stringify(doc, null, 2) and a newline', () => {
  const doc = newDoc();
  assert.equal(serializeDoc(doc), `${JSON.stringify(doc, null, 2)}\n`);
  assert.ok(serializeDoc(doc).startsWith('{\n  "format": "orogen",\n  "version": 1,\n  "settings": {\n    "terrainSize": 5000,'));
  assert.ok(serializeDoc(doc).endsWith('}\n'));
});

test('a new document parses without problems to an equal document', () => {
  const parsed = parseDoc(serializeDoc(newDoc()), registry);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc, newDoc());
});

test('a valid file is returned as it is and written back byte for byte, in the order it holds its members', () => {
  // Members deliberately not in the order the commands write them.
  const content = {
    version: 1,
    format: 'orogen',
    ui: { graphViewport: { zoom: 2, y: 1, x: 0 }, view: { locked: false, height: { port: 'out', node: 'fbm' } } },
    edges: { e1: { to: { port: 'in', node: 'soft' }, from: { node: 'fbm', port: 'out' }, id: 'e1' } },
    nodes: {
      soft: { params: { radius: 0.01 }, position: { y: 5, x: 200 }, version: 1, type: 'ref/soften', id: 'soft', bypass: true, title: 'Soft', collapsed: false },
      fbm: { id: 'fbm', type: 'ref/gen', version: 1, position: { x: 0, y: 0 }, params: { count: 3, later: [1, 2, 3] }, post: [{ kind: 'reserved' }] },
    },
    groups: { g: { rect: { h: 4, w: 3, y: 2, x: 1 }, color: '#79461D', title: 'Group', id: 'g' } },
    settings: { seaLevel: 0.25, previewLevel: 1, buildResolution: 513, seed: 1, heightRange: 1024, terrainSize: 4096 },
    appData: { anything: true },
  };
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const parsed = parseDoc(text, registry);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc, content);
  assert.equal(serializeDoc(parsed.doc), text);
});

// ---- settings --------------------------------------------------------------------------------------------------

test('a setting missing or invalid: the default, or the value clamped, with a problem', () => {
  const parsed = parse(file({ settings: { terrainSize: -5, heightRange: 1024, buildResolution: 513, previewLevel: 9, seaLevel: 'low' } }));
  assert.deepEqual(parsed.doc.settings, { terrainSize: 1, heightRange: 1024, buildResolution: 513, previewLevel: 4, seaLevel: 0, seed: 0 });
  assert.deepEqual(messages(parsed.problems), [
    'setting "terrainSize": -5 is not in 1..1000000; 1 is used',
    'setting "seed" is missing; the default 0 is used',
    'setting "previewLevel": level 9 is not defined for build resolution 513; lowered to 4',
    'setting "seaLevel": "low" is not a finite number; the default 0 is used',
  ]);
  assert.ok(parsed.problems.every((p) => p.nodeId === undefined && p.edgeId === undefined));

  const none = parse(file({ settings: undefined }));
  assert.deepEqual(none.doc.settings, { terrainSize: 5000, heightRange: 2500, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0 });
  assert.equal(none.problems.length, 6);
  assert.deepEqual(parse(file({ settings: [1, 2] })).doc.settings, none.doc.settings);
});

// ---- nodes -----------------------------------------------------------------------------------------------------

test('a node of an unknown type: unchanged, every member kept, with a problem', () => {
  const ghost = instance('ghost', 'legacy/unknown', { foo: 1, bar: 'x' }, { version: 7, title: 'Old', bypass: true, extra: { deep: [1, 2] } });
  const parsed = parse(file({ nodes: { ghost } }));
  assert.deepEqual(parsed.doc.nodes.ghost, ghost);
  assert.deepEqual(parsed.problems, [{ nodeId: 'ghost', message: 'Unknown node type "legacy/unknown"' }]);
});

test('a node with a lower version: migrate once per step, version raised', () => {
  const parsed = parse(file({ nodes: { old: instance('old', 'ref/combine', { mode: 'mix', amount: 25 }, { title: 'Mix' }) } }));
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc.nodes.old, { id: 'old', type: 'ref/combine', version: 2, position: { x: 0, y: 0 }, params: { mode: 'mix', strength: 0.25 }, title: 'Mix' });
  assert.deepEqual(Object.keys(parsed.doc.nodes.old!), ['id', 'type', 'version', 'position', 'params', 'title']);
});

test('migrate runs once per step with the version it migrates from, on a copy', () => {
  const calls: number[] = [];
  const stepped = node({
    type: 'ref/stepped',
    params: [{ kind: 'int', name: 'count', help: 'A count.', default: 0, min: 0, max: 100 }],
    version: 4,
    migrate(params, from) {
      calls.push(from);
      const count = params.count as number;
      delete params.scratch;                 // changing the argument is harmless: it is a copy
      return { ...params, count: count + 10 ** (from - 1) };
    },
  });
  const stored: NodeInstance = { id: 'n', type: 'ref/stepped', version: 2, position: { x: 1, y: 2 }, params: { count: 0, scratch: [1] } };
  const before = JSON.stringify(stored);
  const migrated = migrateNode(stepped, stored);
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual(migrated, { id: 'n', type: 'ref/stepped', version: 4, position: { x: 1, y: 2 }, params: { count: 110 } });
  assert.equal(JSON.stringify(stored), before);
  assert.equal(migrated.position, stored.position);

  const current = { ...stored, version: 4 };
  assert.equal(migrateNode(stepped, current), current);
  const newer = { ...stored, version: 5 };
  assert.equal(migrateNode(stepped, newer), newer);
  assert.equal(migrateNode(node({ type: 'ref/plain' }), stored), stored);       // no version: version 1
  assert.throws(() => migrateNode(node({ type: 'ref/bare', version: 3 }), stored), /has version 3 and no migrate function/);
  assert.throws(() => migrateNode(node({ type: 'ref/odd', version: 3, migrate: () => null as never }), stored), TypeError);
});

test('a node whose migrate throws: unchanged, with a problem', () => {
  const old = instance('old', 'ref/combine', { mode: 'mix' });       // version 1 without `amount`: the migration throws
  const parsed = parse(file({ nodes: { old } }));
  assert.deepEqual(parsed.doc.nodes.old, old);
  assert.deepEqual(parsed.problems, [
    { nodeId: 'old', message: 'Saved with version 1 of this node; the migration to version 2 failed: amount is missing' },
  ]);
});

test('a node with a higher version: unchanged, with a problem; its params are not normalised', () => {
  const future = instance('new', 'ref/combine', { mode: 'screen', strength: 7, falloff: 2 }, { version: 3 });
  const parsed = parse(file({ nodes: { new: future } }));
  assert.deepEqual(parsed.doc.nodes.new, future);
  assert.deepEqual(parsed.problems, [{ nodeId: 'new', message: 'Saved with version 3 of this node; this build has version 2' }]);
});

test('a param outside its hard limits: the normalised value, with a problem; the rest of the node as stored', () => {
  const stored = instance('g', 'ref/gen', { later: { kept: true }, count: 99, hard: 0.5, soft: 1000, offset: [9, 0], label: 'A long label' });
  const parsed = parse(file({ nodes: { g: stored } }));
  assert.deepEqual(parsed.doc.nodes.g!.params, { later: { kept: true }, count: 16, hard: 0.5, soft: 1000, offset: [1, 0], label: 'A long l' });
  assert.deepEqual(Object.keys(parsed.doc.nodes.g!.params), ['later', 'count', 'hard', 'soft', 'offset', 'label']);
  assert.deepEqual(parsed.problems, [
    { nodeId: 'g', message: 'param "count": 99 is outside 1..16; clamped to 16' },
    { nodeId: 'g', message: 'param "offset": [9,0] is outside -1..1; clamped to [1,0]' },
    { nodeId: 'g', message: 'param "label": the text is longer than 8 characters; truncated' },
  ]);
});

test('a missing param is not added, and an unknown enum value is kept and reported', () => {
  const parsed = parse(file({ nodes: { g: instance('g', 'ref/gen', { mode: 'screen' }) } }));
  assert.deepEqual(parsed.doc.nodes.g!.params, { mode: 'screen' });
  assert.deepEqual(parsed.problems, [{ nodeId: 'g', message: 'param "mode": unknown value "screen"' }]);
});

test('a migrated node is normalised like any other', () => {
  const parsed = parse(file({ nodes: { old: instance('old', 'ref/combine', { amount: 250 }) } }));
  assert.deepEqual(parsed.doc.nodes.old!.params, { strength: 1 });
  assert.equal(parsed.doc.nodes.old!.version, 2);
  assert.deepEqual(messages(parsed.problems), ['param "strength": 2.5 is outside 0..1; clamped to 1']);
});

test('a node without the shape of a node is repaired where it can be and removed where it cannot', () => {
  const parsed = parse(file({
    nodes: {
      a: { id: 'other', type: 'ref/gen', version: 0, position: { x: 'left' }, params: [1], title: 5, bypass: 'yes', collapsed: 1, extra: true },
      b: 'node',
      c: { id: 'c', version: 1, position: { x: 0, y: 0 }, params: {} },
      d: instance('d', 'ref/soften'),
    },
  }));
  assert.deepEqual(parsed.doc.nodes, {
    a: { id: 'a', type: 'ref/gen', version: 1, position: { x: 0, y: 0 }, params: {}, extra: true },
    d: instance('d', 'ref/soften'),
  });
  assert.deepEqual(parsed.problems.map((p) => p.nodeId), ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'c']);
  assert.match(parsed.problems[0]!.message, /"id" differs from the key/);
  assert.match(parsed.problems[7]!.message, /not a node with a type/);
});

test('ids are any non-empty string, also the name of a member every object inherits', () => {
  const parsed = parse(file({
    nodes: { constructor: instance('constructor', 'ref/gen'), 'to String': instance('to String', 'ref/soften'), '': instance('', 'ref/gen') },
    edges: { hasOwnProperty: edge('hasOwnProperty', 'constructor.out', 'to String.in') },
  }));
  assert.deepEqual(Object.keys(parsed.doc.nodes), ['constructor', 'to String']);
  assert.deepEqual(Object.keys(parsed.doc.edges), ['hasOwnProperty']);
  assert.deepEqual(messages(parsed.problems), ['"nodes" has an entry with the id "", which cannot be used; it is removed']);
});

test('an entry named __proto__ is removed and leaves every prototype alone', () => {
  const text = '{ "format": "orogen", "version": 1, "settings": ' + JSON.stringify(SETTINGS)
    + ', "nodes": { "__proto__": { "id": "__proto__", "type": "ref/gen", "version": 1, "position": { "x": 0, "y": 0 }, "params": {} },'
    + ' "g": { "id": "g", "type": "ref/gen", "version": 1, "position": { "x": 0, "y": 0 }, "params": { "__proto__": { "polluted": true }, "count": 99 } } },'
    + ' "edges": {}, "groups": {}, "ui": {} }';
  const parsed = parseDoc(text, registry);
  assert.deepEqual(Object.keys(parsed.doc.nodes), ['g']);
  assert.equal(Object.getPrototypeOf(parsed.doc.nodes), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.doc.nodes.g!.params), Object.prototype);
  assert.equal(parsed.doc.nodes.g!.params.count, 16);
  assert.equal(({} as Loose).polluted, undefined);
  assert.equal(messages(parsed.problems)[0], '"nodes" has an entry with the id "__proto__", which cannot be used; it is removed');
});

// ---- edges, groups, ui -----------------------------------------------------------------------------------------

test('an edge that breaks 4.3: unchanged, with a problem under its id', () => {
  const nodes = {
    fbm: instance('fbm', 'ref/gen'),
    ghost: instance('ghost', 'legacy/unknown'),
    after: instance('after', 'ref/soften'),
    loopa: instance('loopa', 'ref/soften'),
    loopb: instance('loopb', 'ref/soften'),
  };
  const edges = {
    e1: edge('e1', 'fbm.out', 'ghost.in'),
    e2: edge('e2', 'ghost.out', 'after.in'),
    e3: edge('e3', 'loopb.out', 'loopa.in'),
    e4: edge('e4', 'loopa.out', 'loopb.in'),
    e5: edge('e5', 'fbm.out', 'after.mask'),
    e6: edge('e6', 'fbm.out', 'after.mask'),
    e7: edge('e7', 'fbm.out', 'gone.in'),
  };
  const parsed = parse(file({ nodes, edges }));
  assert.deepEqual(parsed.doc.edges, edges);
  assert.deepEqual(parsed.problems, [
    { nodeId: 'ghost', message: 'Unknown node type "legacy/unknown"' },
    { edgeId: 'e1', message: 'Unknown node type "legacy/unknown"' },
    { edgeId: 'e2', message: 'Unknown node type "legacy/unknown"' },
    { edgeId: 'e3', message: 'Part of a cycle' },
    { edgeId: 'e4', message: 'Part of a cycle' },
    { edgeId: 'e6', message: 'The input "mask" already has a connection' },
    { edgeId: 'e7', message: 'The target node does not exist' },
  ]);
});

test('an entry that is no edge or no group is removed, and a wrong id is replaced by the key', () => {
  const parsed = parse(file({
    nodes: { a: instance('a', 'ref/gen'), b: instance('b', 'ref/soften') },
    edges: { e1: { id: 'x', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }, e2: { id: 'e2', from: 'a.out', to: 'b.in' }, e3: null },
    groups: {
      g1: { id: 'g1', title: 'Fine', rect: { x: 0, y: 0, w: 1, h: 1 } },
      g2: { id: 'zz', title: 7, color: 'red', rect: { x: 0, y: 0, w: 1, h: 1 }, note: 'kept' },
      g3: { id: 'g3', title: 'No rect' },
      g4: [],
    },
  }));
  assert.deepEqual(parsed.doc.edges, { e1: { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } } });
  assert.deepEqual(parsed.doc.groups, {
    g1: { id: 'g1', title: 'Fine', rect: { x: 0, y: 0, w: 1, h: 1 } },
    g2: { id: 'g2', title: '', rect: { x: 0, y: 0, w: 1, h: 1 }, note: 'kept' },
  });
  assert.deepEqual(parsed.problems.map((p) => p.edgeId ?? p.message.slice(0, 10)), ['e1', 'e2', 'e3', 'group "g2"', 'group "g2"', 'group "g2"', 'group "g3"', 'group "g4"']);
});

test('ui: a view may name a node that does not exist; what has no valid shape is removed', () => {
  const view = { height: { node: 'gone', port: 'out' }, overlay: { ref: { node: 'gone', port: 'x' }, as: 'heat', opacity: 0.5 }, locked: true };
  const kept = parse(file({ ui: { view, graphViewport: { x: 1, y: 2, zoom: 3 }, panel: 'kept' } }));
  assert.deepEqual(kept.problems, []);
  assert.deepEqual(kept.doc.ui, { view, graphViewport: { x: 1, y: 2, zoom: 3 }, panel: 'kept' });

  const repaired = parse(file({
    ui: { view: { height: 'fbm.out', overlay: { ref: { node: 'a', port: 'out' }, as: 'glow', opacity: 1 }, locked: 'yes', note: 1 }, graphViewport: { x: 1, y: 2 } },
  }));
  assert.deepEqual(repaired.doc.ui, { view: { note: 1 } });
  assert.deepEqual(messages(repaired.problems), [
    '"ui.view.height" is not valid; it is removed',
    '"ui.view.overlay" is not valid; it is removed',
    '"ui.view.locked" is not valid; it is removed',
    '"ui.graphViewport" is not valid; it is removed',
  ]);
  assert.deepEqual(parse(file({ ui: { view: 'fbm' } })).doc.ui, {});
});

test('a missing collection is empty, and a version that is not 1 is read as 1, each with a problem', () => {
  const parsed = parseDoc('{ "format": "orogen", "settings": ' + JSON.stringify(SETTINGS) + ', "nodes": [] }', registry);
  assert.deepEqual(parsed.doc, { format: 'orogen', settings: SETTINGS, nodes: {}, version: 1, edges: {}, groups: {}, ui: {} });
  assert.deepEqual(messages(parsed.problems), [
    '"version" is not 1; the file is read as version 1',
    '"nodes" is not an object; an empty one is used',
    '"edges" is missing; an empty one is used',
    '"groups" is missing; an empty one is used',
    '"ui" is missing; an empty one is used',
  ]);
  assert.equal(parse(file({ version: 0 })).doc.version, 1);
  assert.equal(parse(file({ version: '1' })).doc.version, 1);
});

// ---- the acceptance pattern of testing.md 10.2, graph 06 --------------------------------------------------------

test('a broken file is never damaged by opening and saving it', () => {
  const content = file({
    nodes: {
      fbm: instance('fbm', 'ref/gen'),
      ghost: instance('ghost', 'legacy/unknown', { foo: 1, bar: 'x' }),
      after: instance('after', 'ref/soften'),
      old: instance('old', 'ref/combine', { mode: 'mix', amount: 25 }),
      loopa: instance('loopa', 'ref/soften'),
      loopb: instance('loopb', 'ref/soften'),
    },
    edges: {
      e1: edge('e1', 'fbm.out', 'ghost.in'),
      e2: edge('e2', 'ghost.out', 'after.in'),
      e3: edge('e3', 'fbm.out', 'old.a'),
      e4: edge('e4', 'loopb.out', 'loopa.in'),
      e5: edge('e5', 'loopa.out', 'loopb.in'),
    },
  });
  const first = parse(content);
  assert.ok(first.problems.some((p) => p.nodeId === 'ghost'));
  assert.ok(first.problems.some((p) => p.edgeId === 'e4' && p.message === 'Part of a cycle'));
  assert.equal(first.doc.nodes.old!.version, 2);
  assert.deepEqual(first.doc.nodes.ghost, (content.nodes as Loose).ghost);
  assert.deepEqual(first.doc.edges, content.edges);

  const second = parseDoc(serializeDoc(first.doc), registry);
  assert.deepEqual(second.doc, first.doc);
  assert.equal(serializeDoc(second.doc), serializeDoc(first.doc));
  // What cannot be repaired is reported again; the migration is not.
  assert.deepEqual(second.problems, first.problems);
});

test('with the node type registered, the same file loads clean', () => {
  const legacy = node({ type: 'legacy/unknown', category: 'ref', inputs: [{ name: 'in', type: 'field' }] });
  const wider = createRegistry([...registry.list(), legacy]);
  const content = file({
    nodes: { fbm: instance('fbm', 'ref/gen'), ghost: instance('ghost', 'legacy/unknown', { foo: 1 }), after: instance('after', 'ref/soften') },
    edges: { e1: edge('e1', 'fbm.out', 'ghost.in'), e2: edge('e2', 'ghost.out', 'after.in') },
  });
  assert.equal(parseDoc(JSON.stringify(content), registry).problems.length, 3);
  const parsed = parseDoc(JSON.stringify(content), wider);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc.nodes.ghost!.params, { foo: 1 });
});

// ---- loadNode --------------------------------------------------------------------------------------------------

test('loadNode returns the instance itself when nothing has to change', () => {
  const fine: NodeInstance = { id: 'c', type: 'ref/combine', version: 2, position: { x: 0, y: 0 }, params: { strength: 0.5, other: 1 } };
  const loaded = loadNode(registry, fine);
  assert.equal(loaded.node, fine);
  assert.deepEqual(loaded.problems, []);
  assert.equal(combine.version, 2);
});

// ---- newId -----------------------------------------------------------------------------------------------------

test('newId: 10 characters of base 36, different every time', () => {
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newId();
    assert.match(id, /^[0-9a-z]{10}$/);
    ids.add(id);
    for (const character of id) seen.add(character);
  }
  assert.equal(ids.size, 2000);
  assert.equal(seen.size, 36);
});
