// Text files for the bridge and the stored form of a file path (runtime.md 8.6, 6.1 rule 2).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { BUSY_DELAYS_MS } from '../../../../src/core/runtime.ts';
import { HELD_DELAYS_MS, readTextFile, toProjectPath, writeFailure, writeTextFile } from '../../../../src/platform/electron/main/files.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-platform-files-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('files: text written is the text read, whatever it holds', async () => {
  const file = path.join(ROOT, 'project.orogen');
  const text = '{"title":"Ünïcode ✓ \\n","lines":"a\r\nb"}\n';
  await writeTextFile(file, text);
  assert.ok((await readTextFile(file)) === text);
});

test('files: a write replaces the file and leaves nothing beside it', async () => {
  const dir = path.join(ROOT, 'replace');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.orogen');
  await writeTextFile(file, 'first');
  await writeTextFile(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(dir), ['a.orogen']);
});

test('files: a write that fails leaves the old file and no temporary one', async () => {
  const dir = path.join(ROOT, 'failing');
  fs.mkdirSync(dir);
  // The target is a folder: the temporary file is written, and the rename onto it fails.
  fs.mkdirSync(path.join(dir, 'taken'));
  await assert.rejects(writeTextFile(path.join(dir, 'taken'), 'text'));
  assert.deepEqual(fs.readdirSync(dir), ['taken']);
  await assert.rejects(writeTextFile(path.join(dir, 'missing', 'a.orogen'), 'text'), /ENOENT/);
});

