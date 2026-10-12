// Errors (runtime.md 5.3 step 2, 5.8, 5.13): every kind a document or a node can raise, isolation of a failed
// node, "upstream" for what reads it, and the out-of-memory retry.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, FileError } from '../../../src/core/api.ts';
import type { EvalEvent, GraphDoc, NodeError } from '../../../src/core/runtime.ts';
import {
  assertUniform, calls, constantNode, endings, eventsOf, gainNode, memoryFiles, MIB, startEngine, sumNode, tintNode, type NodeSpec,
} from './rig.ts';

const untiled = defineKernel({
  name: 'test/untiled',
  outputs: { out: 'field' },
  tiled: false,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 1.0; }',
});
const plain = defineKernel({
  name: 'test/plain',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return src_at(px); }',
});

/** How often the node has failed in a way that is meant to pass the second time. */
let secondRuns = 0;
const failNode = defineNode({
  type: 'ref/fail',
  title: 'Fail (Test)',
  category: 'ref',
  description: 'Fails the way its parameter says.',
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'how', default: 'none', help: 'The failure.',
      options: ['none', 'throw', 'reject', 'text', 'binding', 'no-output', 'watchdog', 'big', 'big-second'].map((value) => ({ value, label: value })),
    },
    { kind: 'int', name: 'tag', default: 0, min: 0, max: 1000, help: 'Tells instances apart.' },
  ],
  kernels: [untiled, plain],
  async evaluate(ctx) {
    calls.set('ref/fail', (calls.get('ref/fail') ?? 0) + 1);
    const out = ctx.alloc('field', { clear: 1 });
    switch (ctx.params.how) {
      case 'throw': throw new Error('The tide table is empty');
      case 'reject': await ctx.flush(); return Promise.reject(new TypeError('late failure'));
      case 'text': throw 'just a string';
      case 'binding': ctx.run(plain, { in: { src: out }, out: { out } }); break;
      case 'no-output': return;
      case 'watchdog': ctx.run(untiled, { out: { out }, cost: 1e9 }); break;
      case 'big': ctx.alloc('aux', { size: 2048 }); break;
      case 'big-second': if (secondRuns++ > 0) ctx.alloc('aux', { size: 2048 }); break;
      default:
    }
    ctx.output('out', out);
  },
});

const brokenKernel = defineKernel({
  name: 'test/broken',
  outputs: { out: 'field' },
  code: `
fn helper(v: f32) -> f32 { return v * 2.0; }
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let wrong: f32 = vec2f(1.0, 2.0);
  return helper(uv.x);
}`,
});
const brokenNode = defineNode({
  type: 'ref/broken',
  title: 'Broken shader (Test)',
  category: 'ref',
  description: 'Has a kernel that does not compile.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [brokenKernel],
  evaluate() {
    assert.fail('evaluate() is not called when a kernel does not compile');
  },
});

const versionedNode = defineNode({
  type: 'ref/versioned',
  title: 'Versioned (Test)',
  category: 'ref',
  description: 'Is at version 2.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  version: 2,
  migrate: (params) => params,
  evaluate: (ctx) => ctx.output('out', ctx.alloc('field', { clear: 2 })),
});

const importNode = defineNode({
  type: 'ref/import',
  title: 'Import (Test)',
  category: 'ref',
  description: 'Reads a file.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'file', name: 'file', default: '', filters: ['r16'], help: 'The file.' }],
  kernels: [],
  async evaluate(ctx) {
    if (ctx.params.file === '') throw new Error('No file selected');
    const bytes = await ctx.readFile(ctx.params.file);
    ctx.output('out', ctx.alloc('field', { clear: bytes.length }));
  },
});

const sidecarNode = defineNode({
  type: 'ref/sidecar',
  title: 'Sidecar (Test)',
  category: 'ref',
  description: 'Has an externalKey that fails.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'bool', name: 'plainError', default: false, help: 'Throw something that is not a FileError.' }],
  kernels: [],
  externalKey({ params }) {
    if (params.plainError) throw new Error('the sidecar index is corrupt');
    throw new FileError('denied', '/mem/sidecar.json', 'No permission to read /mem/sidecar.json');
  },
  evaluate() {
    assert.fail('evaluate() is not called when externalKey fails');
  },
});

