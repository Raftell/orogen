// The evaluation context (engine.md 4.7 to 4.10, 4.15): every method's semantics and failure behaviour, as a
// node sees them. The node under test calls whatever function the test registers.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  defineKernel, defineNode, FieldAccessError, KernelBindingError, mixSeed, param,
  type EvalContext, type Field,
} from '../../../src/core/api.ts';
import type { EvalEvent, NodeError } from '../../../src/core/runtime.ts';
import { assertUniform, constantNode, eventsOf, SETTINGS, startEngine, tintNode, type RunOutcome, type TestEngine } from './rig.ts';

const fill = defineKernel({
  name: 'test/fill',
  outputs: { out: 'field' },
  params: { value: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return P.value + f32(frame.iteration); }',
});
const accumulate = defineKernel({
  name: 'test/accumulate',
  inPlace: { acc: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out { return Out(cur.acc + f32(frame.iteration)); }',
});
const next = defineKernel({
  name: 'test/next',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return h_at(px) * 1.5 + 1.0; }',
});
const table = defineKernel({
  name: 'test/table',
  outputs: { out: 'field' },
  luts: { ramp: 'f32' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return ramp_at(uv.x) + f32(ramp_len()); }',
});
const seeded = defineKernel({
  name: 'test/seeded',
  outputs: { out: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return f32(frame.seed & 0xffffu); }',
});
const unlisted = defineKernel({
  name: 'test/unlisted',
  outputs: { out: 'field' },
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }',
});

type Script = (ctx: EvalContext) => void | Promise<void>;
const scripts = new Map<string, Script>();

const scriptNode = defineNode({
  type: 'ref/script',
  title: 'Script (Test)',
  category: 'ref',
  description: 'Calls the function a test registered.',
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }, { name: 'extra', type: 'field', role: 'data' }, { name: 'tint', type: 'color' }],
  params: [
    { kind: 'text', name: 'script', default: '', help: 'The registered function to call.' },
    { kind: 'float', name: 'level', unit: 'height', default: 0.5, min: 0, max: 1, help: 'A hard-limited value.' },
    { kind: 'enum', name: 'shape', default: 'round', options: [{ value: 'flat', label: 'Flat' }, { value: 'round', label: 'Round' }, { value: 'sharp', label: 'Sharp' }], help: 'An enum.' },
  ],
  kernels: [fill, accumulate, next, table],
  uses: ['seaLevel'],
  evaluate: (ctx) => scripts.get(ctx.params.script)!(ctx),
});

const seedNode = defineNode({
  type: 'ref/seeded',
  title: 'Seeded (Test)',
  category: 'ref',
  description: 'Writes its seed.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [param.seed()],
  kernels: [seeded],
  evaluate(ctx) {
    scripts.get('seeded')?.(ctx);
    const out = ctx.alloc('field');
    ctx.run(seeded, { out: { out } });
    ctx.output('out', out);
  },
});

const t = await startEngine([scriptNode, seedNode, constantNode, tintNode]);
after(() => t.dispose());

let serial = 0;
/** Evaluates one script node, as a build so that it always runs. `fn` must give the output `out`. */
async function script(fn: Script, opts: { input?: number; targets?: string[]; params?: Record<string, unknown>; engine?: TestEngine; onEvent?: (e: EvalEvent) => void } = {}): Promise<RunOutcome> {
  const name = `s${++serial}`;
  scripts.set(name, fn);
  const engine = opts.engine ?? t;
  const doc = engine.doc({
    source: { type: 'ref/constant', params: { value: opts.input ?? 0 } },
    n: { type: 'ref/script', params: { script: name, ...opts.params }, ...(opts.input !== undefined ? { inputs: { in: 'source.out' } } : {}) },
  });
  try {
    return await engine.run(doc, opts.targets ?? ['n.out'], { mode: 'build', ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
  } finally {
    scripts.delete(name);
    engine.noLeaks();
  }
}
const ok = (outcome: RunOutcome): RunOutcome => {
  assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result.errors));
  return outcome;
};
const failure = (outcome: RunOutcome): NodeError => {
  assert.equal(outcome.result.status, 'errors');
  assert.equal(outcome.result.errors.length, 1);
  return outcome.result.errors[0]!;
};
const filled = (ctx: EvalContext, value: number): Field<'field'> => ctx.alloc('field', { clear: value });
const finish = (ctx: EvalContext, value = 0): void => ctx.output('out', filled(ctx, value));

