// The build of the application (testing.md 8.2): `vite build` with the repository's configuration, into a folder
// of this test's own, which holds an application of before. While the build runs that folder is watched: a test
// that starts meanwhile finds an application in it at every moment, the old one or the new one.
//
// No window and no device: this file builds, and starts nothing it built.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { OUTPUT, ROOT } from './rig.ts';

/** What tests/helpers/app.ts asks of a built application, by name. */
const BUILT = ['main.cjs', 'preload.cjs', 'index.html', 'engine-worker.js', 'cpu-worker.js'];
const SCRATCH = path.join(OUTPUT, 'build');
const DIST = path.join(SCRATCH, 'dist');
/** A build takes seconds; this ends one that hangs. No assertion depends on it. */
const BACKSTOP_MS = 300_000;
const OLD = 'the application of before';

test('build: the folder holds an application at every moment of a build, and the new one at its end', async (t) => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  for (const name of BUILT) fs.writeFileSync(path.join(DIST, name), OLD);
  fs.writeFileSync(path.join(DIST, 'assets', 'left-over.js'), OLD);

  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: ROOT, env: { ...process.env, OROGEN_DIST: DIST }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const backstop = setTimeout(() => child.kill('SIGKILL'), BACKSTOP_MS);

  // Looked at as often as the event loop comes round. The folder is replaced by two renames, one call after the
  // other: a look that falls between them finds no folder, and the next finds the new one. A file that is still
  // missing at a second look is missing for as long as a build takes to write it.
  const complete = (): boolean => BUILT.every((name) => fs.existsSync(path.join(DIST, name)));
  let looks = 0;
  const gaps: number[] = [];
  let done = false;
  void exited.then(() => { done = true; });
  while (!done) {
    looks++;
    if (!complete() && !complete()) gaps.push(looks);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  clearTimeout(backstop);
  const code = await exited;
  assert.equal(code, 0, `the build failed:\n${output.slice(-4000)}`);
  assert.equal(gaps.length, 0, `the application was missing at ${gaps.length} of ${looks} looks, the first at look ${gaps[0]}`);
  t.diagnostic(`${looks} looks at the folder while the build ran`);

  // The new build, whole: every file is a built one, and nothing of the folder of before is left in it or beside it.
  for (const name of BUILT) {
    const text = fs.readFileSync(path.join(DIST, name), 'utf8');
    assert.ok(text !== OLD && text.length > 100, `${name} is the new build's`);
  }
  assert.equal(fs.existsSync(path.join(DIST, 'assets', 'left-over.js')), false, 'a file of the build of before is gone');
  assert.ok(fs.readdirSync(path.join(DIST, 'assets')).some((name) => /^index-.*\.js$/.test(name)), 'the page\'s script is there');
  assert.deepEqual(fs.readdirSync(SCRATCH), ['dist'], 'no staging folder and no replaced folder is left beside it');
  assert.match(fs.readFileSync(path.join(DIST, 'engine-worker.js'), 'utf8'), /require\("node:fs"\)/, 'the engine worker takes Node\'s modules with require (runtime.md 8.3)');
});