test('files: a file whose name is as long as the disk allows is written, and nothing is left beside it', async () => {
  const dir = path.join(ROOT, 'long');
  fs.mkdirSync(dir);
  // 255 bytes is the most a name has on the file systems of Linux, Windows and macOS.
  const file = path.join(dir, `${'n'.repeat(255 - '.orogen'.length)}.orogen`);
  await writeTextFile(file, 'first');
  await writeTextFile(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test('files: a file that is replaced keeps its permissions, a link stays a link, and a read-only file is refused', { skip: process.platform === 'win32' && 'permission bits and links as POSIX has them' }, async () => {
  const dir = path.join(ROOT, 'kept');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'private.orogen');
  fs.writeFileSync(file, 'old', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  await writeTextFile(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a file only its owner reads is not opened to the group by a save');

  const link = path.join(dir, 'link.orogen');
  fs.symlinkSync(file, link);
  await writeTextFile(link, 'through the link');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still one');
  assert.equal(fs.readFileSync(file, 'utf8'), 'through the link');

  const locked = path.join(dir, 'locked.orogen');
  fs.writeFileSync(locked, 'kept');
  fs.chmodSync(locked, 0o444);
  // The folder can be written, so a rename would replace the file without asking anybody.
  await assert.rejects(writeTextFile(locked, 'lost'), (thrown: unknown) => (thrown as { code?: unknown }).code === 'EACCES');
  assert.equal(fs.readFileSync(locked, 'utf8'), 'kept');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.orogen', 'locked.orogen', 'private.orogen']);
});

test('files: a rename that is refused because the file is held is tried again where that passes, and nowhere else', async () => {
  const dir = path.join(ROOT, 'held');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.orogen');
  fs.writeFileSync(file, 'old');
  const refusal = (code: string): Error => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  let calls = 0;
  const twice = async (from: string, to: string): Promise<void> => {
    if (++calls <= 2) throw refusal(calls === 1 ? 'EPERM' : 'EBUSY');
    await fs.promises.rename(from, to);
  };
  // As on Windows: a scanner holds the file for the first two attempts.
  await writeTextFile(file, 'new', { held: true, rename: twice, delaysMs: [1, 1, 1] });
  assert.deepEqual([calls, fs.readFileSync(file, 'utf8'), fs.readdirSync(dir)], [3, 'new', ['a.orogen']]);

  // A file that stays held fails with the system's error, the old file is there, and no temporary one.
  calls = 0;
  const always = async (): Promise<void> => { calls++; throw refusal('EBUSY'); };
  await assert.rejects(writeTextFile(file, 'never', { held: true, rename: always, delaysMs: [1, 1] }), /EBUSY/);
  assert.deepEqual([calls, fs.readFileSync(file, 'utf8'), fs.readdirSync(dir)], [3, 'new', ['a.orogen']]);

  // Where the code means what it says, and for any other failure, there is one attempt.
  calls = 0;
  await assert.rejects(writeTextFile(file, 'never', { held: false, rename: always, delaysMs: [1, 1] }), /EBUSY/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(writeTextFile(file, 'never', { held: true, delaysMs: [1, 1], rename: async () => { calls++; throw refusal('ENOSPC'); } }), /ENOSPC/);
  assert.equal(calls, 1);
  assert.deepEqual([...HELD_DELAYS_MS], [...BUSY_DELAYS_MS], 'the main process repeats the engine\'s waits');
});

test('files: a save that fails is told in words that name the file, its folder and what helps', () => {
  const file = path.join(path.sep, 'work', 'land', 'project.orogen');
  const of = (code: string): string => writeFailure(Object.assign(new Error(`${code}: something, open '/work/land/.~og1-1.tmp'`), { code }), file);
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'ENAMETOOLONG', 'EBUSY']) {
    const said = of(code);
    assert.match(said, /^project\.orogen cannot be written: /, code);
    assert.ok(!said.includes('.tmp') && !said.includes(code), `${code}: ${said}`);
    assert.match(said, /\.$/, code);
  }
  for (const code of ['EACCES', 'EROFS', 'ENOENT']) assert.ok(of(code).includes(path.dirname(file)) && of(code).includes('File > Save As'), code);
  assert.match(of('EACCES'), /read-only/);
  assert.match(of('ENOSPC'), /full/);
  assert.match(of('EBUSY'), /another program/);
  // What it has no words for keeps the system's.
  assert.equal(writeFailure(new Error('EIO: i/o error'), file), 'EIO: i/o error');
  assert.equal(writeFailure('text', file), 'text');
});

test('files: a path that is not absolute is refused before the disk is touched', async () => {
  await assert.rejects(readTextFile('project.orogen'), /not an absolute file path/);
  await assert.rejects(writeTextFile('project.orogen', 'x'), /not an absolute file path/);
  await assert.rejects(writeTextFile('', 'x'), TypeError);
  await assert.rejects(readTextFile(ROOT), /is not a file/);
  await assert.rejects(readTextFile(path.join(ROOT, 'none.orogen')), /ENOENT/);
});

test('files: a file under the project folder is stored relative, with forward slashes', () => {
  const posix = path.posix;
  assert.equal(toProjectPath('/work/land/land.orogen', '/work/land/maps/height.png', posix), 'maps/height.png');
  assert.equal(toProjectPath('/work/land/land.orogen', '/work/land/height.png', posix), 'height.png');
  const win = path.win32;
  assert.equal(toProjectPath('C:\\Work\\Land\\land.orogen', 'C:\\Work\\Land\\maps\\deep\\height.png', win), 'maps/deep/height.png');
  assert.equal(toProjectPath('C:\\Work\\Land\\land.orogen', 'c:\\work\\land\\height.png', win), 'height.png', 'a Windows path is compared without case');
});

test('files: a file elsewhere, and any file of an unsaved project, is stored absolute', () => {
  const posix = path.posix;
  assert.equal(toProjectPath('/work/land/land.orogen', '/work/other/height.png', posix), '/work/other/height.png');
  assert.equal(toProjectPath('/work/land/land.orogen', '/work/height.png', posix), '/work/height.png');
  assert.equal(toProjectPath('/work/land/land.orogen', '/work/land', posix), '/work/land', 'the folder itself is no file under it');
  assert.equal(toProjectPath(null, '/work/land/height.png', posix), '/work/land/height.png');
  const win = path.win32;
  assert.equal(toProjectPath('C:\\Work\\land.orogen', 'D:\\Maps\\height.png', win), 'D:\\Maps\\height.png', 'another drive');
  assert.equal(toProjectPath('C:\\Work\\Land\\land.orogen', 'C:\\Work\\height.png', win), 'C:\\Work\\height.png');
});