test('the environment: resolution, sizes, the ladder, unit helpers, params, enumIndex, settings', async () => {
  ok(await script((ctx) => {
    assert.deepEqual([ctx.res, ctx.terrainSize, ctx.heightRange, ctx.cellSize], [65, 4096, 1024, 64]);
    assert.deepEqual(ctx.ladder, [65, 33]);
    assert.equal(ctx.ladder[2], undefined);
    assert.equal(ctx.signal.aborted, false);
    assert.equal(ctx.lengthToPx(0.25), 16);
    assert.equal(ctx.lengthToPx(0.25, 129), 32);
    assert.equal(ctx.lengthToPx(0.5, ctx.alloc('field', { size: 17 })), 8);
    assert.equal(ctx.lengthToMetres(0.25), 1024);
    assert.equal(ctx.heightToMetres(0.5), 512);
    // Validated values: defaults filled in, hard limits applied.
    assert.deepEqual({ ...ctx.params }, { script: ctx.params.script, level: 1, shape: 'sharp' });
    assert.equal(ctx.enumIndex('shape'), 2);
    assert.throws(() => ctx.enumIndex('level'), /no enum param/);
    assert.equal(ctx.setting('seaLevel'), SETTINGS.seaLevel);
    assert.throws(() => ctx.seed, /no seed param/);
    assert.throws(() => { (ctx.params as { level: number }).level = 2; }, TypeError, 'params are frozen');
    finish(ctx);
  }, { params: { level: 7, shape: 'sharp' } }));
});

test('the seed is mixSeed(project seed, node seed), in ctx.seed and in frame.seed', async () => {
  let seen = -1;
  scripts.set('seeded', (ctx) => { seen = ctx.seed; });
  for (const [project, node] of [[1, 0], [1, 99], [77, 99]] as const) {
    const doc = t.doc({ s: { type: 'ref/seeded', params: { seed: node } } }, { seed: project });
    const out = await t.run(doc, ['s.out'], { mode: 'build' });
    assert.equal(seen, mixSeed(project, node));
    assertUniform(out.data[0], mixSeed(project, node) & 0xffff, `frame.seed for project ${project}, node ${node}`);
  }
  scripts.delete('seeded');
  const undeclared = defineSettingProbe();
  assert.match(failure(await undeclared).message, /does not declare the setting/);
});
// A node without `uses` that reads a setting: the seed node above.
function defineSettingProbe(): Promise<RunOutcome> {
  scripts.set('seeded', (ctx) => { ctx.setting('seaLevel'); });
  return t.run(t.doc({ s: { type: 'ref/seeded' } }), ['s.out'], { mode: 'build' }).finally(() => scripts.delete('seeded'));
}

test('input: the same read-only handle on every call, null for an unconnected optional input', async () => {
  ok(await script((ctx) => {
    const input = ctx.input('in');
    assert.ok(input && input === ctx.input('in'));
    assert.deepEqual([input.kind, input.width, input.height, input.readOnly], ['field', 65, 65, true]);
    assert.throws(() => (ctx as EvalContext).input('mask'), /no input of that name/);
    finish(ctx);
  }, { input: 3 }));
  ok(await script((ctx) => {
    assert.equal(ctx.input('in'), null);
    finish(ctx);
  }));
});

