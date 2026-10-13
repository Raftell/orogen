// The search of the library (src/app/panels/library/search.ts): what a query finds and in which order, and the
// names of other tools (aliases.ts). No window.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry } from '../../../../src/core/runtime.ts';
import { ALIASES } from '../../../../src/app/panels/library/aliases.ts';
import { catalogOf } from '../../../../src/app/panels/library/catalog.ts';
import {
  createSearchIndex, FIELD_WEIGHT, matchText, searchCatalog, searchRows, titleRuns, type SearchHit,
} from '../../../../src/app/panels/library/search.ts';

const catalog = catalogOf(createRegistry(nodes));
const index = createSearchIndex(catalog);
const find = (query: string): SearchHit[] => searchCatalog(index, query);
const types = (query: string): string[] => find(query).map((hit) => hit.entry.type);
const titles = (query: string): string[] => find(query).map((hit) => hit.entry.title);

test('an empty query finds nothing, and so does one that matches no node', () => {
  assert.deepEqual(find(''), []);
  assert.deepEqual(find('   '), []);
  assert.deepEqual(find('xyzq'), []);
  assert.deepEqual(find('qqqqqqqq'), []);
});

test('the exact title of every node finds that node first', () => {
  for (const entry of catalog.entries) {
    const hits = find(entry.title);
    assert.equal(hits[0]?.entry.type, entry.type, `"${entry.title}" finds ${hits[0]?.entry.title} first`);
    assert.equal(hits[0]!.field, 'title');
    assert.ok(hits[0]!.score > 0.99, `${entry.title}: ${hits[0]!.score}`);
    // Lower case, as it is typed.
    assert.equal(find(entry.title.toLowerCase())[0]!.entry.type, entry.type);
  }
});

test('a title ranks above a keyword, a keyword above a description, and the scores never rise down the list', () => {
  // "blur": the node named so, then the titles that hold the word.
  assert.deepEqual(titles('blur').slice(0, 4), ['Blur', 'Slope Blur', 'Smart Blur', 'Directional Blur']);
  // The start of a title, as it is typed.
  assert.deepEqual(titles('mount').slice(0, 2), ['Mountain', 'Mountain Range']);
  assert.equal(titles('therm')[0], 'Thermal Erosion');
  assert.deepEqual(new Set(titles('erosion').slice(0, 3)), new Set(['Fluvial Erosion', 'Hydraulic Erosion', 'Thermal Erosion']));

  // "noise": the three noises by their titles, then nodes that have the word as a keyword or another tool's name.
  const noise = find('noise');
  assert.deepEqual(new Set(noise.slice(0, 3).map((hit) => hit.entry.title)), new Set(['Fractal Noise', 'Cellular Noise', 'Eroded Noise']));
  assert.ok(noise.slice(0, 3).every((hit) => hit.field === 'title'));
  assert.ok(noise.slice(3).every((hit) => hit.field !== 'title'));

  // A word only descriptions hold comes last, and only whole: "plateau" is a keyword of three nodes.
  const plateau = find('plateau');
  assert.deepEqual(plateau.slice(0, 3).map((hit) => hit.field), ['keyword', 'keyword', 'keyword']);
  assert.ok(plateau.length > 3 && plateau.slice(3).every((hit) => hit.field === 'description' && hit.entry.description.toLowerCase().includes('plateau')));
  // A description is not searched letter by letter: a word of two letters finds none.
  assert.ok(find('of').every((hit) => hit.field !== 'description'));

  for (const query of ['blur', 'e', 'noise', 'water', 'slope', 'erosion', 'unreal', 'export', 'mask']) {
    const hits = find(query);
    assert.ok(hits.length > 0, query);
    for (let at = 1; at < hits.length; at++) assert.ok(hits[at]!.score <= hits[at - 1]!.score, `${query}: hit ${at}`);
    assert.equal(new Set(hits.map((hit) => hit.entry.type)).size, hits.length, `${query}: a node is found once`);
    assert.ok(hits.every((hit) => hit.score > 0 && hit.score <= 1));
  }
  assert.ok(FIELD_WEIGHT.title > FIELD_WEIGHT.alias && FIELD_WEIGHT.alias > FIELD_WEIGHT.keyword && FIELD_WEIGHT.keyword > FIELD_WEIGHT.type && FIELD_WEIGHT.type > FIELD_WEIGHT.description);
});

