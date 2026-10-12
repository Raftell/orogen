// Keys (runtime.md 5.4): the canonical strings, the tokens that stand for a key inside another, the content
// behind an output, and the identity of external data. No device is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeKeys, createTokenTable, defaultExternalKey, KEY_VERSION, type NodeKeys } from '../../../src/core/eval/keys.ts';
import { buildPlan } from '../../../src/core/eval/plan.ts';
import { createRegistry, FileError, type FileSource, type GraphDoc } from '../../../src/core/runtime.ts';
import { node } from '../graph-fixtures.ts';

const external = { calls: 0, fail: null as unknown, value: 'v1' };
const registry = createRegistry([
  node({ type: 'ref/gen', params: [{ kind: 'float', name: 'level', unit: 'height', help: 'A level.', default: 0.5, min: 0, max: 1 }, { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 }] }),
  node({ type: 'ref/paint', outputs: [{ name: 'out', type: 'color' }], uses: ['seaLevel'] }),
  node({ type: 'ref/filter', inputs: [{ name: 'in', type: 'field' }], outputs: [{ name: 'out', type: 'field' }, { name: 'extra', type: 'color' }], maskable: true }),
  node({ type: 'ref/pair', inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field', optional: true }] }),
  node({ type: 'ref/sink', inputs: [{ name: 'in', type: 'field' }], outputs: [] }),
  node({ type: 'ref/file', params: [{ kind: 'file', name: 'first', help: 'A file.', default: '', filters: ['png'] }, { kind: 'file', name: 'second', help: 'A file.', default: '', filters: ['png'] }] }),
  node({
    type: 'ref/external',
    externalKey: () => {
      external.calls++;
      if (external.fail) throw external.fail;
      return external.value;
    },
  }),
]);

const files: FileSource = {
  resolve: (path) => `/project/${path}`,
  stat: async (path) => (path === 'here.png' ? { size: 12, mtimeMs: 34.5 } : null),
  read: async () => new Uint8Array(0),
};

interface Spec { type: string; in?: Record<string, string>; params?: Record<string, unknown>; bypass?: boolean }
function doc(nodes: Record<string, Spec>, settings: Partial<GraphDoc['settings']> = {}): GraphDoc {
  const out = { format: 'orogen', version: 1, settings: { terrainSize: 4096, heightRange: 1024, seed: 5, buildResolution: 513, previewLevel: 0, seaLevel: 0.25, ...settings }, nodes: {} as Record<string, unknown>, edges: {} as Record<string, unknown>, groups: {}, ui: {} };
  let n = 0;
  for (const [id, spec] of Object.entries(nodes)) {
    out.nodes[id] = { id, type: spec.type, version: 1, position: { x: 0, y: 0 }, params: spec.params ?? {}, ...(spec.bypass ? { bypass: true } : {}) };
    for (const [port, from] of Object.entries(spec.in ?? {})) {
      const [fromNode, fromPort] = from.split('.');
      out.edges[`e${++n}`] = { id: `e${n}`, from: { node: fromNode, port: fromPort }, to: { node: id, port } };
    }
  }
  return out as unknown as GraphDoc;
}
const tokens = createTokenTable();
async function keysOf(d: GraphDoc, table = tokens): Promise<{ keys: ReadonlyMap<string, NodeKeys>; errors: ReadonlyMap<string, unknown> }> {
  const plan = buildPlan(d, registry, Object.keys(d.nodes).map((id) => ({ node: id })));
  return computeKeys(plan, d, files, table);
}

test('tokens: one per string, never given twice, and forgotten only beyond the limit and outside the computation in progress', () => {
  const table = createTokenTable(4);
  table.begin();
  const a = table.of('a'), b = table.of('b');
  assert.notEqual(a, b);
  assert.equal(table.of('a'), a);
  for (const key of ['c', 'd', 'e', 'f', 'g']) table.of(key);
  table.end();
  assert.equal(table.size, 7, 'nothing used in the computation that just ended is forgotten');

  table.begin();
  assert.equal(table.of('g'), 7);
  table.end();
  assert.equal(table.size, 4, 'the least recently used go first');
  table.begin();
  assert.equal(table.of('f'), 6, 'a key that is still known keeps its token');
  const again = table.of('a');
  assert.ok(again > 7, `a forgotten key gets a new token (${again}), never one that another key had`);
  table.end();

  // Two computations at once: neither loses a token while the other ends.
  const shared = createTokenTable(1);
  shared.begin();
  const x = shared.of('x');
  shared.begin();
  shared.of('y');
  shared.end();
  assert.equal(shared.of('x'), x);
  shared.end();
  assert.equal(shared.size, 2);
});

test('K(n) is JSON of [KEY_VERSION, type, version, P, I, S, X], with a token where another key stands', async () => {
  const d = doc({
    g: { type: 'ref/gen', params: { level: 0.75, extra: 1 } },
    p: { type: 'ref/paint' },
    pair: { type: 'ref/pair', in: { a: 'g.out' } },
    sink: { type: 'ref/sink', in: { in: 'p.out' } },
  });
  const { keys, errors } = await keysOf(d);
  assert.equal(errors.size, 0);
  const g = keys.get('g')!, p = keys.get('p')!, pair = keys.get('pair')!, sink = keys.get('sink')!;
  // P: the normalised values in declaration order. S: terrainSize, heightRange, the seed for a node with a seed param, then `uses`.
  assert.equal(g.key, JSON.stringify([KEY_VERSION, 'ref/gen', 1, [0.75, 0], [], [4096, 1024, 5], '']));
  assert.equal(p.key, JSON.stringify([KEY_VERSION, 'ref/paint', 1, [], [], [4096, 1024, null, 0.25], '']));
  const gToken = tokens.of(g.key!);
  assert.equal(g.contentKey, JSON.stringify([gToken, 'out']));
  assert.equal(g.output('out'), g.contentKey);
  // I: per declared input null, or C(edge) = [O(source), conversion]; an O inside a key is its token.
  assert.equal(pair.key, JSON.stringify([KEY_VERSION, 'ref/pair', 1, [], [[tokens.of(g.contentKey), ''], null], [4096, 1024, null], '']));
  assert.equal(sink.key, JSON.stringify([KEY_VERSION, 'ref/sink', 1, [], [[tokens.of(p.contentKey), 'luma']], [4096, 1024, null], '']));
  assert.equal(sink.contentKey, sink.key, 'a node without outputs: K(n)');

  assert.deepEqual(pair.inputs, { a: g.outputs.out!.content, b: null });
  assert.deepEqual(g.outputs.out!.content, { type: 'node', id: g.contentKey, kind: 'field', nodeKey: g.key, port: 'out' });
  // A conversion is content of its own, addressed by its C.
  const converted = sink.inputs.in!;
  assert.deepEqual([converted.type, converted.kind, converted.id], ['convert', 'field', JSON.stringify([tokens.of(p.contentKey), 'luma'])]);
  assert.equal(converted.type === 'convert' && converted.source, p.outputs.out!.content);
});

test('O(n, port): a bypassed node, a masked output, and everything else', async () => {
  const d = doc({
    g: { type: 'ref/gen' },
    m: { type: 'ref/paint' },
    masked: { type: 'ref/filter', in: { in: 'g.out', mask: 'm.out' } },
    plain: { type: 'ref/filter', in: { in: 'g.out' } },
    off: { type: 'ref/filter', in: { in: 'g.out', mask: 'm.out' }, bypass: true },
    offEmpty: { type: 'ref/filter', bypass: true },
    reader: { type: 'ref/filter', in: { in: 'off.out' } },
  });
  const { keys } = await keysOf(d);
  const g = keys.get('g')!, masked = keys.get('masked')!, plain = keys.get('plain')!, off = keys.get('off')!, offEmpty = keys.get('offEmpty')!;
  // The mask is in O, not in K: the two filters have one key and so one entry.
  assert.equal(masked.key, plain.key);
  const token = tokens.of(plain.key!);
  assert.equal(plain.contentKey, JSON.stringify([token, 'out']));
  const cIn = [tokens.of(g.contentKey), ''], cMask = [tokens.of(keys.get('m')!.contentKey), 'luma'];
  assert.equal(masked.contentKey, JSON.stringify(['mask', token, cMask, cIn]));
  assert.equal(masked.output('extra'), JSON.stringify([token, 'extra']), 'other outputs are untouched');
  const blend = masked.outputs.out!.content;
  assert.equal(blend.type, 'mask');
  if (blend.type === 'mask') {
    assert.deepEqual([blend.id, blend.kind], [masked.contentKey, 'field']);
    assert.equal(blend.raw, masked.raw.out);
    assert.equal(blend.raw.id, plain.contentKey, 'the unblended result is the node\'s own output');
    assert.equal(blend.base, g.outputs.out!.content);
    assert.deepEqual([blend.mask.type, blend.mask.id], ['convert', JSON.stringify(cMask)]);
  }

  // Bypassed: outputs[0] is C(edge into inputs[0]), every other output and an unconnected inputs[0] the constant.
  assert.equal(off.key, null, 'a bypassed node has no entry');
  assert.equal(off.contentKey, JSON.stringify(cIn));
  assert.equal(off.outputs.out!.content, g.outputs.out!.content, 'what its readers receive is its input');
  assert.equal(off.output('extra'), JSON.stringify(['const', 'color']));
  assert.deepEqual(off.outputs.extra!.content, { type: 'const', id: '["const","color"]', kind: 'color' });
  assert.equal(offEmpty.contentKey, JSON.stringify(['const', 'field']));
  assert.deepEqual(Object.keys(off.inputs), ['in'], 'its mask is not read');
  const reader = JSON.parse(keys.get('reader')!.key!) as unknown[];
  assert.deepEqual(reader[4], [[tokens.of(off.contentKey), '']], 'a reader names the bypassed node, and receives the content behind it');
  assert.equal(keys.get('reader')!.inputs.in, g.outputs.out!.content);
});

test('a key does not grow with the depth of the graph, however its nodes share their sources', async () => {
  const DEPTH = 2_000;
  const nodes: Record<string, Spec> = { n0: { type: 'ref/gen' } };
  // Every node reads the one before it twice, and is masked by it: without tokens each level would double the key.
  for (let i = 1; i < DEPTH; i++) {
    nodes[`n${i}`] = i % 2 === 1
      ? { type: 'ref/pair', in: { a: `n${i - 1}.out`, b: `n${i - 1}.out` } }
      : { type: 'ref/filter', in: { in: `n${i - 1}.out`, mask: `n${i - 1}.out` } };
  }
  const table = createTokenTable();
  const { keys } = await keysOf(doc(nodes), table);
  assert.equal(keys.size, DEPTH);
  let longest = 0;
  for (const k of keys.values()) longest = Math.max(longest, k.key!.length, k.contentKey.length);
  assert.ok(longest < 200, `the longest key has ${longest} characters`);
  assert.equal(new Set([...keys.values()].map((k) => k.contentKey)).size, DEPTH, 'and every node has a key of its own');
  assert.ok(table.size <= 3 * DEPTH);
});

test('externalKey: awaited once per node and call, part of X, and a failure is that node\'s alone', async () => {
  const d = doc({ e: { type: 'ref/external' }, r: { type: 'ref/pair', in: { a: 'e.out' } }, g: { type: 'ref/gen' }, off: { type: 'ref/pair', in: { a: 'e.out' }, bypass: true } });
  external.calls = 0;
  external.fail = null;
  const first = await keysOf(d);
  assert.equal(external.calls, 1);
  assert.equal((JSON.parse(first.keys.get('e')!.key!) as unknown[])[6], 'v1');
  external.value = 'v2';
  const second = await keysOf(d);
  assert.notEqual(second.keys.get('e')!.key, first.keys.get('e')!.key);
  assert.notEqual(second.keys.get('r')!.key, first.keys.get('r')!.key, 'and so does everything downstream');
  assert.equal(second.keys.get('g')!.key, first.keys.get('g')!.key);

  external.fail = new FileError('denied', '/x', 'No permission to read /x');
  const failed = await keysOf(d);
  assert.deepEqual([...failed.keys.keys()], ['g']);
  assert.deepEqual([...failed.errors], [['e', external.fail]]);
  external.fail = null;

  const aborted = AbortSignal.abort();
  const plan = buildPlan(d, registry, [{ node: 'r' }]);
  await assert.rejects(computeKeys(plan, d, files, tokens, aborted), (thrown) => thrown === aborted.reason);
});

test('the default externalKey: for each file param in order, the resolved path with size and time, or with null', async () => {
  const def = registry.get('ref/file')!;
  assert.equal(await defaultExternalKey(def, { first: 'here.png', second: 'gone.png' }, files), JSON.stringify([['/project/here.png', 12, 34.5], ['/project/gone.png', null]]));
  assert.equal(await defaultExternalKey(def, { first: '', second: 'here.png' }, files), JSON.stringify([['', null], ['/project/here.png', 12, 34.5]]));
  const throwing: FileSource = { ...files, resolve: (path) => { throw new FileError('invalid-path', path, 'The project has not been saved'); } };
  await assert.rejects(defaultExternalKey(def, { first: 'a.png', second: '' }, throwing), FileError);

  const { keys } = await keysOf(doc({ f: { type: 'ref/file', params: { first: 'here.png' } } }));
  assert.equal((JSON.parse(keys.get('f')!.key!) as unknown[])[6], JSON.stringify([['/project/here.png', 12, 34.5], ['', null]]));
});
