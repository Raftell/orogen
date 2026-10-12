// CPU tasks through the context and file inputs (engine.md 4.11, 4.12; runtime.md 5.4, 6.1, 6.3): a task runs
// in the product's worker thread, and the identity of a file is part of its node's key.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { decodeRaw, defineNode, type EvalContext } from '../../../src/core/api.ts';
import { createNodeCpuRunner } from '../../../src/platform/node/cpu.ts';
import { assertUniform, calls, constantNode, endings, memoryFiles, startEngine, worst } from './rig.ts';

const RES = 33;
/** What the import node does besides importing. */
const hooks: { detached?: boolean; around?: (ctx: EvalContext, cpu: () => Promise<unknown>) => Promise<void> } = {};

/** Reads a headerless 8-bit file of res x res samples and uploads it. */
const importNode = defineNode({
  type: 'ref/import',
  title: 'Import (Test)',
  category: 'ref',
  description: 'Imports a raw 8-bit file of the evaluation resolution.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'file', name: 'file', default: '', filters: ['r8'], help: 'The file.' },
    { kind: 'enum', name: 'sample', default: 'u8', options: [{ value: 'u8', label: '8 bit' }, { value: 'u16', label: '16 bit' }], help: 'The sample type.' },
  ],
  kernels: [],
  cpuTasks: [decodeRaw],
  async evaluate(ctx) {
    calls.set('ref/import', (calls.get('ref/import') ?? 0) + 1);
    if (ctx.params.file === '') throw new Error('No file selected');
    const bytes = await ctx.readFile(ctx.params.file);
    const decode = () => ctx.cpu(decodeRaw, { bytes, sample: ctx.params.sample }, [bytes.buffer]);
    if (hooks.around) {
      await hooks.around(ctx, decode);
      return;
    }
    const image = await decode();
    hooks.detached = bytes.byteLength === 0;
    const out = ctx.alloc('field', { size: [image.width, image.height] });
    ctx.write(out, image.data);
    ctx.output('out', out);
  },
});

/** Reads a file its params do not name: its externalKey covers it. */
const sidecarNode = defineNode({
  type: 'ref/sidecar',
  title: 'Sidecar (Test)',
  category: 'ref',
  description: 'Reads the file "level.bin" beside the project.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  async externalKey({ stat }) {
    calls.set('externalKey', (calls.get('externalKey') ?? 0) + 1);
    const info = await stat('level.bin');
    return info ? `${info.size}/${info.mtimeMs}` : 'missing';
  },
  async evaluate(ctx) {
    calls.set('ref/sidecar', (calls.get('ref/sidecar') ?? 0) + 1);
    const bytes = await ctx.readFile('level.bin');
    ctx.output('out', ctx.alloc('field', { clear: bytes[0]! }));
  },
});

/** Has neither a file param nor an externalKey, and reads a file all the same. */
const sneakyNode = defineNode({
  type: 'ref/sneaky',
  title: 'Sneaky (Test)',
  category: 'ref',
  description: 'Reads a file its key does not cover.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  async evaluate(ctx) {
    await ctx.readFile('level.bin');
    ctx.output('out', ctx.alloc('field', { clear: 0 }));
  },
});

const files = memoryFiles();
const t = await startEngine([constantNode, importNode, sidecarNode, sneakyNode], { files, cpu: createNodeCpuRunner() });
// dispose() also stops the worker thread: without it the process would not end.
after(() => t.dispose());

/** res x res bytes: texel (x, y) holds (x + 2 y) mod 256. */
const picture = (): Uint8Array => Uint8Array.from({ length: RES * RES }, (_, i) => ((i % RES) + 2 * Math.floor(i / RES)) % 256);
const importing = (file: string, sample = 'u8') => t.doc({ n: { type: 'ref/import', params: { file, sample } } });
const run = (doc: ReturnType<typeof importing>, opts: object = {}) => t.run(doc, ['n.out'], { resolution: RES, ...opts });

test('ctx.cpu runs a listed task in the worker thread: arguments are moved there, typed arrays come back', async () => {
  files.put('a.r8', picture());
  delete hooks.around;
  const out = await run(importing('a.r8'), { mode: 'build' });
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  const bytes = picture();
  const w = worst(out.data[0]!, (i) => Math.fround(bytes[i]! / 255));
  assert.ok(w.difference === 0, `texel ${w.index} differs by ${w.difference}`);
  assert.equal(hooks.detached, true, 'a buffer in the transfer list is unusable by the caller afterwards');
  t.noLeaks();
});

