// Keys and the cache (runtime.md 5.4, 2.7, 2.8): what is in a key and what is not, hits, the cache address,
// copied nodes, transient entries, re-runs for an output the entry lacks, eviction, and a build's own table.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, param } from '../../../src/core/api.ts';
import { KEY_VERSION, type AnyFieldHandle, type GraphDoc } from '../../../src/core/runtime.ts';
import { assertUniform, calls, constantNode, endings, eventsOf, gainNode, startEngine, sumNode, target } from './rig.ts';

const offset = defineKernel({
  name: 'test/offset',
  inputs: { src: 'field' },
  outputs: { out: 'field', extra: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> Out { return Out(src_at(px) + 1.0, src_at(px) + 2.0); }',
});
/** What ctx.wants('extra') answered, call by call. */
const wantsExtra: boolean[] = [];
const splitNode = defineNode({
  type: 'ref/split',
  title: 'Split (Test)',
  category: 'ref',
  description: 'Gives in + 1 and, when wanted, in + 2.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'extra', type: 'field', role: 'data' }],
  params: [],
  kernels: [offset],
  evaluate(ctx) {
    wantsExtra.push(ctx.wants('extra'));
    assert.equal(ctx.wants('out'), true, 'outputs[0] is wanted whenever this test evaluates the node');
    const out = ctx.alloc('field');
    const extra = ctx.wants('extra') ? ctx.alloc('field') : null;
    ctx.run(offset, { in: { src: ctx.input('in') }, out: { out, extra } });
    ctx.output('out', out);
    if (extra) ctx.output('extra', extra);
  },
});

const seaKernel = defineKernel({
  name: 'test/sea',
  outputs: { out: 'field' },
  params: { level: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return P.level + f32(frame.seed) * 0.0; }',
});
const seaNode = defineNode({
  type: 'ref/sea',
  title: 'Sea (Test)',
  category: 'ref',
  description: 'Writes the sea level.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [param.seed()],
  kernels: [seaKernel],
  uses: ['seaLevel'],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(seaKernel, { out: { out }, params: { level: ctx.setting('seaLevel') } });
    ctx.output('out', out);
  },
});

const sinkNode = defineNode({
  type: 'ref/sink',
  title: 'Sink (Test)',
  category: 'ref',
  description: 'Reads a field and gives nothing.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [{ kind: 'text', name: 'layer', default: 'Rock', help: 'A name.' }],
  kernels: [],
  evaluate: (ctx) => void ctx.input('in'),
});

const DEFS = [constantNode, gainNode, sumNode, splitNode, seaNode, sinkNode];
const t = await startEngine(DEFS);
after(() => t.dispose());

const chainOf = (value: number, gain: number): GraphDoc => t.doc({
  a: { type: 'ref/constant', params: { value } },
  b: { type: 'ref/gain', params: { gain }, inputs: { in: 'a.out' } },
  c: { type: 'ref/gain', params: { gain: 10 }, inputs: { in: 'b.out' } },
});

test('a second evaluation of an unchanged document runs nothing; an edit re-runs the node and what reads it', async () => {
  await t.engine.trim();
  const first = await t.run(chainOf(1, 2), ['c.out']);
  assert.deepEqual(endings(first.events), { a: 'run', b: 'run', c: 'run' });
  assertUniform(first.data[0], 20, 'c.out');

  const again = await t.run(chainOf(1, 2), ['c.out']);
  assert.deepEqual(endings(again.events), { a: 'cached', b: 'cached', c: 'cached' });
  assert.deepEqual([again.result.timing.nodesRun, again.result.timing.nodesCached], [0, 3]);
  assert.deepEqual(eventsOf(again.events, 'eval-start')[0]!.plan.map((p) => p.state), ['cached', 'cached', 'cached']);
  assert.deepEqual(eventsOf(again.events, 'node-done').map((e) => [e.cached, e.wallMs, e.gpuMs, e.peakBytes]), Array(3).fill([true, 0, null, 0]));
  assert.equal(eventsOf(again.events, 'node-start').length, 0);
  assertUniform(again.data[0], 20, 'c.out from the cache');

  const edited = await t.run(chainOf(1, 3), ['c.out']);
  assert.deepEqual(endings(edited.events), { a: 'cached', b: 'run', c: 'run' });
  assertUniform(edited.data[0], 30, 'c.out after the edit');

  // Undo: the old parameters reproduce the old keys, and what is still cached is a hit.
  assert.deepEqual(endings((await t.run(chainOf(1, 2), ['c.out'])).events), { a: 'cached', b: 'cached', c: 'cached' });
  t.noLeaks();
});

