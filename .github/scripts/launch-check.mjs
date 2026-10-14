#!/usr/bin/env node
// The launch check (testing.md 9.1): starts the application once in test mode, hidden, and says how far it came:
// whether its window loaded, and whether its engine worker opened a GPU device, on which adapter.
//
//   node .github/scripts/launch-check.mjs [--app <executable>] [--result <file>] [--timeout <seconds>] [--settle <seconds>]
//   node .github/scripts/launch-check.mjs --read <file> --require-device
//
// Without --app it starts the build of this checkout (`electron .`, which needs `npm run build`); with --app the
// packaged executable, for example release/win-unpacked/Orogen.exe. The application itself writes what it saw
// (launch-check-driver.cjs) to the result file, and this program reads it.
//
// Exit codes: 0 the window loaded (with --require-device: and a device was opened); 1 the application did not
// start, did not load or left no result; 3 --require-device, and no device was opened; 2 wrong arguments.
//
// On the development machine this runs project code: start it through the guard, as every test is
// (tools/guard --lock --mem=4G node .github/scripts/launch-check.mjs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DRIVER = path.join(HERE, 'launch-check-driver.cjs');
/** What `npm run build` writes (testing.md 8.2). */
const BUILT = ['dist/main.cjs', 'dist/preload.cjs', 'dist/index.html', 'dist/engine-worker.js', 'dist/cpu-worker.js'];
const OUTPUT_KEPT = 16_384;
/** After the main process has exited: how long Chromium's other processes get before the group is ended. */
const SETTLE_MS = 500;

function usage(problem) {
  console.error(`launch-check: ${problem}`);
  console.error('usage: node .github/scripts/launch-check.mjs [--app <executable>] [--result <file>] [--timeout <seconds>] [--settle <seconds>] [--require-device]');
  console.error('       node .github/scripts/launch-check.mjs --read <file> [--require-device]');
  process.exit(2);
}

function parse(argv) {
  const options = { app: null, result: null, read: null, timeout: 300, settle: 0, requireDevice: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next === '') usage(`${arg} needs a value`);
      return next;
    };
    if (arg === '--app') options.app = path.resolve(value());
    else if (arg === '--result') options.result = path.resolve(value());
    else if (arg === '--read') options.read = path.resolve(value());
    else if (arg === '--timeout') {
      options.timeout = Number(value());
      if (!(options.timeout >= 10 && options.timeout <= 3600)) usage('--timeout is a number of seconds from 10 to 3600');
    } else if (arg === '--settle') {
      options.settle = Number(value());
      if (!(options.settle >= 0 && options.settle <= 600)) usage('--settle is a number of seconds from 0 to 600');
    } else if (arg === '--require-device') options.requireDevice = true;
    else usage(`"${arg}" is not understood`);
  }
  if (options.read !== null && (options.app !== null || options.result !== null)) usage('--read reads a result and starts nothing: it goes with --require-device only');
  return options;
}

/** One line for the log and, on GitHub, an annotation of the run. */
function say(level, message) {
  console.log(`launch-check: ${message}`);
  if (process.env.GITHUB_ACTIONS === 'true' && level !== 'info') {
    console.log(`::${level} title=Launch check::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  }
}

function summarise(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n\n`);
  } catch {
    // The summary is a convenience; the log has every line.
  }
}

const adapterName = (adapter) => [adapter?.vendor, adapter?.description || adapter?.device, adapter?.architecture].filter((part) => typeof part === 'string' && part !== '').join(' ') || 'an adapter without a name';

/** Starts the application and resolves when it has exited: its exit code or signal, and the end of its output. */
function launch(options, resultFile) {
  let command;
  let args;
  if (options.app !== null) {
    if (!fs.existsSync(options.app)) usage(`${options.app} does not exist`);
    command = options.app;
    args = [];
  } else {
    const missing = BUILT.filter((file) => !fs.existsSync(path.join(ROOT, file)));
    if (missing.length > 0) usage(`the application is not built: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Run "npm run build" first, or name a packaged executable with --app`);
    // In Node the package `electron` is the path of its executable; it downloads the binary when npm has not.
    command = createRequire(import.meta.url)('electron');
    args = ['.'];
  }

  const env = {
    ...process.env,
    OROGEN_TEST: '1',
    OROGEN_TEST_DRIVER: DRIVER,
    OROGEN_LAUNCH_CHECK_RESULT: resultFile,
  };
  // With it the executable is plain Node and opens no window.
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    // A process group of its own on POSIX, so that every process of the application ends with it.
    const child = spawn(command, args, { cwd: options.app !== null ? path.dirname(options.app) : ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix });
    let output = '';
    const keep = (chunk) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEPT); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const kill = () => {
      if (posix && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // The group is gone already.
        }
      }
      child.kill('SIGKILL');
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeout * 1000);
    process.on('exit', kill);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { kill(); process.exit(130); });

    let settled = false;
    const end = (how) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', kill);
      // Chromium's other processes may outlive the main one for a moment; none is left behind.
      setTimeout(() => {
        if (posix) kill();
        resolve({ ...how, timedOut, output: output.trim(), command });
      }, how.error ? 0 : SETTLE_MS);
    };
    child.once('error', (error) => end({ code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => end({ code, signal, error: null }));
  });
}

