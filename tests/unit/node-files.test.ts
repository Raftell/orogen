// NodeFileSource and NodeFileSink (runtime.md 6.1, 6.2) on a temporary folder.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { FileError } from '../../src/core/runtime.ts';
import { NodeFileSink, NodeFileSource } from '../../src/platform/node/files.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-files-'));
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

let folders = 0;
/** A new empty folder for one test. */
function folder(): string {
  const dir = path.join(scratch, `t${folders++}`);
  fs.mkdirSync(dir);
  return dir;
}

const bytesOf = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const fileError = (code: FileError['code']) => (error: unknown): boolean => error instanceof FileError && error.name === 'FileError' && error.code === code;
/** Every file under a folder, as paths relative to it with `/`, sorted. */
function listing(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

// ---- NodeFileSource ----------------------------------------------------------------------------------------

test('source: resolve takes a relative path from the project folder and leaves an absolute one', () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  assert.equal(source.resolve('maps/height.png'), path.join(dir, 'maps', 'height.png'));
  const absolute = path.join(scratch, 'elsewhere', 'a.tif');
  assert.equal(source.resolve(absolute), absolute);
});

test('source: a relative path is invalid while the project has never been saved', async () => {
  const source = NodeFileSource(null);
  assert.throws(() => source.resolve('maps/height.png'), fileError('invalid-path'));
  assert.throws(() => source.resolve(''), fileError('invalid-path'));
  await assert.rejects(source.read('maps/height.png'), fileError('invalid-path'));
  await assert.rejects(source.stat('maps/height.png'), fileError('invalid-path'));
  const absolute = path.join(folder(), 'a.bin');
  fs.writeFileSync(absolute, bytesOf(1, 2, 3));
  assert.deepEqual([...await source.read(absolute)], [1, 2, 3]);
});

test('source: stat gives size and modification time, and null when there is no such file', async () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  fs.writeFileSync(path.join(dir, 'a.bin'), bytesOf(1, 2, 3, 4, 5));
  const info = await source.stat('a.bin');
  assert.deepEqual(info, { size: 5, mtimeMs: fs.statSync(path.join(dir, 'a.bin')).mtimeMs });
  assert.equal(await source.stat('missing.bin'), null);
  assert.equal(await source.stat('a.bin/below'), null);
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(await source.stat('sub'), null);
});

test('source: read returns the bytes in an array that owns its whole buffer and can be transferred', async () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  const content = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) & 255);
  fs.mkdirSync(path.join(dir, 'maps'));
  fs.writeFileSync(path.join(dir, 'maps', 'a.bin'), content);
  for (const name of ['maps/a.bin', path.join(dir, 'maps', 'a.bin')]) {
    const bytes = await source.read(name);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.byteOffset, 0);
    assert.equal(bytes.byteLength, bytes.buffer.byteLength);
    assert.deepEqual(bytes, content);
    const moved = structuredClone(bytes, { transfer: [bytes.buffer] });
    assert.equal(bytes.byteLength, 0);
    assert.deepEqual(moved, content);
  }
  fs.writeFileSync(path.join(dir, 'empty.bin'), new Uint8Array(0));
  assert.equal((await source.read('empty.bin')).byteLength, 0);
});

test('source: read with a range returns that part, cut at the end of the file', async () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  fs.writeFileSync(path.join(dir, 'a.bin'), bytesOf(10, 11, 12, 13, 14, 15, 16, 17));
  const part = await source.read('a.bin', { offset: 2, length: 3 });
  assert.deepEqual([...part], [12, 13, 14]);
  assert.equal(part.byteLength, part.buffer.byteLength);
  assert.deepEqual([...await source.read('a.bin', { offset: 6, length: 100 })], [16, 17]);
  assert.deepEqual([...await source.read('a.bin', { offset: 50, length: 4 })], []);
  await assert.rejects(source.read('a.bin', { offset: -1, length: 4 }), RangeError);
});

test('source: read rejects with a FileError that says what is wrong', async () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  const missing = path.join(dir, 'missing.png');
  await assert.rejects(source.read('missing.png'), (error: unknown) => {
    assert.ok(fileError('not-found')(error));
    assert.equal((error as FileError).path, missing);
    assert.equal((error as FileError).message, `File not found: ${missing}`);
    return true;
  });
  fs.mkdirSync(path.join(dir, 'sub'));
  await assert.rejects(source.read('sub'), fileError('not-found'));

  // Permissions are not enforced for an administrator, nor by chmod on Windows.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.writeFileSync(path.join(dir, 'locked.bin'), bytesOf(1));
    fs.chmodSync(path.join(dir, 'locked.bin'), 0o000);
    await assert.rejects(source.read('locked.bin'), fileError('denied'));
  }
});