test('keys: a canonical string per node, built from type, version, params, inputs and the settings a node reads', async () => {
  const base = t.doc({
    a: { type: 'ref/constant', params: { value: 1 } },
    b: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'a.out' } },
    sea: { type: 'ref/sea' },
    sink: { type: 'ref/sink', inputs: { in: 'b.out' } },
    loose: { type: 'ref/gain' },
  });
  const keys = await t.engine.keys(base);
  assert.deepEqual([...keys.keys()].sort(), ['a', 'b', 'sea', 'sink'], 'a node that cannot run has no key');
  for (const id of ['a', 'b', 'sea']) {
    const parsed = JSON.parse(keys.get(id)!) as unknown[];
    assert.deepEqual([parsed.length, typeof parsed[0], parsed[1]], [2, 'number', 'out'], `contentKey of ${id} is O(n, outputs[0])`);
  }
  // A node without outputs: its contentKey is K(n) itself.
  const sink = JSON.parse(keys.get('sink')!) as unknown[];
  assert.deepEqual(sink.slice(0, 4), [KEY_VERSION, 'ref/sink', 1, ['Rock']]);
  assert.deepEqual([(sink[4] as unknown[]).length, sink[5], sink[6]], [1, [4096, 1024, null], '']);

  const same = async (doc: GraphDoc, ids: readonly string[], message: string): Promise<void> => {
    const other = await t.engine.keys(doc);
    for (const id of ids) assert.equal(other.get(id), keys.get(id), `${message}: ${id}`);
  };
  const differs = async (doc: GraphDoc, changed: readonly string[], unchanged: readonly string[], message: string): Promise<void> => {
    const other = await t.engine.keys(doc);
    for (const id of changed) assert.notEqual(other.get(id), keys.get(id), `${message}: ${id} changes`);
    for (const id of unchanged) assert.equal(other.get(id), keys.get(id), `${message}: ${id} stays`);
  };
  const all = ['a', 'b', 'sea', 'sink'];

  // Not in any key: position, title, collapsed, groups, ui, buildResolution, previewLevel, a stored default.
  const cosmetic = structuredClone(base) as { -readonly [K in keyof GraphDoc]: any };
  cosmetic.nodes.a.position = { x: 400, y: -20 };
  cosmetic.nodes.b.title = 'My gain';
  cosmetic.nodes.b.collapsed = true;
  cosmetic.nodes.sea.params = { seed: 0 };
  cosmetic.nodes.sink.params = { unknown: 5 };
  cosmetic.groups = { g: { id: 'g', title: 'Group', rect: { x: 0, y: 0, w: 10, h: 10 } } };
  cosmetic.ui = { view: { height: { node: 'b', port: 'out' } }, graphViewport: { x: 1, y: 2, zoom: 3 } };
  cosmetic.settings = { ...base.settings, buildResolution: 1009, previewLevel: 0 };
  await same(cosmetic, all, 'cosmetic members');

  await differs(t.doc({ ...specOf(base), a: { type: 'ref/constant', params: { value: 1.5 } } }), ['a', 'b', 'sink'], ['sea'], 'a param');
  await differs({ ...base, settings: { ...base.settings, terrainSize: 8192 } }, all, [], 'terrainSize');
  await differs({ ...base, settings: { ...base.settings, heightRange: 512 } }, all, [], 'heightRange');
  await differs({ ...base, settings: { ...base.settings, seed: 2 } }, ['sea'], ['a', 'b', 'sink'], 'the project seed, for a node with a seed param');
  await differs({ ...base, settings: { ...base.settings, seaLevel: 0.5 } }, ['sea'], ['a', 'b', 'sink'], 'a setting a node declares in "uses"');

  // The node's id is not in its key: a copy has the key of the original.
  const copy = await t.engine.keys(t.doc({ ...specOf(base), a2: { type: 'ref/constant', params: { value: 1 } }, b2: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'a2.out' } } }));
  assert.deepEqual([copy.get('a2'), copy.get('b2')], [keys.get('a'), keys.get('b')]);
});
function specOf(doc: GraphDoc): Record<string, { type: string; params: Record<string, unknown>; inputs: Record<string, string> }> {
  const spec: Record<string, { type: string; params: Record<string, unknown>; inputs: Record<string, string> }> = {};
  for (const node of Object.values(doc.nodes)) spec[node.id] = { type: node.type, params: { ...node.params }, inputs: {} };
  for (const edge of Object.values(doc.edges)) spec[edge.to.node]!.inputs[edge.to.port] = `${edge.from.node}.${edge.from.port}`;
  return spec;
}

