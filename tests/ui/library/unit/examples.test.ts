// The example projects as the library offers them (examples/, src/app/panels/library/examples.ts): the index
// names what the folder holds, every project is a document this build opens without a problem, laid out so that
// a person can read it, and the texts follow the conventions of testing.md 6.2. No GPU and no window:
// tests/graphs/examples.test.ts evaluates and builds the projects.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry, type GraphDoc } from '../../../../src/core/runtime.ts';
import {
  EXAMPLE_DESCRIPTION_MAX, EXAMPLE_TITLE_MAX, exampleDoc, gridMove, parseExampleIndex, summarize, summaryText,
} from '../../../../src/app/panels/library/examples.ts';

const FOLDER = path.resolve(import.meta.dirname, '../../../../examples');
const registry = createRegistry(nodes);
const index = parseExampleIndex(fs.readFileSync(path.join(FOLDER, 'index.json'), 'utf8'));
const docOf = (file: string): GraphDoc => {
  const { doc, problems } = exampleDoc(fs.readFileSync(path.join(FOLDER, file), 'utf8'), registry);
  assert.deepEqual(problems.map((problem) => problem.message), [], `${file}: what the loader reports`);
  return doc;
};

/** The box a node fills in the graph at the least: its width, and the height of a node that has one port and no thumbnail. */
const NODE = { w: 224, h: 66 };

