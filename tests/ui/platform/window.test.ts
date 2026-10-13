// The main process in test mode (runtime.md 8.2, 1.6; testing.md 2.9): the window is hidden and has the
// contract's preferences, the launch switches of this platform are applied, and what Chromium keeps per user
// lives in a temporary folder that is gone afterwards. Read from the main process itself, by a driver of this
// test's own.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MENU_COMMANDS } from '../../../src/platform/electron/main/menu.ts';
import { launchSwitches } from '../../../src/platform/electron/main/switches.ts';
import { ROOT } from './rig.ts';

interface Facts {
  readonly visible: boolean;
  /** Whether the native menu is a bar inside the window. */
  readonly menuBarVisible: boolean;
  readonly windows: number;
  readonly webPreferences: Readonly<Record<string, unknown>>;
  readonly switches: Readonly<Record<string, string | null>>;
  readonly userData: string;
  readonly page: { readonly bridge: string; readonly require: string; readonly process: string };
  readonly url: string;
  readonly menu: readonly string[];
  readonly menuCommands: readonly string[];
  readonly closeRequests: number;
  readonly openAfterCloseRequest: boolean;
  readonly errors: readonly string[];
  /** How the application ended: 0 when it quit by itself after the page had confirmed the close. */
  readonly exitCode: number | null;
}

const DRIVER = path.join(ROOT, 'tests/ui/platform/facts-driver.cjs');
const MARK = 'OROGEN_FACTS ';
/** Backstop: the application ends by itself within a second of the window's load. */
const RUN_BACKSTOP_MS = 60_000;

/** The system's temporary folder, as it is named and as it is: on some systems the name is a link. */
const TEMPORARY = [os.tmpdir(), fs.realpathSync(os.tmpdir())];

/** Removes the temporary folder of a run that has ended: the test mode's own, and nothing else. */
function removeUserData(folder: string): void {
  if (path.basename(folder).startsWith('orogen-test-') && TEMPORARY.includes(path.dirname(folder))) {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** Starts the built application in test mode with the facts driver and returns what it printed. It has exited when this resolves. */
function mainFacts(environment: Readonly<Record<string, string>>): Promise<Facts> {
  assert.ok(fs.existsSync(path.join(ROOT, 'dist/main.cjs')), 'The application is not built: run "npm run build" first');
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_TEST: '1', OROGEN_TEST_DRIVER: DRIVER, OROGEN_GPU_PROFILE: 'core', OROGEN_ELECTRON_GPU: 'hardware', ...environment };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise<Facts>((resolve, reject) => {
    const child = spawn(electron, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const backstop = setTimeout(() => child.kill('SIGKILL'), RUN_BACKSTOP_MS);
    const kill = (): void => void child.kill('SIGKILL');
    process.on('exit', kill);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(backstop);
      process.off('exit', kill);
      const line = output.split('\n').find((l) => l.startsWith(MARK));
      if (line === undefined) {
        reject(new Error(`The application ended (${signal ?? `code ${code}`}) without its facts:\n${output.slice(-4000)}`));
        return;
      }
      const facts = { ...(JSON.parse(line.slice(MARK.length)) as Facts), exitCode: code };
      // Chromium writes its last state into the folder while it exits, after the application has removed it.
      removeUserData(facts.userData);
      resolve(facts);
    });
  });
}

const featuresOf = (facts: Facts): string[] => (facts.switches['enable-features'] ?? '').split(',').filter((name) => name !== '');

test('window: it opens hidden, with the preferences the contract fixes, on the page of the build', async () => {
  const facts = await mainFacts({});
  assert.equal(facts.visible, false, 'the window of a test is never shown');
  assert.equal(facts.windows, 1);
  assert.deepEqual(facts.webPreferences, {
    contextIsolation: true,
    sandbox: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: true,
    backgroundThrottling: false,
  });
  // The sixth preference: the preload script ran, so the page has the bridge, and it has nothing of Node.
  assert.deepEqual(facts.page, { bridge: 'object', require: 'undefined', process: 'undefined' });
  assert.ok(facts.url.startsWith('file://') && facts.url.endsWith('/dist/index.html'), facts.url);
  assert.deepEqual(facts.menu, ['File', 'Edit', 'View', 'Engine']);
  // 8.2 rule 7: the application has its native menu, and off macOS the window does not show it as a bar.
  if (process.platform !== 'darwin') assert.equal(facts.menuBarVisible, false, 'the page draws the one menu bar of the window');
  assert.deepEqual(facts.errors, []);
});

test('window: an entry of the native menu reaches the page as its command', async () => {
  const facts = await mainFacts({});
  assert.deepEqual(facts.menuCommands, MENU_COMMANDS.map((command) => command.id));
});

test('window: the page is asked before the window closes, and the application ends when it confirms', async () => {
  const facts = await mainFacts({});
  assert.equal(facts.closeRequests, 1, 'the page heard of the close');
  assert.equal(facts.openAfterCloseRequest, true, 'and the window waited for its answer');
  assert.equal(facts.exitCode, 0, 'confirmClose closed the window, and the application quit with its last window');
});

test('window: the launch switches of this platform are applied', async () => {
  const facts = await mainFacts({});
  for (const expected of launchSwitches(process.platform, false)) {
    assert.ok(facts.switches[expected.name] !== null && facts.switches[expected.name] !== undefined, `--${expected.name} is on the command line`);
    // Electron adds features of its own to the same switch; ours are among them.
    if (expected.name === 'enable-features') for (const feature of expected.value!.split(',')) assert.ok(featuresOf(facts).includes(feature), `the feature ${feature} is enabled`);
  }
  if (process.platform === 'linux') assert.ok(featuresOf(facts).includes('Vulkan'), 'without the Vulkan feature the adapter would be SwiftShader');
});

test('window: OROGEN_ELECTRON_GPU=software leaves the Vulkan feature out on Linux', { skip: process.platform === 'linux' ? false : 'the switch is left out on Linux only' }, async () => {
  const facts = await mainFacts({ OROGEN_ELECTRON_GPU: 'software' });
  assert.ok(facts.switches['enable-unsafe-webgpu'] !== null, 'WebGPU itself stays enabled');
  assert.ok(!featuresOf(facts).includes('Vulkan'), `enable-features is "${facts.switches['enable-features']}"`);
});

test('window: preferences live in a temporary folder of the run', async () => {
  const facts = await mainFacts({});
  assert.ok(TEMPORARY.includes(path.dirname(facts.userData)), `${facts.userData} lies in the temporary folder`);
  assert.ok(path.basename(facts.userData).startsWith('orogen-test-'));
  const second = await mainFacts({});
  assert.notEqual(second.userData, facts.userData, 'every run has a folder of its own');
});

test('window: a variable that holds none of its values stops the application before it opens anything', async () => {
  await assert.rejects(mainFacts({ OROGEN_GPU_PROFILE: 'fast' }), /code 2[\s\S]*OROGEN_GPU_PROFILE is "fast"/);
});