test('alloc: size, like, clear; a side outside 1..8192 fails the node', async () => {
  const out = ok(await script(async (ctx) => {
    const a = ctx.alloc('field');
    assert.deepEqual([a.kind, a.width, a.height, a.readOnly], ['field', 65, 65, false]);
    const b = ctx.alloc('vec2', { size: 9 });
    assert.deepEqual([b.kind, b.width, b.height], ['vec2', 9, 9]);
    const c = ctx.alloc('color', { size: [12, 5], clear: [0.25, 0.5, 0.75, 1] });
    assert.deepEqual([c.width, c.height], [12, 5]);
    const d = ctx.alloc('field', { like: c, clear: -2 });
    assert.deepEqual([d.width, d.height], [12, 5]);
    assert.equal(ctx.alloc('half', { like: c, size: 3 }).width, 3, 'like is ignored when size is given');
    assert.notEqual(a.id, b.id);
    assertUniform(await ctx.read(d), -2, 'clear with a number');
    const colour = await ctx.read(c);
    assert.deepEqual([...colour.subarray(0, 4)], [0.25, 0.5, 0.75, 1]);
    assert.deepEqual([...colour.subarray(colour.length - 4)], [0.25, 0.5, 0.75, 1]);
    ctx.output('out', filled(ctx, 4));
  }));
  assertUniform(out.data[0], 4, 'alloc with clear');

  for (const size of [0, 8193, 2.5, [4, -1]] as const) {
    const error = failure(await script((ctx) => { ctx.alloc('field', { size: size as number }); }));
    assert.deepEqual([error.kind, /field side is 1 to 8192/.test(error.message)], ['binding', true], JSON.stringify(error));
  }
  assert.equal(failure(await script((ctx) => { ctx.alloc('nope' as 'field'); })).kind, 'binding');
});

test('clone copies the contents into a writable field, also of a read-only one', async () => {
  const out = ok(await script(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    const copy = ctx.clone(input);
    assert.deepEqual([copy.kind, copy.width, copy.readOnly], ['field', 65, false]);
    ctx.clear(copy, 9);
    const again = ctx.clone(copy);
    ctx.clear(copy, 1);
    assertUniform(await ctx.read(input), 5, 'the input is untouched');
    assertUniform(await ctx.read(copy), 1, 'the copy was cleared after it was cloned');
    ctx.output('out', again);
  }, { input: 5 }));
  assertUniform(out.data[0], 9, 'a clone holds what its source held when it was made');
});

test('clear and write refuse a read-only field; release refuses an input, an output and a second call', async () => {
  ok(await script((ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    assert.throws(() => ctx.clear(input), FieldAccessError);
    assert.throws(() => ctx.write(input, new Float32Array(65 * 65)), FieldAccessError);
    assert.throws(() => ctx.release(input), /is an input/);
    const scratch = ctx.alloc('field');
    ctx.release(scratch);
    assert.throws(() => ctx.release(scratch), /was released/);
    assert.throws(() => ctx.clear(scratch), FieldAccessError);
    assert.throws(() => ctx.clone(scratch), FieldAccessError);
    assert.throws(() => ctx.alloc('field', { like: scratch }), FieldAccessError);
    assert.throws(() => ctx.run(fill, { out: { out: scratch }, params: { value: 1 } }), /was released/);
    assert.throws(() => ctx.clear({ ...ctx.alloc('field') }), /not a field of this evaluation/);
    const out = filled(ctx, 2);
    ctx.output('out', out);
    assert.equal(out.readOnly, true, 'read-only from ctx.output() on');
    assert.throws(() => ctx.release(out), /passed to ctx.output/);
    assert.throws(() => ctx.clear(out), FieldAccessError);
    assert.throws(() => ctx.run(fill, { out: { out }, params: { value: 1 } }), KernelBindingError);
  }, { input: 1 }));
});