function readResult(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Says what the result holds. Returns the exit code. */
function report(result, options) {
  const lines = ['### Launch check'];
  const line = (level, message) => { say(level, message); lines.push(`- ${message}`); };

  line('info', `${result.packaged ? 'the packaged application' : 'the application of this checkout'}: Electron ${result.versions?.electron}, Chromium ${result.versions?.chrome}, ${result.platform} ${result.arch}`);
  if (!result.loaded) {
    line('error', `the window did not load the interface: ${result.failure ?? 'no reason was recorded'}`);
    for (const error of result.errors ?? []) line('info', `error of the application: ${error}`);
    summarise(lines);
    return 1;
  }
  line('info', `the window loaded ("${result.title}"); the check then took ${result.elapsedMs} ms; parts of the page: ${(result.parts ?? []).join(', ') || 'none found'}`);

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  attempts.forEach((attempt, i) => {
    const which = attempts.length > 1 ? (i === 0 ? 'first start of the engine' : 'engine started again (what Retry does)') : 'engine';
    if (attempt.state === 'ready') {
      line('info', `${which}: device ready on ${adapterName(attempt.adapter)}${attempt.software ? ' (a software adapter)' : ''}, profile ${attempt.profile}; features: ${(attempt.features ?? []).join(', ') || 'none'}; states seen: ${(attempt.seen ?? []).map((entry) => `${entry.state}@${entry.atMs}ms`).join(' > ')}`);
    } else {
      const level = i === attempts.length - 1 ? (options.requireDevice ? 'error' : 'warning') : 'warning';
      line(level, `${which}: no device (${attempt.state}${attempt.timedOut ? ', still so when the wait ended' : ''}): ${attempt.message ?? 'no message'}; states seen: ${(attempt.seen ?? []).map((entry) => `${entry.state}@${entry.atMs}ms`).join(' > ')}`);
    }
  });
  if (attempts.length === 0) line(options.requireDevice ? 'error' : 'warning', `the engine was never asked for its device: ${result.failure ?? 'no reason was recorded'}`);
  if (result.gpuFeatureStatusAtFailure) line('info', `Chromium's GPU features when the device failed: ${JSON.stringify(result.gpuFeatureStatusAtFailure)}`);
  if (result.gpuFeatureStatusAtLoad) line('info', `Chromium's GPU features when the window had loaded: ${JSON.stringify(result.gpuFeatureStatusAtLoad)}`);
  if (result.gpuFeatureStatus) line('info', `Chromium's GPU features at the end: ${JSON.stringify(result.gpuFeatureStatus)}`);
  if (result.gpuDevices) line('info', `Chromium's GPU devices: ${JSON.stringify(result.gpuDevices)}`);
  if (result.evaluation) {
    const e = result.evaluation;
    line('info', `the start-up project: ${e.timedOut ? 'not computed when the wait ended' : 'computed'} ${e.afterMs} ms after the window loaded; nodes ${JSON.stringify(e.nodes)}${e.view ? `, shown at ${e.view.resolution}` : ''}${(e.errors ?? []).length > 0 ? `; ${e.errors.join('; ')}` : ''}`);
  }
  if (result.lateAdapter) {
    const late = result.lateAdapter;
    if (late.error) line('info', `an adapter asked for at the end: the request failed (${late.error})`);
    else line(late.adapter ? 'info' : 'warning', `an adapter asked for ${late.atMs} ms after the page began: ${late.adapter ? adapterName(late.adapter) : 'none; in this session only what asks at once is given one, so a restarted engine would find no adapter'}`);
  }
  if (result.failure) line('warning', `the check itself stopped early: ${result.failure}`);
  for (const error of result.errors ?? []) line('warning', `error of the application: ${error}`);

  const last = attempts[attempts.length - 1];
  const device = last?.state === 'ready';
  if (attempts.length > 1 && device) {
    line('warning', 'the first start of the engine found no adapter and a second start did: the application needed its Retry');
  }
  summarise(lines);
  if (options.requireDevice && !device) return 3;
  return 0;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.read !== null) {
    const result = readResult(options.read);
    if (result === null) {
      say('error', `${options.read} holds no result: the application left none`);
      return 1;
    }
    return report(result, options);
  }

  const resultFile = options.result ?? path.join(ROOT, 'test-output', 'launch-check', 'result.json');
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.rmSync(resultFile, { force: true });

  const ended = await launch(options, resultFile);
  // A launcher that starts the application and does not wait for it (--settle): the result may come after it has gone.
  for (const deadline = Date.now() + options.settle * 1000; !ended.error && !fs.existsSync(resultFile) && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const how = ended.error ? `could not be started (${ended.error})` : ended.timedOut ? `was ended after ${options.timeout} s` : ended.signal ? `was ended by ${ended.signal}` : `exited with code ${ended.code}`;
  const result = readResult(resultFile);
  if (result === null) {
    say('error', `${ended.command} ${how} and left no result: it did not get as far as its loaded window`);
    if (ended.output) console.log(`--- its output ---\n${ended.output}`);
    summarise(['### Launch check', `- ${ended.command} ${how} and left no result`]);
    return 1;
  }
  const code = report(result, options);
  if (ended.output && (code !== 0 || process.env.OROGEN_LAUNCH_CHECK_OUTPUT === '1')) console.log(`--- the application's output ---\n${ended.output}`);
  console.log(`launch-check: the result is ${resultFile}`);
  return code;
}

process.exit(await main());
