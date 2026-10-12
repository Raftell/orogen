# Orogen platform facts: WebGPU, Dawn node bindings (`webgpu` npm), Electron

Research date: 2026-10-12. Every fact carries the version/date it applies to. Anything I could not confirm from a primary source is tagged **UNVERIFIED**. Values described as "derived" were computed by reading Dawn/Chromium source, not measured on hardware: the local-testing agent must confirm them with the capability probe in section 7.

Evidence legend
- **[SRC]** read directly in upstream source code (Dawn / Chromium / Electron / node-webgpu repos).
- **[DOC]** official documentation, spec, release notes.
- **[DERIVED]** computed from [SRC]/[DOC] facts (formula shown).
- **UNVERIFIED** could not be confirmed; do not hard-code.

---

## 0. Version pins (as of 2026-10-12)

| Component | Version | Date | Source |
|---|---|---|---|
| `webgpu` (npm, dawn.node) | **0.6.2** | published 2026-10-02 | https://registry.npmjs.org/webgpu |
| Dawn revision inside `webgpu@0.6.2` | commit `77f9a9aa5f71…` | 2026-10-02 (Dawn main, newer than Chromium 156) | submodule `third_party/dawn` at tag v0.6.2, https://github.com/dawn-gpu/node-webgpu |
| Electron stable | **44.7.0** | 2026-10-07 | https://releases.electronjs.org/ |
| Chromium in Electron 44.7.0 | **152.0.7977.130** | | same |
| Node in Electron 44.7.0 | 24.21.0 | | same |
| Electron 45 | 45.0.0-beta.1 (Chromium 156.0.8078.12); stable scheduled **2026-10-20** (M156) | | https://releases.electronjs.org/schedule |
| Supported Electron majors | 44, 43, 42 (42 reaches EOL 2026-10-20) | | same |
| Node.js "Current" | 26.11.1 (line first released 2026-05-05) | 2026-10-07 | https://nodejs.org/en/about/previous-releases |
| WebGPU spec | W3C Candidate Recommendation Draft, 2026-09-15 | | https://www.w3.org/TR/webgpu/ |
| electron-builder | dist-tag `latest` = 26.15.3 (2026-06-09); **newest 26.x = 26.17.0 (2026-09-26, dist-tag `v26`)**; `next` = 27.0.0-alpha.10 (2026-10-08). `npm i electron-builder` installs 26.15.3, not the newest 26.x. [verified against the registry 2026-10-12] | | https://registry.npmjs.org/electron-builder |
| @electron-forge/cli | 8.0.1 (2026-09-29), needs Node >= 22.13 | | https://registry.npmjs.org/@electron-forge/cli |
| electron (npm) | 44.7.0, needs Node >= 22.12 | | https://registry.npmjs.org/electron |
| @webgpu/types | 0.1.74 | | https://registry.npmjs.org/@webgpu/types |
| GitHub `windows-latest` | Windows Server 2025 | | https://github.com/actions/runner-images |
| GitHub `ubuntu-latest` | Ubuntu 24.04 | | same |

**Version skew to design around:** the headless path (`webgpu@0.6.2`) runs a Dawn that is about five Chromium milestones newer than the Dawn inside Electron 44 (Chromium 152). A shader or feature that works in Node is not guaranteed to work in Electron 44. See 1.8.

---

## 1. (a) The `webgpu` npm package (Google Dawn node bindings, `dawn.node`)

### 1.1 What it is

- Repo: https://github.com/dawn-gpu/node-webgpu. It only builds and publishes `dawn.node` from Dawn (`src/dawn/node`). Bugs go to https://crbug.com/dawn, not GitHub issues. [DOC README]
- Dawn's own README still calls the node binding "WIP" and lists unexpected CTS failures as remaining work; `GPUAdapter.cpp` carries a "stub implementation" TODO (crbug.com/dawn/1133). [DOC https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/node/README.md] [SRC]
- ESM package (`"type": "module"`, `main: index.js`, bundled `types.d.ts`), depends on `@webgpu/types ^0.1.72` and `debug`. No `engines`, `os` or `cpu` field. Unpacked size 137,491,009 bytes because **all platforms ship in one tarball** (no per-platform optional deps). [SRC registry JSON]
- It is a Node-API addon (`NODE_API_MODULE`, `Napi::` types). [SRC `src/dawn/node/Module.cpp`]

### 1.2 API

```js
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);          // GPUBufferUsage, GPUTextureUsage, GPUMapMode, GPUShaderStage, ...
const gpu = create([/* "key=value" strings */]);   // returns a GPU object (same shape as navigator.gpu)
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
const device  = await adapter.requestDevice({ requiredFeatures, requiredLimits });
```

- `create(flags: string[])`: every entry **must** be `key=value`; an entry without `=` throws "Flags expected argument format is <key>=<value>". [SRC Module.cpp]
- `globals` is an object of WebGPU interface constructors and constant namespaces; nothing is installed globally unless you assign it. [DOC README]
- Keep the GPU object in a local or module variable, not on `globalThis` (see 1.6, process exit).
- There is no canvas, no `HTMLImageElement`/`VideoFrame` import, no `getPreferredCanvasFormat` meaning; render-to-texture plus readback and compute work. [DOC README]

### 1.3 Flags accepted by `create()` (read from `src/dawn/node/binding/GPU.cpp`, `TogglesLoader.cpp`) [SRC]

| Flag | Effect |
|---|---|
| `backend=<name>` | One of `null`, `webgpu`, `d3d11`, `d3d12` (alias `d3d`), `metal`, `vulkan` (alias `vk`), `opengl` (alias `gl`), `opengles` (alias `gles`). Case-insensitive. Unknown value rejects `requestAdapter()` with the list of backends. |
| env `DAWNNODE_BACKEND` | Same as `backend=` when the flag is absent. |
| `adapter=<substring>` | Case-sensitive substring match against `adapterInfo.device` (for example `NVIDIA`, `Microsoft`, `llvmpipe`). No match rejects `requestAdapter()` with a list of `backend`/`name` pairs, which is the supported way to enumerate adapters. |
| `enable-dawn-features=a,b` / `disable-dawn-features=a,b` | Dawn toggles, applied at instance, adapter and device level. Names are in `src/dawn/native/Toggles.cpp`. |
| `validate=1` (or `true`) | Backend validation level Full (D3D12 debug layer / Vulkan validation layers must be installed). |
| `verbose=1` | Prints the chosen adapter name. |

Default backend when no flag is given: **D3D12 on Windows, Vulkan on Linux, Metal on macOS** (hard-coded, the binding always sets `backendType`). [SRC GPU.cpp]

Adapter choice: the binding takes the **first** adapter from `EnumerateAdapters` that passes the `adapter=` filter. On D3D the order is DXGI's `EnumAdapterByGpuPreference` order for the requested `powerPreference` (`high-performance` maps to `DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE`). [SRC `src/dawn/native/d3d/BackendD3D.cpp`, `Instance.cpp`]

Toggles worth knowing (exact names, from Toggles.cpp) [SRC]:

| Toggle | Use |
|---|---|
| `use_dxc` | DXC instead of FXC when `dxcompiler.dll` is present. Default on with a DXC-enabled build and Shader Model >= 6.0. |
| `fxc_optimizations` | Off by default "because FXC miscompiles in many cases when optimizations are enabled". FXC output is therefore unoptimized. |
| `d3d_disable_ieee_strictness` | IEEE strictness is on by default for D3D shader compiles. |
| `dump_shaders`, `dump_shaders_on_failure` | Log the translated HLSL/SPIR-V. |
| `disable_symbol_renaming` | Keep WGSL names in generated code (debugging). |
| `timestamp_quantization` | Quantizes timestamp queries; disable for profiling. |
| `disable_robustness`, `disable_workgroup_init`, `skip_validation` | Unsafe; benchmarking only. Never ship. |
| `use_d3d12_residency_management` | D3D12 heap paging under VRAM pressure (see section 6). |
| `allow_unsafe_apis` | Exposes experimental API surface. |
| `vulkan_enable_f16_on_nvidia` | Forces `shader-f16` on NVIDIA Vulkan (see 3.3). |

### 1.4 Platforms and backends

Prebuilt binaries inside `webgpu@0.6.2`, from the publish workflow matrix [SRC `.github/workflows/build.yml`]:

| dist folder | Built on | Notes |
|---|---|---|
| `win32-x64` | `windows-latest`, MSVC, Windows SDK 10.0.26100 | ships `d3dcompiler_47.dll` and, from 0.6.2, `dxcompiler.dll` next to `dawn.node` |
| `win32-arm64` | `windows-11-arm` | same DLLs |
| `linux-x64` | `ubuntu-22.04` (from 0.6.2) | loads on Ubuntu 22.04+ (22.04 provides glibc 2.35, `GLIBCXX_3.4.30`). The exact minimum symbol version of the 0.6.2 binary is not stated upstream; the 0.4.0 binary, also built on 22.04, needed glibc 2.34 / `GLIBCXX_3.4.30` (commit edac7f5). Treat "glibc >= 2.35" as the supported floor, not a measured one. |
| `linux-arm64` | `ubuntu-22.04-arm` | added in 0.4.0 |
| `darwin-universal` | `macos-latest` | x86_64 + arm64 |

`index.js` resolves `dist/<process.platform>-<process.arch>/dawn.node` (macOS: `darwin-universal`). [SRC index.js]

Backends: D3D12 (default) and D3D11 on Windows, Vulkan on Linux, Metal on macOS. `backend=vulkan` on Windows should work when a Vulkan ICD is installed (the NVIDIA driver provides one), assuming Dawn's CMake default keeps the Vulkan backend enabled on Windows (**UNVERIFIED**, not needed by Orogen). SwiftShader is **not** bundled: the build does not set `DAWN_ENABLE_SWIFTSHADER`. [SRC build/build.js]

History that matters for pinning [SRC commit log, registry `time`]:

| Version | Date | Relevant change |
|---|---|---|
| 0.3.9 / 0.3.10 | 2026-03-18/19 | absl symbol clash with V8 fixed; worker_threads test added |
| 0.4.0 | 2026-03-27 | linux-arm64 |
| 0.5.0, 0.6.0 | 2026-08-28 | Dawn bump, per-platform `dist/` folders, win32-arm64; **Linux binaries built on 24.04 (need glibc 2.38 and `GLIBCXX_3.4.32`)** |
| 0.6.1 | 2026-09-12 | `GPUDevice.destroy()` now unmaps the device's buffers (JS wrapper in index.js) |
| **0.6.2** | 2026-10-02 | **DXC built and shipped on Windows** (PR #20), Linux back to Ubuntu 22.04 baseline (PR #21) |

**Hard requirement: pin `webgpu >= 0.6.2`.** Before 0.6.2 the Windows build had no DXC, so Dawn forced FXC; the PR that fixed it measured a compute rasterizer pass 44 to 51 times slower under FXC (1241 ms versus 28 ms) and intermittent `DXGI_ERROR_DEVICE_HUNG` (crbug.com/566251711). [SRC commit e996e2f, https://github.com/dawn-gpu/node-webgpu/commit/e996e2fb74d33f9317547131160d21381dfcca6e]

### 1.5 Node version compatibility (we run Node 26)

- No `engines` constraint; the addon is Node-API, which is ABI-stable across Node majors. Upstream CI builds and tests with **Node 24** only. README: Node 18+ is needed for building. [SRC build.yml] [DOC README]
- **UNVERIFIED on Node 26 specifically.** Expected to load unchanged; the local agent must run a smoke test (`requestAdapter`, compute dispatch, `mapAsync`, clean exit) on Node 26.11.
- `Promise.withResolvers` is polyfilled in upstream tests only for old Node; irrelevant on 26.

### 1.6 Known problems and required mitigations

| Problem | Evidence | Mitigation |
|---|---|---|
| **Process does not exit** while the object returned by `create()` is reachable (for example stored on `globalThis.navigator.gpu`). | README "Lifetime" section, crbug.com/387965810 [DOC] | Hold `gpu` in a scoped variable; on shutdown call `device.destroy()`, drop all references (`gpu = null`), and in the CLI finish with an explicit `process.exit(code)` after output is flushed. |
| **Busy polling.** While any async GPU promise is pending (`mapAsync`, `onSubmittedWorkDone`, pipeline-async, `popErrorScope`) the binding re-queues `wgpuInstanceProcessEvents` via `setImmediate` in a tight loop (TODO crbug.com/dawn/1127). One CPU core spins while you await GPU work. | [SRC `AsyncRunner.cpp`] | Accept it for CLI/tests. Do not run CPU-heavy work in the same thread expecting idle time. The `device.lost` promise does not keep the loop alive (`AsyncPolling::kNotRequired`). |
| **GC is not a memory manager.** Upstream's reference-count/GC test file is commented out of the test runner (`//await import('./tests/reference-count-tests.js')`), and it notes dawn.node "will likely crash" if GC ordering is wrong. | [SRC test/functional-tests.js, tests/reference-count-tests.js] | Call `.destroy()` on every texture/buffer/device explicitly, in a deterministic order (resources, then device). Never rely on finalizers to free VRAM. |
| `GPUDevice.destroy()` did not unmap buffers before 0.6.1. | [SRC index.js comment] | Pin >= 0.6.2; unmap before destroy anyway. |
| FXC-only on Windows before 0.6.2. | see 1.4 | Pin >= 0.6.2. Assert at startup that `adapter.features.has('shader-f16')` on D3D12 hardware; in Dawn that feature requires DXC, so its presence proves DXC is active. [SRC `PhysicalDeviceD3D12.cpp`] |
| Linux binaries of 0.5.0 to 0.6.1 need glibc 2.38. | commit edac7f5 (crbug.com/567909981) | Pin >= 0.6.2 (works on Ubuntu 22.04+; our 24.04 is fine either way). |
| Device loss (TDR, driver reset). `device.lost` resolves with `reason: 'unknown'`; a stale adapter yields an already-lost device. | [SRC GPUAdapter.cpp, GPUDevice.cpp] | Same recovery as the browser: new adapter, new device (section 4). |
| No persistent shader/pipeline cache. The binding passes no platform cache to Dawn. | [SRC GPU.cpp: instance created without a caching platform] **inference** | Every process start recompiles every pipeline. Keep pipeline count small in CLI runs; reuse one process for batch builds. |
| 137 MB package. | registry | If it is ever packaged into the Electron app, prune the other platforms' `dist/*` folders and keep `dawn.node` + DLLs outside asar (`asarUnpack`). |
| Limits are **not tiered** (unlike Chrome). | dawn.node never calls `SetUseTieredLimits`; Chrome does. [SRC] | Never compare limits between Node and Electron; always read `adapter.limits`. |

Worker threads: requesting adapters from several `worker_threads` simultaneously is covered by an upstream test (issue #13). Each worker calls `create()` itself. [SRC test/tests/worker-threads-tests.js]

### 1.7 Running with NO GPU (CI): exact setup

This is exactly what node-webgpu's own CI does (`WEBGPU_USE_CI_AVAILABLE_RENDERER=1` in its workflow, mapped in `test/webgpu.js`). [SRC]

| Runner | Software adapter | Setup | `create()` flags |
|---|---|---|---|
| `windows-latest` (Server 2025) | **WARP** = D3D12 adapter named "Microsoft Basic Render Driver" (part of Windows) | nothing to install | `['adapter=Microsoft']` |
| `ubuntu-latest` (24.04) | **lavapipe** (Mesa llvmpipe Vulkan ICD) | `sudo apt-get update && sudo apt-get install -y mesa-vulkan-drivers libvulkan1` | `['adapter=llvmpipe']` |

Facts behind this:
- Dawn's D3D backend enumerates WARP as an ordinary D3D12 adapter (`AdapterType::CPU`, set from `DXGI_ADAPTER_FLAG_SOFTWARE`). With DXGI ordering it is last, so on a GPU-less runner it is the only adapter. [SRC `d3d/PhysicalDeviceD3D.cpp`, `BackendD3D.cpp`]
- **`requestAdapter({ forceFallbackAdapter: true })` returns null on D3D** (the D3D backend returns no adapters for forced fallback), and on Vulkan it only accepts SwiftShader, which this package does not bundle. Do not use `forceFallbackAdapter` in dawn.node; select by name. [SRC `BackendD3D.cpp`, `BackendVk.cpp`]
- Upstream PR #20 states its Windows x64 tests ran on WARP; upstream added the lavapipe packages and `adapter=llvmpipe` in March 2026. [SRC commits]
- SwiftShader alternative (Linux or Windows): build or obtain a SwiftShader Vulkan ICD and set `VK_ICD_FILENAMES=/path/vk_swiftshader_icd.json` with `backend=vulkan`. [DOC Dawn node README] Not needed given WARP/lavapipe.
- WARP and lavapipe are CPU rasterizers. Keep CI terrains tiny (64 to 256 px), raise test timeouts, and never assert bit-identical results against the NVIDIA machines (see 5.9).
- **UNVERIFIED:** that Ubuntu 24.04's Mesa lavapipe passes every Dawn adapter requirement with `webgpu@0.6.2` (upstream runs it on 22.04), and the exact feature set WARP/lavapipe expose (`float32-filterable`, `texture-formats-tier2`). The probe in section 7 must run in CI and print features/limits.

Minimal CI job:

```yaml
jobs:
  engine-tests:
    strategy:
      fail-fast: false
      matrix: { os: [windows-latest, ubuntu-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26 }
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y mesa-vulkan-drivers libvulkan1
      - run: npm ci
      - run: npm test
        env: { OROGEN_GPU: software }     # our harness maps this to adapter=Microsoft / adapter=llvmpipe
```

```ts
// test/gpu.ts
const flags: string[] = [];
if (process.env.OROGEN_GPU === 'software') {
  if (process.platform === 'win32') flags.push('adapter=Microsoft');
  if (process.platform === 'linux') flags.push('adapter=llvmpipe');
} else if (process.env.OROGEN_ADAPTER) {
  flags.push(`adapter=${process.env.OROGEN_ADAPTER}`);   // e.g. NVIDIA
}
export const gpu = create(flags);
```

### 1.8 Version skew between dawn.node and Electron (must be handled in the engine)

| Capability | `webgpu@0.6.2` (Dawn 2026-10-02) | Electron 44 (Chromium 152) | Source |
|---|---|---|---|
| WGSL `linear_indexing` | yes | yes (shipped Chrome 147) | Chrome 147-148 notes |
| WGSL `buffer_view`, `swizzle_assignment` | yes | **no** (Chrome 153-154) | Chrome news index |
| WGSL `fragment_depth` | yes | **no** (Chrome 155-156) | same |
| `shader-f16` on Linux NVIDIA Vulkan | only with driver >= 615.71 | **no** (hard-blocked on NVIDIA in the 152 branch) | [SRC `PhysicalDeviceVk.cpp` main vs chromium/7977] |
| Limit tiering | off | on | [SRC] |
| Timestamp quantization | toggle default (on unless disabled) | on unless developer features enabled | [SRC] |

Rule: engine WGSL may only `requires` language features present in **both**; assert `navigator.gpu.wgslLanguageFeatures` at startup and fail loudly. Safe set (all <= Chrome 124): `readonly_and_readwrite_storage_textures`, `packed_4x8_integer_dot_product`, `unrestricted_pointer_parameters`, `pointer_composite_access`. Add a CI job that compiles every pipeline inside real Electron as well (Playwright `_electron.launch`), because Node-only tests cannot catch skew.

### 1.9 Alternatives if dawn.node proves inadequate

| Option | What it is | Assessment |
|---|---|---|
| Headless Electron as the test/CLI runtime | Run the same engine inside Electron (hidden window or worker) driven by Playwright `_electron` or a `--cli` mode of the app. | Zero skew with the product. On GPU-less CI needs SwiftShader: Electron ships `vk_swiftshader.dll` (Windows) and Chromium accepts `--use-webgpu-adapter=swiftshader` [SRC `service_utils.cc`]; **UNVERIFIED end to end**. Electron >= 44.1.0 required because of the SwiftShader preload fix (PR #53174). |
| Headless Chrome via Puppeteer/Playwright | README of node-webgpu itself recommends Puppeteer for browser-style testing. Flags from Chrome's own guide (2024): `--headless=new --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu`. | Good for CI on GPU runners; software path slower and fiddly. https://developer.chrome.com/blog/supercharge-web-ai-testing |
| Build `dawn.node` ourselves | `cmake -DDAWN_BUILD_NODE_BINDINGS=1` (+ `-DDAWN_USE_BUILT_DXC=ON` on Windows), 40 to 67 minutes per platform on GitHub runners per upstream PR. | Lets us pin Dawn to the Chromium 152 branch (`chromium/7977`) to remove skew. Worth it only if skew bites. |
| Deno | Built-in `navigator.gpu` on wgpu (not Dawn). | Different implementation (wgpu/Naga), so different shader compiler and limits: a second conformance target, not a substitute. Status/version in 2026 **UNVERIFIED**. |
| `@kmamal/gpu` | Community Dawn bindings for Node, pairs with `@kmamal/sdl` for windows. | Release cadence and current version **UNVERIFIED**; only relevant if a native window is needed. |

---

## 2. (b) Electron

### 2.1 Versions

- Stable: **44.7.0** (2026-10-07), Chromium 152.0.7977.130, Node 24.21.0. Electron 44.0.0 shipped 2026-08-25 with Chromium 152.0.7977.54, V8 15.2. [DOC https://www.electronjs.org/blog/electron-44-0, https://releases.electronjs.org/]
- Electron 45.0.0 stable is scheduled for **2026-10-20** with M156. 46 is planned for 2027-01-05 (M160). [DOC schedule]
- Electron 44 breaking changes that touch us: no prebuilt Windows ia32 or Linux armv7l binaries (x64 and arm64 only); ANGLE statically linked (no `libEGL.dll`/`libGLESv2.dll`); `clipboard` module removed from renderers; a Worker gets Node integration only if the frame that created it has it, so workers created by an `<iframe>` need `nodeIntegrationInSubFrames` (workers created by the top-level frame with `nodeIntegrationInWorker: true` are unaffected, which is the case option B in 2.7 relies on). Electron 42: the `electron` npm package no longer downloads its binary in `postinstall` (the package has no `scripts` field; it ships an `install-electron` bin). [DOC https://www.electronjs.org/docs/latest/breaking-changes]
  - *Corrected by the fact-check:* an earlier draft said "preload scripts run only in top-level frames". The real Electron 44 entry is narrower: it concerns `chrome-extension://` documents, which now receive preload scripts only when they are top-level or hosted by the DevTools front-end. It does not change preload behaviour for ordinary app windows.
- Use **>= 44.1.0**: it contains the fix for GPU-process failure when WebGPU falls back to SwiftShader on Windows (PR #53174, also 43.5.0 and 42.11.0). [DOC https://releases.electronjs.org/pr/53174]
- Windows dist of Electron 44 ships `d3dcompiler_47.dll`, `dxcompiler.dll`, `dxil.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`. Do not strip them when packaging. [SRC `script/zip_manifests/dist_zip.win.x64.manifest`, branch 44-x-y]

### 2.2 WebGPU status per OS (Chromium 152 = Electron 44)

| OS | Status | Backend | Source |
|---|---|---|---|
| Windows x64 | On by default since Chrome 113 | D3D12. DXC is used (hard-coded "enabled by default") when hardware supports Shader Model >= 6.0, otherwise FXC | wiki; [SRC `dawn_platform.cc`, `PhysicalDeviceD3D12.cpp` @7977] |
| Windows ARM64 | Behind `--enable-unsafe-webgpu` | D3D12 | wiki |
| macOS | On by default since 113 | Metal | wiki |
| Linux, **Wayland**, Intel Gen12+ with Mesa >= 22.0 | On by default since Chrome 144 | Vulkan, via "WebGPU on Vulkan via GL interop" | wiki; [SRC `software_rendering_list.json` entry 186] |
| Linux, **Wayland**, NVIDIA driver >= 535.183.01 | On by default since Chrome 147 | same | wiki; Chrome 147-148 notes; [SRC entry 186] |
| Linux, **X11**, any GPU | **Not on by default.** Flags required (2.3) | Vulkan | see below |

Why X11 is excluded [SRC, Chromium branch 7977]: `gpu_init.cc` disables the interop path unless the Ozone platform reports `webgpu_on_vulkan_via_gl_interop`; that property defaults to `false` (`ui/ozone/public/ozone_platform.h`) and only `ozone_platform_wayland.cc` sets it to `true`. The NVIDIA driver-version exception in the blocklist therefore helps only under Wayland.

Implementation status wiki (last edited 2026-10-02): https://github.com/gpuweb/gpuweb/wiki/Implementation-Status

**UNVERIFIED:** whether Electron's Linux build sets the `USE_WEBGPU_ON_VULKAN_VIA_GL_INTEROP` build flag at all (it is a Chromium build flag; Electron normally inherits it). Treat Linux as "flags always required" in our launcher.

### 2.3 Linux / X11 / NVIDIA proprietary driver: exact switches

Official recipe for "other" Linux configurations (wiki, 2026-10-02):

```
--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE
```

In Electron (must run before `app.whenReady()`; one `enable-features` call only, a second call replaces the first):

```ts
// main.ts
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('use-angle', 'vulkan');
  app.commandLine.appendSwitch('enable-features', 'Vulkan,VulkanFromANGLE');
}
```

What each does:
- `enable-unsafe-webgpu`: turns the WebGPU service on where it is off by default, sets Dawn safety level "unsafe" (skips the adapter blocklist, exposes experimental features, disables timestamp quantization). [SRC `service_utils.cc`, `webgpu_decoder_impl.cc` @7977]
- `enable-features=Vulkan` + `use-angle=vulkan` + `VulkanFromANGLE`: all of Chromium's GPU work runs on Vulkan, so WebGPU's Vulkan device needs no GL interop.
- `ozone-platform=x11`: pins X11 (also forces XWayland in a Wayland session).

Fallback ladder for the local agent if the recipe above misbehaves on the GTX 1660 Ti (each rung is **UNVERIFIED** on this machine; test in order and record `chrome://gpu`):
1. Recipe above.
2. Add `DefaultANGLEVulkan` to the feature list (issue title of https://github.com/gpuweb/gpuweb/issues/5022).
3. `--enable-unsafe-webgpu --enable-features=Vulkan` only (older documented recipe, Chrome troubleshooting page).
4. `--enable-unsafe-webgpu --enable-features=ForceEnableWebGpuInterop` (feature exists in `gpu_finch_features.cc` @7977; forces the interop path regardless of blocklist; the Ozone/X11 check may still veto it).
5. Run the app in a Wayland session with `--ozone-platform=wayland` and NVIDIA driver >= 535.183.01 (the configuration Chrome enables by default).

Diagnostics: load `chrome://gpu` in a `BrowserWindow`; check "WebGPU: Hardware accelerated" and the Dawn adapter list. From main: `app.getGPUFeatureStatus()` (valid after the `gpu-info-update` event) and `await app.getGPUInfo('complete')`. [DOC https://www.electronjs.org/docs/latest/api/app]

Driver note: NVIDIA Vulkan `shader-f16` is blocked in Chromium 152's Dawn and requires driver >= 615.71 in current Dawn. Chrome 155-156 release notes announce "f16 support on Linux for NVIDIA". [SRC] [DOC https://developer.chrome.com/blog/new-in-webgpu-155-156]

### 2.4 Forcing the discrete / high-performance GPU on Windows

**Corrected by the fact-check (2026-10-12). The earlier draft ranked `powerPreference` first; that is right for dawn.node and wrong for Electron on Windows.**

How it really works, per runtime:

- **dawn.node (headless):** `requestAdapter({ powerPreference: 'high-performance' })` works as expected. Dawn's D3D backend maps it to `DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE` and enumerates with `IDXGIFactory6::EnumAdapterByGpuPreference`; the binding takes the first adapter. [SRC `src/dawn/native/d3d/BackendD3D.cpp`, `src/dawn/node/binding/GPU.cpp`, Dawn main]
- **Electron / Chromium 152 on Windows:** the WebGPU adapter is **pinned to the adapter ANGLE (the compositor) already uses**. `CreatePreferredAdapter` queries ANGLE's D3D11 device and chains its LUID into the adapter request (`dawn::native::d3d::RequestAdapterOptionsLUID`), so `powerPreference` cannot move WebGPU to a different GPU. [SRC `gpu/command_buffer/service/webgpu_decoder_impl.cc` @7977] Chrome's own troubleshooting page says the same under "Windows-specific limitations": Chrome does not support several GPU adapters at once (chromium:329211593), so `powerPreference` has no impact in `requestAdapter()`, and the remedy is the `chrome://flags/#force-high-performance-gpu` flag. [DOC https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips, last updated 2025-10-17]
- The "discrete GPU by default on AC power" behaviour (HighPerformance on AC, LowPower on battery when the page passes no preference) is in the 7977 source without an OS guard, but it was announced for **dual-GPU macOS** (Chrome 115 notes); on Windows the LUID pin overrides it.

Levers for Electron on a multi-GPU Windows machine, most effective first:

1. **Move the whole GPU process to the discrete GPU.** Chromium 152 defines `force-high-performance-gpu` (hyphens) [SRC `gpu/config/gpu_switches.cc` @7977] and Chrome exposes it as `chrome://flags/#force-high-performance-gpu`; Electron's docs spell it `--force_high_performance_gpu` (underscores) [DOC command-line-switches]. Which spelling Electron 44 honours at run time is **UNVERIFIED: append both** before `app.whenReady()`.
2. **OS level:** Windows Settings > System > Display > Graphics lets the user pin a per-app GPU preference (general Windows behaviour, not re-verified here).
3. Still pass `powerPreference: 'high-performance'` in `requestAdapter()`: free, correct on macOS and in dawn.node, harmless on Windows.
4. **Do not use `use-webgpu-power-preference=force-high-performance` as a "hard override" on Windows.** Accepted values are `none`, `default-low-power`, `default-high-performance`, `force-low-power`, `force-high-performance` [SRC `service_utils.cc` @7977], but the `force-*` values only *filter*: with `force-high-performance` every adapter whose type is not `DiscreteGPU` is rejected. Combined with the LUID pin, a GPU process running on the integrated GPU would then find no hardware adapter (SwiftShader fallback or `null`), not the discrete card. [SRC `webgpu_decoder_impl.cc` @7977] Useful only as a diagnostic.

Target machine note: the i7-13700KF has **no integrated GPU** ("F" suffix; retailer spec sheets cite Intel ARK 230489), so the RTX 3080 is the only hardware adapter and none of this is needed there. The section matters only if Orogen is ever run on a hybrid-graphics laptop.

Always verify after device creation and refuse to run heavy jobs on a CPU adapter:

```ts
const info = adapter.info;                      // vendor, architecture, device, description, isFallbackAdapter
// with --enable-webgpu-developer-features (Chromium 152): also info.backend, info.type, info.driver,
// info.memoryHeaps, info.d3dShaderModel, info.vkDriverVersion, info.powerPreference   [SRC gpu_adapter_info.idl @7977]
```

### 2.5 Requesting maximum limits and features

Spec rule: a device only gets what `requiredLimits`/`requiredFeatures` ask for; everything else stays at the default even on a big GPU. Asking for more than `adapter.limits` rejects `requestDevice`. Adapters are single-use since Chrome 140 ("Device requests consume adapter"): request a fresh adapter for every device. [DOC spec; Chrome news index]

```ts
const WANT_LIMITS = [
  'maxTextureDimension2D', 'maxTextureArrayLayers',
  'maxBufferSize', 'maxStorageBufferBindingSize', 'maxUniformBufferBindingSize',
  'maxStorageTexturesPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxSampledTexturesPerShaderStage',
  'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupStorageSize', 'maxComputeWorkgroupsPerDimension',
  'maxBindingsPerBindGroup', 'maxColorAttachmentBytesPerSample',
] as const;

const WANT_FEATURES: GPUFeatureName[] = [
  'float32-filterable', 'float32-blendable',
  'texture-formats-tier1', 'texture-formats-tier2',
  'timestamp-query', 'bgra8unorm-storage',
  // deliberately NOT: 'shader-f16', 'subgroups' (not portable across our two runtimes, see 3.3)
];

async function createDevice(gpu: GPU) {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const requiredLimits: Record<string, number> = {};
  for (const k of WANT_LIMITS) requiredLimits[k] = adapter.limits[k];      // take the adapter maximum
  const requiredFeatures = WANT_FEATURES.filter(f => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
  return { adapter, device };
}
```

Engine minimums to assert (all satisfied by default limits, so the engine runs even where nothing can be raised): `maxTextureDimension2D >= 8192` (8129 fits), `maxStorageTexturesPerShaderStage >= 4`, `maxComputeInvocationsPerWorkgroup >= 256`.

### 2.6 Chromium switches useful to Orogen (all read from Chromium branch 7977 unless noted) [SRC]

| Switch | Effect |
|---|---|
| `enable-webgpu-developer-features` | Removes timestamp quantization; exposes `adapter.info.backend/type/driver/memoryHeaps/d3dShaderModel/vkDriverVersion`; enables `strictMath` on shader modules. Reasonable to ship in a desktop tool. |
| `disable-dawn-features=tiered_adapter_limits` | Reports raw adapter limits instead of Chrome's privacy buckets. This name is handled by Chromium itself (`webgpu_decoder_impl.cc` looks for it in the disabled-toggle list and calls `SetUseTieredLimits`); it is **not** a toggle in Dawn's `Toggles.cpp`, so it means nothing to dawn.node's `create()` (which never tiers anyway). |
| `enable-dawn-features=...` / `disable-dawn-features=...` | Dawn toggles for all WebGPU devices (for example `dump_shaders`). |
| `use-webgpu-adapter=swiftshader` | Force the SwiftShader Vulkan adapter (GPU-less CI). Other values: `default`, `d3d11`, `opengles`. |
| `use-webgpu-power-preference=force-high-performance` | Filter only; not a way to pick the discrete GPU on Windows. See 2.4. |
| `force-high-performance-gpu` | Whole GPU process on the high-performance GPU (Chromium 152 spelling; Electron docs use underscores). See 2.4. |
| `enable-dawn-backend-validation[=full|partial]` | D3D12 debug layer / Vulkan validation. |
| `gpu-watchdog-timeout-seconds=N` | Override GPU watchdog timeout (section 4). |
| `ignore-gpu-blocklist` | Ignore the software-rendering blocklist. |
| `disable-renderer-backgrounding` | Do not lower priority of hidden renderers (documented by Electron). |
| `disable-gpu-process-crash-limit`, `disable-domain-blocking-for-3d-apis` | Lift Chromium's "too many GPU crashes" lockouts (documented by toji.dev device-loss article; not re-read in source). |

### 2.7 Process model for heavy GPU compute

Facts:
- All renderers and workers share **one GPU process**. WebGPU calls are serialized over Dawn Wire to it. A GPU-process crash or kill loses every WebGPU device in the app and briefly blanks all windows. [DOC toji device-loss; Chromium architecture]
- WebGPU is exposed on `Window` and `Worker` (`GPUAdapterInfo` is `Exposed=(Window, Worker)` in Blink). `utilityProcess` is a Node environment started through Chromium's Services API; its docs describe no DOM/Blink, so **no `navigator.gpu` there**. [SRC idl] [DOC https://www.electronjs.org/docs/latest/api/utility-process]
- A hidden `BrowserWindow` is a full Blink context in a separate renderer process (Electron's documented "worker window" pattern). It gets its **own `GPUDevice`**, so it cannot share textures with the UI window; previews would need readback plus IPC. [DOC https://www.electronjs.org/docs/latest/tutorial/message-ports]
- Hidden/background throttling: `webPreferences.backgroundThrottling` (default true) and renderer backgrounding reduce timer and process priority. [DOC web-preferences, command-line-switches]
- Node in workers: `nodeIntegrationInWorker: true` works only when the renderer is not sandboxed (the doc's wording is that `sandbox` "must not be set to `true`"; since renderers are sandboxed by default, set `sandbox: false` explicitly). It is independent of `nodeIntegration`. All Node built-ins work in the worker, Electron modules do not, native addons in workers are strongly discouraged (`process.dlopen` is not thread-safe). Not available in Shared/Service workers. Since Electron 44 a worker created by an `<iframe>` gets Node only with `nodeIntegrationInSubFrames`; create the engine worker from the top-level frame. [DOC https://www.electronjs.org/docs/latest/tutorial/multithreading]

Options:

| Option | Zero-copy preview | UI thread free | Isolation from Chromium GPU process | Direct `fs` for export | Verdict |
|---|---|---|---|---|---|
| A. Engine on the renderer main thread | yes | no (JS scheduling competes with UI) | no | only with nodeIntegration/preload | simplest; acceptable for a first slice |
| **B. Engine in a dedicated Worker of the visible window, viewport via `OffscreenCanvas` transferred to the worker** | yes (same device renders the viewport) | yes | no | yes with `nodeIntegrationInWorker` | **recommended for the app** |
| C. Hidden `BrowserWindow` as compute host | no | yes | no (same GPU process) | yes | adds copies, gains nothing over B |
| D. `utilityProcess` (or child Node) running the headless engine on dawn.node | no (CPU readback) | yes | **yes** (own D3D12/Vulkan device, no GPU watchdog, no wire) | yes | **recommended for final "Build"/export jobs**; loading dawn.node inside Electron's utility process is **UNVERIFIED** (should work as Node-API; Electron bundles Node 24). A plain child process running system Node 26 or `ELECTRON_RUN_AS_NODE` is the fallback. |

Operational settings for long jobs in the app: `backgroundThrottling: false` on the window, `disable-renderer-backgrounding`, and `powerSaveBlocker.start('prevent-app-suspension')` during builds.

Cost to remember for option D: two devices compete for the same VRAM, and D recomputes the graph at export resolution rather than reusing preview results.

### 2.8 Moving 250 MB+ from GPU to disk

Facts:
- `ipcRenderer.send/invoke` serialize with the structured clone algorithm: the payload is **copied**. `ipcRenderer.postMessage(channel, msg, transfer)` can transfer **only `MessagePort`s**; ArrayBuffers are not zero-copy across processes. [DOC https://www.electronjs.org/docs/latest/api/ipc-renderer]
- `contextBridge` copies values across the isolation boundary ("copied and frozen"; cloneable types follow structured clone). [DOC https://www.electronjs.org/docs/latest/api/context-bridge]
- Sandboxed preload scripts can only `require` `electron` renderer modules, `events`, `timers`, `url`; **no `fs`**. `sandbox: false` gives the preload full Node. [DOC https://www.electronjs.org/docs/latest/tutorial/sandbox]
- Electron documents **no IPC message size limit**. The practical ceiling for one message is **UNVERIFIED**; do not design around a single 250 MB+ message.
- In Chromium, a `MAP_READ` mapping is already one copy (GPU process to renderer). `getMappedRange` throws `RangeError` only above `v8::TypedArray::kMaxByteLength`. [SRC `gpu_buffer.cc`]

Ranked approaches:

1. **Do not move it: strip readback and write in the process that mapped it.** In a worker with Node integration, write straight from the mapped range. No IPC, no extra copy.

```ts
// Worker with nodeIntegrationInWorker (or the headless engine). W=8129 r32float example.
const ROWS = 1024;                                   // 32 MiB strips
const bpr  = Math.ceil((W * 4) / 256) * 256;         // 32768
const staging = device.createBuffer({ size: bpr * ROWS, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const fd = fs.openSync(path, 'w');
for (let y = 0; y < H; y += ROWS) {
  const rows = Math.min(ROWS, H - y);
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture, origin: [0, y] }, { buffer: staging, bytesPerRow: bpr, rowsPerImage: rows }, [W, rows]);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, bpr * rows);
  const view = new Uint8Array(staging.getMappedRange(0, bpr * rows));
  for (let r = 0; r < rows; r++) fs.writeSync(fd, view, r * bpr, W * 4);   // drop row padding
  staging.unmap();
}
fs.closeSync(fd); staging.destroy();
```

2. **Run the export in the headless engine process** (option D): it owns the file handles; the renderer only sends the graph JSON and receives progress.
3. **Chunked IPC with backpressure** when the renderer must stay sandboxed: `await ipcRenderer.invoke('export:chunk', { id, offset, bytes })` with 8 to 32 MiB `Uint8Array` chunks; main appends with `FileHandle.write`. Two memcpy-class copies per chunk; awaiting each `invoke` bounds memory.
4. `MessagePort` between renderer and a utility process (ports are transferred once through main, then data bypasses main). Same copy cost as 3, keeps the main process idle.
5. File System Access API (`showSaveFilePicker`) or streaming `fetch` POST to a `protocol.handle` scheme: plausible, **UNVERIFIED** in Electron 44; avoid.

Never use `sendSync`, and never base64/JSON-encode pixel data.

### 2.9 Packaging for Windows in 2026

- Electron's docs recommend **Electron Forge** and mention other tools only generically; signing integration is documented for both Forge (`@electron/windows-sign`) and electron-builder. [DOC application-distribution, code-signing]
- **electron-builder** (`latest` = 26.15.3; newest 26.x = 26.17.0 under dist-tag `v26`): Windows `target` accepts `nsis` (default), `nsis-web`, `portable`, `appx`, `msix`, `msi`, `msi-wrapped`, `squirrel`, `7z`, `zip`, `tar.xz`, `tar.lz`, `tar.gz`, `tar.bz2`, `dir`. `forceCodeSigning` defaults to false. [DOC https://www.electron.build/docs/win] **Caveat found by the fact-check:** on 2026-10-12 that docs page describes the **v27 schema** (it states the v26 keys `win.signtoolOptions` / `win.azureSignOptions` "were removed" in favour of a single `win.sign` object and points to `electron-builder migrate-schema`). The target list above is therefore confirmed for v27 docs only; `zip` and `portable` are long-standing targets, but whether every listed name (for example `msix`) exists in 26.x is **UNVERIFIED**. With a 26.x pin, signing keys are the v26 ones; do not copy v27 `win.sign` snippets into a 26.x config. Confirm with one local build.
- **Electron Forge 8.0.1** (two weeks old on this date): `@electron-forge/maker-zip` works on every platform including win32; Windows installers via Squirrel.Windows and WiX MSI. There is no single-exe "portable" maker. [DOC https://www.electronforge.io/config/makers/zip] Details of Forge 8's breaking changes **UNVERIFIED**.
- Unsigned builds are allowed by both tools. Windows treats the app as unsigned and shows the corresponding warning dialogs; since June 2023 only EV-class certificates on hardware/cloud HSMs help, and Azure Artifact Signing (formerly Trusted Signing) is the cheapest route. Irrelevant for a tool the developer runs on his own machine. [DOC code-signing]
- `portable` (electron-builder) is a self-extracting single exe that unpacks on launch; `zip` is the plain app folder. For a 250 MB+ Electron app, `zip` starts faster and is easier to debug.

Recommendation: **electron-builder 26.x (exact pin, for example `26.17.0`; plain `npm i electron-builder` resolves to 26.15.3), targets `zip` + `portable`, x64 only, unsigned**, bundling with electron-vite 5 (5.0.0 on npm; needs Node `^20.19.0 || >=22.12.0`, peer `vite ^5 || ^6 || ^7`).

```jsonc
// package.json (excerpt)
"build": {
  "appId": "dev.orogen.app",
  "files": ["out/**"],
  "asarUnpack": ["**/*.node", "**/*.dll"],
  "win": { "target": [{ "target": "zip", "arch": ["x64"] }, { "target": "portable", "arch": ["x64"] }] }
}
```

```yaml
# .github/workflows/package-win.yml
jobs:
  package-win:
    runs-on: windows-latest            # Windows Server 2025 on 2026-10-12
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }   # electron tooling needs Node >= 22.12
      - run: npm ci
      - run: npm run build                        # electron-vite build
      - run: npx electron-builder --win --x64 --publish never
        env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" }
      - uses: actions/upload-artifact@v4
        with:
          name: orogen-win-x64
          path: |
            dist/*.zip
            dist/*.exe
```

---

## 3. (c) WebGPU capability facts

### 3.1 Limits: spec defaults versus what the two machines should report

Spec defaults: [DOC https://www.w3.org/TR/webgpu/#limits]. Chrome/Electron values are **[DERIVED]** from Dawn's backend code plus Chrome's limit tiers (`src/dawn/native/Limits.cpp`, identical on `main` and `chromium/7977`), and for Windows corroborated by web3dsurvey distributions (https://web3dsurvey.com/webgpu). Tiering lowers each limit group to the highest predefined tier the adapter fully satisfies.

| Limit | Spec default | RTX 3080, D3D12, Electron 44 (tiered) | GTX 1660 Ti, Vulkan, Electron 44 (tiered) | dawn.node (untiered) |
|---|---|---|---|---|
| `maxTextureDimension2D` | 8192 | **16384** (`D3D12_REQ_TEXTURE2D_U_OR_V_DIMENSION`, tier cap 16384) | 16384 expected (tier cap; driver value **UNVERIFIED**, 97% of Linux reports are >= 16384) | D3D12 16384; Vulkan = driver `maxImageDimension2D` (may be 32768) |
| `maxTextureArrayLayers` | 256 | 2048 | 2048 expected | same or driver value |
| `maxBufferSize` | 268,435,456 (256 MiB) | **2,147,483,648** (Dawn assumes 2 GiB on D3D12; 92% of Windows reports) | >= 1 GiB (100% of Linux reports); 2,147,483,648 or 4,294,967,292 expected, **UNVERIFIED** | D3D12 2,147,483,648; Vulkan = driver `maxBufferSize` |
| `maxStorageBufferBindingSize` | 134,217,728 (128 MiB) | **2,147,483,644** (2 GiB tiered to 2 GiB - 4; 99% of Windows reports) | 2,147,483,644 expected (Dawn clamps NVIDIA Vulkan to 2 GiB - 4 because of a driver bug, crbug 435684920) | D3D12 2,147,483,648; NVIDIA Vulkan 2,147,483,644 |
| `maxUniformBufferBindingSize` | 65,536 | 65,536 | 65,536 | 65,536 on D3D12 |
| `maxComputeWorkgroupsPerDimension` | 65,535 | **65,535** | 65,535 | 65,535 |
| `maxComputeInvocationsPerWorkgroup` | 256 | 1024 | 1024 expected | D3D12 1024 |
| `maxComputeWorkgroupSizeX / Y / Z` | 256 / 256 / 64 | 1024 / 1024 / 64 | 1024 / 1024 / 64 expected | D3D12 1024 / 1024 / 64 |
| `maxComputeWorkgroupStorageSize` | 16,384 | 32,768 | 32,768 expected | D3D12 32,768 |
| `maxStorageTexturesPerShaderStage` | 4 | **8** | **8** | 8 (Dawn hard cap `kMaxStorageTexturesPerShaderStage`) |
| `maxStorageBuffersPerShaderStage` | 8 | 16 (tiers 8/8/10/16) | 10 or 16 | 16 (hard cap `kMaxStorageBuffersPerShaderStage`) |
| `maxSampledTexturesPerShaderStage` | 16 | 48 expected (tiers 16/16/16/48) | 16 or 48 | 48 (hard cap `kMaxSampledTexturesPerShaderStage`) |
| `maxBindGroups` | 4 | 4 | 4 | 4 |
| `maxBindingsPerBindGroup` | 1000 | 1000 | 1000 | 1000 |
| `minUniformBufferOffsetAlignment` | 256 | 256 | 256 | driver value |

Consequences for 8129 x 8129 terrains:
- An 8129-wide texture fits the **default** `maxTextureDimension2D` (8192). No limit increase is needed for textures. 16384 leaves headroom for 16k later.
- One r32float layer as a **storage buffer** is 264,322,564 bytes: over the default 128 MiB binding limit. Textures have no such limit, which is one more reason to keep heightfields in textures.
- Dispatch grid: `ceil(8129/8) = 1017` workgroups per axis at 8x8 (1,034,289 groups), 509 at 16x16; far below 65,535.

### 3.2 Storage texture formats and access modes

Source: "Plain color formats" table of the spec source (`spec/index.bs`, CRD 2026-09-15). [DOC] Verified twice for the highlighted rows.

Legend: core = no feature needed; T1 = `texture-formats-tier1`; T2 = `texture-formats-tier2`; "-" = not allowed.

| Format | bytes/texel | write-only | read-only | read-write | Sample type | Notes |
|---|---|---|---|---|---|---|
| **`r32float`** | 4 | core | core | **core** | float if `float32-filterable`, else unfilterable-float | The only float format with core read-write. Blendable only with `float32-blendable`. |
| `r32uint`, `r32sint` | 4 | core | core | core | uint / sint | Masks, IDs, flow directions. |
| `rgba32float` | 16 | core | core | T2 | as r32float | |
| `rgba16float` | 8 | core | core | T2 | float | |
| `rgba8unorm` | 4 | core | core | T2 | float | Colour maps. |
| `rgba8snorm`, `rgba8uint`, `rgba8sint`, `rgba16uint`, `rgba16sint`, `rgba32uint`, `rgba32sint` | 4 / 8 / 16 | core | core | T2 (not `rgba8snorm`) | | |
| `rg32float`, `rg32uint`, `rg32sint` | 8 | core (not in compatibility mode) | core | **-** | | No read-write even with T2. |
| `r16float` | 2 | T1 | T1 | T2 | float | |
| `rg16float` | 4 | T1 | T1 | - | float | |
| `r8unorm` | 1 | T1 | T1 | T2 | float | |
| `rg8unorm`, `rgb10a2unorm`, `rg11b10ufloat`, `r8snorm`, `rg8snorm`, `rg8uint/sint`, `rg16uint/sint`, `rgb10a2uint` | | T1 | T1 | - | | |
| `r16unorm`, `rg16unorm`, `rgba16unorm` (+ snorm) | 2 / 4 / 8 | T1 | T1 | - | **unfilterable-float** | Format itself requires T1. |
| `r8uint/sint`, `r16uint/sint` | 1 / 2 | T1 | T1 | T2 | | |
| `bgra8unorm` | 4 | `bgra8unorm-storage` | - | - | | |
| `rgba8unorm-srgb`, `bgra8unorm-srgb` | | - | - | - | | Never storage. |

Do the tier features ship?
- Chrome 142 (2025-10-22) introduced both; requesting `texture-formats-tier2` implies tier1. [DOC https://developer.chrome.com/blog/new-in-webgpu-142] (That post's sample code misspells the name as `texture-format-tier1`; the spec enum is `texture-formats-tier1` / `texture-formats-tier2`.)
- Dawn D3D12 (branch 7977): tier1 is unconditional; tier2 is enabled when `R8_UNORM` supports typed UAV load and store (true on RTX-class hardware). Dawn Vulkan: both enabled when `shaderStorageImageExtendedFormats` and format checks pass (expected on NVIDIA desktop). [SRC]
- web3dsurvey (all platforms): tier1 93.3%, tier2 82.8%.

**Design rule:** keep single-channel float data in `r32float` so in-place read-write works everywhere with zero features. Treat tier2 (read-write `rgba16float`/`rgba32float`/`rgba8unorm`) as an optimization with a ping-pong fallback.

### 3.3 Optional feature status (2026-10)

| Feature | Shipped in Chrome | RTX 3080 / D3D12 / Electron 44 | GTX 1660 Ti / Vulkan / Electron 44 | Notes |
|---|---|---|---|---|
| `float32-filterable` | 119 | yes (unconditional on D3D12) | yes if the three float32 formats report linear filtering (expected) | 91.1% overall |
| `float32-blendable` | 132 | yes (unconditional) | expected | 89.4% |
| `timestamp-query` | 121 for pass-level timestamps | yes | yes if `timestampComputeAndGraphics` | Values quantized to 100 microseconds unless `enable-webgpu-developer-features` (or `enable-unsafe-webgpu`). 98.8% |
| `shader-f16` | 120 | yes (needs DXC, SM >= 6.2, native 16-bit ops) | **no** in Chromium 152; current Dawn needs NVIDIA driver >= 615.71 | Do not depend on it. 94.0% |
| `subgroups` | 134 | yes (needs DXC + wave ops) | likely, **UNVERIFIED** | 68.3%. Do not depend on it. |
| `texture-formats-tier1/2` | 142 | yes / yes | expected / expected | 3.2 |
| `bgra8unorm-storage` | early | yes | expected | |
| `subgroup-size-control` | 151-152 | yes with SM 6.6 | **UNVERIFIED** | |
| `texture-compression-unaligned` | 155-156 | not in Electron 44 | not in Electron 44 | |

Sources: Chrome "What's New in WebGPU" index https://developer.chrome.com/docs/web-platform/webgpu/news; [SRC `PhysicalDeviceD3D12.cpp`, `PhysicalDeviceVk.cpp` @chromium/7977]; https://web3dsurvey.com/webgpu.

### 3.4 `copyTextureToBuffer` / `copyBufferToTexture` layout rules

From `spec/sections/copies.bs` [DOC]:
- `bytesPerRow` **must be a multiple of 256** for buffer<->texture copies (not for `queue.writeTexture`).
- `bytesPerRow` is required when the copy has more than one row (height > 1 or depth > 1) and must be >= `width * bytesPerTexel`. `rowsPerImage` is required when depth > 1 and must be >= height.
- `offset` must be a multiple of the texel block size (4 for r32float).
- Required size: `offset + bytesPerRow * rowsPerImage * (depth - 1) + bytesPerRow * (height - 1) + width * bytesPerTexel <= buffer.size`.
- `copyBufferToBuffer`: `size`, `sourceOffset`, `destinationOffset` multiples of 4. `mapAsync`/`getMappedRange`: `offset` multiple of 8, `size` multiple of 4. A buffer created with `mappedAtCreation` needs a size multiple of 4.
- A `MAP_READ` buffer may only add `COPY_DST`; `MAP_WRITE` may only add `COPY_SRC`.

```ts
const align = (n: number, a: number) => Math.ceil(n / a) * a;
const bytesPerRow = align(width * bytesPerTexel, 256);
const bufferSize  = bytesPerRow * height;             // simple, multiple of 256
```

Worked numbers for 8129 x 8129 (66,080,641 texels) [DERIVED]:

| Format | Texture bytes | Unpadded row | `bytesPerRow` | Full readback buffer | Fits default `maxBufferSize`? |
|---|---|---|---|---|---|
| r32float / rgba8unorm | 264,322,564 | 32,516 | 32,768 | 266,371,072 | yes (limit 268,435,456), barely |
| r16float / r16unorm | 132,161,282 | 16,258 | 16,384 | 133,185,536 | yes |
| rgba16float | 528,645,128 | 65,032 | 65,280 | 530,661,120 | no: raise limit or use strips |
| rgba32float | 1,057,290,256 | 130,064 | 130,304 | 1,059,241,216 | no |

Strip readback: 1024 rows x 32,768 = 33,554,432 bytes (32 MiB) per strip; 8 strips for 8129 rows (7 full + 961 rows).

### 3.5 Practical mapping limits

- Spec: no mapping-specific size limit beyond `buffer.size`; failures surface as a rejected `mapAsync` or `RangeError`/`OperationError` from `getMappedRange`. [DOC]
- Chromium: `getMappedRange` rejects only above `v8::TypedArray::kMaxByteLength`; the real constraint is that mapping a read buffer copies the whole mapped range from the GPU process into renderer memory, so a 266 MB map costs 266 MB in each process. [SRC `gpu_buffer.cc`]
- dawn.node: the returned ArrayBuffer aliases driver-mapped memory and is detached on `unmap()`. [SRC `GPUBuffer.cpp`]
- Recommendation: map at most 32 to 64 MiB at a time; keep a ring of 2 or 3 reusable staging buffers; copy out and `unmap()` immediately.
- Dawn (2026-10-02) splits buffer<->texture copies on Intel GPUs whose row pitch exceeds 262,144 bytes or 16,384 texels; not relevant to NVIDIA but another reason not to rely on single giant copies. [SRC Dawn commit 77f9a9aa]

---

## 4. (d) Long-running compute, Windows TDR, device loss

### 4.1 The three timers that can kill a job

| Mechanism | Threshold | What happens | Source |
|---|---|---|---|
| **Windows TDR** (`TdrDelay`) | **2 s** default: the GPU must complete or be preempted from its current task within 2 s of the scheduler's preempt request | Driver reset; all video memory purged; apps get device-removed; screen flicker | https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery |
| `TdrDdiDelay` | 5 s | Threads stuck in the driver: bug check 0x116 | https://learn.microsoft.com/en-us/windows-hardware/drivers/display/tdr-registry-keys |
| `TdrLimitCount` / `TdrLimitTime` | 5 TDRs within 60 s | **Bug check (blue screen)** on the next one | same |
| **Chromium GPU watchdog** | 30 s Windows, 15 s Linux, 25 s macOS (Chromium 152); x2 for software rendering | GPU main thread unresponsive: GPU process killed, every WebGPU device in the app lost | [SRC `gpu/ipc/common/gpu_watchdog_timeout.h` @7977] |
| Chromium GPU crash limits | 2nd crash within 2 min: the page cannot get a new adapter; 3 within 2 min: all pages blocked; roughly 3 to 6 crashes in 5 min: GPU process no longer restarted | WebGPU unavailable until reload/restart | https://toji.dev/webgpu-best-practices/device-loss.html (2024-10-23) |

The registry keys are for driver development; Microsoft says applications and end users should not change them. Do not "fix" TDR by editing the registry.

Design consequences:
- Budget each **individual dispatch** far below 2 s. A dispatch cannot be assumed preemptible mid-flight.
- A TDR in our device also resets the user's Unreal Editor session on the same GPU. Treat TDR avoidance as a correctness requirement.
- Linux has no TDR, but the NVIDIA driver reports `VK_ERROR_DEVICE_LOST` on its own channel timeouts (thresholds **UNVERIFIED**). Same discipline applies.
- In Electron, synchronous `createComputePipeline` compiles in the GPU process on first use; a pathological compile could approach the watchdog timeout (**inference**). Always use the async variant.

### 4.2 Chunking rules

1. **Spatial tiling** for single-pass kernels: dispatch per tile with a tile origin in a uniform; guard out-of-range texels in the shader.
2. **Temporal batching** for iterative solvers (erosion steps): N iterations per submit, N adapted to measured time.
3. **Bound per-invocation work**: no per-texel loops whose trip count scales with terrain size (for example particle traces of unbounded length). Cap iterations with a constant and carry state to the next dispatch.
4. One `queue.submit()` per slice, then **`await device.queue.onSubmittedWorkDone()`** before submitting the next. Without the await, JS can enqueue minutes of GPU work in milliseconds: memory balloons in the GPU process, cancellation becomes impossible and the UI starves.
5. Slice targets: interactive preview 8 to 16 ms; background build 50 to 150 ms; hard ceiling 500 ms.
6. Calibrate per kernel: time a 256 x 256 tile once per device, derive ns/texel, pick the largest tile whose estimate is under the target. Re-calibrate after device loss or adapter change.

```ts
async function runIterations(device: GPUDevice, step: (enc: GPUCommandEncoder, i: number) => void,
                             total: number, opts: { targetMs: number; maxBatch?: number; signal?: AbortSignal }) {
  let batch = 1;
  for (let done = 0; done < total; ) {
    opts.signal?.throwIfAborted();
    const n = Math.min(batch, total - done);
    const enc = device.createCommandEncoder();
    for (let i = 0; i < n; i++) step(enc, done + i);          // one compute pass per iteration
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();                 // backpressure + timing
    const dt = Math.max(performance.now() - t0, 0.25);
    done += n;
    const scale = Math.min(2, Math.max(0.5, opts.targetMs / dt));   // grow/shrink at most 2x per step
    batch = Math.max(1, Math.min(opts.maxBatch ?? 256, Math.round(batch * scale)));
  }
}
```

Notes:
- Wall time around `onSubmittedWorkDone` includes queue and IPC latency; with `timestamp-query` use pass `timestampWrites` for true GPU time (resolve to a `QUERY_RESOLVE` buffer; `resolveQuerySet` destination offset must be a multiple of 256; read as `BigInt64Array` nanoseconds; counters can reset, so discard negative deltas). [DOC Chrome 121 notes; spec]
- `onSubmittedWorkDone` resolving also guarantees completion of earlier `mapAsync` calls on buffers last used on that queue. [DOC spec]
- In dawn.node, awaiting spins a core (1.6); fine.
- In a compute pass **each dispatch is its own usage scope**, so many dispatches with different bind groups can share one pass. [DOC spec "usage scopes"]

### 4.3 Device loss handling and recovery

Facts [DOC spec, explainer, toji device-loss]:
- `device.lost` is a promise that resolves once with `{ reason: 'destroyed' | 'unknown', message }`. Never `await` it inline (it normally never resolves).
- After loss every object from that device is dead; `mapAsync` rejects with `AbortError`; no further errors are raised from the device.
- `requestDevice` rejects only for invalid requests; other failures return an **already-lost device**. A used or stale adapter returns a lost device, so **always request a new adapter**.
- `requestAdapter()` returning `null` after a loss means the browser is blocking GPU access (crash limits): surface "restart the app".
- Test hooks: `device.destroy()` (reason `destroyed`; set your own "simulated" flag first), and in Chromium navigate a second window to `about:gpucrash` to kill the GPU process.

Recovery state machine for Orogen (the node graph is the source of truth; GPU textures are caches):

```ts
async function initGpu(isRecovery = false): Promise<void> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail(isRecovery ? 'GPU unavailable: restart Orogen' : 'WebGPU not supported');
  const device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
  device.lost.then(info => {
    if (info.reason === 'destroyed' && !simulatedLoss) return;       // intentional shutdown
    engine.onDeviceLost(info.message);                               // 1. abort running job, drop pool bookkeeping
    lossCount++;
    if (lossesWithin(120_000) > 2) return fail('GPU keeps resetting');    // stay under Chromium's and TDR's limits
    setTimeout(() => initGpu(true), 1000);                           // 2. rebuild
  });
  await engine.rebuild(device);   // 3. recreate pipelines (async), re-upload imported sources from CPU/disk,
                                  //    mark every node dirty, halve slice targets if the loss happened mid-job
}
```

Rules:
- Keep CPU-side or on-disk copies of every non-derivable input (imported heightmaps, painted masks). Derived node outputs are recomputed.
- After a loss during a job, retry once with `targetMs` halved and tile size halved; on a second loss stop and report which node was running.
- In Electron main, log `app.on('child-process-gone', (e, d) => ...)` when `d.type === 'GPU'` (`reason`: `crashed`, `killed`, `oom`, `launch-failed`, ...). [DOC app API]
- Consider `disable-domain-blocking-for-3d-apis` so one GPU crash does not lock WebGPU out of our own window; leave the crash limit itself in place.

---

## 5. (e) WGSL gotchas for simulation kernels

### 5.1 Reading textures in compute

- `textureSample`, `textureSampleBias`, `textureSampleCompare` and derivative builtins are **fragment-only** (shader-creation error elsewhere). In compute use `textureLoad` or `textureSampleLevel(t, s, uv, 0.0)`. [DOC WGSL]
- `textureLoad` on a sampled `texture_2d<f32>` takes a mip level: `textureLoad(t, vec2i, 0)`. On a storage texture there is no level argument: `textureLoad(t, vec2i)`; it always returns a 4-component vector (`r32float` gives `(r, 0, 0, 1)`).
- **Out-of-bounds `textureLoad` is not portable**: it may return any in-bounds texel or zeros. Out-of-bounds `textureStore` is not executed. Clamp/wrap coordinates yourself. [DOC WGSL, textureLoad/textureStore]
- Without `float32-filterable`, `r32float` has sample type `unfilterable-float`: binding it with a filtering sampler is a validation error; use a non-filtering sampler or `textureLoad`.
- Hardware bilinear filtering uses fixed-point weights (Vulkan exposes this as `subTexelPrecisionBits`; 8 fractional bits is typical, secondary sources only, **UNVERIFIED** per device). For heightfield resampling do bilinear/bicubic by hand from four `textureLoad`s; it is also identical across backends up to float rounding.
- `textureSampleLevel` uses normalized coordinates: `uv = (vec2f(p) + 0.5) / vec2f(dims)`.

### 5.2 Storage texture rules

- WGSL types: `texture_storage_2d<r32float, read | write | read_write>`. `read` and `read_write` need language feature `readonly_and_readwrite_storage_textures` (Chrome 124+); put `requires readonly_and_readwrite_storage_textures;` at the top. [DOC https://developer.chrome.com/blog/new-in-webgpu-124]
- Bind group layout: `storageTexture: { access: 'read-only' | 'write-only' | 'read-write', format, viewDimension }`; the view must have exactly **one mip level**; texture needs `STORAGE_BINDING` (a read-only storage binding does not need `TEXTURE_BINDING`). [DOC spec]
- Usage-scope rule (per dispatch): a texture subresource may be used either only for reading (sampled and/or read-only storage) **or** only as writable storage (write-only/read-write). The same mip of the same texture cannot be an input and an output in one dispatch unless it is a single `read_write` binding. Different mip levels or array layers are different subresources. [DOC spec "compatible usage list"]
- `read_write` is safe only when each invocation touches **its own texel** (point operations). If any invocation reads a texel another invocation writes in the same dispatch, the result is a data race and nondeterministic. Neighbourhood kernels (erosion, blur, flow) must ping-pong between two textures.
- `textureBarrier()` synchronizes only within a workgroup.
- Budget: 4 storage textures per stage by default, 8 on both target adapters; sampled textures have 16+ slots, so bind inputs as `texture_2d<f32>` when a kernel has many inputs.

### 5.3 Scatter writes and atomics

- Atomics exist only as `atomic<u32>` / `atomic<i32>` in storage buffers or workgroup memory. There are no float atomics and no atomic texture ops. Particle-style erosion that deposits into arbitrary cells must either accumulate fixed-point values in an `atomic<i32>` storage buffer (an 8129 x 8129 buffer is 264 MB and needs a raised binding limit, section 3.1) or be reformulated as a gather (grid/pipe model). Prefer gather formulations.

### 5.4 Bounds, robustness, zero-init

- Always guard: `if (any(gid.xy >= size)) { return; }`. Dawn's robustness clamps out-of-range **array/buffer** indices to the last element, so an unguarded edge invocation silently overwrites the last element.
- All variables are zero-initialized, including `var<workgroup>` arrays (per workgroup) and large function-local arrays (per invocation). Keep them small.
- Integer semantics are fully defined and identical everywhere (wrapping, division by zero defined); float-to-int conversion clamps.

### 5.5 Uniformity analysis

- Functions that need uniform control flow in compute: `workgroupBarrier`, `storageBarrier`, `textureBarrier`, `workgroupUniformLoad`, and subgroup builtins. Calling them inside a branch that depends on per-invocation data is a compile error. `textureSampleLevel`/`textureLoad` have no uniformity requirement. An out-of-bounds access invalidates uniformity assumptions. [DOC WGSL]

### 5.6 Override constants and pipeline cost

- `override` values are fixed at pipeline creation (`compute: { module, entryPoint, constants: { NAME: value } }`); they may appear in `@workgroup_size` and in array sizes of workgroup variables.
- Every distinct `constants` set is a new backend compile (WGSL to HLSL/SPIR-V, then DXC or the driver). Use overrides for a handful of structural variants (workgroup size, kernel radius class, format variant); use uniforms for node parameters the user drags.
- Cache pipelines by `hash(wgsl) + entryPoint + JSON(constants) + layout key`.
- Use **`createComputePipelineAsync`** everywhere: it resolves when the pipeline is ready and rejects with `GPUPipelineError`; the synchronous version stalls at first use. Use `getCompilationInfo()` on modules to show WGSL errors with line numbers.
- Chromium keeps a persistent Dawn blob cache (feature `WebGPUBlobCache`, enabled by default on Windows in Chromium 152 [SRC]); second launches are much faster. dawn.node has no persistent cache (1.6).
- Warm all node-kernel pipelines at startup in parallel with progress UI; compile lazily only for rarely used nodes.

### 5.7 D3D12 compile pitfalls (FXC versus DXC)

- Electron 44 on SM6+ hardware and `webgpu >= 0.6.2` both use **DXC**. FXC remains the fallback for pre-SM6 adapters or a missing `dxcompiler.dll`. [SRC]
- Under FXC, Dawn disables optimizations by default (miscompile risk), so generated code is slow at run time, and FXC compile times explode on long or nested loops and big constant arrays. Measured upstream: 44 to 51x slower execution plus `DXGI_ERROR_DEVICE_HUNG`. [SRC Toggles.cpp; node-webgpu PR #20]
- Chrome's numbers: DXC about 20% faster compute-shader compilation than FXC (Chrome 121); Tint IR up to 10x faster WGSL-to-HLSL (Chrome 136). [DOC]
- Detect and refuse: on a D3D12 adapter, absence of `shader-f16` strongly suggests FXC; warn the user. With developer features, `adapter.info.d3dShaderModel` reports the shader model.
- Even with DXC keep loops bounded by small constants, avoid deep `switch`/branch nests inside loops, split giant kernels into several passes.
- `strictMath` (shader module option, Chrome 131, behind `enable-webgpu-developer-features`, Metal and D3D only): when false the compiler may assume no NaN/Inf, treat -0 as +0, turn division into reciprocal multiply and reassociate. [DOC https://developer.chrome.com/blog/new-in-webgpu-131]

### 5.8 Layout traps

- `vec3f` in buffers has alignment 16 and size 12; `array<vec3f>` has stride 16. Use `vec4f` or scalars in structs shared with TypeScript.
- Uniform buffers follow stricter layout rules than storage buffers unless `uniform_buffer_standard_layout` is available (Chrome 144+); do not rely on it. Dynamic uniform offsets must be multiples of 256.
- `textureStore` always takes a `vec4`. `textureDimensions` returns unsigned vectors. No implicit conversion between `i32`, `u32`, `f32`.

### 5.9 Precision and determinism across backends

WGSL does not promise bit-identical floats [DOC WGSL "Floating Point Evaluation" and accuracy table]:
- `+`, `-`, `*`, `abs`, `floor`, `ceil`, `min`, `max`, `clamp` are correctly rounded; `/` is within 2.5 ULP; `inverseSqrt` 2 ULP; `exp`/`exp2` within `3 + 2|x|` ULP; `atan`/`atan2` up to 4096 ULP; many functions (`mix`, `dot`, `length`, `fract`, `fma`, `pow`, hyperbolics) inherit the accuracy of a reference expression.
- Implementations may reassociate and fuse (`a*b+c` may or may not become an FMA), may flush subnormals to zero, may ignore the sign of zero.
- **Finite math assumption:** implementations may assume no NaN/Inf/overflow at run time; a value that overflows becomes indeterminate, and `min`/`max` NaN tricks or `x != x` tests can be optimized away. Guard divisions and `sqrt`/`log` inputs explicitly.

Practical rules:
- Same machine, same driver, race-free kernel: reproducible. Different backend (D3D12 vs Vulkan vs WARP vs lavapipe) or driver: expect last-bit differences in arithmetic and larger ones in transcendentals; iterative simulations amplify them.
- Build noise from **integer hashes** (u32 arithmetic is exact everywhere) and convert to float at the end.
- Tests compare with tolerances (for example max abs error <= 1e-5 of range for single-pass kernels; statistical/structural metrics for long erosion runs). Golden bit-hashes are valid only per adapter+driver.
- Seeds, iteration counts and tile decomposition must not change results: make tiling invisible (identical maths at tile borders), otherwise chunk-size adaptation (4.2) would make outputs timing-dependent.

### 5.10 Kernel skeleton

```wgsl
requires readonly_and_readwrite_storage_textures;

// 32 bytes, alignment 4: origin @0, size @8, strength @16, three f32 pads @20/24/28.
// (Fact-check fix: the earlier draft padded with `_pad : vec3f`. vec3f aligns to 16, so that field
//  lands at offset 32 and the struct becomes 48 bytes with alignment 16, the exact trap 5.8 warns about.)
struct Params { origin : vec2u, size : vec2u, strength : f32, _pad0 : f32, _pad1 : f32, _pad2 : f32 }
@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var src : texture_2d<f32>;                         // input (sampled binding, read via textureLoad)
@group(0) @binding(2) var dst : texture_storage_2d<r32float, write>;     // output, a different texture

override WG : u32 = 8;

fn H(p : vec2i) -> f32 {                                                 // explicit edge policy
  let q = clamp(p, vec2i(0), vec2i(P.size) - 1);
  return textureLoad(src, q, 0).r;
}

@compute @workgroup_size(WG, WG)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let p = P.origin + gid.xy;
  if (any(p >= P.size)) { return; }                                      // tile + edge guard
  let c = vec2i(p);
  let h = H(c) + P.strength * (H(c + vec2i(1, 0)) + H(c - vec2i(1, 0)) + H(c + vec2i(0, 1)) + H(c - vec2i(0, 1)) - 4.0 * H(c));
  textureStore(dst, p, vec4f(h, 0.0, 0.0, 1.0));
}
```

---

## 6. (f) GPU texture pool and VRAM budgeting

### 6.1 Facts

- WebGPU exposes **no free/used VRAM query**. Allocation failure is reported as a `GPUOutOfMemoryError` through `pushErrorScope('out-of-memory')` / `uncapturederror`, or as device loss. OOM is inherently unpredictable because other applications share the GPU. [DOC spec; https://toji.dev/webgpu-best-practices/error-handling.html]
- Chromium with `enable-webgpu-developer-features` exposes `adapter.info.memoryHeaps` (heap sizes and properties, not current usage). [SRC idl @7977; DOC Chrome 121 notes]
- **Dawn D3D12 has a residency manager** (toggle `use_d3d12_residency_management`): it reads the DXGI budget (`QueryVideoMemoryInfo`), caps itself at 95% of it and evicts least-recently-used heaps when over budget. On Windows, over-commit therefore shows up first as paging and severe slowdown, and only fails with an OOM error when nothing more can be evicted. [SRC `ResidencyManagerD3D12.cpp`]
- Dawn Vulkan has no equivalent: on the Linux machine over-commit fails allocation (OOM error or device loss).
- Dawn lazily zero-clears a new texture on first use (toggle `lazy_clear_resource_on_first_use`) [SRC Toggles.cpp]; a compute pass writing through a storage binding cannot be proven to cover every texel, so expect a full clear on the first use of each newly created texture (**inference**). A recycled pool texture skips both allocation and clear, and therefore contains **stale data**.
- `texture.destroy()` / `buffer.destroy()` release memory deterministically (after pending GPU work completes). JS garbage collection does not respond to VRAM pressure.

### 6.2 Budget

```
texBytes(w, h, format, mips=1) = w * h * bytesPerTexel(format) * (mips > 1 ? 4/3 : 1), rounded up to 64 KiB
```

| Item at 8129 x 8129 | Bytes |
|---|---|
| r32float layer | 264 MB (252 MiB) |
| rgba8unorm colour map | 264 MB |
| rgba16float | 529 MB |
| rgba32float | 1,057 MB |

Default budget = **60% of dedicated VRAM**, user-adjustable (30 to 85%), because Unreal Editor will usually be running on the same card:

| Card | Dedicated VRAM | Default budget | Full-res r32float layers that fit |
|---|---|---|---|
| RTX 3080 | 10 GB | 6.0 GB | 22 |
| GTX 1660 Ti | 6 GB | 3.6 GB | 13 |

Arithmetic check (fact-check, 2026-10-12): one layer rounded up to 64 KiB is 264,372,224 bytes; 6.0e9 / 264,372,224 = 22.7 and 3.6e9 / 264,372,224 = 13.6, so 22 and 13 hold for **decimal** gigabytes. If the driver reports binary units (10,240 MiB and 6,144 MiB are the nominal figures for these cards; the actual reported totals are **UNVERIFIED**), 60% is 6,442,450,944 and 3,865,470,566 bytes, giving 24 and 14 layers. Do not hard-code the table: compute `floor(0.6 * measuredTotalBytes / texBytes)` from the value read at run time.

Getting "dedicated VRAM" without a WebGPU API:
1. Electron: `adapter.info.memoryHeaps` with developer features (largest device-local heap).
2. Both machines are NVIDIA: main process can run `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits` at startup and every few seconds during builds as an advisory signal (availability on PATH **UNVERIFIED** on the Windows machine).
3. Fallback: a small device-name table, else assume 4 GB.

### 6.3 Pool design

```ts
type Key = `${number}x${number}:${GPUTextureFormat}:${number /*usage*/}:${number /*mips*/}`;

class TexturePool {
  private free = new Map<Key, GPUTexture[]>();     // LIFO per key
  private lru: { tex: GPUTexture; key: Key; bytes: number; lastUsed: number }[] = [];
  private liveBytes = 0;                           // leased + free
  constructor(private device: GPUDevice, private budgetBytes: number) {}

  async acquire(desc: Desc): Promise<Lease> {
    const key = keyOf(desc);
    const hit = this.free.get(key)?.pop();
    if (hit) return this.lease(hit, key);
    const need = texBytes(desc);
    this.evictUntil(this.budgetBytes - need);                  // destroy LRU free textures first
    if (this.liveBytes + need > this.budgetBytes) throw new BudgetExceeded(need);   // caller falls back to tiling / lower res
    this.device.pushErrorScope('out-of-memory');
    let tex = this.device.createTexture(desc);                 // synchronous section only inside the scope
    const err = await this.device.popErrorScope();
    if (err) { tex.destroy(); this.evictAllFree(); throw new GpuOutOfMemory(need); }
    this.liveBytes += need;
    return this.lease(tex, key);
  }
  release(l: Lease) { /* push to free list, stamp lastUsed */ }
  trim(toBytes: number) { /* destroy LRU free entries until liveBytes <= toBytes */ }
  onDeviceLost() { this.free.clear(); this.lru.length = 0; this.liveBytes = 0; }   // objects are already dead
}
```

Rules:
1. **Key on exact (width, height, format, usage, mipLevelCount).** Terrain sizes are few (preview and build resolution), so exact-match buckets beat size classes.
2. **One usage superset for all pooled textures**: `STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST`. Add `RENDER_ATTACHMENT` only to a separate class if a raster pass needs it.
3. **Every node must write every texel of its outputs** (or explicitly clear). Stale data from the previous tenant is the classic pool bug. In debug builds fill released textures with a sentinel (NaN is unsafe under the finite-math assumption; use -1e30) to catch violations.
4. **Graph-level liveness, not ad hoc release.** Topologically sort the graph, reference-count each output by number of unexecuted consumers, release the lease when it reaches zero (unless the node is pinned for preview/caching). Compute the **peak** bytes for the schedule before running; if peak > budget, reorder (depth-first on the largest subtree), drop caches, then fall back to tiled evaluation. Report the estimate to the user up front.
5. **Two tiers of cache**: "required for current evaluation" (never evicted) and "result cache for unchanged upstream nodes" (LRU-evictable, cheap to recompute versus the cost of OOM).
6. **React to pressure**: on `GPUOutOfMemoryError` evict all free textures and retry once; on a second failure reduce the budget by 25% for the session and switch the job to tiled mode. On Windows also treat a sudden 5x slowdown of a calibrated kernel as "over budget" (residency thrash) and trim.
7. **Staging buffers** (readback/upload) are pooled separately, capped at 2 or 3 of 32 to 64 MiB, and destroyed after an export.
8. **Preview versus build pools**: preview resolution (512 to 2048) textures are tiny (1 to 16 MB per layer); keep them in their own budget slice (for example 512 MB) so a build cannot evict the interactive graph.
9. **Never wait for GC**: call `destroy()` when evicting; null out references in the same tick.
10. **Device loss**: drop all bookkeeping, do not call `destroy()` on dead objects in a loop that can throw, rebuild lazily.
11. Mips: allocate mip chains only for textures that are actually sampled minified (viewport colour); intermediates are single-level (also required for storage views).
12. Count the viewport: swapchain, depth, shadow and readback targets belong to the same budget.

Tiled build mode for graphs that exceed budget: evaluate in tiles of T x T plus a halo equal to the kernel's reach (for iterative erosion the halo grows with iterations, so tile only pure local nodes and keep global simulations full-frame at reduced layer count). This is an engine design topic; the platform fact is only that nothing in WebGPU prevents it (copies between textures of different sizes are cheap, `copyTextureToTexture` has no 256-byte row constraint).

---

## 7. Startup capability probe (run in Electron, in dawn.node, and in CI; log the JSON)

```ts
export async function probe(gpu: GPU) {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false };
  const L = adapter.limits, F = adapter.features, I = adapter.info as any;
  return {
    ok: true,
    info: { vendor: I.vendor, architecture: I.architecture, device: I.device, description: I.description,
            isFallbackAdapter: I.isFallbackAdapter, backend: I.backend, type: I.type, driver: I.driver,
            d3dShaderModel: I.d3dShaderModel, vkDriverVersion: I.vkDriverVersion, memoryHeaps: I.memoryHeaps },
    features: [...F].sort(),
    wgsl: [...gpu.wgslLanguageFeatures].sort(),
    limits: Object.fromEntries(['maxTextureDimension2D','maxTextureArrayLayers','maxBufferSize','maxStorageBufferBindingSize',
      'maxUniformBufferBindingSize','maxStorageTexturesPerShaderStage','maxStorageBuffersPerShaderStage',
      'maxSampledTexturesPerShaderStage','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX',
      'maxComputeWorkgroupSizeY','maxComputeWorkgroupSizeZ','maxComputeWorkgroupStorageSize',
      'maxComputeWorkgroupsPerDimension','maxBindGroups','maxBindingsPerBindGroup',
      'minUniformBufferOffsetAlignment','minStorageBufferOffsetAlignment'].map(k => [k, (L as any)[k]])),
    checks: {
      r32floatReadWrite: gpu.wgslLanguageFeatures.has('readonly_and_readwrite_storage_textures'),
      tier2: F.has('texture-formats-tier2'),
      float32Filterable: F.has('float32-filterable'),
      timestampQuery: F.has('timestamp-query'),
      dxcLikely: F.has('shader-f16'),            // on D3D12 this implies DXC
      softwareAdapter: I.isFallbackAdapter === true || /llvmpipe|SwiftShader|Basic Render/i.test(I.device + I.description),
    },
  };
}
```

Expected results to confirm or refute (file a correction to this report if any differ):

| Check | RTX 3080 / Win11 / Electron 44 | GTX 1660 Ti / Ubuntu X11 / Electron 44 with 2.3 flags | dawn.node 0.6.2 on either |
|---|---|---|---|
| `maxTextureDimension2D` | 16384 | 16384 | 16384 (D3D12) / driver value (Vulkan) |
| `maxBufferSize` | 2147483648 | >= 1073741824 | 2147483648 (D3D12) |
| `maxStorageBufferBindingSize` | 2147483644 | 2147483644 | 2147483648 (D3D12) / 2147483644 (NVIDIA Vulkan) |
| `maxStorageTexturesPerShaderStage` | 8 | 8 | 8 |
| `texture-formats-tier2` | present | present | present |
| `float32-filterable` | present | present | present |
| `shader-f16` | present | absent | present on D3D12; on Vulkan only with driver >= 615.71 |

---

## 8. Things I could not verify (do not hard-code)

1. `webgpu@0.6.2` on **Node 26** (only Node 24 is exercised upstream).
2. Exact Vulkan limits of the GTX 1660 Ti (raw `maxImageDimension2D`, `maxBufferSize`, compute workgroup limits) and which tier Electron reports.
3. Which Linux/X11 flag set actually works on the dev machine with the NVIDIA proprietary driver, and its stability with `--use-angle=vulkan`; whether Electron's Linux build includes the GL-interop build flag.
4. Feature set and limits of WARP and lavapipe under Dawn on current GitHub runners.
5. Whether `--force_high_performance_gpu` (Electron docs) or `--force-high-performance-gpu` (Chromium 152 source and `chrome://flags/#force-high-performance-gpu`) is the spelling Electron 44 honours; and, on a hybrid-graphics Windows laptop, which adapter ANGLE (and therefore WebGPU, see 2.4) ends up on.
6. Maximum practical single IPC message size in Electron 44.
7. Loading `dawn.node` inside an Electron `utilityProcess` (symbol clashes with Electron's own Dawn/absl are possible on Linux).
8. `--use-webgpu-adapter=swiftshader` working inside Electron on GPU-less runners.
9. Sub-texel precision of hardware bilinear filtering on these GPUs.
10. Contents of the two Chromium issues referenced by node-webgpu (387965810 process exit, 566251711 FXC hang): the tracker requires sign-in; facts were taken from the repo's README and commit messages instead.
11. Forge 8 breaking changes; electron-builder `zip` on Windows (listed in the config reference, missing from the targets guide).
12. Deno's and `@kmamal/gpu`'s 2026 status.
13. Location of Chromium's Dawn cache inside Electron's `userData`, and NVIDIA's Linux-side device-lost timeouts.

---

## 9. Primary sources

Spec and standards
- WebGPU CRD 2026-09-15: https://www.w3.org/TR/webgpu/ ; source https://github.com/gpuweb/gpuweb/blob/main/spec/index.bs and https://github.com/gpuweb/gpuweb/blob/main/spec/sections/copies.bs
- WGSL: https://www.w3.org/TR/WGSL/ ; source https://github.com/gpuweb/gpuweb/blob/main/wgsl/index.bs
- Implementation status (edited 2026-10-02): https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- Explainer: https://gpuweb.github.io/gpuweb/explainer/

Dawn (https://dawn.googlesource.com/dawn, `main` on 2026-10-12 and branch `chromium/7977`)
- `src/dawn/node/README.md`, `src/dawn/node/Module.cpp`, `src/dawn/node/binding/{GPU,GPUAdapter,GPUDevice,GPUBuffer,AsyncRunner,TogglesLoader,Flags}.cpp`, `src/dawn/node/interop/DawnExtensions.idl`
- `src/dawn/native/{Limits.cpp,Toggles.cpp,Instance.cpp,Adapter.cpp}`, `src/dawn/common/Constants.h`
- `src/dawn/native/d3d/BackendD3D.cpp`, `src/dawn/native/d3d/PhysicalDeviceD3D.cpp`, `src/dawn/native/d3d12/{PhysicalDeviceD3D12,ResidencyManagerD3D12}.cpp`
- `src/dawn/native/vulkan/{BackendVk,PhysicalDeviceVk}.cpp`

node-webgpu (https://github.com/dawn-gpu/node-webgpu, tag v0.6.2)
- `README.md`, `index.js`, `build/build.js`, `.github/workflows/build.yml`, `test/webgpu.js`, `test/functional-tests.js`, commits e996e2f (#20 DXC) and edac7f5 (#21 Ubuntu 22.04)
- npm registry document: https://registry.npmjs.org/webgpu

Chromium (https://chromium.googlesource.com/chromium/src, `refs/branch-heads/7977` = Chromium 152)
- `gpu/config/{gpu_switches.cc,gpu_finch_features.cc,gpu_util.cc,software_rendering_list.json}`
- `gpu/command_buffer/service/{service_utils.cc,webgpu_decoder_impl.cc,dawn_platform.cc}`
- `gpu/ipc/common/gpu_watchdog_timeout.h`, `gpu/ipc/service/gpu_init.cc`
- `ui/ozone/public/ozone_platform.h`, `ui/ozone/platform/wayland/ozone_platform_wayland.cc`
- `third_party/blink/renderer/modules/webgpu/{gpu_adapter_info.idl,gpu_buffer.cc}`

Chrome release notes
- Index: https://developer.chrome.com/docs/web-platform/webgpu/news
- 120, 121, 124, 131, 136, 142, 144, 145, 147-148, 151-152, 155-156: `https://developer.chrome.com/blog/new-in-webgpu-<n>`
- Troubleshooting: https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
- Headless testing: https://developer.chrome.com/blog/supercharge-web-ai-testing

Electron
- Releases and schedule: https://releases.electronjs.org/ , https://releases.electronjs.org/schedule
- Electron 44 blog: https://www.electronjs.org/blog/electron-44-0 ; breaking changes: https://www.electronjs.org/docs/latest/breaking-changes
- Docs: command-line-switches, ipc-renderer, context-bridge, message-ports, sandbox, multithreading, utility-process, app, web-preferences, code-signing, application-distribution under https://www.electronjs.org/docs/latest/
- PR #53174 (SwiftShader preload): https://releases.electronjs.org/pr/53174
- Dist manifest: https://github.com/electron/electron/blob/44-x-y/script/zip_manifests/dist_zip.win.x64.manifest

Packaging and CI
- electron-builder: https://www.electron.build/docs/win , https://www.electron.build/docs/targets
- Electron Forge: https://www.electronforge.io/ , https://www.electronforge.io/config/makers/zip
- GitHub runner images: https://github.com/actions/runner-images

Windows and best practices
- TDR: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery , https://learn.microsoft.com/en-us/windows-hardware/drivers/display/tdr-registry-keys
- Device loss: https://toji.dev/webgpu-best-practices/device-loss.html ; error handling: https://toji.dev/webgpu-best-practices/error-handling.html
- Field data: https://web3dsurvey.com/webgpu
- Node releases: https://nodejs.org/en/about/previous-releases

---

## Verification log

Independent fact-check performed 2026-10-12 by a second reviewer. Each claim was checked by fetching the primary source named in the row afresh, rather than by trusting the report's quotations; arithmetic was redone by hand. "Dawn main" means `github.com/google/dawn` `main` as fetched that day; "@7977" means Chromium `refs/branch-heads/7977` (Chromium 152) or Dawn `chromium/7977`. Nothing was run on hardware.

Limits of this pass: source files were read through a page-fetch tool that extracts the relevant passages, not by cloning the repositories, so identifiers and numbers are as that extraction returned them (large files were read in the relevant window only). Dawn `main` moves daily; rows marked "Dawn main" describe the tree on 2026-10-12, which is at or after the `77f9a9a` revision shipped in `webgpu@0.6.2`, not necessarily identical to it.

Status key: **CONFIRMED** (primary source read and agrees), **CORRECTED** (report edited in place; old -> new), **UNVERIFIABLE** (no primary source reached in this pass; treat as not confirmed).

### Corrected (5 edits of substance, 4 precision fixes)

| # | Claim (section) | Old -> new | Source |
|---|---|---|---|
| C1 | Forcing the discrete GPU on Windows (2.4, 2.6, 8) | Old: `requestAdapter({ powerPreference: 'high-performance' })` is the first lever in Electron, and `use-webgpu-power-preference=force-high-performance` is a "hard override". New: in Chromium 152 on Windows the WebGPU adapter is pinned to ANGLE's adapter (LUID chained via `RequestAdapterOptionsLUID`), so `powerPreference` has no effect there; `force-high-performance` only rejects non-discrete adapters and can leave no hardware adapter. The effective levers are `force-high-performance-gpu` for the whole GPU process, or the Windows per-app graphics setting. `powerPreference` does work in dawn.node. | `gpu/command_buffer/service/webgpu_decoder_impl.cc` @7977 (`CreatePreferredAdapter`, `CanUseAdapter`); https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips ("Windows-specific limitations", updated 2025-10-17); https://developer.chrome.com/blog/new-in-webgpu-115 (AC-power default announced for dual-GPU macOS) |
| C2 | Electron 44 breaking changes (2.1) | Old: "preload scripts run only in top-level frames". New: the entry applies only to `chrome-extension://` frames (preload only when top-level or DevTools-hosted). Also "64-bit only (no ia32)" reworded to what the doc says: no Windows ia32 and no Linux armv7l binaries. | https://www.electronjs.org/docs/latest/breaking-changes (44.0 section); https://www.electronjs.org/blog/electron-44-0 |
| C3 | WGSL kernel skeleton `Params` (5.10) | Old: `_pad : vec3f` (struct is 48 bytes, alignment 16, pad lands at offset 32). New: three `f32` pads (32 bytes, alignment 4). Recomputed by hand from WGSL alignment rules (vec2u: align 4 size 8; f32: align 4 size 4; vec3f: align 16 size 12). | WGSL alignment and size table, https://www.w3.org/TR/WGSL/ |
| C4 | electron-builder version (0, 2.9) | Old: "26.15.3 (latest)" presented as the current 26.x. New: `latest` = 26.15.3 (2026-06-09) but 26.17.0 (2026-09-26) exists under dist-tag `v26`; `next` = 27.0.0-alpha.10 (2026-10-08). Also noted that electron.build/docs/win now documents the v27 schema, so its target list and signing keys are not guaranteed for 26.x. | https://registry.npmjs.org/electron-builder (`dist-tags`, `time`); https://www.electron.build/docs/win |
| C5 | `tiered_adapter_limits` (2.6) | Old: listed as a Dawn toggle without qualification. New: it is a name Chromium intercepts itself; it does not exist in Dawn's `Toggles.cpp` and has no meaning for dawn.node. | `webgpu_decoder_impl.cc` @7977; `src/dawn/native/Toggles.cpp` (Dawn main) |
| P1 | Limit tier lists (3.1) | `maxStorageBuffersPerShaderStage` tiers 8/10/16 -> 8/8/10/16; `maxSampledTexturesPerShaderStage` tiers 16/16/48 -> 16/16/16/48. Resulting values unchanged. | `src/dawn/native/Limits.cpp` (Dawn main) |
| P2 | glibc floor of `webgpu@0.6.2` linux-x64 (1.4) | "needs glibc >= 2.35" -> "loads on Ubuntu 22.04+ (glibc 2.35 available); exact minimum not stated; 0.4.0 built on 22.04 needed 2.34". Added `GLIBCXX_3.4.32` to the 0.5.0-0.6.1 requirement. | commit edac7f5, https://github.com/dawn-gpu/node-webgpu/commit/edac7f5 |
| P3 | `nodeIntegrationInWorker` (2.7) | "requires `sandbox: false`" -> doc wording is "`sandbox` must not be set to `true`"; added the Electron 44 subframe-worker rule. | https://www.electronjs.org/docs/latest/tutorial/multithreading |
| P4 | VRAM budget table (6.2) | Table kept; added that 22 / 13 layers assume decimal GB, and that binary units give 24 / 14. Advice changed to compute from the measured total. | Recomputed: 264,322,564 -> 264,372,224 after 64 KiB rounding; 6.0e9 / 264,372,224 = 22.7; 6,442,450,944 / 264,372,224 = 24.4 |

### Confirmed

| # | Claim | Evidence read |
|---|---|---|
| 1 | `webgpu@0.6.2` is `latest`, published 2026-10-02T21:37Z; ESM (`type: module`, `main: index.js`, `types: types.d.ts`); deps `@webgpu/types ^0.1.72` + `debug ^4.4.0`; no `engines`/`os`/`cpu`; unpacked 137,491,009 bytes; published from Node 24.21.0 | https://registry.npmjs.org/webgpu and `/latest` |
| 2 | Release dates 0.3.9 (2026-03-18), 0.3.10 (03-19), 0.4.0 (03-27), 0.5.0 and 0.6.0 (08-28), 0.6.1 (09-12), 0.6.2 (10-02) | registry `time` object |
| 3 | Dawn submodule at tag v0.6.2 is commit `77f9a9a`; that commit is the Intel row-pitch copy-splitting workaround (262,144 bytes / 16,384 texels) | https://github.com/dawn-gpu/node-webgpu/tree/v0.6.2/third_party ; https://github.com/google/dawn/commit/77f9a9aa5f71 |
| 4 | `create()` flags must be `key=value`; error text "Flags expected argument format is <key>=<value>"; exports are `create` and `globals` | `src/dawn/node/Module.cpp` (Dawn main) |
| 5 | Flag keys `backend`, `adapter`, `validate` (`1` or `true`), `verbose`, env `DAWNNODE_BACKEND`; backend names `null`, `webgpu`, `d3d11`, `d3d12`/`d3d`, `metal`, `vulkan`/`vk`, `opengl`/`gl`, `opengles`/`gles`, lower-cased before matching; `adapter=` is a case-sensitive substring test on `adapterInfo.device`; first matching adapter wins; unknown backend / no match rejects with a list of available adapters | `src/dawn/node/binding/GPU.cpp` (Dawn main) |
| 6 | `enable-dawn-features=` / `disable-dawn-features=` comma lists | node-webgpu `README.md`; Dawn `src/dawn/node/README.md` |
| 7 | Default backend D3D12 on Windows, Vulkan on Linux, Metal on macOS (compile-time `kDefaultBackendType`) | `GPU.cpp` |
| 8 | Toggle names exist verbatim: `use_dxc`, `fxc_optimizations`, `d3d_disable_ieee_strictness`, `dump_shaders`, `dump_shaders_on_failure`, `disable_symbol_renaming`, `timestamp_quantization`, `disable_robustness`, `disable_workgroup_init`, `skip_validation`, `use_d3d12_residency_management`, `allow_unsafe_apis`, `vulkan_enable_f16_on_nvidia`, `lazy_clear_resource_on_first_use` | `src/dawn/native/Toggles.cpp` (Dawn main) |
| 9 | Build matrix: `windows-latest` -> `win32-x64`, `windows-11-arm` -> `win32-arm64`, `ubuntu-22.04` -> `linux-x64`, `ubuntu-22.04-arm` -> `linux-arm64`, `macos-latest` -> `darwin-universal`; Node 24; Windows SDK 26100; `WEBGPU_USE_CI_AVAILABLE_RENDERER=1`; apt installs `mesa-vulkan-drivers libvulkan1` | `.github/workflows/build.yml` (node-webgpu main) |
| 10 | CI software adapters: `adapter=Microsoft` on Windows, `adapter=llvmpipe` on Linux | `test/webgpu.js` (node-webgpu main) |
| 11 | `index.js` loads `dist/<platform>-<arch>/dawn.node` (`darwin-universal` on macOS) and wraps `GPUDevice.prototype.destroy` to unmap buffers first | `index.js` (node-webgpu main) |
| 12 | DXC commit e996e2f (#20): FXC 44-51x slower, 1241 ms vs 28 ms, `DXGI_ERROR_DEVICE_HUNG`, bug 566251711, `DAWN_USE_BUILT_DXC=ON`, `dxcompiler.dll` shipped beside `dawn.node`, job time 40 -> 67 min, Windows x64 tests ran on WARP | https://github.com/dawn-gpu/node-webgpu/commit/e996e2fb74d33f9317547131160d21381dfcca6e |
| 13 | Process-exit caveat and bug 387965810; no canvas / image / video integration; Puppeteer suggested for page testing; Node 18+ to build; bugs go to crbug.com/dawn | node-webgpu `README.md` |
| 14 | `forceFallbackAdapter` returns no adapters on D3D; on Vulkan only SwiftShader counts as fallback; D3D enumerates with `EnumAdapterByGpuPreference` and maps `HighPerformance` to `DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE` | `src/dawn/native/d3d/BackendD3D.cpp`, `src/dawn/native/vulkan/BackendVk.cpp` (Dawn main) |
| 15 | Busy polling: `wgpuInstanceProcessEvents` re-queued through `setImmediate` while tasks are pending; TODO crbug.com/dawn/1127; `AsyncPolling { kRequired, kNotRequired }` exists | `src/dawn/node/binding/AsyncRunner.cpp`, `AsyncRunner.h` |
| 16 | dawn.node never calls `SetUseTieredLimits`; "stub implementation" TODO crbug.com/dawn/1133; stale adapter -> device force-lost with reason Unknown | `src/dawn/node/binding/GPUAdapter.cpp` |
| 17 | Electron stable 44.7.0 (2026-10-07), Chromium 152.0.7977.130, Node 24.21.0; 45.0.0-beta.1 on Chromium 156.0.8078.12; 44.0.0 on 2026-08-25 with Chromium 152.0.7977.54, V8 15.2 | https://releases.electronjs.org/releases.json ; https://www.electronjs.org/blog/electron-44-0 |
| 18 | Electron 45 stable 2026-10-20 (M156); 46 stable 2027-01-05 (M160); 42 EOL 2026-10-20 | https://releases.electronjs.org/schedule |
| 19 | PR #53174 (SwiftShader preload) landed in 44.1.0, 43.5.0, 42.11.0 | https://releases.electronjs.org/pr/53174 |
| 20 | Windows dist ships `d3dcompiler_47.dll`, `dxcompiler.dll`, `dxil.dll`, `vk_swiftshader.dll`, `vk_swiftshader_icd.json`, `vulkan-1.dll` | `script/zip_manifests/dist_zip.win.x64.manifest`, branch 44-x-y |
| 21 | Node 26.11.1 released 2026-10-07, not LTS; 26.0.0 on 2026-05-05 | https://nodejs.org/dist/index.json |
| 22 | npm: `electron@44.7.0` needs Node >= 22.12.0 and has no `scripts`; `@electron-forge/cli@8.0.1` needs Node >= 22.13.0; `@webgpu/types@0.1.74`; `electron-vite@5.0.0` | registry `/latest` documents |
| 23 | `windows-latest` = Windows Server 2025, `ubuntu-latest` = Ubuntu 24.04 | https://github.com/actions/runner-images README |
| 24 | WebGPU spec status: W3C Candidate Recommendation Draft, 15 September 2026 | https://www.w3.org/TR/webgpu/ |
| 25 | Spec default limits: `maxTextureDimension2D` 8192, `maxTextureArrayLayers` 256, `maxBindGroups` 4, `maxBindingsPerBindGroup` 1000, `maxSampledTexturesPerShaderStage` 16, `maxStorageBuffersPerShaderStage` 8, `maxStorageTexturesPerShaderStage` 4, `maxUniformBufferBindingSize` 65536, `maxStorageBufferBindingSize` 134217728, `minUniformBufferOffsetAlignment` 256, `maxBufferSize` 268435456, `maxComputeWorkgroupStorageSize` 16384, `maxComputeInvocationsPerWorkgroup` 256, `maxComputeWorkgroupSizeX/Y/Z` 256/256/64, `maxComputeWorkgroupsPerDimension` 65535 | https://www.w3.org/TR/webgpu/#limits |
| 26 | Dawn tiers and caps: `maxTextureDimension2D` 4096/8192/16384; `maxTextureArrayLayers` 256/256/2048; `maxBufferSize` 256 MiB/256 MiB/1 GiB/2 GiB/4 GiB-4; `maxStorageBufferBindingSize` ... 1 GiB / 2 GiB-4 / 4 GiB-4; compute 128/256/1024; workgroup storage 16384/16384/32768/49152/65536; `maxStorageTexturesPerShaderStage` 4/4/8/8; caps `kMaxStorageTexturesPerShaderStage` 8, `kMaxStorageBuffersPerShaderStage` 16, `kMaxSampledTexturesPerShaderStage` 48; `kAssumedMaxBufferSize` 0x80000000 | `src/dawn/native/Limits.cpp`, `src/dawn/common/Constants.h` (Dawn main) |
| 27 | D3D12 backend limits: texture 2D from `D3D12_REQ_TEXTURE2D_U_OR_V_DIMENSION`, buffer and storage binding = `kAssumedMaxBufferSize` (2 GiB), uniform binding = `D3D12_REQ_CONSTANT_BUFFER_ELEMENT_COUNT * 16`, workgroup storage 32768, compute limits from `D3D12_CS_*` constants. Features: `float32-filterable`, `float32-blendable`, `texture-formats-tier1` unconditional; tier2 needs `R8_UNORM` typed UAV load+store; `shader-f16` needs built DXC + SM >= 6.2 + native 16-bit ops; `subgroups` needs wave ops and DXC | `src/dawn/native/d3d12/PhysicalDeviceD3D12.cpp` (Dawn main) |
| 28 | Vulkan backend: NVIDIA `maxStorageBufferBindingSize` clamped to 2 GiB - 4 (crbug 435684920); `shader-f16` on NVIDIA needs driver >= 615.71 on Dawn main and is refused outright at `chromium/7977` unless `vulkan_enable_f16_on_nvidia`; tier1/tier2 enabled together under `shaderStorageImageExtendedFormats` + format checks; `timestamp-query` needs `timestampComputeAndGraphics`; `float32-filterable` needs linear filtering on R32/RG32/RGBA32 float | `src/dawn/native/vulkan/PhysicalDeviceVk.cpp` (Dawn main and `chromium/7977`) |
| 29 | Storage-texture format table (3.2): 28 formats re-read; all access-mode cells, required features and byte footprints match (`r32float`/`r32uint`/`r32sint` core read-write; `rgba8unorm`/`rgba16float`/`rgba32float` read-write with tier2; `rg32*` no read-write; `bgra8unorm` write-only with `bgra8unorm-storage`) | `spec/index.bs`, gpuweb main, "Plain color formats" |
| 30 | Copy layout rules: `bytesPerRow` multiple of 256 for buffer copies; required when more than one row; `rowsPerImage` required when depth > 1; offset multiple of block footprint; required-bytes formula | `spec/sections/copies.bs`, gpuweb main |
| 31 | Buffer rules: `MAP_READ` only with `COPY_DST`, `MAP_WRITE` only with `COPY_SRC`; `mappedAtCreation` size multiple of 4; `mapAsync` and `getMappedRange` offset multiple of 8, size multiple of 4 | `spec/index.bs`, gpuweb main, GPUBuffer sections |
| 32 | Worked numbers for 8129 x 8129, recomputed by hand: 66,080,641 texels; r32float 264,322,564 bytes, row 32,516 -> 32,768, buffer 266,371,072 (exact minimum 266,370,820; fits 268,435,456); r16 132,161,282 / 16,258 -> 16,384 / 133,185,536; rgba16float 528,645,128 / 65,032 -> 65,280 / 530,661,120; rgba32float 1,057,290,256 / 130,064 -> 130,304 / 1,059,241,216; strips 1024 x 32,768 = 33,554,432, 7 full + 961 rows; dispatch ceil(8129/8) = 1017 (1,034,289 groups), ceil(8129/16) = 509; 252 MiB per r32float layer; preview 512^2 = 1 MiB, 2048^2 = 16 MiB | arithmetic |
| 33 | Chrome feature milestones: `float32-filterable` 119; `shader-f16` 120; timestamp queries in passes 121; DXC 121 (20% faster compute-shader compile); storage texture read access 124; DP4a / pointer features 123; `strictMath` 131 (developer flag, Metal and D3D); `float32-blendable` 132; subgroups 134; Tint IR on D3D12 136 (up to 10x); adapter consumed 140; texture format tiers 142 (2025-10-22, prose `texture-formats-tier1/2`, sample code missing the "s"); `uniform_buffer_standard_layout` 144; `linear_indexing` and Linux NVIDIA 147-148; `subgroup-size-control` 151-152; `buffer_view`, `swizzle_assignment` 153-154; `fragment_depth`, `texture-compression-unaligned`, NVIDIA Linux f16 155-156 | https://developer.chrome.com/docs/web-platform/webgpu/news and posts 115, 120, 121, 131, 136, 142, 144, 147-148, 155-156 |
| 34 | Timestamp quantization is 100 microseconds, removed by `enable-webgpu-developer-features` or unsafe mode; Dawn mask comment "~0.1ms" | Chrome 120 and 121 posts; `Constants.h`; `webgpu_decoder_impl.cc` @7977 |
| 35 | Linux: official recipe `--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE`; Intel Gen12+ default since 144; NVIDIA default on Wayland with driver >= 535.183.01 since 147; wiki edited 2026-10-02 | https://github.com/gpuweb/gpuweb/wiki/Implementation-Status |
| 36 | X11 exclusion mechanism: blocklist entry 186 (exceptions Intel gen >= 12 with Mesa >= 22.0, NVIDIA >= 535.183.01); `gpu_init.cc` disables the interop feature when the Ozone property is false; Wayland sets `webgpu_on_vulkan_via_gl_interop = true`, the X11 platform file does not; `ForceEnableWebGpuInterop` feature exists, disabled by default | `gpu/config/software_rendering_list.json`, `gpu/ipc/service/gpu_init.cc`, `ui/ozone/platform/wayland/ozone_platform_wayland.cc`, `ui/ozone/platform/x11/ozone_platform_x11.cc`, `gpu/config/gpu_finch_features.cc`, all @7977 |
| 37 | Chromium switch spellings and values: `enable-unsafe-webgpu`, `enable-webgpu-developer-features`, `enable-dawn-backend-validation` (empty/`full`/`partial`), `use-webgpu-adapter` (`default`, `d3d11`, `opengles`, `swiftshader`), `use-webgpu-power-preference` (five values), `enable-dawn-features`, `disable-dawn-features`, `gpu-watchdog-timeout-seconds`, `ignore-gpu-blocklist`, `force-high-performance-gpu` | `gpu/config/gpu_switches.cc`, `gpu/command_buffer/service/service_utils.cc` @7977 |
| 38 | `enable-unsafe-webgpu` sets safety level unsafe (blocklist skipped, quantization off); developer features set "safe experimental"; tiered limits on unless `tiered_adapter_limits` is disabled; SwiftShader = Vulkan backend with forced fallback | `webgpu_decoder_impl.cc` @7977 |
| 39 | `GPUAdapterInfo` developer-only attributes at Chromium 152: `driver`, `backend`, `type`, `memoryHeaps`, `d3dShaderModel`, `vkDriverVersion`, `powerPreference`; always present: `vendor`, `architecture`, `device`, `description`, `subgroupMinSize`, `subgroupMaxSize`, `isFallbackAdapter`; `Exposed=(Window, Worker)` | `third_party/blink/renderer/modules/webgpu/gpu_adapter_info.idl` @7977 |
| 40 | `WebGPUBlobCache` enabled by default on Windows (same macro as `WebGPUService`) | `gpu_finch_features.cc` @7977 |
| 41 | GPU watchdog: 30 s Windows, 25 s macOS, 15 s elsewhere; software-rendering factor 2 | `gpu/ipc/common/gpu_watchdog_timeout.h` @7977 |
| 42 | TDR: `TdrDelay` 2 s, `TdrDdiDelay` 5 s (bug check 0x116), `TdrLimitCount` 5 within `TdrLimitTime` 60 s, bug check on the sixth; keys are for driver development only; video memory purged on recovery | https://learn.microsoft.com/en-us/windows-hardware/drivers/display/tdr-registry-keys ; .../timeout-detection-and-recovery (both dated 2025-11-05) |
| 43 | Chrome GPU crash limits (second crash within two minutes blocks the page, third blocks all pages, "something like 3-6 times within 5 minutes" stops restarts); `about:gpucrash`; `--disable-domain-blocking-for-3d-apis`, `--disable-gpu-process-crash-limit`; lost-device and null-adapter behaviour | https://toji.dev/webgpu-best-practices/device-loss.html (updated 2024-10-23) |
| 44 | WGSL accuracy: `+ - *`, `abs`, `ceil`, `floor`, `min`, `max`, `clamp` correctly rounded; `/` 2.5 ULP; `inverseSqrt` 2 ULP; `exp`/`exp2` 3 + 2|x| ULP; `atan`/`atan2` 4096 ULP; `mix`, `dot`, `length`, `fract`, `fma`, `pow`, `sqrt` inherited; finite math assumption; reassociation and fusion allowed; subnormal flush | `wgsl/index.bs`, gpuweb main |
| 45 | WGSL built-ins: out-of-bounds `textureLoad` may return any in-bounds texel (or zero-like values), out-of-bounds `textureStore` is not executed; storage `textureLoad` has no level argument; `textureSample` is fragment-only; all synchronization functions are compute-only and need uniform control flow | `wgsl/index.bs`, gpuweb main |
| 46 | D3D12 residency manager: `kBudgetCap = 0.95`, budget from `QueryVideoMemoryInfo`, LRU eviction, gated by `use_d3d12_residency_management` | `src/dawn/native/d3d12/ResidencyManagerD3D12.cpp` (Dawn main) |
| 47 | Electron docs: sandboxed preload can require only `electron` renderer modules plus `events`, `timers`, `url` (no `fs`); IPC arguments use structured clone; `postMessage` transfers `MessagePort`s only; no documented message size limit; `--force_high_performance_gpu` and `--disable-renderer-backgrounding` documented; switches must be appended before `ready` | https://www.electronjs.org/docs/latest/tutorial/sandbox , /api/ipc-renderer , /api/command-line-switches |

### Unverifiable in this pass (still not confirmed; do not hard-code)

| # | Claim | Why |
|---|---|---|
| U1 | web3dsurvey percentages quoted in 3.1 to 3.3 (93.3%, 82.8%, 91.1%, and so on) | Not re-read; they are moving field statistics and nothing depends on them. |
| U2 | Chromium `getMappedRange` only throws above `v8::TypedArray::kMaxByteLength`, and a mapped read costs a full copy in each process (2.8, 3.5) | `gpu_buffer.cc` @7977 not read. |
| U3 | dawn.node mapped ArrayBuffer aliases driver memory and is detached on `unmap()` (3.5) | `GPUBuffer.cpp` not read. |
| U4 | WARP is reported as `AdapterType::CPU` and sorts last under DXGI ordering (1.7) | `PhysicalDeviceD3D.cpp` not read. Upstream CI selecting it with `adapter=Microsoft` is confirmed (row 10). |
| U5 | `device.lost` in dawn.node uses `AsyncPolling::kNotRequired` (1.6) | The enum exists (row 15); its use in `GPUDevice.cpp` was not read. |
| U6 | dawn.node has no persistent pipeline cache (1.6) | The report already marks this as inference. |
| U7 | Upstream reference-count tests are commented out of the test runner (1.6) | `test/functional-tests.js` not read. |
| U8 | `linear_indexing` "shipped Chrome 147" (1.8) | The release note covers 147-148 jointly; the exact milestone is not stated. |
| U9 | "DXC hard-coded enabled by default" in Chromium's `dawn_platform.cc` (2.2) | That file was not read; consistent with `PhysicalDeviceD3D12.cpp`, which defers to the platform feature `kWebGPUUseDXC` when SM >= 6.0. |
| U10 | All "expected" values for the GTX 1660 Ti, WARP and lavapipe (3.1, 3.3, 7) | Driver-dependent; need the section 7 probe on real hardware. |
| U11 | `utilityProcess` has no `navigator.gpu`; hidden-window and `contextBridge` details (2.7, 2.8) | Those Electron pages were not re-read. |
| U12 | Chrome headless flag recipe, Forge maker details, Intel ARK id, Deno and `@kmamal/gpu` status (1.9, 2.4, 2.9) | Not checked; none is load-bearing. |
| U13 | Which spelling of the force-high-performance switch Electron 44 honours at run time | Chromium 152 source defines only the hyphenated form; Electron's docs show underscores. Needs a run on a dual-GPU machine. |
| U14 | Whether every Windows target name on electron.build exists in electron-builder 26.x | The docs page describes v27 (see C4). |