test('output: the port\'s kind and size, once per port, a field of this node or one of its inputs', async () => {
  const cases: [RegExp, Script][] = [
    [/is "color"; the output is "field"/, (ctx) => ctx.output('out', ctx.alloc('color'))],
    [/is "half"; the output is "field"/, (ctx) => ctx.output('out', ctx.alloc('half') as never)],
    [/is 33x33; an output is 65x65/, (ctx) => ctx.output('out', ctx.alloc('field', { size: 33 }))],
    [/was already given/, (ctx) => { finish(ctx); finish(ctx); }],
    [/was released/, (ctx) => { const f = ctx.alloc('field'); ctx.release(f); ctx.output('out', f); }],
    [/no output of that name/, (ctx) => (ctx as EvalContext).output('flow', ctx.alloc('field'))],
    [/^output "out" was not produced$/, () => undefined],
  ];
  for (const [message, fn] of cases) {
    const error = failure(await script(fn));
    assert.deepEqual([error.kind, message.test(error.message)], ['binding', true], `${message}: ${JSON.stringify(error)}`);
  }

  // One field for two outputs is published once and referenced twice; an unwanted output may be given anyway.
  const twice = ok(await script((ctx) => {
    assert.deepEqual([ctx.wants('out'), ctx.wants('extra'), ctx.wants('tint')], [true, true, false]);
    assert.throws(() => (ctx as EvalContext).wants('flow'), /no output of that name/);
    const both = filled(ctx, 6);
    ctx.output('out', both);
    ctx.output('extra', both);
    ctx.output('tint', ctx.alloc('color', { clear: [1, 0, 0, 1] }));
  }, { targets: ['n.out', 'n.extra'] }));
  assertUniform(twice.data[0], 6, 'out');
  assertUniform(twice.data[1], 6, 'extra');

  // An input given as an output is an alias: no texture is allocated.
  const alias = ok(await script((ctx) => ctx.output('out', ctx.input('in') as Field<'field'>), { input: 8 }));
  assertUniform(alias.data[0], 8, 'the input passed through');
  assert.equal(eventsOf(alias.events, 'node-done').find((e) => e.nodeId === 'n')!.peakBytes, 0);
});

test('run: a kernel the node does not list is refused; everything takes effect in call order', async () => {
  const error = failure(await script((ctx) => { ctx.run(unlisted, { out: { out: ctx.alloc('field') } }); }));
  assert.deepEqual([error.kind, error.kernel], ['binding', 'test/unlisted']);
  assert.match(error.message, /^kernel "test\/unlisted" \(node n, ref\/script\): is not listed in NodeDef.kernels/);

  const out = ok(await script(async (ctx) => {
    const a = ctx.alloc('field');
    const b = ctx.alloc('field');
    ctx.run(fill, { out: { out: a }, params: { value: 1 } });              // a = 1
    ctx.run(next, { in: { h: a }, out: { next: b } });                      // b = 2.5
    ctx.clear(a, 10);                                                       // a = 10
    ctx.run(next, { in: { h: b }, out: { next: a } });                      // a = 4.75
    const data = new Float32Array(65 * 65).fill(2);
    ctx.write(b, data);                                                     // b = 2
    data.fill(99);                                                          // too late to matter
    ctx.run(next, { in: { h: b }, out: { next: a } });                      // a = 4
    ctx.run(fill, { out: { out: b }, params: { value: 0 }, iteration: 7 }); // b = 7
    assertUniform(await ctx.read(b), 7, 'iteration override');
    ctx.output('out', a);
  }));
  assertUniform(out.data[0], 4, 'the last run wins');
});