test('two nodes with the same key share one entry: the second is a cache hit, also inside one evaluation', async () => {
  await t.engine.trim();
  calls.clear();
  const doc = t.doc({
    a: { type: 'ref/constant', params: { value: 4 } },
    twin: { type: 'ref/constant', params: { value: 4 } },
    sum: { type: 'ref/sum', inputs: { a: 'a.out', b: 'twin.out' } },
  });
  for (const mode of ['preview', 'build'] as const) {
    const out = await t.run(doc, ['sum.out'], { mode });
    assert.deepEqual(endings(out.events), { a: 'run', twin: 'cached', sum: 'run' }, mode);
    assert.deepEqual(eventsOf(out.events, 'eval-start')[0]!.plan.map((p) => p.state), ['run', 'cached', 'run'], mode);
    assertUniform(out.data[0], 8, `${mode}: sum.out`);
    await t.engine.trim();
  }
  assert.equal(calls.get('ref/constant'), 2, 'one call per evaluation for the two nodes');
  t.noLeaks();
});

test('the resolution is the second half of the cache address, and Engine.trim keeps one resolution', async () => {
  await t.engine.trim();
  const doc = chainOf(2, 2);
  const run = async (resolution: number): Promise<string> => {
    const out = await t.run(doc, ['c.out'], { resolution });
    assert.equal(out.data[0]!.length, resolution * resolution);
    assertUniform(out.data[0], 40, `c.out at ${resolution}`);
    return endings(out.events).c!;
  };
  assert.deepEqual([await run(33), await run(65), await run(33), await run(65)], ['run', 'run', 'cached', 'cached']);
  await t.engine.trim({ keepResolution: 65 });
  assert.equal(t.engine.memory().freeBytes, 0, 'trim destroys the free textures of other widths');
  assert.deepEqual([await run(65), await run(33)], ['cached', 'run']);
  await t.engine.trim();
  assert.deepEqual([t.engine.memory().cacheBytes, t.engine.memory().freeBytes, t.engine.memory().drainingBytes], [0, 0, 0]);
  assert.equal(await run(65), 'run');
  t.noLeaks();
});