test('source: watch reports a change of the file, and nothing after it was stopped', async () => {
  const dir = folder();
  const source = NodeFileSource(dir);
  assert.ok(source.watch);
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, bytesOf(1, 2, 3));

  let changes = 0;
  let notify: () => void = () => {};
  const next = (): Promise<void> => new Promise((resolve) => { notify = resolve; });
  const stop = source.watch('a.bin', () => {
    changes++;
    notify();
  });
  const settle = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
  // The watcher takes the state of the file when it starts as its baseline.
  await settle(400);
  assert.equal(changes, 0);

  let changed = next();
  fs.writeFileSync(file, bytesOf(1, 2, 3, 4, 5));
  await changed;
  assert.equal(changes, 1);

  changed = next();
  fs.rmSync(file);
  await changed;
  assert.equal(changes, 2);

  changed = next();
  fs.writeFileSync(file, bytesOf(9));
  await changed;
  assert.equal(changes, 3);

  stop();
  stop();
  fs.writeFileSync(file, bytesOf(1, 2, 3, 4, 5, 6, 7));
  await settle(800);
  assert.equal(changes, 3);
});

// ---- NodeFileSink ------------------------------------------------------------------------------------------

test('sink: write stores a whole file, a string as UTF-8, and creates missing folders', async () => {
  const dir = path.join(folder(), 'out', 'not-yet');
  const sink = NodeFileSink(dir);
  await sink.write('manifest.json', '{"name":"Grüße"}');
  await sink.write('layers/deep/a.r8', bytesOf(1, 2, 3));
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), '{"name":"Grüße"}');
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'layers', 'deep', 'a.r8'))], [1, 2, 3]);
  assert.deepEqual(listing(dir), ['layers/deep/a.r8', 'manifest.json']);
});

test('sink: a writer appends exactly the bytes of each chunk, and the file appears under its name at close', async () => {
  const dir = folder();
  const sink = NodeFileSink(dir);
  const writer = await sink.create('height.r16');
  assert.deepEqual(listing(dir), ['height.r16.partial']);

  // A view into a larger buffer: only its own bytes are written. The buffer is reused after each write.
  const buffer = Uint8Array.from({ length: 16 }, (_, i) => i);
  const view = buffer.subarray(4, 10);
  await writer.write(view);
  buffer.fill(200);
  await writer.write(view);
  await writer.write(new Uint8Array(0));
  await writer.write(bytesOf(7));
  assert.deepEqual(listing(dir), ['height.r16.partial']);

  assert.deepEqual(await writer.close(), { bytes: 13 });
  assert.deepEqual(listing(dir), ['height.r16']);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'height.r16'))], [4, 5, 6, 7, 8, 9, 200, 200, 200, 200, 200, 200, 7]);
  assert.deepEqual(await writer.close(), { bytes: 13 });
  await assert.rejects(writer.write(bytesOf(1)));
});

test('sink: until close has resolved, an existing file keeps its previous contents', async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'a.bin'), bytesOf(1, 1, 1));
  fs.writeFileSync(path.join(dir, 'a.bin.partial'), bytesOf(9, 9, 9, 9, 9, 9, 9, 9));      // left by a build that crashed
  const sink = NodeFileSink(dir);
  const writer = await sink.create('a.bin');
  await writer.write(bytesOf(2, 2));
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'a.bin'))], [1, 1, 1]);
  await writer.close();
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'a.bin'))], [2, 2]);
  assert.deepEqual(listing(dir), ['a.bin']);
});

test('sink: abort deletes the partial file and leaves an earlier file alone; it is idempotent', async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'a.bin'), bytesOf(1, 1, 1));
  const sink = NodeFileSink(dir);
  const writer = await sink.create('a.bin');
  await writer.write(bytesOf(2, 2));
  await writer.abort();
  await writer.abort();
  assert.deepEqual(listing(dir), ['a.bin']);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'a.bin'))], [1, 1, 1]);
  await assert.rejects(writer.write(bytesOf(3)));
  await assert.rejects(writer.close());
  assert.deepEqual(listing(dir), ['a.bin']);

  const fresh = await sink.create('b.bin');
  await fresh.abort();
  assert.deepEqual(listing(dir), ['a.bin']);
});

test('sink: abort does nothing after close', async () => {
  const dir = folder();
  const sink = NodeFileSink(dir);
  const writer = await sink.create('a.bin');
  await writer.write(bytesOf(5, 6));
  await writer.close();
  await writer.abort();
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'a.bin'))], [5, 6]);
  await sink.abortAll();
  assert.deepEqual(listing(dir), ['a.bin']);
});

