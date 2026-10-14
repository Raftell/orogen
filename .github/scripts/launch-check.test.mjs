// The verdicts of the launch check (testing.md 9.1), without an application: `--read` judges a result that was
// written before, and these are the results the driver can write. What starts the application is exercised by
// the jobs that use it.
//
//   node --test .github/scripts/launch-check.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launch-check.mjs');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-launch-check-'));
after(() => fs.rmSync(folder, { recursive: true, force: true }));

const ready = { state: 'ready', message: null, profile: 'max', adapter: { vendor: 'google', description: 'SwiftShader Device', device: '', architecture: 'swiftshader' }, software: true, features: [], seen: [{ state: 'starting', message: null, atMs: 500 }, { state: 'ready', message: null, atMs: 1200 }] };
const failed = { state: 'failed', message: 'No WebGPU adapter is available', profile: 'max', adapter: null, software: null, features: null, seen: [{ state: 'starting', message: null, atMs: 500 }, { state: 'failed', message: 'No WebGPU adapter is available', atMs: 700 }] };
const base = { loaded: true, platform: 'win32', arch: 'x64', packaged: true, versions: { electron: '44.7.0', chrome: '152', node: '24' }, title: 'Untitled - Orogen', parts: ['menubar', 'statusbar'], errors: [], failure: null, elapsedMs: 1500 };

let written = 0;
/** Runs the program on a result; `result` null: on a file that does not exist. */
function judge(result, ...options) {
  const file = path.join(folder, `result-${++written}.json`);
  if (result !== null) fs.writeFileSync(file, typeof result === 'string' ? result : JSON.stringify(result));
  // Outside a run of GitHub: the annotations and the summary of a run are not part of the verdict.
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  const done = spawnSync(process.execPath, [SCRIPT, '--read', file, ...options], { encoding: 'utf8', env, timeout: 30_000 });
  return { code: done.status, out: `${done.stdout}${done.stderr}` };
}

test('a window that loaded and a device that is ready pass, with and without --require-device', () => {
  const result = { ...base, attempts: [ready] };
  assert.equal(judge(result).code, 0);
  const strict = judge(result, '--require-device');
  assert.equal(strict.code, 0);
  assert.match(strict.out, /device ready on google SwiftShader Device swiftshader \(a software adapter\)/);
});

test('a window that loaded without a device passes, and fails with 3 under --require-device', () => {
  const result = { ...base, attempts: [failed] };
  const lenient = judge(result);
  assert.equal(lenient.code, 0);
  assert.match(lenient.out, /no device \(failed\): No WebGPU adapter is available/);
  assert.equal(judge(result, '--require-device').code, 3);
});

test('a first start without an adapter and a second with one pass, and the need for Retry is said', () => {
  const second = judge({ ...base, attempts: [failed, ready] }, '--require-device');
  assert.equal(second.code, 0);
  assert.match(second.out, /first start of the engine: no device/);
  assert.match(second.out, /the application needed its Retry/);
  assert.equal(judge({ ...base, attempts: [failed, failed] }, '--require-device').code, 3);
});

test('a device that was still starting when the wait ended is no device', () => {
  const starting = { ...failed, state: 'starting', message: null, timedOut: true, seen: [{ state: 'starting', message: null, atMs: 500 }] };
  const strict = judge({ ...base, attempts: [starting] }, '--require-device');
  assert.equal(strict.code, 3);
  assert.match(strict.out, /still so when the wait ended/);
});

test('a window that did not load its interface fails with 1, whatever else is asked', () => {
  const result = { ...base, loaded: false, failure: 'the page has loaded without its test object', attempts: [] };
  const lenient = judge(result);
  assert.equal(lenient.code, 1);
  assert.match(lenient.out, /the window did not load the interface: the page has loaded without its test object/);
  assert.equal(judge(result, '--require-device').code, 1);
});

test('no result, and a file that is no result, fail with 1', () => {
  assert.equal(judge(null).code, 1);
  assert.equal(judge('not JSON').code, 1);
  assert.equal(judge('[1, 2]').code, 1, 'a list is no result of the driver');
});

test('arguments that are not understood end with 2 and the usage', () => {
  const done = spawnSync(process.execPath, [SCRIPT, '--frobnicate'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.status, 2);
  assert.match(done.stderr, /usage: node \.github\/scripts\/launch-check\.mjs/);
  const both = spawnSync(process.execPath, [SCRIPT, '--read', 'x.json', '--app', 'y'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(both.status, 2);
});