test('transient entries: what a drag leaves behind is dropped; what is hit again, or asked for outside it, stays', async () => {
  await t.engine.trim();
  const tick = async (gain: number, cache: 'keep' | 'transient'): Promise<Record<string, string>> => {
    const out = await t.run(chainOf(1, gain), ['c.out'], { cache });
    assertUniform(out.data[0], 10 * gain, `gain ${gain}`);
    return endings(out.events);
  };
  // Three ticks of a drag on b. a is upstream of the edit and is hit on every tick.
  assert.deepEqual(await tick(2, 'transient'), { a: 'run', b: 'run', c: 'run' });
  assert.deepEqual(await tick(3, 'transient'), { a: 'cached', b: 'run', c: 'run' });
  assert.deepEqual(await tick(4, 'transient'), { a: 'cached', b: 'run', c: 'run' });
  // The drag's earlier results are gone; its last one, and a, are still there.
  assert.deepEqual(await tick(4, 'transient'), { a: 'cached', b: 'cached', c: 'cached' });
  assert.deepEqual(await tick(2, 'transient'), { a: 'cached', b: 'run', c: 'run' }, 'gain 2 was dropped when the tick for 3 settled');

  // A 'keep' evaluation makes the entries it hits ordinary: they survive the rest of the drag.
  assert.deepEqual(await tick(2, 'keep'), { a: 'cached', b: 'cached', c: 'cached' });
  await tick(5, 'transient');
  await tick(6, 'transient');
  assert.deepEqual(await tick(2, 'transient'), { a: 'cached', b: 'cached', c: 'cached' }, 'an ordinary entry stays ordinary when a transient evaluation hits it');
  await tick(7, 'transient');
  assert.deepEqual(await tick(2, 'keep'), { a: 'cached', b: 'cached', c: 'cached' });
  assert.deepEqual(await tick(5, 'keep'), { a: 'cached', b: 'run', c: 'run' });
  t.noLeaks();
});

test('the cache is per node: an output the entry lacks re-runs the node with everything wanted before or now', async () => {
  await t.engine.trim();
  wantsExtra.length = 0;
  const doc = t.doc({ a: { type: 'ref/constant', params: { value: 5 } }, split: { type: 'ref/split', inputs: { in: 'a.out' } } });
  const needed = { outputs: 'needed' as const };
  const out = await t.run(doc, ['split.out'], needed);
  assertUniform(out.data[0], 6, 'out');
  assert.deepEqual(wantsExtra, [false]);
  assert.deepEqual(endings((await t.run(doc, ['split.out'], needed)).events), { a: 'cached', split: 'cached' });

  const extra = await t.run(doc, ['split.extra'], needed);
  assert.deepEqual(endings(extra.events), { a: 'cached', split: 'run' }, 'the entry held "out" only');
  assertUniform(extra.data[0], 7, 'extra');
  assert.deepEqual(wantsExtra, [false, true], 'the re-run wants "extra", and "out" because the old entry held it');

  for (const targets of [['split.out'], ['split.extra'], ['split.out', 'split.extra']]) {
    assert.deepEqual(endings((await t.run(doc, targets, needed)).events), { a: 'cached', split: 'cached' }, targets.join());
  }
  assert.deepEqual(wantsExtra, [false, true]);

  // 'all', the default of a preview: every output is wanted, so viewing another port never re-runs the node.
  await t.engine.trim();
  await t.run(doc, ['split.out']);
  assert.deepEqual(wantsExtra, [false, true, true]);
  assert.deepEqual(endings((await t.run(doc, ['split.extra'], needed)).events), { a: 'cached', split: 'cached' });
  t.noLeaks();
});

