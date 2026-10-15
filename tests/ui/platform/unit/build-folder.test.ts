// How a build of the application gets into place (testing.md 8.2): tools/build-folder.ts on temporary folders.
// The build itself, with the folder watched while it runs, is tests/ui/platform/build.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { removeStale, replaceFolder, STALE_MS, stagingFolder, waitThroughSwap } from '../../../../tools/build-folder.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-build-folder-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let cases = 0;

function folder(dir: string, files: Readonly<Record<string, string>>): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/** Every file under a folder with its text, by its path with `/`. */
function held(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, held(dir, rel));
    else out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
  }
  return out;
}

const OLD = { 'index.html': 'old page', 'main.cjs': 'old main', 'assets/index-old.js': 'old script', 'assets/only-old.css': 'gone with the new build' };
const NEW = { 'index.html': 'new page', 'main.cjs': 'new main', 'assets/index-new.js': 'new script', 'engine-worker.js': 'new worker' };

test('build folder: the staging folder is beside the target and bears the process\'s id', () => {
  assert.equal(stagingFolder('/work/orogen/dist', 4711), '/work/orogen/dist.partial-4711');
  assert.equal(stagingFolder('/work/orogen/dist'), `/work/orogen/dist.partial-${process.pid}`);
});

test('build folder: the new build takes the place of the old by a rename, and nothing of either is left beside it', () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = folder(path.join(parent, 'dist'), OLD);
  const staging = folder(stagingFolder(target), NEW);
  // What the system is asked to do, in order: the folder is in place again one call after it was moved aside.
  const renames: string[] = [];
  const how = replaceFolder(staging, target, {
    renameSync(from, to) {
      renames.push(`${path.basename(from)} -> ${path.basename(to)}`);
      fs.renameSync(from, to);
    },
  });
  assert.equal(how, 'renamed');
  assert.equal(renames.length, 2);
  assert.match(renames[0]!, /^dist -> dist\.previous-\d+-\d+$/);
  assert.equal(renames[1], `dist.partial-${process.pid} -> dist`);
  assert.deepEqual(held(target), NEW, 'the target is the new build, whole, without a file of the old one');
  assert.deepEqual(fs.readdirSync(parent), ['dist'], 'the staging folder and the replaced one are gone');
});

test('build folder: a first build has nothing to replace', () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = path.join(parent, 'dist');
  const staging = folder(stagingFolder(target), NEW);
  assert.equal(replaceFolder(staging, target), 'renamed');
  assert.deepEqual(held(target), NEW);
  assert.deepEqual(fs.readdirSync(parent), ['dist']);
});

test('build folder: a target that cannot be moved has its files replaced one by one, and those the new build lacks deleted', () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = folder(path.join(parent, 'dist'), OLD);
  const staging = folder(stagingFolder(target), NEW);
  // As Windows answers for a folder a running program has open.
  const how = replaceFolder(staging, target, {
    renameSync(from) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
    },
  });
  assert.equal(how, 'copied');
  assert.deepEqual(held(target), NEW);
  assert.deepEqual(fs.readdirSync(parent), ['dist'], 'no staging folder and no temporary file is left');
});

test('build folder: when the new build cannot be put in place the old one is back, and the error says where the new one is', () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = folder(path.join(parent, 'dist'), OLD);
  const staging = folder(stagingFolder(target), NEW);
  let calls = 0;
  assert.throws(() => replaceFolder(staging, target, {
    renameSync(from, to) {
      // The target moves aside; the staging folder does not move; the target moves back.
      if (++calls === 2) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      fs.renameSync(from, to);
    },
  }), (thrown: Error) => thrown.message.includes(staging) && thrown.message.includes('EXDEV'));
  assert.equal(calls, 3);
  assert.deepEqual(held(target), OLD, 'the folder in use is the build of before');
  assert.deepEqual(held(staging), NEW);
});

test('build folder: what interrupted builds left is deleted after an hour, and a build under way is left alone', () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = folder(path.join(parent, 'dist'), OLD);
  const stale = folder(`${target}.partial-111`, NEW);
  const replacedLongAgo = folder(`${target}.previous-222-1`, OLD);
  const underWay = folder(`${target}.partial-333`, NEW);
  const other = folder(path.join(parent, 'distribution'), NEW);
  const now = Date.now();
  const longAgo = new Date(now - STALE_MS - 60_000);
  for (const dir of [stale, replacedLongAgo]) fs.utimesSync(dir, longAgo, longAgo);
  assert.deepEqual(removeStale(target, now).sort(), [stale, replacedLongAgo].sort());
  assert.deepEqual(fs.readdirSync(parent).sort(), ['dist', 'dist.partial-333', 'distribution']);
  assert.deepEqual([held(target), held(underWay), held(other)], [OLD, NEW, NEW]);
  assert.deepEqual(removeStale(path.join(ROOT, 'no-such-parent', 'dist')), []);
});

test('build folder: whoever looks for the application between the two renames finds the new one when the second is made', async () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = folder(path.join(parent, 'dist'), OLD);
  const staging = folder(stagingFolder(target), NEW);
  const names = ['index.html', 'main.cjs'];
  assert.deepEqual(await waitThroughSwap(target, names), [], 'a folder in place is found at once');
  // The swap of replaceFolder, with time between its two renames, as a slow file system leaves. A look that does
  // not wait finds no application then.
  fs.renameSync(target, `${target}.previous-test`);
  assert.deepEqual(await waitThroughSwap(target, names, 0), names);
  const found = waitThroughSwap(target, names);
  setTimeout(() => fs.renameSync(staging, target), 40);
  assert.deepEqual(await found, []);
  assert.deepEqual(held(target), NEW, 'and it is the new build');
});

test('build folder: a folder that does not come is said missing, file by file, once the wait is over', async () => {
  const parent = path.join(ROOT, `case-${++cases}`);
  const target = path.join(parent, 'dist');
  assert.deepEqual(await waitThroughSwap(target, ['main.cjs', 'index.html'], 30), ['main.cjs', 'index.html']);
  folder(target, { 'main.cjs': 'a build without its page' });
  assert.deepEqual(await waitThroughSwap(target, ['main.cjs', 'index.html'], 30), ['index.html']);
});