const DEFS = [constantNode, gainNode, sumNode, tintNode, failNode, brokenNode, versionedNode, importNode, sidecarNode];
const files = memoryFiles();
const t = await startEngine(DEFS, { files });
after(() => t.dispose());

const errorOf = (events: readonly EvalEvent[], nodeId: string): NodeError => {
  const found = eventsOf(events, 'node-error').find((e) => e.error.nodeId === nodeId);
  assert.ok(found, `node ${nodeId} has a node-error`);
  return found.error;
};
const failing = (how: string, extra: Record<string, NodeSpec> = {}): GraphDoc => t.doc({ n: { type: 'ref/fail', params: { how } }, ...extra });

test('the checks before any GPU work: unknown type, version, cycle, missing input, parameter error', async () => {
  const doc = t.doc({
    level: { type: 'ref/constant' },
    gone: { type: 'ref/gone', inputs: { in: 'level.out' } },
    afterGone: { type: 'ref/gain', inputs: { in: 'gone.out' } },
    newer: { type: 'ref/versioned', version: 3 },
    older: { type: 'ref/versioned', version: 1 },
    current: { type: 'ref/versioned' },
    loopA: { type: 'ref/gain', inputs: { in: 'loopB.out' } },
    loopB: { type: 'ref/gain', inputs: { in: 'loopA.out' } },
    afterLoop: { type: 'ref/gain', inputs: { in: 'loopB.out' } },
    unconnected: { type: 'ref/sum', inputs: { b: 'level.out' } },
    badParam: { type: 'ref/fail', params: { how: 'explode' } },
    optional: { type: 'ref/sum', inputs: { a: 'level.out', b: 'badParam.out' } },
  });
  calls.clear();
  const out = await t.run(doc, ['gone', 'afterGone.out', 'newer.out', 'older.out', 'current.out', 'afterLoop.out', 'unconnected.out', 'optional.out']);
  assert.equal(out.result.status, 'errors');
  assert.deepEqual(endings(out.events), {
    gone: 'error:unknown-type', afterGone: 'error:missing-input', newer: 'error:version', older: 'error:version', current: 'run',
    loopA: 'error:cycle', loopB: 'error:cycle', afterLoop: 'skipped:upstream', unconnected: 'error:missing-input',
    level: 'run', badParam: 'error:param', optional: 'skipped:upstream',
  });
  const message = (id: string): string => errorOf(out.events, id).message;
  assert.equal(message('gone'), 'Unknown node type "ref/gone"');
  assert.equal(errorOf(out.events, 'gone').nodeType, 'ref/gone');
  // An edge from a node of unknown type is ignored: its reader has an unconnected input, not a failed source.
  assert.equal(message('afterGone'), 'missing input "in"');
  assert.equal(message('newer'), 'Saved with version 3 of this node; this build has version 2');
  assert.equal(message('older'), 'Saved with version 1 of this node; this build has version 2');
  assert.equal(message('loopA'), 'Part of a cycle');
  assert.equal(message('unconnected'), 'missing input "a"');
  assert.equal(message('badParam'), 'param "how": unknown value "explode"');
  const skipped = eventsOf(out.events, 'node-skipped');
  assert.deepEqual(skipped.map((e) => [e.nodeId, e.reason, e.upstream]), [['afterLoop', 'upstream', 'loopB'], ['optional', 'upstream', 'badParam']]);
  assert.deepEqual(eventsOf(out.events, 'eval-start')[0]!.plan.filter((p) => p.state !== 'blocked').map((p) => p.nodeId).sort(), ['current', 'level']);
  assert.deepEqual(out.result.errors.map((e) => e.nodeId), ['gone', 'afterGone', 'newer', 'older', 'loopA', 'loopB', 'unconnected', 'badParam'], 'one per failed node, in plan order');
  assert.deepEqual(out.data.map((d) => d !== null), [false, false, false, false, true, false, false, false]);
  assert.equal(calls.get('ref/fail'), undefined, 'evaluate() is not called for a blocked node');
  assert.equal(eventsOf(out.events, 'node-start').length, 2);
  t.noLeaks();
});

