// Text files for the bridge and the stored form of a file path (runtime.md 8.6, 6.1 rule 2).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readTextFile, toProjectPath, writeTextFile } from '../../../../src/platform/electron/main/files.ts';

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
