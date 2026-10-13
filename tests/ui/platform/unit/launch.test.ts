// What a launch reads from the environment and the command line: the test mode of testing.md 2.9 and the
// variables of runtime.md 1.1 rule 5.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LaunchError, readLaunch } from '../../../../src/platform/electron/main/launch.ts';

const CWD = path.resolve('/work/project');
const DRIVER = path.resolve('/repo/tests/electron/driver.cjs');
const dev = { packaged: false, cwd: CWD };

test('launch: without variables the application is a normal one with the max profile on hardware', () => {
  assert.deepEqual(readLaunch({}, ['electron', '.'], dev), { test: false, driver: null, project: null, profile: 'max', software: false });
});

test('launch: OROGEN_TEST=1 is the test mode, and only then is a driver loaded', () => {
  assert.equal(readLaunch({ OROGEN_TEST: '1' }, ['electron', '.'], dev).test, true);
  assert.equal(readLaunch({ OROGEN_TEST: '0' }, ['electron', '.'], dev).test, false);
  assert.equal(readLaunch({ OROGEN_TEST: '1', OROGEN_TEST_DRIVER: DRIVER }, ['electron', '.'], dev).driver, DRIVER);
  assert.equal(readLaunch({ OROGEN_TEST_DRIVER: DRIVER }, ['electron', '.'], dev).driver, null, 'a driver outside test mode is not loaded');
  assert.throws(() => readLaunch({ OROGEN_TEST: '1', OROGEN_TEST_DRIVER: 'tests/electron/driver.cjs' }, ['electron', '.'], dev), LaunchError);
});

test('launch: the first argument is the project file, as an absolute path', () => {
  assert.equal(readLaunch({}, ['electron', '.', 'graphs/a.orogen'], dev).project, path.join(CWD, 'graphs/a.orogen'));
  assert.equal(readLaunch({}, ['electron', '.', path.resolve('/x/b.orogen')], dev).project, path.resolve('/x/b.orogen'));
  // Packaged, no application folder stands before it: this is how a double-clicked project file arrives.
  assert.equal(readLaunch({}, ['Orogen.exe', 'a.orogen'], { packaged: true, cwd: CWD }).project, path.join(CWD, 'a.orogen'));
  assert.equal(readLaunch({}, ['Orogen.exe'], { packaged: true, cwd: CWD }).project, null);
});

test("launch: Chromium's own switches are no arguments", () => {
  assert.equal(readLaunch({}, ['electron', '--no-sandbox', '.', '--enable-logging', 'a.orogen'], dev).project, path.join(CWD, 'a.orogen'));
  assert.equal(readLaunch({}, ['electron', '.', '--inspect=9229'], dev).project, null);
});

test('launch: the profile and the adapter take their values and no others', () => {
  assert.equal(readLaunch({ OROGEN_GPU_PROFILE: 'core' }, ['electron', '.'], dev).profile, 'core');
  assert.equal(readLaunch({ OROGEN_GPU_PROFILE: 'max' }, ['electron', '.'], dev).profile, 'max');
  assert.equal(readLaunch({ OROGEN_GPU_PROFILE: '' }, ['electron', '.'], dev).profile, 'max');
  assert.throws(() => readLaunch({ OROGEN_GPU_PROFILE: 'fast' }, ['electron', '.'], dev), { name: 'LaunchError', message: /OROGEN_GPU_PROFILE is "fast"; it is "max" or "core"/ });
  assert.equal(readLaunch({ OROGEN_ELECTRON_GPU: 'software' }, ['electron', '.'], dev).software, true);
  assert.equal(readLaunch({ OROGEN_ELECTRON_GPU: 'hardware' }, ['electron', '.'], dev).software, false);
  assert.throws(() => readLaunch({ OROGEN_ELECTRON_GPU: 'swiftshader' }, ['electron', '.'], dev), LaunchError);
});
