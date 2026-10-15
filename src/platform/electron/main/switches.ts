// The launch switches of runtime.md 1.6. Pure: main.ts hands in the platform and applies the result before
// app.whenReady(). No Electron import, so the table is tested without Electron.

export interface LaunchSwitch { readonly name: string; readonly value?: string }

/**
 * The switches for one platform. `software` is OROGEN_ELECTRON_GPU=software, or a run the user restarted with
 * software rendering: on Linux the Vulkan feature is then left out, which leaves Chromium on SwiftShader
 * (testing.md 9.3); on Windows WebGPU is asked to take SwiftShader, which Chromium does not give it there
 * (measured on windows-latest and on the target machine: no adapter).
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
    // SwiftShader is Vulkan, and Electron's Windows distribution carries it (vk_swiftshader.dll). Chromium's
    // blocklist keeps WebGPU from a machine whose only adapter is a software one, and it no longer falls back to
    // SwiftShader unless that is allowed. Measured on windows-latest, with the GPU blocklist the only adapter is
    // Microsoft's Basic Render Driver and "gpu_compositing" is "disabled_software"; lifting the blocklist and
    // putting ANGLE on SwiftShader enabled compositing, WebGL and rasterization, but "webgpu" stayed
    // "unavailable_software". Dawn's SwiftShader adapter is a Vulkan one, so the Vulkan backend is asked for too.
    // That is not enough either: WebGPU still had no adapter on the runner, nor on the target machine beside a
    // working RTX 3080 (ARCHITECTURE.md section 2). The page therefore offers no software rendering on Windows
    // (runtime.md 8.7 rule 16); these stay for the advisory CI step that tries them (testing.md 9.3).
    if (software) {
      switches.push(
        { name: 'enable-unsafe-webgpu' }, { name: 'enable-unsafe-swiftshader' }, { name: 'use-webgpu-adapter', value: 'swiftshader' },
        { name: 'ignore-gpu-blocklist' }, { name: 'use-angle', value: 'swiftshader' }, { name: 'use-vulkan', value: 'swiftshader' },
      );
      features.push('Vulkan');
    }
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