test('a failed node fails alone: what reads it is skipped as "upstream", other branches evaluate, nothing of it is cached', async () => {
  await t.engine.trim();
  const doc = failing('throw', {
    reader: { type: 'ref/gain', inputs: { in: 'n.out' } },
    far: { type: 'ref/gain', inputs: { in: 'reader.out' } },
    level: { type: 'ref/constant', params: { value: 2 } },
    side: { type: 'ref/sum', inputs: { a: 'level.out', b: 'far.out' } },
    free: { type: 'ref/gain', params: { gain: 4 }, inputs: { in: 'level.out' } },
  });
  for (const round of [1, 2]) {
    const out = await t.run(doc, ['far.out', 'side.out', 'free.out']);
    assert.equal(out.result.status, 'errors');
    assert.deepEqual(endings(out.events), {
      n: 'error:node-exception', reader: 'skipped:upstream', far: 'skipped:upstream', side: 'skipped:upstream',
      level: round === 1 ? 'run' : 'cached', free: round === 1 ? 'run' : 'cached',
    }, `round ${round}`);
    assert.deepEqual(eventsOf(out.events, 'node-skipped').map((e) => e.upstream), ['n', 'n', 'n'], 'every skipped node names the failed one');
    assert.deepEqual(out.result.errors.map((e) => [e.nodeId, e.kind, e.message]), [['n', 'node-exception', 'The tide table is empty']]);
    assert.deepEqual(out.data.map((d) => d !== null), [false, false, true]);
    assertUniform(out.data[2], 8, 'the branch that does not read the failed node');
    t.noLeaks();
  }
  assert.equal(t.engine.memory().cacheBytes, 2 * 65 * 65 * 4, 'only level and free are cached');
});