test('eviction: least recently used first under the budget; content behind a handle outlives its entry', async () => {
  const small = await startEngine(DEFS);
  try {
    const bytes = 65 * 65 * 4;
    const constantDoc = (value: number): GraphDoc => small.doc({ n: { type: 'ref/constant', params: { value } } });
    const state = async (value: number): Promise<string> => {
      const out = await small.run(constantDoc(value), ['n.out']);
      assertUniform(out.data[0], value, `constant ${value}`);
      return endings(out.events).n!;
    };
    // Room for three fields beside what the engine reserves.
    await small.run(constantDoc(0), ['n.out']);
    await small.engine.trim();
    small.engine.setBudget(small.engine.memory().reservedBytes + 3 * bytes + 100);

    assert.deepEqual([await state(1), await state(2), await state(3)], ['run', 'run', 'run']);
    assert.equal(small.engine.memory().cacheBytes, 3 * bytes);
    assert.equal(await state(1), 'cached', '1 is used again: 2 is now the least recently used');
    assert.equal(await state(4), 'run');
    assert.ok(small.engine.memory().cacheBytes <= 3 * bytes, JSON.stringify(small.engine.memory()));
    assert.deepEqual([await state(1), await state(3), await state(4)], ['cached', 'cached', 'cached']);
    assert.equal(await state(2), 'run', '2 was evicted');

    // A handle pins its content: the entry goes, the texture stays until the handle is released.
    const held = await small.evaluate(constantDoc(9), ['n.out']);
    const handle = held.result.fields[0] as AnyFieldHandle;
    assert.deepEqual([await state(10), await state(11)], ['run', 'run']);
    assert.equal(small.engine.memory().pinnedBytes, bytes);
    assert.equal(await state(12), 'run');
    assert.ok(small.engine.memory().pinnedBytes + small.engine.memory().cacheBytes + small.engine.memory().freeBytes <= 3 * bytes);
    assertUniform(await small.engine.read(handle), 9, 'the pinned content');
    handle.release();
    small.noLeaks();

    // Nothing fits: the node fails with kind 'budget' and nothing leaks.
    await small.engine.trim();
    small.engine.setBudget(small.engine.memory().reservedBytes + bytes - 1);
    const out = await small.run(constantDoc(13), ['n.out']);
    assert.deepEqual(out.result.errors.map((e) => e.kind), ['budget']);
    assert.match(out.result.errors[0]!.message, /^Needs \d+ KB more GPU memory at 65 × 65: budget \d+ (KB|MB), 0 MB in use by this node, 0 MB pinned$/);
    small.noLeaks();
  } finally {
    await small.dispose();
  }
});

test('a build neither reads nor writes the cache, shares content of one key, and frees outputs as it goes', async () => {
  await t.engine.trim();
  const doc = chainOf(3, 2);
  const preview = await t.run(doc, ['c.out']);
  assert.deepEqual(endings(preview.events), { a: 'run', b: 'run', c: 'run' });
  const cached = t.engine.memory().cacheBytes;
  assert.equal(cached, 3 * 65 * 65 * 4);

  const build = await t.run(doc, ['c.out'], { mode: 'build' });
  assert.deepEqual(endings(build.events), { a: 'run', b: 'run', c: 'run' }, 'a build does not read the cache');
  assertUniform(build.data[0], 60, 'c.out of the build');
  assert.equal(t.engine.memory().cacheBytes, cached, 'and does not write it');
  // a, then a and b, then b and c: two fields at the widest step.
  assert.equal(eventsOf(build.events, 'eval-start')[0]!.outputPeakBytes, 2 * 65 * 65 * 4);
  assert.deepEqual(endings((await t.run(doc, ['c.out'])).events), { a: 'cached', b: 'cached', c: 'cached' });

  await t.engine.trim();
  const fresh = await t.run(doc, ['c.out', 'a.out'], { mode: 'build' });
  assert.deepEqual(fresh.data.map((d) => d![0]), [60, 3]);
  assert.equal(t.engine.memory().cacheBytes, 0, 'after a build nothing is cached');
  assert.equal(eventsOf(fresh.events, 'eval-start')[0]!.outputPeakBytes, 3 * 65 * 65 * 4, 'a target is alive until the result is returned');
  t.noLeaks();
});

