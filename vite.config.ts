// The application build (testing.md 8.2): `npm run build` writes dist/ from this one configuration.
//
//   dist/index.html, dist/assets/   the page, from src/app/index.html
//   dist/main.cjs                   the main process; package.json names it in "main"
//   dist/preload.cjs                the preload script
//   dist/engine-worker.js           the engine worker, a classic script that takes Node's modules with require()
//   dist/cpu-worker.js              the CPU worker, a classic script without Node
//
// `vite build` builds the page; the plugin below then builds the four scripts, each a bundle of its own with
// its own format. Every output has a source map.

import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { build, defineConfig, type InlineConfig, type Plugin } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

interface Script {
  readonly entry: string;
  readonly file: string;
  /** `cjs`: a Node script. `iife`: a classic worker script. */
  readonly format: 'cjs' | 'iife';
  /** The modules left to the environment. In a worker each becomes a `require` call (runtime.md 8.3). */
  readonly external: readonly (string | RegExp)[];
}

/** The only Node modules the engine worker uses (runtime.md 8.3). */
const WORKER_NODE_MODULES = ['node:fs', 'node:path', 'node:zlib'];

/**
 * Fails a worker's build when a file of this repository imports a Node module the worker may not use. Left to
 * itself the bundler replaces such a module with an empty object and says so in a warning: the script would be
 * built, and would fail where it runs.
 */
function nodeModules(script: Script): Plugin {
  const allowed = new Set(script.external.filter((id): id is string => typeof id === 'string'));
  return {
    name: 'orogen:node-modules',
    enforce: 'pre',
    resolveId(source, importer) {
      const builtin = source.startsWith('node:') || builtinModules.includes(source.split('/')[0]!);
      if (!builtin || allowed.has(source) || importer === undefined || importer.includes('/node_modules/')) return null;
      const may = allowed.size > 0 ? `of Node's modules only ${[...allowed].join(', ')}` : 'no module of Node';
      this.error(`${path.relative(ROOT, importer)} imports "${source}": dist/${script.file} uses ${may} (runtime.md 8.3, 8.4)`);
    },
  };
}

const SCRIPTS: readonly Script[] = [
  { entry: 'src/platform/electron/main/main.ts', file: 'main.cjs', format: 'cjs', external: ['electron', /^node:/] },
  { entry: 'src/platform/electron/preload/preload.ts', file: 'preload.cjs', format: 'cjs', external: ['electron', /^node:/] },
  { entry: 'src/platform/electron/worker/engine-worker.ts', file: 'engine-worker.js', format: 'iife', external: WORKER_NODE_MODULES },
  { entry: 'src/platform/electron/worker/cpu-worker.ts', file: 'cpu-worker.js', format: 'iife', external: [] },
];

function scriptConfig(script: Script): InlineConfig {
  const globals = Object.fromEntries(script.external.filter((id): id is string => typeof id === 'string').map((id) => [id, `require(${JSON.stringify(id)})`]));
  return {
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    plugins: script.format === 'iife' ? [nodeModules(script)] : [],
    // A library build leaves this to the consumer; these scripts are the consumer.
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: DIST,
      emptyOutDir: false,
      copyPublicDir: false,
      sourcemap: true,
      // Readable stacks in the engine's error details; the size of a script on disk does not matter here.
      minify: false,
      target: 'esnext',
      reportCompressedSize: false,
      lib: { entry: path.join(ROOT, script.entry), formats: [script.format], name: 'orogen', fileName: () => script.file },
      rolldownOptions: {
        external: [...script.external],
        output: script.format === 'iife' ? { globals } : {},
      },
    },
  };
}

/** Builds the scripts once the page is written. */
function scripts(): Plugin {
  let written = false;
  return {
    name: 'orogen:scripts',
    apply: 'build',
    writeBundle() {
      written = true;
    },
    async closeBundle() {
      // Not after a page build that failed: its error is the one to read.
      if (!written) return;
      for (const script of SCRIPTS) {
        await build(scriptConfig(script));
        this.info(`built dist/${script.file}`);
      }
    },
  };
}

export default defineConfig({
  root: path.join(ROOT, 'src/app'),
  // The page is loaded from a file: every reference is relative to it.
  base: './',
  plugins: [react(), scripts()],
  build: {
    outDir: DIST,
    emptyOutDir: true,
    sourcemap: true,
    target: 'esnext',
    reportCompressedSize: false,
  },
});
