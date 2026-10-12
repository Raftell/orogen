// memorySource and memorySink against the rules of runtime.md 6.1 and 6.2: the same rules the files on node:fs
// keep (tests/unit/node-files.test.ts), so that a test of a build means the same with either. No device.
//
// Sizes: files of a few bytes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FileError } from '../../../src/core/runtime.ts';
import { memorySink, memorySource } from '../../helpers/index.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const isFileError = (code: FileError['code']) => (thrown: unknown): boolean => {
  assert.ok(thrown instanceof FileError, `a FileError, not ${String(thrown)}`);
  assert.equal(thrown.code, code);
  return true;
};

// ---- the source ----------------------------------------------------------------------------------------------------

test('a memory source resolves relative paths from one folder and reads what was put', async () => {
  const source = memorySource({ 'assets/a.bin': bytes(1, 2, 3, 4, 5) });
  const resolved = source.resolve('assets/a.bin');
  assert.ok(resolved.startsWith('/') && resolved.endsWith('/assets/a.bin'), resolved);
  assert.equal(source.resolve(resolved), resolved, 'an absolute path stays');
  assert.equal(source.resolve('assets/../assets/./a.bin'), resolved);
  assert.throws(() => source.resolve(''), isFileError('invalid-path'));

  const whole = await source.read('assets/a.bin');
  assert.deepEqual([...whole], [1, 2, 3, 4, 5]);
  // It owns its whole buffer, so it can be transferred to a CPU task (6.1 rule 3), and it is a copy.
  assert.deepEqual([whole.byteOffset, whole.byteLength], [0, whole.buffer.byteLength]);
  whole[0] = 99;
  assert.deepEqual([...await source.read(resolved)], [1, 2, 3, 4, 5]);
  assert.deepEqual([...await source.read('assets/a.bin', { offset: 1, length: 3 })], [2, 3, 4]);
  assert.deepEqual([...await source.read('assets/a.bin', { offset: 3, length: 100 })], [4, 5], 'a range is cut at the end of the file');
  assert.deepEqual([...await source.read('assets/a.bin', { offset: 9, length: 2 })], []);
  await assert.rejects(source.read('assets/a.bin', { offset: -1, length: 2 }), RangeError);

  await assert.rejects(source.read('assets/none.bin'), isFileError('not-found'));
  assert.equal(await source.stat('assets/none.bin'), null);
});

test('stat reports the size and the mtimeMs of the put; the default grows with every put', async () => {
  const source = memorySource();
  const data = bytes(7, 7);
  source.put('a.bin', data);
  const first = await source.stat('a.bin');
  assert.equal(first?.size, 2);
  source.put('b.bin', bytes(1));
  source.put('a.bin', data);
  const second = await source.stat('a.bin');
  assert.ok(second!.mtimeMs > first!.mtimeMs, 'the same bytes put again are a newer file');
  assert.ok(second!.mtimeMs > (await source.stat('b.bin'))!.mtimeMs);

  source.put('a.bin', bytes(1, 2, 3), 1234.5);
  assert.deepEqual(await source.stat('a.bin'), { size: 3, mtimeMs: 1234.5 });
  // The source keeps its own copy: the caller's array may change afterwards.
  data[0] = 0;
  source.put('c.bin', data);
  data[1] = 0;
  assert.deepEqual([...await source.read('c.bin')], [0, 7]);

  source.remove('a.bin');
  assert.equal(await source.stat('a.bin'), null);
  source.remove('a.bin');
  assert.throws(() => source.put('x.bin', 'text' as never), TypeError);
});

test('watch calls back after a file changed, appeared or went, until it is stopped', async () => {
  const source = memorySource({ 'a.bin': bytes(1) });
  let changes = 0, others = 0;
  const stop = source.watch!('a.bin', () => { changes++; });
  source.watch!('b.bin', () => { others++; });
  source.put('a.bin', bytes(2));
  assert.equal(changes, 0, 'after the change, never inside the call that makes it');
  await turn();
  assert.equal(changes, 1);
  source.remove('a.bin');
  source.put(source.resolve('a.bin'), bytes(3));
  await turn();
  assert.deepEqual([changes, others], [3, 0]);
  source.put('b.bin', bytes(1));
  await turn();
  assert.equal(others, 1, 'a watched file that did not exist yet');
  stop();
  stop();
  source.put('a.bin', bytes(4));
  await turn();
  assert.equal(changes, 3);
});

// ---- the sink ------------------------------------------------------------------------------------------------------