test('loop: body(i) for every i in order, frame.iteration is i, and the result does not depend on the batches', async () => {
  const body = (iterations: number, order: number[]): Script => async (ctx) => {
    let a = filled(ctx, 0), b = ctx.alloc('field');
    const sum = filled(ctx, 0);
    await ctx.loop(iterations, (i) => {
      order.push(i);
      ctx.run(next, { in: { h: a }, out: { next: b } });
      ctx.run(accumulate, { rw: { acc: sum } });
      [a, b] = [b, a];
    });
    ctx.output('out', a);
    ctx.output('extra', sum);
  };
  const order: number[] = [];
  const auto = ok(await script(body(12, order), { targets: ['n.out', 'n.extra'] }));
  assert.deepEqual(order, Array.from({ length: 12 }, (_, i) => i));
  assertUniform(auto.data[1], 66, 'the sum of frame.iteration over 12 iterations');
  let expected = 0;
  for (let i = 0; i < 12; i++) expected = Math.fround(Math.fround(expected * 1.5) + 1);
  assertUniform(auto.data[0], expected, 'twelve steps', 1e-3);

  // Every dispatch its own slice, tiles one workgroup high, a wait after every iteration (testing.md 2.1, 'small').
  const small = await startEngine([scriptNode, seedNode, constantNode, tintNode], { hooks: { sliceTargetMs: 1e-6 } });
  try {
    const before = small.slices.length;
    const sliced = ok(await script(body(12, []), { targets: ['n.out', 'n.extra'], engine: small }));
    assert.ok(small.slices.length - before >= 24, `${small.slices.length - before} slices`);
    assert.ok(small.slices.slice(before).some((s) => s.nodeId === 'n' && s.kernels.includes('test/next')));
    const a = new Uint32Array(auto.data[0]!.buffer), b = new Uint32Array(sliced.data[0]!.buffer);
    assert.equal(a.findIndex((bits, i) => bits !== b[i]), -1, 'bit-identical however the runs were batched and tiled');
    assertUniform(sliced.data[1], 66, 'iterations under small slices');
  } finally {
    await small.dispose();
  }

  ok(await script(async (ctx) => {
    await ctx.loop(0, () => assert.fail('the body of an empty loop is not called'));
    finish(ctx);
  }));
});

test('loop: the body is synchronous and may only encode; progress follows the iterations', async () => {
  for (const iterations of [-1, 1.5, NaN, '3' as unknown as number]) {
    const error = failure(await script(async (ctx) => { await ctx.loop(iterations, () => undefined); }));
    assert.deepEqual([error.kind, /iterations/.test(error.message)], ['binding', true], JSON.stringify(error));
  }
  const thenable = failure(await script(async (ctx) => { await ctx.loop(2, (async () => undefined) as never); }));
  assert.deepEqual([thenable.kind, /must be synchronous/.test(thenable.message)], ['binding', true]);

  ok(await script(async (ctx) => {
    const field = filled(ctx, 0);
    await ctx.loop(1, () => {
      const inside = /cannot be called inside a ctx.loop body/;
      assert.throws(() => ctx.loop(1, () => undefined), inside);
      assert.throws(() => ctx.flush(), inside);
      assert.throws(() => ctx.read(field), inside);
      assert.throws(() => ctx.write(field, new Float32Array(65 * 65)), inside);
      assert.throws(() => ctx.stats(field), inside);
      assert.throws(() => ctx.lut(new Float32Array(4), 'f32'), inside);
      assert.throws(() => ctx.cpu({ name: 'x/y', run: () => 0 }, {}), inside);
      assert.throws(() => ctx.readFile('a.png'), inside);
      assert.throws(() => ctx.progress(0.5), inside);
      assert.throws(() => ctx.output('out', field), inside);
      // What a body may do.
      const scratch = ctx.alloc('field', { like: field });
      ctx.clear(scratch, 1);
      ctx.release(ctx.clone(scratch));
      ctx.run(next, { in: { h: scratch }, out: { next: field } });
    });
    ctx.output('out', field);
  }));

  const events: EvalEvent[] = [];
  ok(await script(async (ctx) => {
    const field = filled(ctx, 0);
    ctx.progress(0.1, 'warming up');
    await ctx.loop(4, () => ctx.run(accumulate, { rw: { acc: field } }), { progress: [0.2, 0.6], label: 'first' });
    await ctx.loop(4, () => ctx.run(accumulate, { rw: { acc: field } }), { progress: [0.6, 1] });
    ctx.progress(0.3);                                                       // never decreases
    ctx.output('out', field);
  }, { onEvent: (e) => events.push(e) }));
  const progress = eventsOf(events, 'node-progress');
  assert.ok(progress.length >= 1 && progress.length <= 4, `${progress.length} progress events within 100 ms`);
  assert.deepEqual([progress[0]!.nodeId, progress[0]!.fraction, progress[0]!.label, progress[0]!.etaMs], ['n', 0.1, 'warming up', null]);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i]!.fraction >= progress[i - 1]!.fraction && progress[i]!.fraction <= 1);
});