test('the index lists the projects of the folder, the first project first, each with its picture', () => {
  assert.deepEqual(index.map((example) => example.id), ['first-terrain', 'alpine-range', 'temperate-hills', 'volcanic-island', 'desert-canyons', 'cratered-highland']);
  const held = fs.readdirSync(FOLDER).sort();
  assert.deepEqual(held.filter((name) => name.endsWith('.orogen')), index.map((example) => example.file).sort(), 'every project of the folder is in the index, and nothing else');
  assert.deepEqual(held.filter((name) => name.endsWith('.png')), index.map((example) => example.image).sort());
  assert.deepEqual(held.filter((name) => !/\.(orogen|png)$/.test(name)), ['index.json']);
  for (const example of index) {
    assert.equal(example.file, `${example.id}.orogen`);
    assert.equal(example.image, `${example.id}.png`);
    // The picture: an 8-bit RGB PNG of 384 x 256, the CLI's 3D view at half its size, small enough to pack into the page.
    const png = fs.readFileSync(path.join(FOLDER, example.image));
    assert.equal(png.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', example.image);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [384, 256, 8, 2], `${example.image}: width, height, bits, color type`);
    assert.ok(png.length < 160_000, `${example.image} has ${png.length} bytes`);
  }
});

test('the titles and descriptions follow the text conventions', () => {
  for (const example of index) {
    assert.ok(example.title.length <= EXAMPLE_TITLE_MAX, example.title);
    assert.match(example.title, /^([A-Z][a-z]+)( [A-Z][a-z]+)*$/, `${example.title} is in Title Case`);
    assert.ok(example.description.length <= EXAMPLE_DESCRIPTION_MAX, `${example.title}: ${example.description.length} characters`);
    assert.match(example.description, /^[A-Z].*\.$/, `${example.title}: sentences, the last with its full stop`);
    assert.ok(!/colour|centre|grey\b/.test(example.description), `${example.title}: American spelling`);
  }
  assert.equal(new Set(index.map((example) => example.title)).size, index.length);
});

test('an index that is not one is refused with a sentence that names the fault', () => {
  const entry = { file: 'a.orogen', image: 'a.png', title: 'A', description: 'One.' };
  const refused = (value: unknown, message: RegExp): void => {
    assert.throws(() => parseExampleIndex(typeof value === 'string' ? value : JSON.stringify(value)), message);
  };
  assert.deepEqual(parseExampleIndex(JSON.stringify({ examples: [entry] })), [{ id: 'a', ...entry }]);
  assert.deepEqual(parseExampleIndex('{"examples":[]}'), []);
  refused('{', /not JSON/);
  refused({}, /no list "examples"/);
  refused(null, /no list "examples"/);
  refused({ examples: [{ ...entry, title: '' }] }, /Example 1 of the index has no "title"/);
  refused({ examples: [entry, 7] }, /Example 2 of the index has no "file"/);
  refused({ examples: [{ ...entry, file: '../a.orogen' }] }, /names the file/);
  refused({ examples: [{ ...entry, file: 'a.json' }] }, /names the file/);
  refused({ examples: [{ ...entry, image: 'a.jpg' }] }, /names the picture/);
  refused({ examples: [{ ...entry, title: 'A Title That Is Much Too Long' }] }, /more than 24 characters/);
  refused({ examples: [{ ...entry, description: 'x'.repeat(201) }] }, /more than 200 characters/);
  refused({ examples: [entry, entry] }, /a second time/);
});

test('every project opens without a problem, and the tab says what it holds', () => {
  const said = Object.fromEntries(index.map((example) => [example.id, summaryText(summarize(docOf(example.file)))]));
  assert.deepEqual(said, {
    'first-terrain': '3 nodes',
    'alpine-range': '21 nodes · 5 layers',
    'temperate-hills': '17 nodes · 3 layers',
    'volcanic-island': '19 nodes · 4 layers',
    'desert-canyons': '19 nodes · 3 layers',
    'cratered-highland': '14 nodes · 3 layers',
  });
  const held = Object.fromEntries(index.map((example) => [example.id, summarize(docOf(example.file))]));
  assert.deepEqual(held['alpine-range'], { nodes: 21, layers: 5, textures: 1, landscape: true });
  assert.deepEqual(held['volcanic-island'], { nodes: 19, layers: 4, textures: 2, landscape: true });
  assert.deepEqual(held['first-terrain'], { nodes: 3, layers: 0, textures: 0, landscape: true });
  for (const example of index) assert.equal(summarize(docOf(example.file)).landscape, true, `${example.title} exports a landscape`);
  assert.equal(summaryText({ nodes: 1, layers: 1, textures: 4, landscape: true }), '1 node · 1 layer');
  // A text that is no project is refused, as File > Open refuses it.
  assert.throws(() => exampleDoc('{"format":"other"}', registry));
});

test('the arrow keys move through the cards as they lie: along the list in one column, by rows in a grid', () => {
  // One column, as in the panel: down and right are the next card, up and left the one before.
  assert.deepEqual(['down', 'right', 'up', 'left'].map((move) => gridMove(6, 1, 2, move as 'down')), [3, 3, 1, 1]);
  assert.deepEqual([gridMove(6, 1, 5, 'down'), gridMove(6, 1, 0, 'up'), gridMove(6, 1, 5, 'right'), gridMove(6, 1, 0, 'left')], [5, 0, 5, 0], 'both ends stop');
  // Three columns, as in the dialog: down and up keep the column.
  assert.deepEqual([gridMove(6, 3, 0, 'down'), gridMove(6, 3, 1, 'down'), gridMove(6, 3, 5, 'up'), gridMove(6, 3, 4, 'up')], [3, 4, 2, 1]);
  assert.deepEqual([gridMove(6, 3, 4, 'down'), gridMove(6, 3, 1, 'up')], [4, 1], 'no row to go to: the selection stays');
  assert.deepEqual([gridMove(6, 3, 2, 'right'), gridMove(6, 3, 3, 'left')], [3, 2], 'left and right go on into the next row');
  // A last row that is not full: there is no card below the second of five in rows of three... but one below the first.
  assert.deepEqual([gridMove(5, 3, 0, 'down'), gridMove(5, 3, 2, 'down')], [3, 2]);
  // Nothing selected: the first card, or the last when the key goes backward.
  assert.deepEqual(['down', 'right', 'up', 'left', 'first', 'last'].map((move) => gridMove(6, 3, -1, move as 'down')), [0, 0, 5, 5, 0, 5]);
  assert.deepEqual([gridMove(6, 3, 4, 'first'), gridMove(6, 3, 1, 'last'), gridMove(6, 3, 99, 'down')], [0, 5, 0]);
  assert.deepEqual([gridMove(0, 3, -1, 'down'), gridMove(1, 0, 0, 'down'), gridMove(3, 2.9, 0, 'down')], [-1, 0, 2], 'no card; a column count that is none counts as one');
});

test('the alpine range is the chain the library promises: range, fluvial, hydraulic and thermal erosion, snow, color, and four named layers', () => {
  const doc = docOf('alpine-range.orogen');
  const from = (node: string, port: string): string | undefined => {
    const edge = Object.values(doc.edges).find((candidate) => candidate.to.node === node && candidate.to.port === port);
    return edge && doc.nodes[edge.from.node]!.type;
  };
  const chain: string[] = [];
  // Upstream from the landscape, along the primary inputs.
  let at: string | undefined = Object.values(doc.nodes).find((node) => node.type === 'io/export-landscape')!.id;
  for (let step = 0; step < 16 && at !== undefined; step++) {
    chain.push(doc.nodes[at]!.type);
    const edge = Object.values(doc.edges).find((candidate) => candidate.to.node === at && (candidate.to.port === 'in' || candidate.to.port === 'a'));
    at = edge?.from.node;
  }
  assert.deepEqual(chain, [
    'io/export-landscape', 'simulate/snow', 'simulate/thermal-erosion', 'simulate/hydraulic-erosion', 'simulate/fluvial-erosion', 'adjust/combine', 'generate/mountain-range',
  ]);
  const layers = Object.values(doc.nodes).filter((node) => node.type === 'io/export-layer').map((node) => node.params.layer).sort();
  assert.deepEqual(layers, ['Grass', 'Rock', 'Scree', 'Snow']);
  const color = Object.values(doc.nodes).find((node) => node.type === 'color/natural')!;
  assert.deepEqual([color.params.mode, from(color.id, 'snow'), from(color.id, 'flow')], ['alpine', 'simulate/snow', 'simulate/flow']);
});

for (const example of index) {
  test(`${example.file}: named nodes in groups, laid out left to right without overlap, and a view to open with`, () => {
    const doc = docOf(example.file);
    const all = Object.values(doc.nodes);
    const groups = Object.values(doc.groups);
    assert.ok(groups.length >= 1, 'the graph has groups');
    for (const group of groups) {
      assert.match(group.title, /^[A-Z]/, `the group ${group.id} has a title`);
      assert.match(group.color ?? '', /^#[0-9a-f]{6}$/, `${group.title} has a color`);
    }
    assert.equal(new Set(groups.map((group) => group.title)).size, groups.length, 'no two groups share a title');

    // Every node lies wholly inside exactly one group, below its title bar.
    for (const node of all) {
      const inside = groups.filter(({ rect }) => node.position.x >= rect.x && node.position.y >= rect.y + 22
        && node.position.x + NODE.w <= rect.x + rect.w && node.position.y + NODE.h <= rect.y + rect.h);
      assert.equal(inside.length, 1, `${node.id} lies in ${inside.map((group) => group.title).join(' and ') || 'no group'}`);
    }
    for (const a of groups) {
      for (const b of groups) {
        if (a === b) continue;
        const apart = a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y;
        assert.ok(apart, `the groups ${a.title} and ${b.title} overlap`);
      }
    }
    // No two nodes overlap: they differ by a node's width across, or by the height of the tallest node down.
    for (const a of all) {
      for (const b of all) {
        if (a.id >= b.id) continue;
        assert.ok(Math.abs(a.position.x - b.position.x) >= NODE.w + 40 || Math.abs(a.position.y - b.position.y) >= 200, `${a.id} and ${b.id} lie on each other`);
      }
    }
    // The graph reads from left to right: every connection leads to a node further right.
    for (const edge of Object.values(doc.edges)) {
      assert.ok(doc.nodes[edge.from.node]!.position.x < doc.nodes[edge.to.node]!.position.x, `${edge.id} leads to the left`);
    }

    // Nodes carry names that say what they are for in this terrain. The first project keeps the names of the
    // node types, which are what its reader looks for in the library.
    if (example.id !== 'first-terrain') {
      const untitled = all.filter((node) => typeof node.title !== 'string' || node.title.trim() === '').map((node) => node.id);
      assert.deepEqual(untitled, [], 'nodes without a title');
      assert.equal(new Set(all.map((node) => node.title)).size, all.length, 'no two nodes share a title');
      for (const node of all) assert.ok(node.title!.length <= 24 && /^[A-Z]/.test(node.title!), `${node.id}: "${node.title}"`);
    } else {
      assert.deepEqual(all.map((node) => node.type), ['generate/mountain', 'simulate/hydraulic-erosion', 'io/export-landscape']);
    }
    for (const node of all) assert.match(node.id, /^[a-z][A-Za-z]*$/, `${node.id}: an id a person can type after --node`);

    // What the viewport shows when the project opens: the final terrain, and its color where the project makes one.
    const view = doc.ui.view;
    assert.ok(view?.height, 'the project shows a terrain');
    const shown = doc.nodes[view.height.node];
    assert.ok(shown && registry.get(shown.type)!.outputs.some((port) => port.name === view.height!.port));
    const landscape = all.find((node) => node.type === 'io/export-landscape')!;
    const exported = Object.values(doc.edges).find((edge) => edge.to.node === landscape.id)!.from;
    assert.deepEqual(view.height, exported, 'the terrain shown is the terrain exported');
    const colored = all.some((node) => node.type.startsWith('color/'));
    assert.equal(view.overlay !== undefined, colored);
    if (view.overlay) assert.deepEqual([view.overlay.as, view.overlay.opacity, Object.hasOwn(doc.nodes, view.overlay.ref.node)], ['color', 1, true]);
    assert.equal(view.locked, undefined);
  });
}