test('ctx.cpu: a task the node does not list, a task that throws, and cancellation', async () => {
  hooks.around = async (ctx) => { await ctx.cpu({ name: 'core/decode-image', run: () => 0 }, {}); };
  const unlisted = await run(importing('a.r8'), { mode: 'build' });
  assert.deepEqual(unlisted.result.errors.map((e) => [e.kind, e.message]), [['binding', 'ctx.cpu: the task "core/decode-image" is not listed in NodeDef.cpuTasks of ref/import']]);

  // 33 x 33 bytes are not a whole number of 16-bit samples: the task throws in the worker, which survives.
  delete hooks.around;
  const thrown = await run(importing('a.r8', 'u16'), { mode: 'build' });
  assert.deepEqual(thrown.result.errors.map((e) => [e.kind, e.message]), [['node-exception', 'raw file has 1089 bytes, which is not a whole number of 16-bit samples']]);
  assert.equal((await run(importing('a.r8'), { mode: 'build' })).result.status, 'ok', 'the worker serves the next task');

  // On cancellation ctx.cpu rejects at once, with the reason.
  const controller = new AbortController();
  let rejection: unknown = null;
  hooks.around = async (_ctx, cpu) => {
    const pending = cpu();
    controller.abort();
    try {
      await pending;
    } catch (reason) {
      rejection = reason;
      throw reason;
    }
  };
  const aborted = await run(importing('a.r8'), { mode: 'build', signal: controller.signal });
  assert.equal(aborted.result.status, 'aborted');
  assert.equal(rejection, controller.signal.reason);
  delete hooks.around;
  assert.equal((await run(importing('a.r8'), { mode: 'build' })).result.status, 'ok', 'and the next task runs');
  t.noLeaks();
});

test('the identity of a file is its resolved path, size and modification time; it is part of the node\'s key', async () => {
  await t.engine.trim();
  calls.clear();
  files.put('b.r8', picture(), 1000);
  const doc = importing('b.r8');
  const key = async (): Promise<string | undefined> => (await t.engine.keys(doc)).get('n');
  const first = await key();
  assert.deepEqual(endings((await run(doc)).events), { n: 'run' });
  assert.deepEqual(endings((await run(doc)).events), { n: 'cached' });
  assert.equal(await key(), first, 'an unchanged file is the same content');

  // Saved again with the same bytes: the modification time alone changes the key.
  files.put('b.r8', picture(), 2000);
  assert.notEqual(await key(), first);
  assert.deepEqual(endings((await run(doc)).events), { n: 'run' });
  assert.equal(calls.get('ref/import'), 2);

  // The same time, another size.
  const grown = await key();
  files.put('b.r8', new Uint8Array(RES * RES + 1), 2000);
  assert.notEqual(await key(), grown);
  const wrongSize = await run(doc);
  assert.deepEqual(wrongSize.result.errors.map((e) => e.kind), ['node-exception'], '1090 samples are not a square image');

  // Removed: the key is that of a missing file, the node runs and fails to read.
  files.remove('b.r8');
  assert.notEqual(await key(), undefined, 'a missing file is an identity too');
  const missing = await run(doc);
  assert.deepEqual(missing.result.errors.map((e) => [e.kind, e.message]), [['io', 'File not found: /mem/b.r8']]);

  // Back as it was at first: the old key, and the old result if it is still cached.
  files.put('b.r8', picture(), 1000);
  assert.equal(await key(), first);
  assert.deepEqual(endings((await run(doc)).events), { n: 'cached' });

  // No file selected: the node says so, and the key does not name a path.
  const none = await run(importing(''));
  assert.deepEqual(none.result.errors.map((e) => [e.kind, e.message]), [['node-exception', 'No file selected']]);
  t.noLeaks();
});

test('externalKey covers a file no param names, and is awaited once per evaluation', async () => {
  await t.engine.trim();
  calls.clear();
  files.put('level.bin', Uint8Array.of(7), 10);
  const doc = t.doc({ n: { type: 'ref/sidecar' }, twin: { type: 'ref/sidecar' } });
  const out = await t.run(doc, ['n.out', 'twin.out'], { resolution: RES });
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assertUniform(out.data[0], 7, 'the sidecar\'s first byte');
  assert.deepEqual([calls.get('externalKey'), calls.get('ref/sidecar')], [2, 1], 'once per node; the two nodes share one key and one run');
  assert.deepEqual(endings((await t.run(doc, ['n.out'], { resolution: RES })).events), { n: 'cached' });

  files.put('level.bin', Uint8Array.of(9), 11);
  const changed = await t.run(doc, ['n.out'], { resolution: RES });
  assert.deepEqual(endings(changed.events), { n: 'run' });
  assertUniform(changed.data[0], 9, 'the sidecar after it changed');

  const sneaky = await t.run(t.doc({ n: { type: 'ref/sneaky' } }), ['n.out'], { resolution: RES });
  assert.deepEqual(sneaky.result.errors.map((e) => e.kind), ['binding']);
  assert.match(sneaky.result.errors[0]!.message, /^ctx\.readFile: ref\/sneaky has neither a file param nor externalKey/);
  t.noLeaks();
});

test('setFiles replaces the source: the same path is another file', async () => {
  await t.engine.trim();
  files.put('c.r8', picture(), 5);
  const doc = importing('c.r8');
  assert.deepEqual(endings((await run(doc)).events), { n: 'run' });

  const other = memoryFiles();
  other.put('c.r8', new Uint8Array(RES * RES).fill(51), 6);
  t.engine.setFiles(other);
  const out = await run(doc);
  assert.deepEqual(endings(out.events), { n: 'run' });
  assertUniform(out.data[0], 0.2, 'the bytes of the other source', 1e-6);
  assert.deepEqual(other.reads, ['/mem/c.r8']);
  t.engine.setFiles(files);
  assert.deepEqual(endings((await run(doc)).events), { n: 'cached' });
  t.noLeaks();
});
