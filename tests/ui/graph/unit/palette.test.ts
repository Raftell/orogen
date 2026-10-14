// What the add-node palette lists: the nodes of the product, as the library lists them, by category, found by
// the library's own search (a few letters of a title, a keyword, another tool's name for the node), narrowed to
// a category, and for a dragged wire only what the wire can end at.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CATEGORY_TITLES } from '../../../../src/app/panels/graph/model.ts';
import { PALETTE_MARGIN, paletteCategories, paletteEntries, palettePlace, searchPalette } from '../../../../src/app/panels/graph/palette-model.ts';
import { catalogOf, CATEGORIES as CATALOG_CATEGORIES } from '../../../../src/app/ui/node-catalog.ts';
import { createSearchIndex, searchCatalog } from '../../../../src/app/ui/node-search.ts';
import { REGISTRY } from './_graph.ts';

const CATALOG = catalogOf(REGISTRY);
/** The categories of the product, in the order of engine.md 4.1: `ref`, the engine's reference nodes, is none of them. */
const CATEGORIES = CATALOG_CATEGORIES.map((category) => category.id);

const ENTRIES = paletteEntries(REGISTRY);
const types = (text: string, category: Parameters<typeof searchPalette>[2] = null): string[] => searchPalette(ENTRIES, text, category).map((row) => row.entry.type);

test('the palette lists every node of the product once, by category in the order of the contract and by title within one', () => {
  assert.deepEqual(ENTRIES.map((entry) => entry.type), CATALOG.entries.map((entry) => entry.type), 'what the library lists, in its order');
  assert.equal(ENTRIES.length, REGISTRY.list().filter((def) => def.category !== 'ref').length);
  assert.equal(new Set(ENTRIES.map((entry) => entry.type)).size, ENTRIES.length);
  const ranks = ENTRIES.map((entry) => CATEGORIES.indexOf(entry.category));
  assert.ok(ranks.every((rank, i) => rank >= 0 && (i === 0 || rank >= ranks[i - 1]!)), 'categories in the order of engine.md 4.1');
  for (const category of CATEGORIES) {
    const titles = ENTRIES.filter((entry) => entry.category === category).map((entry) => entry.title);
    assert.ok(titles.length > 0, `${category} has nodes`);
    assert.ok(titles.every((title, i) => i === 0 || titles[i - 1]!.localeCompare(title, 'en') <= 0), `${category} by title`);
    assert.match(CATEGORY_TITLES[category], /^[A-Z]/);
  }
  const blur = ENTRIES.find((entry) => entry.type === 'filter/blur')!;
  assert.deepEqual([blur.title, blur.category, blur.inputs, blur.outputs], ['Blur', 'filter', ['In', 'Mask'], ['Out']]);
  assert.match(blur.description, /\.$/);
  assert.match(blur.keywords, /gaussian/);
});

test('without text the list is everything, or one category', () => {
  assert.equal(searchPalette(ENTRIES, '').length, ENTRIES.length);
  assert.equal(searchPalette(ENTRIES, '   ').length, ENTRIES.length);
  const simulate = searchPalette(ENTRIES, '', 'simulate');
  assert.equal(simulate.length, 10);
  assert.ok(simulate.every((row) => row.entry.category === 'simulate'));
  assert.deepEqual(simulate[0]!.title, [{ text: simulate[0]!.entry.title, match: false }]);
});

test('a few letters of a title find it, with the letters marked; a whole title comes first', () => {
  assert.equal(types('blur')[0], 'filter/blur', 'the exact title before Smart Blur and Directional Blur');
  assert.ok(types('blur').includes('filter/smart-blur') && types('blur').includes('filter/directional-blur') && types('blur').includes('filter/slope-blur'));
  assert.equal(types('hydr')[0], 'simulate/hydraulic-erosion');
  // Letters that are not next to each other: the first letters of the words.
  assert.equal(types('mr')[0], 'generate/mountain-range');
  assert.equal(types('therm ero')[0], 'simulate/thermal-erosion');
  const marked = searchPalette(ENTRIES, 'terr')[0]!;
  assert.equal(marked.entry.type, 'surface/terraces');
  assert.deepEqual(marked.title, [{ text: 'Terr', match: true }, { text: 'aces', match: false }]);
  assert.equal(marked.matchedKeywords, null);
  assert.deepEqual(types('zzqx'), []);
});

