// The import rules of the registry lint (testing.md section 4): import-node, import-src, import-tests and
// import-ext, found by scanning import specifiers. import-src is the "of src/" half of runtime.md 8.4, which no
// tsconfig can check, with the panel rule of 8.7 and the package rules of 1.1 and 8.4.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The packages src/core/ may import, and the one folder that may import them (runtime.md 8.4, 8.9). The integrator keeps this list. */
const CORE_PACKAGES: ReadonlySet<string> = new Set(['fast-png', 'geotiff', 'parse-exr']);
const CORE_PACKAGE_FOLDER = 'src/core/io/';

const RUNTIME = 'src/core/runtime.ts';
const API = 'src/core/api.ts';
const NODES = 'src/core/nodes/index.ts';
const ENTRY: readonly string[] = [RUNTIME, API, NODES];
const WORKER_NODE_MODULES: ReadonlySet<string> = new Set(['fs', 'path', 'zlib']);

type Target =
  | { readonly kind: 'file'; readonly path: string }        // a relative import, as a path from the repository root
  | { readonly kind: 'node'; readonly module: string }      // a Node built-in, without `node:` and without a subpath
  | { readonly kind: 'package'; readonly name: string };

function targetOf(file: string, specifier: string): Target {
  if (specifier.startsWith('.')) {
    return { kind: 'file', path: path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) };
  }
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (specifier.startsWith('node:') || builtinModules.includes(bare)) return { kind: 'node', module: bare.split('/')[0]! };
  const parts = specifier.split('/');
  return { kind: 'package', name: specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]! };
}

const under = (p: string, folder: string): boolean => p.startsWith(folder);
const segment = (file: string, prefix: string): string => file.slice(prefix.length).split('/')[0]!;

/** What a file of src/ may import of the repository, by the folder it is in. Null: the rule of that folder says nothing about files. */
function srcFileRule(file: string): ((target: string) => boolean) | null {
  if (under(file, 'src/core/nodes/') && file !== NODES) {
    const own = `src/core/nodes/${segment(file, 'src/core/nodes/')}/`;
    return (t) => t === API || under(t, own);
  }
  if (file === NODES) return (t) => t === API || /^src\/core\/nodes\/[a-z]+\/index\.ts$/.test(t);
  if (under(file, 'src/core/')) return (t) => under(t, 'src/core/') && !under(t, 'src/core/nodes/');
  if (under(file, 'src/viewport/')) return (t) => under(t, 'src/viewport/') || ENTRY.includes(t);
  if (under(file, 'src/export/')) {
    return (t) => under(t, 'src/export/') || ENTRY.includes(t) || (file === 'src/export/cli.ts' && under(t, 'src/platform/node/'));
  }
  if (under(file, 'src/platform/node/')) return (t) => under(t, 'src/platform/node/') || ENTRY.includes(t);
  if (under(file, 'src/cli/')) {
    return (t) => under(t, 'src/cli/') || ENTRY.includes(t) || under(t, 'src/platform/node/') || under(t, 'src/export/');
  }
  if (under(file, 'src/platform/electron/worker/')) {
    return (t) => under(t, 'src/platform/electron/worker/') || ENTRY.includes(t) || under(t, 'src/viewport/')
      || under(t, 'src/export/') || t === 'src/platform/node/files.ts';
  }
  if (under(file, 'src/platform/electron/')) return (t) => under(t, 'src/platform/electron/') || ENTRY.includes(t);
  if (under(file, 'src/app/panels/')) {
    const own = `src/app/panels/${segment(file, 'src/app/panels/')}/`;
    return (t) => under(t, own) || under(t, 'src/app/state/') || under(t, 'src/app/engine/') || under(t, 'src/app/ui/')
      || t === 'src/app/platform.ts' || t === RUNTIME || t === API;
  }
  if (under(file, 'src/app/')) return (t) => under(t, 'src/app/') || ENTRY.includes(t) || t === 'src/platform/electron/ipc.ts';
  return null;
}

/** The Node built-ins a file of src/ may import. Null: any. */
function nodeModulesFor(file: string): ReadonlySet<string> | null {
  if (under(file, 'src/core/') || under(file, 'src/viewport/') || under(file, 'src/app/')) return new Set();
  if (under(file, 'src/export/') || under(file, 'src/platform/electron/worker/')) return WORKER_NODE_MODULES;
  return null;
}