test('read and write: row-major floats by channel count, row ranges, and the length a write needs', async () => {
  ok(await script(async (ctx) => {
    const w = 7, h = 5;
    const vec = ctx.alloc('vec2', { size: [w, h] });
    const data = Float32Array.from({ length: w * h * 2 }, (_, i) => i * 0.5 - 3);
    ctx.write(vec, data);
    const all = await ctx.read(vec);
    assert.equal(all.length, w * h * 2);
    assert.equal(all.findIndex((v, i) => v !== data[i]), -1);
    const rows = await ctx.read(vec, [1, 3]);
    assert.equal(rows.length, 2 * w * 2);
    assert.equal(rows.findIndex((v, i) => v !== data[w * 2 + i]), -1);

    ctx.write(vec, new Float32Array(w * 2).fill(8), [4, 5]);
    const last = await ctx.read(vec, [3, 5]);
    assert.equal(last[w * 2 - 1], data[4 * w * 2 - 1], 'row 3 is untouched');
    assertUniform(last.subarray(w * 2), 8, 'row 4 was replaced');

    assert.throws(() => ctx.write(vec, new Float32Array(w * h)), RangeError);
    assert.throws(() => ctx.write(vec, new Float32Array(w * 2), [0, 2]), RangeError);
    assert.throws(() => ctx.read(vec, [3, 9]), RangeError);
    assert.throws(() => ctx.read(vec, [2, 2]), RangeError);
    await ctx.flush();
    finish(ctx);
  }));
  for (const fn of [
    (ctx: EvalContext) => { ctx.write(ctx.alloc('field'), new Float32Array(3)); },
    (ctx: EvalContext) => { void ctx.read(ctx.alloc('field'), [0, 100]); },
  ]) assert.equal(failure(await script(fn)).kind, 'binding');
});

test('a field is not changed while a read of it is pending', async () => {
  ok(await script(async (ctx) => {
    const field = filled(ctx, 3);
    const pending = ctx.read(field);
    assert.throws(() => ctx.clear(field, 1), /is being read/);
    assert.throws(() => ctx.write(field, new Float32Array(65 * 65)), /is being read/);
    assert.throws(() => ctx.run(fill, { out: { out: field }, params: { value: 1 } }), /is being read/);
    assert.throws(() => ctx.release(field), /is being read/);
    assertUniform(await pending, 3, 'the read');
    ctx.clear(field, 1);
    ctx.output('out', field);
  }));
});

test('lut: an immutable table for kernels, with its length rules; its memory is the ledger\'s until the node settles', async () => {
  const reserved = t.engine.memory().reservedBytes;
  let during = 0;
  const out = ok(await script((ctx) => {
    const ramp = ctx.lut(Float32Array.from([10, 20, 30]), 'f32');
    assert.deepEqual([ramp.type, ramp.length], ['f32', 3]);
    assert.deepEqual(ctx.lut(new Float32Array(8), 'vec4f').length, 2);
    assert.throws(() => ctx.lut(new Float32Array(0), 'f32'), RangeError);
    assert.throws(() => ctx.lut(new Float32Array(6), 'vec4f'), RangeError);
    assert.throws(() => ctx.lut(new Float32Array(1_048_577), 'f32'), RangeError);
    during = t.engine.memory().reservedBytes;
    const field = ctx.alloc('field');
    ctx.run(table, { out: { out: field }, luts: { ramp } });
    assert.throws(() => ctx.run(table, { out: { out: field }, luts: { ramp: { type: 'f32', length: 3 } } }), /was not created in this evaluation/);
    ctx.output('out', field);
  }));
  // ramp_at(u) + ramp_len(): 13 at u = 0, 23 in the middle, 33 at u = 1.
  const row = out.data[0]!.subarray(0, 65);
  assert.deepEqual([row[0], row[32], row[64]], [13, 23, 33]);
  assert.ok(during >= reserved + 12 + 32, `LUT buffers are registered: ${during} against ${reserved}`);
  assert.equal(t.engine.memory().reservedBytes <= during - 44, true, 'and released when the node has settled');
  assert.equal(failure(await script((ctx) => { ctx.lut(new Float32Array(0), 'f32'); })).kind, 'binding');
});