test('what evaluate() does wrong: an exception, a rejection, a broken binding, a missing output, a dispatch that cannot be tiled', async () => {
  const cases: [string, NodeError['kind'], RegExp][] = [
    ['throw', 'node-exception', /^The tide table is empty$/],
    ['reject', 'node-exception', /^late failure$/],
    ['text', 'node-exception', /^just a string$/],
    ['binding', 'binding', /^kernel "test\/plain" \(node n, ref\/fail\): field #\d+ is bound to input "src" and output "out"\. One run cannot read and write the same texture/],
    ['no-output', 'binding', /^output "out" was not produced$/],
    ['watchdog', 'watchdog', /^kernel "test\/untiled" cannot be tiled and one dispatch is estimated at \d+ ms; the limit is 500 ms$/],
  ];
  for (const [how, kind, message] of cases) {
    const out = await t.run(failing(how), ['n.out'], { mode: 'build' });
    const error = errorOf(out.events, 'n');
    assert.deepEqual([error.kind, message.test(error.message)], [kind, true], `${how}: ${JSON.stringify(error)}`);
    assert.deepEqual(eventsOf(out.events, 'node-start').length, 1);
    t.noLeaks();
  }
  assert.equal(errorOf((await t.run(failing('binding'), ['n.out'], { mode: 'build' })).events, 'n').kernel, 'test/plain');
  assert.equal(errorOf((await t.run(failing('watchdog'), ['n.out'], { mode: 'build' })).events, 'n').kernel, 'test/untiled');
  assert.deepEqual(endings((await t.run(failing('none'), ['n.out'], { mode: 'build' })).events), { n: 'run' });
});

test('a kernel that does not compile blocks its node, with the diagnostic in the author\'s own code', async () => {
  const doc = t.doc({ bad: { type: 'ref/broken' }, reader: { type: 'ref/gain', inputs: { in: 'bad.out' } }, level: { type: 'ref/constant' } });
  for (const round of [1, 2]) {
    const out = await t.run(doc, ['reader.out', 'level.out']);
    assert.deepEqual(endings(out.events), { bad: 'error:shader-compile', reader: 'skipped:upstream', level: round === 1 ? 'run' : 'cached' });
    assert.deepEqual(eventsOf(out.events, 'eval-start')[0]!.plan.map((p) => [p.nodeId, p.state]), [['bad', 'blocked'], ['reader', 'blocked'], ['level', round === 1 ? 'run' : 'cached']]);
    const error = errorOf(out.events, 'bad');
    assert.match(error.message, /^kernel "test\/broken": /);
    assert.equal(error.kernel, 'test/broken');
    assert.ok(error.wgsl, 'a WGSL diagnostic');
    assert.deepEqual([error.wgsl.origin, error.wgsl.line], ['code', 4], JSON.stringify(error.wgsl));
    assert.ok(error.wgsl.excerpt.some((line) => line.includes('let wrong: f32 = vec2f(1.0, 2.0);')), error.wgsl.excerpt.join('\n'));
    assert.ok(typeof error.detail === 'string' && error.detail.length > 0);
    t.noLeaks();
  }
});

test('files: no file selected, a file that is missing, an externalKey that fails', async () => {
  files.put('heights.r16', new Uint8Array(40));
  const run = (file: string) => t.run(t.doc({ n: { type: 'ref/import', params: { file } } }), ['n.out'], { mode: 'build' });
  assertUniform((await run('heights.r16')).data[0], 40, 'the bytes of the file');
  const none = errorOf((await run('')).events, 'n');
  assert.deepEqual([none.kind, none.message], ['node-exception', 'No file selected']);
  const missing = errorOf((await run('nowhere.r16')).events, 'n');
  assert.deepEqual([missing.kind, missing.message], ['io', 'File not found: /mem/nowhere.r16']);

  const doc = t.doc({
    side: { type: 'ref/sidecar' },
    plain: { type: 'ref/sidecar', params: { plainError: true } },
    reader: { type: 'ref/gain', inputs: { in: 'side.out' } },
    level: { type: 'ref/constant' },
  });
  const out = await t.run(doc, ['reader.out', 'plain.out', 'level.out'], { mode: 'build' });
  assert.deepEqual(endings(out.events), { side: 'error:io', reader: 'skipped:upstream', plain: 'error:node-exception', level: 'run' });
  assert.equal(errorOf(out.events, 'side').message, 'No permission to read /mem/sidecar.json');
  assert.equal(errorOf(out.events, 'plain').message, 'the sidecar index is corrupt');
  assert.deepEqual([...(await t.engine.keys(doc)).keys()], ['level'], 'a node whose externalKey fails has no key, and neither has its reader');
  t.noLeaks();
});

test('two nodes of one key fail together: the second does not run to fail the same way', async () => {
  calls.clear();
  const doc = t.doc({
    first: { type: 'ref/fail', params: { how: 'throw' } },
    twin: { type: 'ref/fail', params: { how: 'throw' } },
    sum: { type: 'ref/sum', inputs: { a: 'first.out', b: 'twin.out' } },
  });
  const out = await t.run(doc, ['sum.out', 'twin.out']);
  assert.deepEqual(endings(out.events), { first: 'error:node-exception', twin: 'error:node-exception', sum: 'skipped:upstream' });
  assert.deepEqual(out.result.errors.map((e) => [e.nodeId, e.message]), [['first', 'The tide table is empty'], ['twin', 'The tide table is empty']]);
  assert.equal(calls.get('ref/fail'), 1);
  t.noLeaks();
});

test('a node skipped for its mask alone does not take the nodes of its key with it: the next one runs', async () => {
  // The mask is not in K(n) (5.4): the three gains have one key, and the first in the plan cannot run.
  const twins = (broken: NodeSpec): GraphDoc => t.doc({
    level: { type: 'ref/constant', params: { value: 3 } },
    half: { type: 'ref/constant', params: { value: 0.5 } },
    broken,
    masked: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'level.out', mask: 'broken.out' } },
    plain: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'level.out' } },
    blended: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'level.out', mask: 'half.out' } },
  });
  const targets = ['masked.out', 'plain.out', 'blended.out'];
  for (const mode of ['preview', 'build'] as const) {
    await t.engine.trim();
    calls.clear();
    // The mask source fails when it runs: nothing says so before the masked node's turn.
    const doc = twins({ type: 'ref/fail', params: { how: 'throw', tag: 7 }, inputs: { in: 'level.out' } });
    const out = await t.run(doc, targets, { mode });
    assert.equal(out.result.status, 'errors');
    assert.deepEqual(endings(out.events), {
      level: 'run', half: 'run', broken: 'error:node-exception', masked: 'skipped:upstream', plain: 'run', blended: 'cached',
    }, mode);
    assert.deepEqual(out.result.errors.map((e) => [e.nodeId, e.kind]), [['broken', 'node-exception']], mode);
    assert.equal(calls.get('ref/gain'), 1, `${mode}: one run for the key`);
    assert.equal(out.data[0], null);
    assertUniform(out.data[1], 15, `${mode}: the node that reads nothing that failed`);
    assertUniform(out.data[2], 9, `${mode}: the node of the same key with a mask that did not fail`);
    assert.equal(out.result.timing.nodesRun, 3, mode);
    t.noLeaks();
    if (mode === 'preview') {
      // The entry the second node made is a hit for all of them now.
      const again = await t.run(doc, targets);
      assert.deepEqual(endings(again.events), {
        level: 'cached', half: 'cached', broken: 'error:node-exception', masked: 'skipped:upstream', plain: 'cached', blended: 'cached',
      });
      assert.equal(calls.get('ref/gain'), 1);
      t.noLeaks();
    }
  }

  // A mask source that is known not to run before the first node does: eval-start says which node runs for the key.
  await t.engine.trim();
  calls.clear();
  const out = await t.run(twins({ type: 'ref/broken' }), targets);
  assert.deepEqual(eventsOf(out.events, 'eval-start')[0]!.plan.filter((p) => ['masked', 'plain', 'blended'].includes(p.nodeId)), [
    { nodeId: 'masked', state: 'blocked' }, { nodeId: 'plain', state: 'run' }, { nodeId: 'blended', state: 'cached' },
  ]);
  assert.deepEqual(endings(out.events), {
    level: 'run', half: 'run', broken: 'error:shader-compile', masked: 'skipped:upstream', plain: 'run', blended: 'cached',
  });
  assertUniform(out.data[1], 15, 'plain.out');
  assertUniform(out.data[2], 9, 'blended.out');
  assert.equal(calls.get('ref/gain'), 1);
  t.noLeaks();

  // Every node of the key reads something that failed: none runs, and none is reported as an internal failure.
  await t.engine.trim();
  calls.clear();
  const all = await t.run(t.doc({
    level: { type: 'ref/constant', params: { value: 3 } },
    broken: { type: 'ref/fail', params: { how: 'throw', tag: 8 }, inputs: { in: 'level.out' } },
    first: { type: 'ref/gain', params: { gain: 6 }, inputs: { in: 'level.out', mask: 'broken.out' } },
    second: { type: 'ref/gain', params: { gain: 6 }, inputs: { in: 'level.out', mask: 'broken.out' } },
  }), ['first.out', 'second.out']);
  assert.deepEqual(endings(all.events), { level: 'run', broken: 'error:node-exception', first: 'skipped:upstream', second: 'skipped:upstream' });
  assert.equal(calls.get('ref/gain') ?? 0, 0);
  t.noLeaks();
});

