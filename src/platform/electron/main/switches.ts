// The launch switches of runtime.md 1.6. Pure: main.ts hands in the platform and applies the result before
// app.whenReady(). No Electron import, so the table is tested without Electron.

export interface LaunchSwitch { readonly name: string; readonly value?: string }

/**
 * The switches for one platform. `software` is OROGEN_ELECTRON_GPU=software: on Linux the Vulkan feature is then
 * left out, which leaves Chromium on SwiftShader (testing.md 9.3).
 */
export function launchSwitches(platform: string, software: boolean): LaunchSwitch[] {
  const switches: LaunchSwitch[] = [
    { name: 'enable-webgpu-developer-features' },
    { name: 'disable-renderer-backgrounding' },
    // 7.8 rule 3. Without these two Chromium answers a GPU process that ended twice within about two minutes by
    // refusing the page every adapter for that long, and one that ended more often by leaving hardware
    // acceleration for good: the session's own rule (three losses in 120 s) is then the only one in force.
    { name: 'disable-gpu-process-crash-limit' },
    { name: 'disable-domain-blocking-for-3d-apis' },
  ];
  // `enable-features` is appended exactly once with the full list: a second appendSwitch replaces the first.
  const features: string[] = [];
  if (platform === 'linux') {
    switches.push({ name: 'enable-unsafe-webgpu' });
    if (!software) features.push('Vulkan');
  }
  if (platform === 'win32') {
    // Both spellings: which one Electron 44 honours is not verified.
    switches.push({ name: 'force_high_performance_gpu' }, { name: 'force-high-performance-gpu' });
  }
  if (features.length > 0) switches.push({ name: 'enable-features', value: features.join(',') });
  return switches;
}

/** `commandLine` is app.commandLine. */
export function applySwitches(commandLine: { appendSwitch(name: string, value?: string): void }, switches: readonly LaunchSwitch[]): void {
  for (const s of switches) {
    if (s.value === undefined) commandLine.appendSwitch(s.name);
    else commandLine.appendSwitch(s.name, s.value);
  }
}
