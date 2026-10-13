// The user documentation against the product (docs/user/): what is generated from the registry is what the
// registry gives today, and the example projects the pages build are projects this checkout opens, evaluates
// and builds. Neither needs a GPU, so the unit layer, and with it the `check` job of CI, fails as soon as a node
// changes and the page or an example does not.
//
// Sizes: the reference is a page of a few hundred kilobytes. It is compared line by line by a loop that
// reports the first difference; no text and no list of lines is handed to an assertion.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPlan } from '../../src/core/eval/plan.ts';
import { nodes } from '../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, previewResolution, serializeDoc } from '../../src/core/runtime.ts';
import { planBuild } from '../../src/export/plan.ts';
import { nodeReference, REFERENCE_FILE, referencePage } from '../../tools/node-reference.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(ROOT, 'docs', 'user', 'examples');
const registry = createRegistry(nodes);

/** Where two texts first differ, as a sentence; null when they are equal. */
function firstDifference(held: string, wanted: string): string | null {
  if (held === wanted) return null;
  const a = held.split('\n'), b = wanted.split('\n');
  const shown = (line: string | undefined): string => (line === undefined ? 'nothing: the text ends before it' : JSON.stringify(line.length > 160 ? `${line.slice(0, 160)}...` : line));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1} holds ${shown(a[i])} and the registry gives ${shown(b[i])}`;
  }
  return 'the two differ in their line ends';
}

test('docs/user/nodes.md is the reference the registry gives: what `tools/node-reference.ts --check` checks', () => {
  const file = path.relative(ROOT, REFERENCE_FILE);
  let held: string;
  try {
    held = readFileSync(REFERENCE_FILE, 'utf8');
  } catch {
    assert.fail(`${file} does not exist: run tools/guard node tools/node-reference.ts`);
  }
  const difference = firstDifference(held, nodeReference());
  assert.equal(difference, null, `${file} has fallen behind the nodes: ${difference}. Run tools/guard node tools/node-reference.ts and commit the page.`);
});

test('the reference says of every node its type, its ports and its parameters, and a changed node changes the page', () => {
  const page = nodeReference();
  const missing = registry.list().filter((def) => !page.includes(`<a id="${def.type.replace('/', '-')}"></a>\`${def.type}\``)).map((def) => def.type);
  assert.equal(missing.length, 0, `nodes the reference does not hold: ${missing.slice(0, 10).join(', ')}`);

  // The comparison above is one of texts: a parameter that gains a word of help is a different page.
  const defs = registry.list();
  const at = defs.findIndex((def) => def.params.length > 0);
  const edited = defs[at]!, param = edited.params[0]!;
  const changed = { ...edited, params: [{ ...param, help: `${param.help} Changed.` }, ...edited.params.slice(1)] } as typeof edited;
  const difference = firstDifference(referencePage(defs), referencePage(defs.with(at, changed)));
  // The line is that of the parameter's row; a long line is shown by its beginning.
  assert.match(difference ?? '', /^line \d+ holds "\| .*" and the registry gives "\| /);
  assert.ok(referencePage(defs.with(at, changed)).includes(`${param.help} Changed.`));
  assert.equal(firstDifference('a\nb\n', 'a\nb\n'), null);
  assert.equal(firstDifference('a\n', 'a\nb\n'), 'line 2 holds "" and the registry gives "b"');
  assert.equal(firstDifference('a', 'a\nb'), 'line 2 holds nothing: the text ends before it and the registry gives "b"');
});

const examples = readdirSync(EXAMPLES).filter((name) => name.endsWith('.orogen')).sort();

test('docs/user/examples holds the project the pages build', () => {
  assert.ok(examples.includes('ridge.orogen'), `the examples are ${examples.join(', ') || 'none'}`);
});

for (const name of examples) {
  test(`docs/user/examples/${name}: the project parses without a problem, every node can be evaluated, and it plans a build`, () => {
    const text = readFileSync(path.join(EXAMPLES, name), 'utf8');
    const { doc, problems } = parseDoc(text, registry);
    assert.deepEqual(problems.map((problem) => problem.message), [], 'what the loader reports: an unknown node type, a parameter the node no longer has, a value out of range');

    // The file is in the form the program writes: stored versions are those of the nodes, and nothing was migrated.
    const stale = Object.values(doc.nodes).filter((node) => node.version !== (registry.get(node.type)?.version ?? 1)).map((node) => node.id);
    assert.deepEqual(stale, [], 'nodes stored at another version than the registry has');
    assert.deepEqual(parseDoc(serializeDoc(doc), registry).problems, []);
    assert.ok(Number.isInteger(previewResolution(doc.settings)), 'the settings give a preview resolution');

    // Steps 1 and 2 of an evaluation (runtime.md 5.3), for every node: no unknown type, no missing input, no cycle.
    const targets = Object.values(doc.nodes).map((node) => ({ node: node.id }));
    assert.ok(targets.length > 0, 'the project has nodes');
    const failing = buildPlan(doc, registry, targets).nodes.filter((node) => node.error !== null).map((node) => `${node.nodeId}: ${node.error!.kind}: ${node.error!.message}`);
    assert.deepEqual(failing, [], 'nodes an evaluation would refuse');

    // The build the pages run with `orogen build`: the export nodes declare items the plan accepts.
    const plan = planBuild(doc, registry);
    assert.deepEqual(plan.problems.filter((problem) => problem.severity === 'error').map((problem) => `${problem.code}: ${problem.message}`), []);
    assert.ok(plan.ok && plan.items.length > 0 && plan.files.length > plan.items.length, `the plan has ${plan.items.length} items and ${plan.files.length} files`);
    assert.equal(plan.files.at(-1)!.encoding, 'json', 'the manifest is the last file of the plan');
  });
}