test('a node is found by the name another tool uses for it, and the row says whose name it is', () => {
  const first = (query: string): SearchHit => {
    const hit = find(query)[0];
    assert.ok(hit, `"${query}" finds a node`);
    return hit;
  };
  const cases: readonly [query: string, type: string, says: string][] = [
    ['erosion2', 'simulate/hydraulic-erosion', 'Erosion2 in Gaea'],
    ['Erosion2', 'simulate/hydraulic-erosion', 'Erosion2 in Gaea'],
    ['perlin', 'generate/fractal-noise', 'Perlin in Gaea'],
    ['voronoi', 'generate/cellular-noise', 'Voronoi in Gaea'],
    ['thermal2', 'simulate/thermal-erosion', 'Thermal2 in Gaea'],
    ['cluter', 'color/gradient-map', 'CLUTer in Gaea'],
    ['bomber', 'surface/scatter', 'Bomber in Gaea'],
    ['stratify', 'surface/strata', 'Stratify in Gaea'],
    ['flowmap', 'simulate/flow', 'FlowMap in Gaea'],
    ['advanced perlin', 'generate/fractal-noise', 'Advanced Perlin in World Machine'],
    ['select convexity', 'select/curvature', 'Select Convexity in World Machine'],
    ['thermal weathering', 'simulate/thermal-erosion', 'Thermal Weathering in World Machine'],
    ['colorizer', 'color/gradient-map', 'Colorizer in World Machine'],
    ['heightfield erode', 'simulate/hydraulic-erosion', 'HeightField Erode in Houdini'],
    ['heightfield noise', 'generate/fractal-noise', 'HeightField Noise in Houdini'],
    ['transform 2d', 'filter/transform', 'Transformation 2D in Substance Designer'],
    ['transformation 2d', 'filter/transform', 'Transformation 2D in Substance Designer'],
  ];
  for (const [query, type, says] of cases) {
    const hit = first(query);
    assert.equal(hit.entry.type, type, query);
    assert.equal(hit.field, 'alias', query);
    assert.equal(matchText(hit), says, query);
  }
  // One name of another tool for two nodes finds both.
  assert.deepEqual(new Set(types('satmap').slice(0, 2)), new Set(['color/gradient-map', 'color/natural']));
  // A keyword says itself; a title and a description say nothing beside the row.
  const talus = first('talus');
  assert.deepEqual([talus.entry.type, talus.field, matchText(talus)], ['simulate/thermal-erosion', 'keyword', 'talus']);
  assert.equal(matchText(first('blur')), null);
  assert.equal(matchText(find('plateau').at(-1)!), null);
});

test('the table of other names holds registered product nodes, and no name a title already is', () => {
  for (const [type, aliases] of Object.entries(ALIASES)) {
    const entry = catalog.get(type);
    assert.ok(entry, `${type} is a node of the product`);
    assert.ok(aliases.length > 0, type);
    assert.deepEqual(entry.aliases, aliases);
    const seen = new Set<string>();
    for (const alias of aliases) {
      assert.notEqual(alias.name.toLowerCase(), entry.title.toLowerCase(), `${type}: "${alias.name}" is the title`);
      assert.ok(alias.name.trim() === alias.name && alias.name !== '', type);
      const key = `${alias.tool}:${alias.name.toLowerCase()}`;
      assert.ok(!seen.has(key), `${type} lists ${alias.name} of ${alias.tool} twice`);
      seen.add(key);
    }
  }
  assert.ok(Object.keys(ALIASES).length >= 60, 'most nodes have a name elsewhere');

  // The names of Gaea's nodes are those the research report lists: a name it does not know is a typing mistake.
  const report = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../docs/research/gaea-features.md'), 'utf8');
  const unknown = Object.entries(ALIASES).flatMap(([type, aliases]) => aliases
    .filter((alias) => alias.tool === 'Gaea' && !new RegExp(`\\b${alias.name}\\b`).test(report))
    .map((alias) => `${type}: ${alias.name}`));
  assert.deepEqual(unknown, [], 'Gaea names that docs/research/gaea-features.md does not list');
});

test('the rows of a search are its hits in order, each with what a row draws', () => {
  const hits = find('slope bl');
  const rows = searchRows(hits);
  assert.equal(rows[0]!.key, 'search:filter/slope-blur');
  assert.deepEqual(rows.map((row) => row.kind === 'node' && row.hit), hits);
  assert.ok(rows.every((row) => row.section === 'search'));

  // The characters of the title that matched, in order, for the bold runs of the row.
  const blur = find('blur').find((hit) => hit.entry.title === 'Slope Blur')!;
  assert.deepEqual(blur.titleIndexes, [6, 7, 8, 9]);
  assert.deepEqual(titleRuns('Slope Blur', blur.titleIndexes), [{ text: 'Slope ', strong: false }, { text: 'Blur', strong: true }]);
  assert.deepEqual(titleRuns('Blur', [0, 1, 2, 3]), [{ text: 'Blur', strong: true }]);
  assert.deepEqual(titleRuns('Blur', []), [{ text: 'Blur', strong: false }]);
  assert.deepEqual(titleRuns('Mountain Range', [0, 9]), [
    { text: 'M', strong: true }, { text: 'ountain ', strong: false }, { text: 'R', strong: true }, { text: 'ange', strong: false },
  ]);
  assert.deepEqual(find('talus')[0]!.titleIndexes, [], 'a keyword marks nothing of the title');
});