test('sink: a path has one writer: open or closed it cannot be created again, aborted it can', async () => {
  const dir = folder();
  const sink = NodeFileSink(dir);
  const first = await sink.create('a/b.bin');
  await assert.rejects(sink.create('a/b.bin'), /written twice/);
  await assert.rejects(sink.write('a/b.bin', 'x'), /written twice/);
  await first.write(bytesOf(1));
  await first.close();
  await assert.rejects(sink.create('a/b.bin'), /written twice/);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'a', 'b.bin'))], [1]);

  const second = await sink.create('c.bin');
  await second.abort();
  const again = await sink.create('c.bin');
  await again.write(bytesOf(2));
  await again.close();
  assert.deepEqual(listing(dir), ['a/b.bin', 'c.bin']);
});

test('sink: a path that is not relative, plain and separated by "/" is invalid', async () => {
  const dir = path.join(folder(), 'root');
  const sink = NodeFileSink(dir);
  for (const bad of ['', '/a.bin', 'a//b.bin', './a.bin', 'a/./b.bin', '../a.bin', 'a/../b.bin', 'a/', 'a\\b.bin', 'C:a.bin', 'a/b:c.bin']) {
    await assert.rejects(sink.create(bad), fileError('invalid-path'), bad);
    await assert.rejects(sink.write(bad, 'x'), fileError('invalid-path'), bad);
  }
  // Nothing was created, inside the root or beside it.
  assert.deepEqual(listing(path.dirname(dir)), []);
});

test('sink: abortAll aborts every open writer and leaves closed files', async () => {
  const dir = folder();
  const sink = NodeFileSink(dir);
  await sink.write('done.bin', bytesOf(1));
  const a = await sink.create('a.bin');
  const b = await sink.create('sub/b.bin');
  await a.write(bytesOf(1, 2, 3));
  // A write that is still under way is aborted behind it.
  const pending = b.write(bytesOf(4, 5, 6));
  await sink.abortAll();
  await pending;
  assert.deepEqual(listing(dir), ['done.bin']);
  await assert.rejects(a.close());
  await assert.rejects(b.write(bytesOf(1)));
  await sink.abortAll();
  assert.deepEqual(listing(dir), ['done.bin']);
});

test('sink: a close that cannot rename leaves no partial file and does not touch what is there', async () => {
  const dir = folder();
  // The final name is taken by a folder, which a file cannot replace.
  fs.mkdirSync(path.join(dir, 'a.bin'));
  fs.writeFileSync(path.join(dir, 'a.bin', 'inside.txt'), 'kept');
  const sink = NodeFileSink(dir);
  const writer = await sink.create('a.bin');
  await writer.write(bytesOf(1, 2, 3));
  await assert.rejects(writer.close(), (error: unknown) => error instanceof FileError && error.path === 'a.bin');
  assert.deepEqual(listing(dir), ['a.bin/inside.txt']);
  await writer.abort();

  await assert.rejects(sink.write('a.bin', bytesOf(1, 2, 3)), FileError);
  assert.deepEqual(listing(dir), ['a.bin/inside.txt']);
});

test('sink: a chunk that is not a Uint8Array fails the writer and leaves no partial file', async () => {
  const dir = folder();
  const sink = NodeFileSink(dir);
  const writer = await sink.create('a.bin');
  await writer.write(bytesOf(1, 2, 3));
  await assert.rejects(writer.write('text' as unknown as Uint8Array), FileError);
  assert.deepEqual(listing(dir), []);
  await assert.rejects(writer.write(bytesOf(4)), FileError);
  await assert.rejects(writer.close(), FileError);
  assert.deepEqual(listing(dir), []);
});

// A device that accepts no byte: the operating system itself fails the write. Linux has one.
if (process.platform === 'linux') {
  test('sink: a write the operating system refuses rejects, and leaves neither a partial file nor a final one', async () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'old.bin'), bytesOf(1, 1, 1));
    const sink = NodeFileSink(dir);

    fs.symlinkSync('/dev/full', path.join(dir, 'a.bin.partial'));
    const writer = await sink.create('a.bin');
    await assert.rejects(writer.write(bytesOf(1, 2, 3)), (error: unknown) => {
      assert.ok(fileError('io')(error));
      assert.match((error as FileError).message, /^Cannot write .*a\.bin: /);
      return true;
    });
    assert.deepEqual(listing(dir), ['old.bin']);
    await assert.rejects(writer.close(), fileError('io'));
    await writer.abort();
    assert.deepEqual(listing(dir), ['old.bin']);

    // The same through write(), over a file that exists: the earlier contents stay.
    fs.symlinkSync('/dev/full', path.join(dir, 'old.bin.partial'));
    await assert.rejects(sink.write('old.bin', 'replacement'), fileError('io'));
    assert.deepEqual(listing(dir), ['old.bin']);
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'old.bin'))], [1, 1, 1]);

    // The failed path is free again.
    await sink.write('a.bin', bytesOf(7));
    assert.deepEqual(listing(dir), ['a.bin', 'old.bin']);
  });
}
