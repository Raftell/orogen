// The catalogue of the library (src/app/panels/library/catalog.ts): which nodes it lists, how it groups them,
// what it says of their ports, the rows of the list and the keys that move through them. No window.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry } from '../../../../src/core/runtime.ts';
import {
  catalogOf, catalogRows, CATEGORIES, categoryTitle, moveActive, nodeKey, PAGE_ROWS, RECENT_SECTION, sectionKey,
} from '../../../../src/app/panels/library/catalog.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const registry = createRegistry(nodes);
const catalog = catalogOf(registry);
const product = nodes.filter((def) => def.category !== 'ref');

test('the catalogue lists every registered product node once, and no reference node', () => {
  assert.deepEqual(catalog.entries.map((entry) => entry.type).sort(), product.map((def) => def.type).sort());
  assert.equal(new Set(catalog.entries.map((entry) => entry.type)).size, catalog.entries.length);
  assert.ok(nodes.some((def) => def.category === 'ref'), 'the registry holds reference nodes');
  assert.deepEqual(catalog.entries.filter((entry) => entry.type.startsWith('ref/')), []);
  assert.equal(catalog.get('ref/blur'), undefined);
  assert.equal(catalog.get('filter/blur')?.title, 'Blur');
});

test('the groups are the categories of engine.md 4.1 in its order, each with its nodes by title', () => {
  assert.deepEqual(catalog.groups.map((group) => group.category), ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io']);
  assert.deepEqual(CATEGORIES.map((category) => category.id), catalog.groups.map((group) => group.category));
  for (const group of catalog.groups) {
    const expected = product.filter((def) => def.category === group.category).map((def) => def.title).sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(group.entries.map((entry) => entry.title), expected, group.category);
    assert.ok(group.entries.every((entry) => entry.category === group.category && entry.type.startsWith(`${group.category}/`)));
    assert.equal(categoryTitle(group.category), group.title);
    // testing.md 6.2: Title Case, one sentence without a full stop.
    assert.match(group.title, /^[A-Z][A-Za-z ]+$/);
    assert.ok(group.hint.length > 0 && !group.hint.endsWith('.'), group.hint);
  }
  // nodes.md: the number of nodes of each category.
  assert.deepEqual(catalog.groups.map((group) => group.entries.length), [16, 11, 14, 10, 10, 8, 9, 8]);
  assert.deepEqual(catalog.entries, catalog.groups.flatMap((group) => group.entries));
});

test('a registry without a category has no group for it, and one of reference nodes alone has none', () => {
  const some = catalogOf(createRegistry(nodes.filter((def) => def.category === 'filter' || def.category === 'ref')));
  assert.deepEqual(some.groups.map((group) => group.category), ['filter']);
  assert.deepEqual(catalogOf(createRegistry(nodes.filter((def) => def.category === 'ref'))).groups, []);
});

test('the theme has the color of every category the library draws, as testing.md 6.7 gives it', () => {
  const theme = fs.readFileSync(path.join(ROOT, 'src/app/shell/theme.css'), 'utf8');
  const expected: Record<string, string> = {
    generate: '#79461d', adjust: '#246283', filter: '#412b51', simulate: '#2b652b', select: '#3c3c83', color: '#6e6e23', surface: '#1d725e', io: '#82354c',
  };
  for (const { id } of CATEGORIES) {
    assert.match(theme, new RegExp(`--og-category-${id}: ${expected[id]};`), id);
  }
  // The panel names the tokens and holds no color of its own.
  const css = fs.readFileSync(path.join(ROOT, 'src/app/panels/library/library.module.css'), 'utf8');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], []);
  const source = fs.readFileSync(path.join(ROOT, 'src/app/panels/library/NodeBrowser.tsx'), 'utf8');
  assert.match(source, /var\(--og-category-\$\{named\}\)/);
});

test('an entry says what its ports carry, in the words of the user documentation', () => {
  const port = (type: string, side: 'inputs' | 'outputs', name: string) => {
    const found = catalog.get(type)![side].find((candidate) => candidate.name === name);
    assert.ok(found, `${type} has the ${side.slice(0, -1)} ${name}`);
    return `${found.label}: ${found.carries}${found.optional ? ', optional' : ''}`;
  };
  assert.equal(port('generate/island', 'outputs', 'out'), 'Out: terrain');
  assert.equal(port('generate/island', 'outputs', 'water'), 'Water: mask');
  assert.equal(port('simulate/flow', 'outputs', 'out'), 'Out: data');
  assert.equal(port('color/natural', 'outputs', 'out'), 'Out: color');
  assert.equal(port('color/natural', 'inputs', 'snow'), 'Snow: mask, optional');
  assert.equal(port('filter/blur', 'inputs', 'in'), 'In: terrain or color');
  assert.equal(port('filter/blur', 'outputs', 'out'), 'Out: same as In');
  assert.equal(port('adjust/combine', 'outputs', 'out'), 'Out: same as A');
  // A maskable node has the mask input the evaluator gives it (engine.md 4.13); a node with its own has it once.
  assert.equal(port('filter/blur', 'inputs', 'mask'), 'Mask: mask, optional');
  assert.equal(catalog.get('simulate/thermal-erosion')!.inputs.filter((candidate) => candidate.name === 'mask').length, 1);
  assert.deepEqual(catalog.get('generate/mountain')!.inputs, []);
  assert.deepEqual(catalog.get('io/export-landscape')!.outputs, []);
  for (const entry of catalog.entries) {
    const def = registry.get(entry.type)!;
    assert.equal(entry.inputs.length, def.inputs.length + (def.maskable ? 1 : 0), entry.type);
    assert.equal(entry.outputs.length, def.outputs.length, entry.type);
    assert.equal(entry.description, def.description);
    assert.deepEqual(entry.keywords, def.keywords ?? []);
  }
});