test('a keyword finds a node whose title does not hold the word: the names other tools use', () => {
  // testing.md 6.2: keywords are the names other tools and textbooks use.
  assert.equal(types('perlin')[0], 'generate/fractal-noise');
  assert.equal(types('voronoi')[0], 'generate/cellular-noise');
  assert.ok(types('gaussian').includes('filter/blur'));
  assert.ok(types('talus').includes('simulate/thermal-erosion'));
  const row = searchPalette(ENTRIES, 'voronoi')[0]!;
  assert.deepEqual(row.title, [{ text: 'Cellular Noise', match: false }]);
  assert.equal(row.matchedKeywords, 'Voronoi in Gaea', 'the row says what it was found by');
  assert.equal(searchPalette(ENTRIES, 'talus').find((found) => found.entry.type === 'simulate/thermal-erosion')!.matchedKeywords, 'talus');
  // A title match is worth more than the same match in a keyword.
  const erosion = types('erosion');
  assert.ok(erosion.indexOf('simulate/hydraulic-erosion') < erosion.indexOf('generate/eroded-noise') || !erosion.includes('generate/eroded-noise'));
});

test('the text and a category narrow together, and the categories are counted for the text', () => {
  assert.deepEqual(types('blur', 'filter').filter((type) => !type.startsWith('filter/')), []);
  assert.ok(types('blur', 'filter').length >= 4);
  assert.deepEqual(types('blur', 'simulate'), []);

  const all = paletteCategories(ENTRIES, '');
  assert.deepEqual(all.map((item) => item.category), [null, ...CATEGORIES]);
  assert.equal(all[0]!.count, ENTRIES.length);
  assert.equal(all.slice(1).reduce((sum, item) => sum + item.count, 0), ENTRIES.length);
  assert.equal(all.find((item) => item.category === 'generate')!.count, 16);

  const blurred = paletteCategories(ENTRIES, 'blur');
  assert.equal(blurred[0]!.count, types('blur').length);
  assert.ok(blurred.some((item) => item.category === 'filter') && !blurred.some((item) => item.category === 'simulate'), 'a category without a match is not listed');
  assert.deepEqual(paletteCategories(ENTRIES, 'zzqx'), [{ category: null, count: 0 }]);
});

test('the engine\'s reference nodes are not offered: the palette holds what the library holds', () => {
  assert.ok(REGISTRY.list().some((def) => def.category === 'ref'), 'the registry has reference nodes');
  assert.deepEqual(ENTRIES.filter((entry) => entry.type.startsWith('ref/')), []);
  assert.ok(!paletteCategories(ENTRIES, '').some((item) => (item.category as string) === 'ref'));
  for (const query of ['blur', 'combine', 'perlin', 'color', 'fail', 'reference', 'slow']) {
    assert.deepEqual(types(query).filter((type) => type.startsWith('ref/')), [], query);
  }
  for (const pending of [{ from: { node: 'a', port: 'out' } }, { to: { node: 'b', port: 'in' } }]) {
    assert.deepEqual(paletteEntries(REGISTRY, pending).filter((entry) => entry.type.startsWith('ref/')), []);
  }
});

test('one search for the library and the palette: the names other tools use find the same node first in both', () => {
  const library = createSearchIndex(CATALOG);
  for (const [query, type] of [
    ['combiner', 'adjust/combine'], ['mixer', 'adjust/combine'], ['erosion2', 'simulate/hydraulic-erosion'], ['thermal2', 'simulate/thermal-erosion'],
    ['fractalterraces', 'surface/terraces'], ['stratify', 'surface/strata'], ['select height', 'select/height'],
  ] as const) {
    assert.equal(types(query)[0], type, `${query} in the palette`);
    assert.equal(searchCatalog(library, query)[0]?.entry.type, type, `${query} in the library`);
  }
  // And any query, in the same order.
  for (const query of ['blur', 'erosion', 'export', 'color', 'noise', 'water', 'unreal land', 'mask']) {
    assert.deepEqual(types(query), searchCatalog(library, query).map((hit) => hit.entry.type), query);
  }
  assert.equal(searchPalette(ENTRIES, 'erosion2')[0]!.matchedKeywords, 'Erosion2 in Gaea');
});

test('the obvious words pick the node they mean: "export" and "output" the terrain\'s export, "color" the node that colours', () => {
  // A wire dragged from a terrain and dropped on the canvas, and the words a newcomer types.
  const fromTerrain = paletteEntries(REGISTRY, { from: { node: 'a', port: 'out' } });
  const first = (query: string): string | undefined => searchPalette(fromTerrain, query)[0]?.entry.type;
  assert.equal(first('export'), 'io/export-landscape');
  assert.equal(first('output'), 'io/export-landscape');
  assert.equal(first('heightmap'), 'io/export-landscape');
  assert.equal(first('unreal'), 'io/export-landscape');
  assert.equal(first('color'), 'color/natural', 'the node that makes a colour before the one that writes one');
  assert.equal(first('colour'), 'color/natural');
  // The whole title of an export node still finds it first.
  assert.equal(first('color texture'), 'io/export-color');
  assert.equal(first('mask texture'), 'io/export-mask');
  // In the palette opened with Tab the same.
  assert.equal(types('export')[0], 'io/export-landscape');
  assert.equal(types('output')[0], 'io/export-landscape');
  assert.deepEqual(new Set(types('export').slice(0, 6)), new Set(['io/export-landscape', 'io/export-color', 'io/export-field', 'io/export-mask', 'io/export-layer', 'io/export-normal']));
});