test('BudgetExceededError is not retried: the node fails with kind "budget" and its fields are free again', async () => {
  const small = await startEngine(DEFS, { budgetBytes: 8 * MIB });
  try {
    calls.clear();
    const out = await small.run(small.doc({ n: { type: 'ref/fail', params: { how: 'big' } }, reader: { type: 'ref/gain', inputs: { in: 'n.out' } } }), ['reader.out']);
    assert.deepEqual(endings(out.events), { n: 'error:budget', reader: 'skipped:upstream' });
    // 2048 x 2048 x 16 bytes are 64 MB, the budget is 8.
    assert.match(out.result.errors[0]!.message, /^Needs (5[6-9]|6[0-4]) MB more GPU memory at 65 × 65: budget 8 MB, 17 KB in use by this node, 0 MB pinned$/);
    assert.match(out.result.errors[0]!.detail ?? '', /does not fit the GPU memory budget/);
    assert.equal(calls.get('ref/fail'), 1, 'one attempt');
    small.noLeaks();
    assertUniform((await small.run(small.doc({ n: { type: 'ref/fail' } }), ['n.out'])).data[0], 1, 'the engine goes on');
  } finally {
    await small.dispose();
  }
});

test('a GPU out-of-memory report: everything reclaimable is freed and the node runs once more', async () => {
  // The second texture this engine creates reports out of memory: the field of node "n", after that of "level".
  const oom = await startEngine(DEFS, { hooks: { failAllocAfter: 2 } });
  try {
    calls.clear();
    const doc = oom.doc({
      level: { type: 'ref/constant', params: { value: 3 } },
      n: { type: 'ref/fail', params: { how: 'none' }, inputs: { in: 'level.out' } },
      reader: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'n.out' } },
    });
    const out = await oom.run(doc, ['reader.out']);
    assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
    assert.deepEqual(endings(out.events), { level: 'run', n: 'run', reader: 'run' });
    assert.equal(calls.get('ref/fail'), 2, 'evaluate() ran twice');
    assert.equal(eventsOf(out.events, 'node-start').filter((e) => e.nodeId === 'n').length, 1, 'one node-start');
    assertUniform(out.data[0], 5, 'reader.out');
    oom.noLeaks();
    assert.equal(oom.engine.memory().drainingBytes, 0, 'the retry waits until the destroyed textures are drained');
    // The hook fires once: the same document evaluates from the cache, and a new one without a retry.
    calls.clear();
    await oom.engine.trim();
    assert.equal((await oom.run(doc, ['reader.out'])).result.status, 'ok');
    assert.equal(calls.get('ref/fail'), 1);
  } finally {
    await oom.dispose();
  }
});

