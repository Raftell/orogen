// The type-check programs of runtime.md 8.4. One program has one set of libraries, so a folder that may use
// other globals than its neighbours is a program of its own. A source file that no program includes would be
// checked by nothing, and a program that `npm run check` does not run would check nothing.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Tsconfig {
  readonly extends?: string;
  readonly compilerOptions?: { readonly lib?: readonly string[]; readonly types?: readonly string[] };
  readonly include?: readonly string[];
}

/** A tsconfig file: JSON with whole-line comments. */
function readConfig(name: string): Tsconfig {
  const text = readFileSync(path.join(ROOT, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(text) as Tsconfig;
}

const configs = readdirSync(ROOT).filter((name) => /^tsconfig(\.[\w-]+)?\.json$/.test(name)).sort();

function sourceFiles(folder: string): string[] {
  return readdirSync(path.join(ROOT, folder), { withFileTypes: true }).flatMap((e) => {
    const rel = `${folder}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

test('npm run check runs every tsconfig of the repository root', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const runs = pkg.scripts.check!.split('&&').map((command) => command.trim());
  assert.deepEqual(runs, configs.map((name) => `tsc -p ${name}`).sort((a, b) => runs.indexOf(a) - runs.indexOf(b)));
});

test('every source file of src/ and tests/ belongs to a program', () => {
  // An include entry is a folder or a file, relative to the repository root.
  const includes = configs.flatMap((name) => readConfig(name).include ?? []).map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''));
  for (const entry of includes) assert.ok(!/[*?{]/.test(entry), `include "${entry}": this test reads folders and files, not patterns`);
  const orphans = [...sourceFiles('src'), ...sourceFiles('tests')].filter((file) => !includes.some((entry) => file === entry || file.startsWith(`${entry}/`)));
  assert.deepEqual(orphans, [], 'no tsconfig*.json includes these files: a folder with libraries of its own needs its own tsconfig (runtime.md 8.4) and its own "tsc -p" in the check script');
});

test('the core program has neither DOM nor Node types, and no other program includes core', () => {
  const core = readConfig('tsconfig.core.json');
  assert.deepEqual(core.include, ['src/core']);
  assert.deepEqual(core.compilerOptions?.lib, ['ES2024']);
  assert.deepEqual(core.compilerOptions?.types, ['@webgpu/types']);
  assert.ok(readdirSync(path.join(ROOT, 'src/core')).includes('globals.d.ts'));
  for (const name of configs.filter((n) => n !== 'tsconfig.core.json')) {
    for (const entry of readConfig(name).include ?? []) {
      assert.ok(entry !== 'src' && !entry.startsWith('src/core'), `${name} includes "${entry}": src/core/globals.d.ts would collide with that program's own globals`);
    }
  }
});