test('opened for a dragged wire, the palette lists the nodes the wire can end at', () => {
  const fromOutput = paletteEntries(REGISTRY, { from: { node: 'a', port: 'out' } });
  const intoInput = paletteEntries(REGISTRY, { to: { node: 'b', port: 'in' } });
  // From an output: everything with an input. Generators without one are gone; an export node is there.
  assert.ok(fromOutput.length < ENTRIES.length);
  assert.ok(fromOutput.every((entry) => entry.inputs.length > 0));
  assert.equal(fromOutput.some((entry) => entry.type === 'generate/mountain-range'), false);
  assert.equal(fromOutput.some((entry) => entry.type === 'generate/crater'), true);
  assert.equal(fromOutput.some((entry) => entry.type === 'io/export-landscape'), true);
  assert.equal(fromOutput.length, REGISTRY.list().filter((def) => def.category !== 'ref' && (def.inputs.length > 0 || def.maskable)).length);
  // Into an input: everything with an output.
  assert.ok(intoInput.every((entry) => entry.outputs.length > 0));
  assert.equal(intoInput.some((entry) => entry.type === 'io/export-landscape'), false);
  assert.equal(intoInput.some((entry) => entry.type === 'generate/mountain-range'), true);
  assert.equal(searchPalette(fromOutput, 'mountain').some((row) => row.entry.type === 'generate/mountain-range'), false);
});

test('the palette lies beside the point it was opened for and inside the window, also a window smaller than the graph', () => {
  const size = { width: 480, height: 360 };
  const big = { width: 1600, height: 1000 };
  // Room on the side asked for: its corner is at the point.
  assert.deepEqual(palettePlace({ x: 400, y: 300 }, big, size), { left: 400, top: 300 });
  assert.deepEqual(palettePlace({ x: 900, y: 300 }, big, size, 'left'), { left: 420, top: 300 }, 'left of the point: a wire that comes from the right stays in sight');
  // No room on that side: on the other, not over the point.
  assert.deepEqual(palettePlace({ x: 1400, y: 300 }, big, size), { left: 920, top: 300 });
  assert.deepEqual(palettePlace({ x: 200, y: 300 }, big, size, 'left'), { left: 200, top: 300 });
  // Low in the window, where the graph is: moved up until it fits, never cut off.
  assert.deepEqual(palettePlace({ x: 400, y: 950 }, big, size), { left: 400, top: 1000 - 360 - PALETTE_MARGIN });
  assert.deepEqual(palettePlace({ x: 400, y: -20 }, big, size), { left: 400, top: PALETTE_MARGIN });
  // The least window the application has, and one narrower than two palettes: inside it wherever the point is.
  for (const bounds of [{ width: 960, height: 600 }, { width: 700, height: 400 }]) {
    for (const x of [0, 10, 350, 480, 690, 959]) {
      for (const y of [0, 200, 399, 599]) {
        for (const side of ['right', 'left'] as const) {
          const place = palettePlace({ x, y }, bounds, size, side);
          assert.ok(place.left >= PALETTE_MARGIN && place.left + size.width <= bounds.width - PALETTE_MARGIN + 1, `${JSON.stringify({ x, y, side, bounds, place })}`);
          assert.ok(place.top >= PALETTE_MARGIN && place.top + size.height <= bounds.height - PALETTE_MARGIN + 1, `${JSON.stringify({ x, y, side, bounds, place })}`);
        }
      }
    }
  }
});

test('words are found in any order and each where it stands: one in the title, another in a keyword or the type', () => {
  // No export node has "export" in its title: the word is in its type, and "landscape" in the title.
  for (const query of ['export landscape', 'landscape export']) {
    assert.deepEqual(types(query).slice(0, 2).sort(), ['io/export-landscape', 'io/export-layer'], `${query}: ${types(query).slice(0, 4).join(', ')}`);
  }
  assert.equal(types('unreal landscape')[0], 'io/export-landscape');
  assert.equal(types('erosion hydraulic')[0], 'simulate/hydraulic-erosion');
});