/** The rules one import breaks. Each message starts with the rule id and the file. Paths are relative to the repository root, with `/`. */
function check(file: string, specifier: string): string[] {
  const out: string[] = [];
  const fail = (rule: string, why: string): void => { out.push(`${rule} ${file}: imports "${specifier}": ${why}`); };
  const target = targetOf(file, specifier);

  if (target.kind === 'file' && !/\.(tsx?|css)$/.test(specifier)) fail('import-ext', 'a relative import has an explicit .ts or .tsx extension');
  if (target.kind === 'package' && target.name === 'webgpu' && file !== 'src/platform/node/gpu.ts') {
    fail(under(file, 'tests/') ? 'import-tests' : 'import-src', 'only src/platform/node/gpu.ts imports the webgpu package');
  }

  if (under(file, 'src/')) {
    if (target.kind === 'file' && under(target.path, 'tests/')) fail('import-tests', 'nothing in src/ imports from tests/');
    const inCategory = under(file, 'src/core/nodes/') && file !== NODES;
    const rule = inCategory ? 'import-node' : 'import-src';
    const allowed = srcFileRule(file);
    if (target.kind === 'file' && allowed && !under(target.path, 'tests/') && !allowed(target.path)) {
      fail(rule, inCategory ? 'a node file imports only ../../api.ts and files of its own folder' : 'not among the files this folder may import (runtime.md 8.4)');
    }
    if (target.kind === 'node') {
      const modules = nodeModulesFor(file);
      if (modules && !modules.has(target.module)) fail(rule, modules.size ? 'this folder uses node:fs, node:path and node:zlib only' : 'this folder uses no Node module');
    }
    if (target.kind === 'package' && under(file, 'src/core/')) {
      if (inCategory) fail(rule, 'a node file imports no package');
      else if (!CORE_PACKAGES.has(target.name)) fail(rule, 'not on the allow-list of packages for src/core/');
      else if (!under(file, CORE_PACKAGE_FOLDER)) fail(rule, `the decoder packages are imported in ${CORE_PACKAGE_FOLDER} only`);
    }
  }

  if (under(file, 'tests/')) {
    if (target.kind === 'file' && under(target.path, 'tests/helpers/') && !under(file, 'tests/helpers/') && target.path !== 'tests/helpers/index.ts') {
      fail('import-tests', 'the harness is imported through tests/helpers/index.ts only');
    }
    if (under(file, 'tests/nodes/')) {
      const category = segment(file, 'tests/nodes/');
      const ok = target.kind === 'node' ? specifier === 'node:test' || specifier === 'node:assert/strict'
        : target.kind === 'file' && (target.path === 'tests/helpers/index.ts' || target.path === API
          || under(target.path, `tests/nodes/${category}/`) || under(target.path, `src/core/nodes/${category}/`));
      if (!ok) fail('import-tests', "a node's test imports only node:test, node:assert/strict, the harness, api.ts and its own category");
    }
  }
  return out;
}