test('a writer appends exactly the bytes of each chunk, and the file appears when close() resolves', async () => {
  const sink = memorySink();
  const writer = await sink.create('height/terrain.r16');
  assert.deepEqual([sink.open, [...sink.files.keys()]], [['height/terrain.r16'], []]);
  const buffer = bytes(0, 1, 2, 3, 4, 5, 6, 7);
  await writer.write(buffer.subarray(2, 5));
  buffer.fill(9);                                    // the caller may reuse its buffer once write() has resolved
  await writer.write(bytes());
  await writer.write(bytes(8));
  assert.equal(sink.files.has('height/terrain.r16'), false, 'never a part under the final name');
  assert.deepEqual(await writer.close(), { bytes: 4 });
  assert.deepEqual([...sink.files.get('height/terrain.r16')!], [2, 3, 4, 8]);
  assert.deepEqual(sink.open, []);
  assert.deepEqual(await writer.close(), { bytes: 4 }, 'close() answers the same again');
  await writer.abort();
  assert.equal(sink.files.size, 1, 'abort() does nothing after close()');
  await assert.rejects(writer.write(bytes(1)), /closed/);
});

test('write() makes a whole file; a string is written as UTF-8', async () => {
  const sink = memorySink();
  await sink.write('manifest.json', '{"é":1}');
  await sink.write('data/a.bin', bytes(5, 6));
  assert.equal(new TextDecoder().decode(sink.files.get('manifest.json')), '{"é":1}');
  assert.equal(sink.files.get('manifest.json')!.length, 8);
  assert.deepEqual([...sink.files.get('data/a.bin')!], [5, 6]);
  assert.deepEqual([...sink.files.keys()], ['manifest.json', 'data/a.bin']);
});

test('a path is relative, of plain segments separated by "/"', async () => {
  const sink = memorySink();
  for (const path of ['', '/abs.bin', 'a//b.bin', './a.bin', 'a/../b.bin', 'a/', 'a\\b.bin', 'c:/a.bin', 'a/./b']) {
    await assert.rejects(sink.create(path), isFileError('invalid-path'), JSON.stringify(path));
    await assert.rejects(sink.write(path, bytes(1)), isFileError('invalid-path'), JSON.stringify(path));
  }
  assert.deepEqual([sink.open, sink.files.size], [[], 0]);
  await sink.write('a.b/c-d_e.f.bin', bytes(1));
});

test('one writer per path: an open or a closed path cannot be created again, an aborted one can', async () => {
  const sink = memorySink();
  const first = await sink.create('a.bin');
  await assert.rejects(sink.create('a.bin'), /written twice/);
  await first.write(bytes(1));
  await first.abort();
  await first.abort();
  assert.deepEqual([sink.open, sink.files.size], [[], 0], 'the partial content is gone');
  await assert.rejects(first.write(bytes(2)), /aborted/);
  await assert.rejects(first.close(), /aborted/);

  const second = await sink.create('a.bin');
  await second.write(bytes(3));
  await second.close();
  await assert.rejects(sink.create('a.bin'), /written twice/, 'nothing is overwritten within one build');
  await assert.rejects(sink.write('a.bin', bytes(4)), /written twice/);
  assert.deepEqual([...sink.files.get('a.bin')!], [3]);
});

test('operations on one writer take effect in the order of the calls', async () => {
  const sink = memorySink();
  const writer = await sink.create('a.bin');
  // Not awaited: a caller that forgets cannot reorder bytes or close a file before its last chunk.
  const writes = [writer.write(bytes(1)), writer.write(bytes(2, 3)), writer.write(bytes(4))];
  const closed = writer.close();
  await Promise.all(writes);
  assert.deepEqual(await closed, { bytes: 4 });
  assert.deepEqual([...sink.files.get('a.bin')!], [1, 2, 3, 4]);
});

test('a write that fails deletes the partial file, and every later write and close rejects with the same error', async () => {
  const sink = memorySink();
  const writer = await sink.create('a.bin');
  await writer.write(bytes(1));
  const failure = await writer.write('text' as never).then(() => null, (thrown: unknown) => thrown);
  assert.ok(failure instanceof FileError && failure.code === 'io', String(failure));
  await assert.rejects(writer.write(bytes(2)), (thrown) => thrown === failure);
  await assert.rejects(writer.close(), (thrown) => thrown === failure);
  assert.deepEqual([sink.open, sink.files.size], [[], 0]);
  // A path whose writer has failed may be created again.
  await sink.write('a.bin', bytes(9));
  assert.deepEqual([...sink.files.get('a.bin')!], [9]);
});

test('abortAll aborts every open writer, also one whose create is still under way, and keeps the closed files', async () => {
  const sink = memorySink();
  await sink.write('done.bin', bytes(1));
  const open = await sink.create('open.bin');
  await open.write(bytes(2));
  const underWay = sink.create('late.bin');
  await sink.abortAll();
  assert.deepEqual([sink.open, [...sink.files.keys()]], [[], ['done.bin']]);
  await assert.rejects(open.write(bytes(3)), /aborted/);
  const late = await underWay;
  await assert.rejects(late.write(bytes(4)), /aborted/, 'the writer is handed out already aborted');
  await assert.rejects(late.close(), /aborted/);
  assert.deepEqual(sink.open, []);
  // The sink goes on: a cancelled build left nothing of these paths behind.
  await sink.write('open.bin', bytes(5));
  await sink.write('late.bin', bytes(6));
  assert.deepEqual([...sink.files.keys()], ['done.bin', 'open.bin', 'late.bin']);
});
