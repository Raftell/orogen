// The tools of tests/tools/ where they decide something without a device: which paths a branch may change
// (testing.md 7.1; runtime.md 8.10), and what verify and expect refuse before they start anything.
//
// A tool that is started here ends at its usage check, with one exception: `verify --probe` opens the device
// the environment selects through the harness's getEngine and says what it is. This process opens none.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

import { foreignPaths, ownerOf, owns } from '../../tools/ownership.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Starts a tool and returns how it ended. `set` replaces variables of the environment; undefined removes one. */
function start(tool: string, args: readonly string[], set: Readonly<Record<string, string | undefined>> = {}): { readonly code: number | null; readonly out: string; readonly err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...set };
  delete env.NODE_TEST_CONTEXT;
  for (const [name, value] of Object.entries(set)) if (value === undefined) delete env[name];
  const done = spawnSync(process.execPath, [path.join('tests', 'tools', tool), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

test('a branch is named for its owner: a category, export, an application owner or core', () => {
  assert.deepEqual(ownerOf('nodes/filter/blur')?.name, 'nodes/filter');
  assert.deepEqual(ownerOf('nodes/simulate/erosion/second-try')?.name, 'nodes/simulate');
  assert.deepEqual(ownerOf('export/tiff')?.name, 'export');
  assert.deepEqual(ownerOf('ui/inspector/curve-editor')?.name, 'ui/inspector');
  assert.deepEqual(ownerOf('core/harness'), { name: 'core', paths: null, requests: null });
  for (const branch of ['main', 'filter/blur', 'nodes/filter', 'nodes/io/import', 'nodes/ref/blur', 'nodes/weather/rain', 'ui/shell', 'ui/menus/x', 'export', 'core', 'nodes//x', 'feature/nodes/filter/blur']) {
    assert.equal(ownerOf(branch), null, branch);
  }
});

test('a category owns its nodes, their tests and its change requests, and nothing else', () => {
  const filter = ownerOf('nodes/filter/blur')!;
  for (const path of ['src/core/nodes/filter/blur.ts', 'src/core/nodes/filter/_wgsl.ts', 'src/core/nodes/filter/index.ts', 'tests/nodes/filter/blur.test.ts', 'tests/nodes/filter/unit/kernel.test.ts', 'tests/nodes/filter/assets/a.png', 'docs/changes/filter-wider-blur.md']) {
    assert.equal(owns(filter, path), true, path);
  }
  // The node reference is generated from the registry: a change to a node brings the regenerated page with it.
  assert.equal(owns(filter, 'docs/user/nodes.md'), true);
  for (const path of ['docs/user/building.md', 'docs/user/examples/ridge.orogen', 'docs/user/nodes.md.bak']) assert.equal(owns(filter, path), false, path);
  assert.equal(owns(ownerOf('ui/shell/menu')!, 'docs/user/nodes.md'), false, 'an application owner changes no node');
  for (const path of [
    'src/core/nodes/adjust/levels.ts', 'src/core/nodes/index.ts', 'src/core/nodes/ref/blur.ts', 'src/core/api.ts', 'src/core/nodes/filter', 'tests/nodes/adjust/levels.test.ts',
    'tests/helpers/conformance.ts', 'tests/unit/registry.test.ts', 'docs/contract/testing.md', 'docs/changes/LOG.md', 'docs/changes/adjust-x.md', 'docs/changes/filter-.md',
    'docs/changes/filter/x.md', 'docs/changes/filtering-x.txt', 'package.json', 'src/core/nodes/filters/x.ts',
  ]) {
    assert.equal(owns(filter, path), false, path);
  }
});

test('a category two owners share by file is one owner to the tool: its private index modules are its own, the product index is not', () => {
  // nodes.md sections 1 and 4. The two agree among themselves which files are whose (testing.md 7.1).
  for (const [branch, paths] of [
    ['nodes/generate/basics', ['src/core/nodes/generate/_basics.ts', 'src/core/nodes/generate/_landforms.ts', 'src/core/nodes/generate/_noise-warp.ts', 'src/core/nodes/generate/index.ts', 'tests/nodes/generate/fractal-noise.test.ts']],
    ['nodes/simulate/hydrology/router', ['src/core/nodes/simulate/_hydrology.ts', 'src/core/nodes/simulate/_erosion.ts', 'src/core/nodes/simulate/_route.ts', 'src/core/nodes/simulate/_refine.ts', 'tests/nodes/simulate/unit/route.test.ts']],
  ] as const) {
    assert.deepEqual(foreignPaths(branch, [...paths]), [], branch);
    assert.deepEqual(foreignPaths(branch, ['src/core/nodes/index.ts', 'src/core/ops/resample.ts']), ['src/core/nodes/index.ts', 'src/core/ops/resample.ts'], branch);
  }
});

test('export, the application owners and the integrator own what the tables give them', () => {
  const exportOwner = ownerOf('export/tiff')!;
  for (const path of ['src/export/encode/png.ts', 'src/core/nodes/io/export-layer.ts', 'tests/nodes/io/import.test.ts', 'tests/export/unit/png.test.ts', 'unreal/OrogenBridge/x.cpp', 'docs/user/unreal-import.md', 'docs/changes/export-sink.md']) {
    assert.equal(owns(exportOwner, path), true, path);
  }
  for (const path of ['src/core/export-decl.ts', 'src/cli/main.ts', 'src/platform/node/files.ts', 'src/core/io/png.ts', 'docs/changes/ui-build-x.md']) assert.equal(owns(exportOwner, path), false, path);

  const owned: Readonly<Record<string, readonly string[]>> = {
    'ui/platform/ipc': ['src/platform/node/gpu.ts', 'src/platform/electron/main/main.ts', 'tests/ui/platform/smoke.test.ts', 'docs/changes/ui-platform-x.md'],
    'ui/state/undo': ['src/app/state/doc-store.ts', 'src/app/engine/client.ts', 'src/app/platform.ts', 'tests/ui/state/unit/undo.test.ts'],
    'ui/shell/menu': ['src/app/main.tsx', 'src/app/shell/theme.css', 'src/app/ui/scrub.tsx', 'tests/ui/shell/smoke.test.ts'],
    'ui/graph/wires': ['src/app/panels/graph/index.ts', 'tests/ui/graph/assets/recording.json'],
    'ui/viewport/camera': ['src/app/panels/viewport/index.ts', 'src/viewport/renderer.ts', 'tests/ui/viewport/x.test.ts'],
    'ui/inspector/fields': ['src/app/panels/inspector/index.ts'],
    'ui/library/search': ['src/app/panels/library/index.ts'],
    'ui/build/progress': ['src/app/panels/build/index.ts', 'docs/changes/ui-build-events.md'],
  };
  const everything = Object.values(owned).flat();
  for (const [branch, paths] of Object.entries(owned)) {
    assert.deepEqual(foreignPaths(branch, paths), [], branch);
    // What another application owner holds is not this one's.
    assert.deepEqual(foreignPaths(branch, everything), everything.filter((path) => !paths.includes(path)), branch);
  }
  for (const path of ['src/app/registry.ts', 'src/app/platform.tsx', 'src/core/session/session.ts']) assert.deepEqual(foreignPaths('ui/shell/menu', [path]), [path]);

  assert.deepEqual(foreignPaths('core/anything', [...everything, 'package.json', 'docs/contract/testing.md', 'src/core/nodes/filter/blur.ts']), [], 'the integrator changes frozen files');
  assert.deepEqual(foreignPaths('nodes/filter/blur', ['src/core/nodes/filter/blur.ts', 'package.json', 'tests/nodes/filter/blur.test.ts', 'tests/helpers/index.ts']), ['package.json', 'tests/helpers/index.ts']);
  assert.throws(() => foreignPaths('main', ['a']), /names no owner/);
});

test('ownership as a program: a branch that names no owner is refused before git is asked', () => {
  const refused = start('ownership.ts', ['--branch', 'feature/x']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /the branch "feature\/x" names no owner/);
  assert.equal(start('ownership.ts', ['--branches']).code, 2);
});

test('verify and expect refuse what they cannot start', () => {
  for (const args of [[], ['blur'], ['filter/blur', 'extra'], ['Filter/Blur']]) {
    const refused = start('verify.ts', args);
    assert.equal(refused.code, 2, args.join(' '));
    assert.match(refused.err, /usage: npm run verify -- <category>\/<name>/);
  }
  const absent = start('verify.ts', ['filter/no-such-node']);
  assert.deepEqual([absent.code, /src\/core\/nodes\/filter\/no-such-node\.ts does not exist/.test(absent.err)], [2, true]);

  const noGraph = start('expect.ts', ['no-such-graph']);
  assert.equal(noGraph.code, 2);
  assert.match(noGraph.err, /no project file "no-such-graph" in tests\/graphs\/ or at that path/);
  assert.equal(start('expect.ts', []).code, 2);
  assert.equal(start('expect.ts', ['x', '--resolution', '257']).code, 2);
});

test('the environment selects the device of the harness: core unless it says otherwise, and never a fallback', () => {
  // `verify --probe` is getEngine() in a process of its own, printing the profile and the adapter it got.
  const unset = start('verify.ts', ['--probe'], { OROGEN_GPU_PROFILE: undefined });
  assert.equal(unset.code, 0, unset.err);
  const device = JSON.parse(unset.out.split('\n').find((line) => line.startsWith('{'))!) as { adapter: string; software: boolean; profile: string; compactFormats: boolean };
  assert.equal(device.profile, 'core', 'the harness passes core explicitly: the factory\'s own default is max');
  assert.equal(device.compactFormats, false, 'a core device has no optional feature');
  assert.equal(unset.out.includes('[orogen] gpu'), false, 'opening a device prints nothing unless OROGEN_GPU_LOG asks for it');

  const logged = start('verify.ts', ['--probe'], { OROGEN_GPU_PROFILE: 'core', OROGEN_GPU_LOG: '1' });
  const line = logged.out.split('\n').find((text) => text.startsWith('[orogen] gpu '));
  assert.ok(line, 'with OROGEN_GPU_LOG=1 the capabilities are logged as one line');
  assert.equal((JSON.parse(line.slice('[orogen] gpu '.length)) as { compactFormats: boolean }).compactFormats, false);

  const wrong = start('verify.ts', ['--probe'], { OROGEN_GPU_PROFILE: 'fastest' });
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, /OROGEN_GPU_PROFILE is "fastest"; it is "core" or "max"/);

  // An adapter name that matches nothing fails with the factory's GpuUnavailableError (exit code 3 of the command line).
  const nobody = start('verify.ts', ['--probe'], { OROGEN_GPU_ADAPTER: 'no-adapter-has-this-name' });
  assert.equal(nobody.code, 3, nobody.err);
  assert.match(nobody.err, /No WebGPU adapter is available.*adapter "no-adapter-has-this-name" was asked for/);
});