test('stats: minimum, maximum and mean over the finite texels, and the count of the others', async () => {
  ok(await script(async (ctx) => {
    // 70 x 40: more than one block each way, with blocks that are cut off, and not square.
    const w = 70, h = 40;
    const field = ctx.alloc('field', { size: [w, h] });
    const data = Float32Array.from({ length: w * h }, (_, i) => ((i * 37) % 101) / 100);
    data[5] = -4;
    data[w * h - 1] = 12.5;
    data[100] = NaN;
    data[200] = Infinity;
    data[300] = -Infinity;
    ctx.write(field, data);
    let sum = 0, count = 0;
    for (const v of data) if (Number.isFinite(v)) { sum += v; count++; }
    const s = await ctx.stats(field);
    assert.deepEqual([s.min, s.max, s.nonFinite], [-4, 12.5, 3]);
    assert.ok(Math.abs(s.mean - sum / count) < 1e-6, `mean ${s.mean} against ${sum / count}`);

    const flat = await ctx.stats(filled(ctx, 0.75));
    assert.deepEqual(flat, { min: 0.75, max: 0.75, mean: 0.75, nonFinite: 0 });
    const one = await ctx.stats(ctx.alloc('mask8', { size: 1, clear: 1 }));
    assert.deepEqual(one, { min: 1, max: 1, mean: 1, nonFinite: 0 });
    assert.throws(() => ctx.stats(ctx.alloc('color') as never), FieldAccessError);
    finish(ctx);
  }));
});

test('after evaluate() has settled, every method of its context throws', async () => {
  let kept: EvalContext | null = null;
  let field: Field<'field'> | null = null;
  ok(await script((ctx) => {
    kept = ctx;
    field = filled(ctx, 0);
    ctx.output('out', field);
  }));
  const ctx = kept as unknown as EvalContext;
  const settled = /after evaluate\(\) had settled/;
  assert.throws(() => ctx.alloc('field'), settled);
  assert.throws(() => ctx.clear(field!), settled);
  assert.throws(() => ctx.run(fill, { out: { out: field! }, params: { value: 1 } }), settled);
  assert.throws(() => ctx.loop(1, () => undefined), settled);
  assert.throws(() => ctx.flush(), settled);
  assert.throws(() => ctx.read(field!), settled);
  assert.throws(() => ctx.input('in'), settled);
  assert.throws(() => ctx.wants('out'), settled);
  assert.throws(() => ctx.progress(1), settled);
  assert.throws(() => ctx.readFile('x'), settled);
  assert.equal(ctx.res, 65, 'the environment stays readable');
});

test('a node that throws fails alone, with its message; what it allocated is free again', async () => {
  const error = failure(await script((ctx) => {
    ctx.alloc('aux', { size: 257 });
    ctx.lut(new Float32Array(16), 'f32');
    throw new Error('No file selected');
  }));
  assert.deepEqual([error.kind, error.message, error.nodeId, error.nodeType], ['node-exception', 'No file selected', 'n', 'ref/script']);
  assert.match(error.detail ?? '', /No file selected/);
  const rejected = failure(await script(async (ctx) => {
    await ctx.flush();
    ctx.alloc('field');
    return Promise.reject(new RangeError('out of range in the node\'s own code'));
  }));
  assert.equal(rejected.kind, 'node-exception');
  // A promise the node never awaited must not take the process down when it rejects.
  ok(await script((ctx) => {
    void ctx.read(filled(ctx, 0));
    finish(ctx);
  }));
});
