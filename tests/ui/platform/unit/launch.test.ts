// What a launch reads from the environment and the command line: the test mode of testing.md 2.9 and the
// variables of runtime.md 1.1 rule 5.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { LaunchError, readLaunch, secondStartProject, SOFTWARE_SWITCH, softwareRelaunchArgs } from '../../../../src/platform/electron/main/launch.ts';

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

test('launch: a run restarted with software rendering is on the software adapter, by its switch, and the switch is no project', () => {
  assert.equal(SOFTWARE_SWITCH, '--software-rendering');
  const restarted = readLaunch({}, ['Orogen.exe', 'alps.orogen', SOFTWARE_SWITCH], { packaged: true, cwd: CWD });
  assert.deepEqual([restarted.software, restarted.project], [true, path.join(CWD, 'alps.orogen')]);
  assert.equal(readLaunch({}, ['electron', '.', SOFTWARE_SWITCH], dev).project, null);
  assert.equal(readLaunch({}, ['Orogen.exe'], { packaged: true, cwd: CWD }).software, false, 'without it, and without the variable, the graphics card');
});

test('launch: the run that takes this one\'s place with software rendering opens the project and has the switch, once', () => {
  const alps = path.resolve('/terrains/alps.orogen');
  // Packaged: no folder. What this run was given as its project is not given again: the project now is.
  assert.deepEqual(softwareRelaunchArgs(['C:\\Orogen\\Orogen.exe', 'old.orogen'], { packaged: true }, alps), [alps, SOFTWARE_SWITCH]);
  assert.deepEqual(softwareRelaunchArgs(['Orogen.exe'], { packaged: true }, null), [SOFTWARE_SWITCH]);
  // From source: the application's folder first, and the switches this run had stay.
  assert.deepEqual(softwareRelaunchArgs(['electron', '--no-sandbox', '.', 'old.orogen'], { packaged: false }, alps), ['.', '--no-sandbox', alps, SOFTWARE_SWITCH]);
  // A run that was restarted so already is restarted with the switch once.
  const twice = softwareRelaunchArgs(['Orogen.exe', SOFTWARE_SWITCH], { packaged: true }, null);
  assert.deepEqual(twice, [SOFTWARE_SWITCH]);
  // What it is given is what the next run reads: the project, on the software adapter.
  const next = readLaunch({}, ['Orogen.exe', ...softwareRelaunchArgs(['Orogen.exe'], { packaged: true }, alps)], { packaged: true, cwd: CWD });
  assert.deepEqual([next.project, next.software], [alps, true]);
});

test('launch: a second start hands over the project file it was given, read as a first start reads its own', () => {
  const cwd = path.resolve('/home/ada/Terrain');
  // Packaged: the executable, then the file. From source: the executable, the application's folder, then the file.
  assert.equal(secondStartProject(['C:\\Orogen\\Orogen.exe', 'alps.orogen'], { packaged: true, cwd }), path.resolve(cwd, 'alps.orogen'));
  assert.equal(secondStartProject(['electron', '.', '/work/andes.orogen'], { packaged: false, cwd }), path.resolve('/work/andes.orogen'));
  // Chromium adds switches of its own to what it passes on: they are no file.
  assert.equal(secondStartProject(['Orogen.exe', '--allow-file-access-from-files', '--original-process-start-time=1', 'alps.orogen'], { packaged: true, cwd }), path.resolve(cwd, 'alps.orogen'));
  // A second start without a file only brings the window forward.
  assert.equal(secondStartProject(['Orogen.exe'], { packaged: true, cwd }), null);
  assert.equal(secondStartProject(['electron', '.'], { packaged: false, cwd }), null);
  assert.equal(secondStartProject([], { packaged: true, cwd }), null);
});