test('the notes of an entry say what its flags mean to a user', () => {
  const notes = (type: string): readonly string[] => catalog.get(type)!.notes;
  assert.deepEqual(notes('filter/blur'), ['A mask limits where it acts']);
  assert.deepEqual(notes('io/export-landscape'), ['A build writes what is connected to it']);
  assert.deepEqual(notes('simulate/sea'), ["Reads the project's sea level"]);
  assert.ok(notes('adjust/autolevel').some((note) => /preview can differ/.test(note)));
  assert.deepEqual(notes('io/import-field'), ['Reads a file']);
  assert.deepEqual(notes('generate/constant'), []);
  for (const entry of catalog.entries) for (const note of entry.notes) assert.ok(!note.endsWith('.'), note);
});

test('the rows are the recent nodes, then each category with its nodes; a folded section is its header alone', () => {
  const all = catalogRows(catalog, [], []);
  assert.equal(all.length, catalog.groups.length + catalog.entries.length);
  assert.deepEqual(all.filter((row) => row.kind === 'section').map((row) => row.section), catalog.groups.map((group) => group.category));
  assert.deepEqual(all[0], { kind: 'section', key: 'section:generate', section: 'generate', title: 'Generate', hint: CATEGORIES[0]!.hint, count: 16, open: true });
  assert.equal(all[1]!.key, nodeKey('generate', catalog.groups[0]!.entries[0]!.type));
  assert.equal(new Set(all.map((row) => row.key)).size, all.length, 'every row has a key of its own');

  const folded = catalogRows(catalog, [], ['generate', 'io', 'nothing']);
  assert.equal(folded.length, all.length - 16 - 8);
  assert.deepEqual(folded.slice(0, 2).map((row) => [row.kind, row.section]), [['section', 'generate'], ['section', 'adjust']]);
  assert.equal(folded[0]!.kind === 'section' && folded[0]!.open, false);

  // Recent: newest first, above the categories; a type the registry no longer has is left out, and a node is
  // then listed twice, under two keys.
  const recent = catalogRows(catalog, ['filter/blur', 'gone/away', 'ref/blur', 'generate/dunes'], []);
  assert.deepEqual(recent.slice(0, 3).map((row) => row.key), [sectionKey(RECENT_SECTION), 'recent:filter/blur', 'recent:generate/dunes']);
  assert.equal(recent[0]!.kind === 'section' && recent[0]!.count, 2);
  assert.equal(recent.filter((row) => row.kind === 'node' && row.entry.type === 'filter/blur').length, 2);
  assert.equal(new Set(recent.map((row) => row.key)).size, recent.length);
  assert.equal(catalogRows(catalog, ['gone/away'], [])[0]!.key, 'section:generate', 'no section for nothing');
  assert.equal(catalogRows(catalog, ['filter/blur'], [RECENT_SECTION])[1]!.key, 'section:generate');
});

test('the navigation keys move through the rows and stop at both ends', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((key) => ({ key }));
  assert.equal(moveActive(rows, null, 'next'), 'a');
  assert.equal(moveActive(rows, null, 'previous'), 'l');
  assert.equal(moveActive(rows, 'a', 'next'), 'b');
  assert.equal(moveActive(rows, 'a', 'previous'), 'a');
  assert.equal(moveActive(rows, 'l', 'next'), 'l');
  assert.equal(moveActive(rows, 'f', 'first'), 'a');
  assert.equal(moveActive(rows, 'f', 'last'), 'l');
  assert.equal(PAGE_ROWS, 8);
  assert.equal(moveActive(rows, 'b', 'pageDown'), 'j');
  assert.equal(moveActive(rows, 'j', 'pageDown'), 'l');
  assert.equal(moveActive(rows, 'j', 'pageUp'), 'b');
  assert.equal(moveActive(rows, 'c', 'pageUp'), 'a');
  // A selection that is no row any more counts as none.
  assert.equal(moveActive(rows, 'gone', 'next'), 'a');
  assert.equal(moveActive([], 'a', 'next'), null);
});