test('staged delivery: each target is handed over when it is published, and held only while it is consumed', async () => {
  await t.engine.trim();
  const doc = chainOf(1, 2);
  const seen: string[] = [];
  const out = await t.evaluate(doc, ['a.out', 'c', 'c.out', 'b.out'], {
    mode: 'build',
    onEvent: (e) => { if (e.type === 'node-done') seen.push(`done ${e.nodeId}`); },
    onTarget: async (index, field) => {
      seen.push(`target ${index}`);
      if (!field) return;
      assert.ok(t.engine.memory().pinnedBytes >= 65 * 65 * 4, 'the content is pinned while it is consumed');
      assertUniform(await t.engine.read(field), [1, 0, 20, 2][index]!, `target ${index}`);
    },
  });
  assert.equal(out.result.status, 'ok');
  assert.deepEqual(out.result.fields, [null, null, null, null], 'with onTarget the result carries no handles');
  assert.deepEqual(seen, ['done a', 'target 0', 'done b', 'target 3', 'done c', 'target 1', 'target 2']);
  assert.equal(eventsOf(out.events, 'eval-start')[0]!.outputPeakBytes, 2 * 65 * 65 * 4, 'a staged target is alive until its delivery only');
  t.noLeaks();
  assert.equal(t.engine.memory().cacheBytes, 0);

  // A rejection of onTarget stops the evaluation as if aborted, and evaluate() rejects with the same reason.
  const events: string[] = [];
  const boom = new Error('the disk is full');
  await assert.rejects(t.engine.evaluate(doc, [target('a.out'), target('c.out')], {
    resolution: 65, mode: 'build', requestId: t.nextRequestId(),
    onEvent: (e) => {
      if (e.type === 'eval-progress' || e.type === 'node-progress') return;
      events.push(e.type === 'node-skipped' ? `${e.type}:${e.reason}` : e.type === 'eval-end' ? `${e.type}:${e.status}` : e.type);
    },
    onTarget: () => Promise.reject(boom),
  }), boom);
  assert.deepEqual(events, ['eval-start', 'node-start', 'node-done', 'node-skipped:aborted', 'node-skipped:aborted', 'eval-end:aborted']);
  t.noLeaks();
});

test('the memory check of a build: outputs that cannot fit fail before any node runs', async () => {
  const small = await startEngine(DEFS);
  try {
    const doc = small.doc({
      a: { type: 'ref/constant', params: { value: 1 } },
      b: { type: 'ref/gain', inputs: { in: 'a.out' } },
      c: { type: 'ref/gain', inputs: { in: 'b.out' } },
    });
    await small.run(doc, ['c.out'], { mode: 'build' });
    await small.engine.trim();
    calls.clear();
    const bytes = 65 * 65 * 4;
    small.engine.setBudget(small.engine.memory().reservedBytes + 2 * bytes - 1);
    const out = await small.run(doc, ['c.out'], { mode: 'build' });
    assert.equal(out.result.status, 'errors');
    assert.deepEqual(out.result.fields, [null]);
    assert.deepEqual(endings(out.events), { a: 'skipped:upstream', b: 'error:budget', c: 'skipped:upstream' });
    assert.deepEqual(eventsOf(out.events, 'eval-start')[0]!.plan.map((p) => p.state), ['blocked', 'blocked', 'blocked']);
    assert.equal(eventsOf(out.events, 'eval-start')[0]!.outputPeakBytes, 2 * bytes);
    assert.match(out.result.errors[0]!.message, /^Needs \d+ KB more GPU memory at 65 × 65: budget \d+ (KB|MB), 0 MB in use by this node, 0 MB pinned$/);
    assert.equal(calls.size, 0, 'no node ran');

    // With room for the widest cut the build runs, and frees each output after its last reader.
    small.engine.setBudget(small.engine.memory().reservedBytes + 2 * bytes + 100);
    const fits = await small.run(doc, ['c.out'], { mode: 'build' });
    assert.equal(fits.result.status, 'ok', JSON.stringify(fits.result.errors));
    assertUniform(fits.data[0], 4, 'c.out');
    small.noLeaks();
  } finally {
    await small.dispose();
  }
});