test('the retry empties the cache of what can go; a second failure for memory is kind "out-of-memory"', async () => {
  const oom = await startEngine(DEFS, { hooks: { failAllocAfter: 4 }, budgetBytes: 16 * MIB });
  try {
    // Three textures are created and cached; the fourth creation is the one that fails.
    const warm = oom.doc({
      a: { type: 'ref/constant', params: { value: 1 } },
      b: { type: 'ref/constant', params: { value: 2 } },
      c: { type: 'ref/constant', params: { value: 3 } },
    });
    const kept = await oom.evaluate(warm, ['a.out', 'b.out', 'c.out']);
    kept.result.fields[1]!.release();
    kept.result.fields[2]!.release();
    assert.equal(oom.engine.memory().cacheBytes, 2 * 65 * 65 * 4);

    secondRuns = 0;
    calls.clear();
    const out = await oom.run(oom.doc({ n: { type: 'ref/fail', params: { how: 'big-second' } } }), ['n.out']);
    assert.deepEqual(endings(out.events), { n: 'error:out-of-memory' });
    assert.equal(calls.get('ref/fail'), 2, 'the node ran once more, and no third time');
    const error = out.result.errors[0]!;
    assert.equal(error.message, 'Out of GPU memory at 65 × 65 (budget 16 MB). Lower the resolution or raise the GPU memory budget');
    assert.match(error.detail ?? '', /does not fit the GPU memory budget/);

    // Every evictable entry went; the content behind the handle that is still held did not.
    const memory = oom.engine.memory();
    assert.deepEqual([memory.cacheBytes, memory.pinnedBytes, memory.workingBytes, memory.drainingBytes], [0, 65 * 65 * 4, 0, 0]);
    assertUniform(await oom.engine.read(kept.result.fields[0]!), 1, 'pinned content survives the reclaim');
    kept.result.fields[0]!.release();
    oom.noLeaks();
  } finally {
    await oom.dispose();
  }
});

/**
 * Makes the next pool texture the device creates an invalid one, which is what createTexture returns on a full
 * card: the object exists and every use of it is a validation error. Returns the undo.
 */