/** Every module specifier of a source text: static imports and re-exports, import(), require(). */
function specifiersOf(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  const patterns = [
    /(?:^|[;{}\s])(?:import|export)\s+(?:type\s+)?[\w*${}\s,]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
    /(?:^|[;{}\s])import\s*['"]([^'"\n]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const m of code.matchAll(pattern)) found.push(m[1]!);
  return found;
}

function sourceFiles(folder: string): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(ROOT, folder), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const rel = `${folder}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

test('specifiersOf finds every form of import and ignores comments', () => {
  const text = [
    "import a from './a.ts';",
    "import type { B } from '../b.ts';",
    "import {\n  c,\n  type D,\n} from 'pkg/sub';",
    "export { e } from './e.ts';",
    "export type * from './f.ts';",
    "import './side.ts';",
    "const g = await import('./g.ts');",
    "const h: import('./h.ts').H = require('node:fs');",
    "// import x from './commented.ts';",
    "/* import y from './block.ts'; */",
    "const text = `fn from(x: f32) -> f32 { return x; }`;",
  ].join('\n');
  assert.deepEqual(specifiersOf(text).sort(), ['../b.ts', './a.ts', './e.ts', './f.ts', './g.ts', './h.ts', './side.ts', 'node:fs', 'pkg/sub'].sort());
});

const CASES: readonly (readonly [file: string, specifier: string, rule: string | null])[] = [
  // import-ext
  ['src/core/gpu/pool.ts', './stream', 'import-ext'],
  ['src/core/gpu/pool.ts', './stream.js', 'import-ext'],
  ['src/core/gpu/pool.ts', './stream.ts', null],
  ['src/app/panels/graph/index.ts', './graph.module.css', null],
  // import-node
  ['src/core/nodes/filter/blur.ts', '../../api.ts', null],
  ['src/core/nodes/filter/blur.ts', './_wgsl.ts', null],
  ['src/core/nodes/filter/index.ts', './blur.ts', null],
  ['src/core/nodes/filter/blur.ts', '../../runtime.ts', 'import-node'],
  ['src/core/nodes/filter/blur.ts', '../../gpu/kernel.ts', 'import-node'],
  ['src/core/nodes/filter/blur.ts', '../adjust/levels.ts', 'import-node'],
  ['src/core/nodes/filter/blur.ts', 'node:fs', 'import-node'],
  ['src/core/nodes/filter/blur.ts', 'fast-png', 'import-node'],
  // import-src: core
  ['src/core/nodes/index.ts', './filter/index.ts', null],
  ['src/core/nodes/index.ts', '../api.ts', null],
  ['src/core/nodes/index.ts', './filter/blur.ts', 'import-src'],
  ['src/core/eval/context.ts', '../gpu/field.ts', null],
  ['src/core/api.ts', './nodes/index.ts', 'import-src'],
  ['src/core/eval/evaluator.ts', '../nodes/ref/fbm.ts', 'import-src'],
  ['src/core/session/session.ts', '../../export/build.ts', 'import-src'],
  ['src/core/session/session.ts', '../../platform/node/files.ts', 'import-src'],
  ['src/core/io/files.ts', 'node:fs', 'import-src'],
  ['src/core/io/files.ts', 'path', 'import-src'],
  ['src/core/io/png.ts', 'fast-png', null],
  ['src/core/io/tiff.ts', 'geotiff', null],
  ['src/core/eval/thumbnails.ts', 'fast-png', 'import-src'],
  ['src/core/graph/commands.ts', 'immer', 'import-src'],
  ['src/core/gpu/device.ts', 'webgpu', 'import-src'],
  ['src/core/session/session.ts', 'electron', 'import-src'],
  // import-src: the folders around core
  ['src/platform/node/gpu.ts', 'webgpu', null],
  ['src/platform/node/gpu.ts', '../../core/runtime.ts', null],
  ['src/platform/node/gpu.ts', '../../core/gpu/device.ts', 'import-src'],
  ['src/platform/node/cpu-worker.ts', '../../core/nodes/index.ts', null],
  ['src/platform/node/cpu-worker.ts', 'node:worker_threads', null],
  ['src/platform/node/files.ts', 'webgpu', 'import-src'],
  ['src/platform/node/files.ts', '../../export/folder.ts', 'import-src'],
  ['src/export/build.ts', '../core/runtime.ts', null],
  ['src/export/build.ts', './encode/png.ts', null],
  ['src/export/encode/png.ts', 'node:zlib', null],
  ['src/export/folder.ts', 'node:fs/promises', null],
  ['src/export/build.ts', 'node:worker_threads', 'import-src'],
  ['src/export/build.ts', '../platform/node/files.ts', 'import-src'],
  ['src/export/cli.ts', '../platform/node/files.ts', null],
  ['src/export/plan.ts', '../core/graph/params.ts', 'import-src'],
  ['src/cli/main.ts', '../export/cli.ts', null],
  ['src/cli/render.ts', '../platform/node/gpu.ts', null],
  ['src/cli/render.ts', '../core/eval/evaluator.ts', 'import-src'],
  ['src/cli/render.ts', '../app/main.tsx', 'import-src'],
  ['src/viewport/renderer.ts', '../core/runtime.ts', null],
  ['src/viewport/renderer.ts', '../core/gpu/pool.ts', 'import-src'],
  ['src/viewport/renderer.ts', 'node:fs', 'import-src'],
  ['src/platform/electron/worker/engine-worker.ts', '../../../viewport/renderer.ts', null],
  ['src/platform/electron/worker/engine-worker.ts', '../../../export/folder.ts', null],
  ['src/platform/electron/worker/engine-worker.ts', '../../node/files.ts', null],
  ['src/platform/electron/worker/engine-worker.ts', '../../node/gpu.ts', 'import-src'],
  ['src/platform/electron/worker/engine-worker.ts', 'node:fs', null],
  ['src/platform/electron/worker/engine-worker.ts', 'node:child_process', 'import-src'],
  ['src/platform/electron/main/main.ts', 'electron', null],
  ['src/platform/electron/main/main.ts', 'node:child_process', null],
  ['src/platform/electron/main/main.ts', '../ipc.ts', null],
  ['src/platform/electron/main/main.ts', '../../../app/main.tsx', 'import-src'],
  ['src/platform/electron/ipc.ts', '../../core/runtime.ts', null],
  // import-src: the interface
  ['src/app/main.tsx', '../core/nodes/index.ts', null],
  ['src/app/platform.ts', '../platform/electron/ipc.ts', null],
  ['src/app/platform.ts', '../platform/electron/main/main.ts', 'import-src'],
  ['src/app/engine/client.ts', '../../export/build.ts', 'import-src'],
  ['src/app/engine/client.ts', '../../viewport/renderer.ts', 'import-src'],
  ['src/app/state/doc-store.ts', 'node:fs', 'import-src'],
  ['src/app/state/doc-store.ts', 'immer', null],
  ['src/app/registry.ts', './panels/graph/index.ts', null],
  ['src/app/panels/graph/index.ts', '../../state/doc-store.ts', null],
  ['src/app/panels/graph/index.ts', '../../platform.ts', null],
  ['src/app/panels/graph/index.ts', '../../../core/api.ts', null],
  ['src/app/panels/graph/index.ts', '../../../core/nodes/index.ts', 'import-src'],
  ['src/app/panels/graph/index.ts', '../inspector/index.ts', 'import-src'],
  ['src/app/panels/graph/index.ts', '../../shell/keys.ts', 'import-src'],
  ['src/app/panels/graph/index.ts', '../../registry.ts', 'import-src'],
  // import-tests
  ['src/core/eval/evaluator.ts', '../../../tests/helpers/index.ts', 'import-tests'],
  ['tests/nodes/filter/blur.test.ts', 'node:test', null],
  ['tests/nodes/filter/blur.test.ts', 'node:assert/strict', null],
  ['tests/nodes/filter/blur.test.ts', '../../helpers/index.ts', null],
  ['tests/nodes/filter/blur.test.ts', '../../../src/core/nodes/filter/blur.ts', null],
  ['tests/nodes/filter/blur.test.ts', '../../../src/core/api.ts', null],
  ['tests/nodes/filter/unit/kernel.test.ts', '../../../../src/core/nodes/filter/_kernel.ts', null],
  ['tests/nodes/filter/blur.test.ts', '../../../src/core/runtime.ts', 'import-tests'],
  ['tests/nodes/filter/blur.test.ts', '../../../src/core/nodes/adjust/levels.ts', 'import-tests'],
  ['tests/nodes/filter/blur.test.ts', '../../helpers/stats.ts', 'import-tests'],
  ['tests/nodes/filter/blur.test.ts', 'node:fs', 'import-tests'],
  ['tests/nodes/filter/blur.test.ts', 'node:assert', 'import-tests'],
  ['tests/engine/pool.test.ts', '../helpers/engine.ts', 'import-tests'],
  ['tests/engine/pool.test.ts', '../helpers/index.ts', null],
  ['tests/engine/pool.test.ts', 'webgpu', 'import-tests'],
  ['tests/helpers/engine.ts', '../../src/platform/node/gpu.ts', null],
  ['tests/helpers/index.ts', './stats.ts', null],
];

test('the import rules, case by case', () => {
  for (const [file, specifier, rule] of CASES) {
    const broken = check(file, specifier);
    if (rule === null) {
      assert.deepEqual(broken, [], `${file} may import "${specifier}"`);
    } else {
      assert.ok(broken.length > 0, `${file} must not import "${specifier}"`);
      assert.ok(broken.some((m) => m.startsWith(`${rule} ${file}: `)), `expected ${rule}, got: ${broken.join(' | ')}`);
    }
  }
});

test('every import of src/ and tests/ obeys the rules', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('tests')];
  assert.ok(files.includes(API) && files.includes(RUNTIME) && files.includes(NODES), 'the entry modules of core exist');
  const broken = files.flatMap((file) => specifiersOf(readFileSync(path.join(ROOT, file), 'utf8')).flatMap((s) => check(file, s)));
  assert.deepEqual(broken, []);
});
