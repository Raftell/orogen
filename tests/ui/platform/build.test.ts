// The build of the application (testing.md 8.2): `vite build` with the repository's configuration, into a folder
// of this test's own, which holds an application of before. While the build runs that folder is watched: it holds
// the whole application at every moment, the old one or the new one, but for the one moment between the two
// renames that put the new one in place, when there is no folder at all; and a test that starts in that moment
// waits it out as launchApp does (testing.md 2.9).
//
// No window and no device: this file builds, and starts nothing it built.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { waitThroughSwap } from '../../../tools/build-folder.ts';
import { OUTPUT, ROOT } from './rig.ts';

/** What tests/helpers/app.ts asks of a built application, by name. */
const BUILT = ['main.cjs', 'preload.cjs', 'index.html', 'engine-worker.js', 'cpu-worker.js'];
const SCRATCH = path.join(OUTPUT, 'build');
const DIST = path.join(SCRATCH, 'dist');
/** A build takes seconds; this ends one that hangs. No assertion depends on it. */
const BACKSTOP_MS = 300_000;
const OLD = 'the application of before';

test('build: the folder holds a whole application at every moment of a build but the swap, which a test that starts then waits out, and the new one at its end', async (t) => {
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
  // other, and between them there is none (Node cannot do it in one call, tools/build-folder.ts): on Linux no
  // look has found that moment, on Windows 16 of 32 778 looks did during one build. What holds on every system is
  // asserted: no look finds the folder without the whole application in it, it is missing at one moment at most,
  // and a test that starts in that moment waits it out and finds the new application, as launchApp does.
  const complete = (): boolean => BUILT.every((name) => fs.existsSync(path.join(DIST, name)));
  let looks = 0;
  /** The looks that found the application missing twice in a row, and those of them that found the folder without it. */
  const gaps: number[] = [];
  const partial: number[] = [];
  /** What launchApp would find, started at the first look that found nothing. */
  let started: Promise<string[]> | null = null;
  let done = false;
  void exited.then(() => { done = true; });
  while (!done) {
    looks++;
    if (!complete() && !complete()) {
      gaps.push(looks);
      if (fs.existsSync(DIST) && !complete()) partial.push(looks);
      started ??= waitThroughSwap(DIST, BUILT);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  clearTimeout(backstop);
  const code = await exited;
  assert.equal(code, 0, `the build failed:\n${output.slice(-4000)}`);
  assert.equal(partial.length, 0, `the folder was there without the whole application at ${partial.length} of ${looks} looks, the first at look ${partial[0]}`);
  assert.ok(gaps.every((look, i) => i === 0 || look === gaps[i - 1]! + 1), `the folder was missing at more than one moment: at looks ${gaps.slice(0, 20).join(', ')}`);
  if (started !== null) assert.deepEqual(await started, [], 'a test that started while the folder was missing found the new application');
  t.diagnostic(`${looks} looks at the folder while the build ran; ${gaps.length} of them, in a row, between the two renames`);

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