function nextTextureInvalid(device: GPUDevice): () => void {
  const create = device.createTexture;
  let armed = true;
  (device as { createTexture: GPUDevice['createTexture'] }).createTexture = (descriptor) => {
    if (!armed || !(descriptor.label ?? '').startsWith('field ')) return create.call(device, descriptor);
    armed = false;
    return create.call(device, { ...descriptor, mipLevelCount: 99 });
  };
  return () => { delete (device as { createTexture?: GPUDevice['createTexture'] }).createTexture; };
}

test('an out-of-memory report on a conversion: reclaimed and made once more, like a node', async () => {
  // Creations in order: the colour of "c", its luma conversion for the field input of "g", the output of "g".
  const oom = await startEngine(DEFS, { hooks: { failAllocAfter: 2 } });
  try {
    calls.clear();
    const doc = (gain: number): GraphDoc => oom.doc({
      c: { type: 'ref/tint', params: { tint: [1, 1, 1] } },
      g: { type: 'ref/gain', params: { gain }, inputs: { in: 'c.out' } },
    });
    const out = await oom.run(doc(3), ['g.out']);
    assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
    assert.deepEqual(endings(out.events), { c: 'run', g: 'run' });
    assert.equal(calls.get('ref/gain'), 1, 'the node that reads the conversion ran once');
    assertUniform(out.data[0], 3, 'g.out', 2e-3);
    assert.equal(oom.slices.filter((s) => s.service === 'convert').length, 2, 'the conversion was made twice');
    oom.noLeaks();
    assert.equal(oom.engine.memory().drainingBytes, 0, 'the retry waits until the destroyed textures are drained');
  } finally {
    await oom.dispose();
  }
});

test('a texture whose creation failed is not left in the pool: what the engine allocates next for itself works', async () => {
  // The fault hits a conversion, whose texture the evaluator itself allocates and releases.
  const converted = await startEngine(DEFS, { hooks: { failAllocAfter: 2 } });
  try {
    const doc = (gain: number): GraphDoc => converted.doc({
      c: { type: 'ref/tint', params: { tint: [1, 1, 1] } },
      g: { type: 'ref/gain', params: { gain }, inputs: { in: 'c.out' } },
    });
    const colour = await converted.run(doc(2), ['c.out']);
    assert.equal(colour.result.status, 'ok');
    const undo = nextTextureInvalid(converted.gpu.device);
    let first;
    try {
      first = await converted.run(doc(2), ['g.out']);
    } finally {
      undo();
    }
    assert.equal(first.result.status, 'ok', JSON.stringify(first.result.errors));
    assertUniform(first.data[0], 2, 'g.out after the retry', 2e-3);
    // Other documents afterwards read nothing of the fault.
    for (const gain of [4, 5, 6]) {
      const later = await converted.run(doc(gain), ['g.out']);
      assert.equal(later.result.status, 'ok', `gain ${gain}: ${JSON.stringify(later.result.errors)}`);
      assertUniform(later.data[0], gain, `g.out at gain ${gain}`, 2e-3);
    }
    converted.noLeaks();
  } finally {
    await converted.dispose();
  }

  // The fault hits the scratch texture of Engine.stats, a service that is not retried.
  const stats = await startEngine(DEFS, { hooks: { failAllocAfter: 2 } });
  try {
    const { result } = await stats.evaluate(stats.doc({ level: { type: 'ref/constant', params: { value: 3 } } }), ['level.out']);
    const handle = result.fields[0]!;
    assert.equal(handle.kind, 'field');
    const undo = nextTextureInvalid(stats.gpu.device);
    try {
      await assert.rejects(stats.engine.stats(handle as never), /out of memory/i);
    } finally {
      undo();
    }
    const measured = await stats.engine.stats(handle as never);
    assert.deepEqual([measured.min, measured.max, measured.nonFinite], [3, 3, 0], 'the same call again measures the field');
    handle.release();
    stats.noLeaks();
  } finally {
    await stats.dispose();
  }
});

