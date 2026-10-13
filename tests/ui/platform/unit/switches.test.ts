// The launch switches of runtime.md 1.6, per platform. Linux is what the development machine runs; the rows of
// Windows are checked here because nothing else on this machine can.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySwitches, launchSwitches, type LaunchSwitch } from '../../../../src/platform/electron/main/switches.ts';

const names = (switches: readonly LaunchSwitch[]): string[] => switches.map((s) => s.name);
const valueOf = (switches: readonly LaunchSwitch[], name: string): string | undefined => switches.find((s) => s.name === name)?.value;

test('switches: every platform gets the developer features and no renderer backgrounding', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const switches = names(launchSwitches(platform, false));
    assert.ok(switches.includes('enable-webgpu-developer-features'), platform);
    assert.ok(switches.includes('disable-renderer-backgrounding'), platform);
  }
});

test('switches: Linux enables WebGPU and Vulkan, without which the adapter is SwiftShader', () => {
  const switches = launchSwitches('linux', false);
  assert.ok(names(switches).includes('enable-unsafe-webgpu'));
  assert.equal(valueOf(switches, 'enable-features'), 'Vulkan');
});

test('switches: the software adapter is asked for by leaving the Vulkan feature out', () => {
  const switches = launchSwitches('linux', true);
  assert.ok(names(switches).includes('enable-unsafe-webgpu'));
  assert.ok(!names(switches).includes('enable-features'), 'no feature list at all: an empty one would still be a switch');
});

test('switches: Windows asks for the discrete GPU in both spellings and needs nothing for WebGPU', () => {
  for (const software of [false, true]) {
    const switches = names(launchSwitches('win32', software));
    assert.ok(switches.includes('force_high_performance_gpu') && switches.includes('force-high-performance-gpu'));
    assert.ok(!switches.includes('enable-unsafe-webgpu') && !switches.includes('enable-features'));
  }
});

test('switches: no switch is appended twice, enable-features least of all', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const software of [false, true]) {
      const switches = names(launchSwitches(platform, software));
      assert.equal(new Set(switches).size, switches.length, `${platform}: ${switches.join(' ')}`);
    }
  }
});

test('switches: applySwitches appends each once, a value only where there is one', () => {
  const calls: unknown[][] = [];
  applySwitches({ appendSwitch: (...args: unknown[]) => void calls.push(args) }, [{ name: 'a' }, { name: 'b', value: 'x,y' }]);
  assert.deepEqual(calls, [['a'], ['b', 'x,y']]);
});
