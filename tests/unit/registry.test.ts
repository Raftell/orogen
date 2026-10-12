// The registry lint over the product (testing.md section 4): for every category folder the rules about its
// files, its index and its tests, the rules on the text of its files and the rules on its definitions; across
// the product title-unique and test-location. The import rules are boundaries.test.ts. The rules themselves
// are src/core/graph/lint.ts, tested in lint.test.ts; this file reads the tree and imports the modules.
//
// Each category index is imported by its own test case, so a category that fails to load fails that case only.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NodeDef } from '../../src/core/api.ts';
import { lintCategory, lintNodes, lintTestLocations, type LintProblem } from '../../src/core/graph/lint.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATEGORIES = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref'] as const;

/** File name → text, for the files directly in a folder; empty when the folder does not exist. */
function textsOf(folder: string): Record<string, string> {
  const absolute = path.join(ROOT, folder);
  if (!existsSync(absolute)) return {};
  const texts: Record<string, string> = {};
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isFile()) texts[entry.name] = readFileSync(path.join(absolute, entry.name), 'utf8');
  }
  return texts;
}

/**
 * Fails with the first messages when there is a problem. The count is compared, not the list: a product-wide
 * list can be long, and the diff node:assert builds for a failed deepEqual grows with the square of its length.
 */
function noProblems(problems: readonly LintProblem[]): void {
  const shown = problems.slice(0, 25).map((p) => p.message);
  if (problems.length > shown.length) shown.push(`... and ${problems.length - shown.length} more`);
  assert.equal(problems.length, 0, `${problems.length} lint problems:\n${shown.join('\n')}`);
}

const load = (file: string): Promise<Record<string, unknown>> => import(pathToFileURL(path.join(ROOT, file)).href);

function walk(folder: string): string[] {
  return readdirSync(path.join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => {
    const child = `${folder}/${entry.name}`;
    return entry.isDirectory() ? walk(child) : [child];
  });
}

for (const category of CATEGORIES) {
  test(`${category}: files, index, tests, source and definitions`, async () => {
    const folder = `src/core/nodes/${category}`;
    const files = textsOf(folder);
    const index = (await load(`${folder}/index.ts`)).nodes;
    const defaults: Record<string, unknown> = {};
    for (const file of Object.keys(files)) {
      if (file.endsWith('.ts') && file !== 'index.ts' && !file.startsWith('_')) defaults[file] = (await load(`${folder}/${file}`)).default;
    }
    const problems = lintCategory({ category, files, defaults, index, tests: textsOf(`tests/nodes/${category}`) });
    noProblems(problems);
  });
}

test('title-unique: no two nodes of the product have the same title', async () => {
  const all: NodeDef[] = [];
  for (const category of CATEGORIES) {
    // A category that does not load is reported by its own case above.
    const nodes = await load(`src/core/nodes/${category}/index.ts`).then((module) => module.nodes, () => []);
    if (Array.isArray(nodes)) all.push(...(nodes as NodeDef[]));
  }
  noProblems(lintNodes(all));
});

test('test-location: every test file is in a folder that a layer of testing.md 8.1 runs', () => {
  noProblems(lintTestLocations(walk('tests')));
});
