// The example projects of examples/ (the Examples tab of the library): each parses without a problem, plans an
// evaluation and a build, evaluates at a small level of its ladder with every node done, and builds a landscape
// whose weight-blended layers total 255 on every texel. The picture beside each project is still the picture of
// what the project shows.
//
// Sizes: evaluations at 253, the fourth level of the ladder of the default build resolution, and builds at 241,
// the smallest size near it that is both a build resolution and a landscape (8 x 8 components of 2 x 2 sections
// of 15 quads). Fields and files are compared by loops that count; no field and no file is handed to an
// assertion of node:assert.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decode } from 'fast-png';

import { drawPreview, type Picture } from '../../src/cli/preview.ts';
import { buildPlan } from '../../src/core/eval/plan.ts';
import { nodes } from '../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, previewResolution, serializeDoc, type GraphDoc, type PortRef } from '../../src/core/runtime.ts';
import { planBuild } from '../../src/export/plan.ts';
import { buildGraph, expectFinite, expectMask, renderGraph, stats, useNodes } from '../helpers/index.ts';

const FOLDER = path.resolve(import.meta.dirname, '../../examples');
/** A level of the ladder of 4033. */
const RES = 253;
/** A build resolution that is a size an Unreal landscape can have. */
const BUILD = 241;
/** The project of three nodes: a generator, an erosion and the landscape. It has no layer. */
const MINIMAL = 'first-terrain.orogen';
const registry = createRegistry(nodes);
useNodes(nodes);

const files = fs.readdirSync(FOLDER).filter((name) => name.endsWith('.orogen')).sort();
const text = (ref: PortRef): string => `${ref.node}.${ref.port}`;

/** A picture beside a project is compared with a fresh one by the mean colors of this many blocks across and down. */
const BLOCKS = { x: 6, y: 4 };
/**
 * How far the mean color of a block may lie from the fresh picture's, of 255: on average over the blocks, and for
 * the worst block. The pictures are drawn at 1009 and compared with one drawn at 253, which an erosion leaves a
 * little different: measured on the GTX 1660 Ti and on lavapipe alike, the six differ by 1.4 at the most on average
 * and by 8.4 in their worst block (First Terrain; the others by half of that or less). Measured too, what the limits catch: another
 * palette (3.7 to 15 on average), another seed of the range or the mountain (2.8 and 3.0; 20 at the worst), a snow
 * line at 0.6 for 0.42 (3.0; 24). And what they do not: a change of fine detail, as dunes two thirds as large
 * (0.5; 3), or of one small part of the picture, as a volcano of half the height (2.0; 12).
 */
const PICTURE_MEAN = 2.5;
const PICTURE_WORST = 16;

/** The mean of each channel in each block of BLOCKS, row by row. */
function blockMeans(picture: Pick<Picture, 'width' | 'height'> & { readonly rgb: ArrayLike<number> }): number[] {
  const w = picture.width / BLOCKS.x, h = picture.height / BLOCKS.y;
  assert.ok(Number.isInteger(w) && Number.isInteger(h), `a picture of ${picture.width} x ${picture.height} is not ${BLOCKS.x} x ${BLOCKS.y} whole blocks`);
  const means: number[] = [];
  for (let by = 0; by < BLOCKS.y; by++) {
    for (let bx = 0; bx < BLOCKS.x; bx++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) sum += picture.rgb[((by * h + y) * picture.width + bx * w + x) * 3 + c]!;
        }
        means.push(sum / (w * h));
      }
    }
  }
  return means;
}

function load(name: string): GraphDoc {
  const { doc, problems } = parseDoc(fs.readFileSync(path.join(FOLDER, name), 'utf8'), registry);
  assert.deepEqual(problems.map((problem) => problem.message), [], `${name}: what the loader reports`);
  return doc;
}

/** The output connected to each input of the nodes of one type, by the node's id. */
function feeds(doc: GraphDoc, type: string): Map<string, PortRef> {
  const found = new Map<string, PortRef>();
  for (const edge of Object.values(doc.edges)) if (doc.nodes[edge.to.node]?.type === type) found.set(edge.to.node, edge.from);
  return found;
}

test('examples/ holds the six projects of the library', () => {
  assert.deepEqual(files, ['alpine-range.orogen', 'cratered-highland.orogen', 'desert-canyons.orogen', 'first-terrain.orogen', 'temperate-hills.orogen', 'volcanic-island.orogen']);
});

for (const name of files) {
  test(`examples/${name}: parses, and plans an evaluation and a build`, () => {
    const doc = load(name);
    // The file is in the form the program writes, with the default resolutions: a build at 4033, previews at 1009.
    assert.ok(fs.readFileSync(path.join(FOLDER, name), 'utf8') === serializeDoc(doc), 'the file is what serializeDoc writes of its document');
    assert.deepEqual([doc.settings.buildResolution, doc.settings.previewLevel, previewResolution(doc.settings)], [4033, 2, 1009]);
    assert.deepEqual([doc.settings.terrainSize, doc.settings.heightRange], [4032, 1008]);
    const stale = Object.values(doc.nodes).filter((node) => node.version !== (registry.get(node.type)?.version ?? 1)).map((node) => node.id);
    assert.deepEqual(stale, [], 'nodes stored at another version than the registry has');

    const targets = Object.values(doc.nodes).map((node) => ({ node: node.id }));
    const failing = buildPlan(doc, registry, targets).nodes.filter((node) => node.error !== null).map((node) => `${node.nodeId}: ${node.error!.message}`);
    assert.deepEqual(failing, [], 'nodes an evaluation would refuse');

    const plan = planBuild(doc, registry, { resolution: BUILD });
    assert.deepEqual(plan.problems.map((problem) => `${problem.code}: ${problem.message}`), [], 'problems of the build plan, warnings included');
    assert.ok(plan.ok && plan.layout !== null, 'the project exports a landscape');
    // A base layer and one layer for every Landscape Layer node. The first project has none: three nodes, a heightmap.
    const layerNodes = feeds(doc, 'io/export-layer').size;
    assert.equal(layerNodes > 0, name !== MINIMAL, 'every example but the first paints layers');
    assert.equal(plan.layers.length, layerNodes > 0 ? layerNodes + 1 : 0);
    assert.ok(plan.layers.length === 0 || plan.layers[0]!.base, 'the base layer comes first');
    assert.equal(plan.files.at(-1)!.encoding, 'json', 'the manifest is the last file of the plan');
    // The same plan at the build resolution the file names.
    assert.ok(planBuild(doc, registry).ok);
  });

  test(`examples/${name}: every node evaluates at ${RES}, the terrain has relief and the layer masks are masks`, async () => {
    const doc = load(name);
    const view = doc.ui.view;
    assert.ok(view?.height, 'the project shows a terrain');
    const layers = feeds(doc, 'io/export-layer');
    const exported = [...new Set(Object.values(doc.edges).filter((edge) => doc.nodes[edge.to.node]!.type.startsWith('io/export-')).map((edge) => text(edge.from)))];
    const targets = [...new Set([text(view.height), ...(view.overlay ? [text(view.overlay.ref)] : []), ...exported])];

    const { fields, report } = await renderGraph(doc, targets, { res: RES });
    assert.equal(report.status, 'ok');
    const unfinished = Object.values(report.nodes).filter((node) => node.state !== 'done').map((node) => `${node.nodeId}: ${node.state}${node.error ? ` (${node.error.message})` : ''}`);
    assert.deepEqual(unfinished, [], 'nodes that did not end done');
    // Every node that has an output leads to what is shown or exported: the graph has no dead branch.
    const ran = new Set(Object.keys(report.nodes));
    const idle = Object.values(doc.nodes).filter((node) => !node.type.startsWith('io/export-') && !ran.has(node.id)).map((node) => node.id);
    assert.deepEqual(idle, [], 'nodes that nothing reads');

    for (const target of targets) {
      assert.ok(fields[target], `${target} was delivered`);
      expectFinite(fields[target]!);
    }
    const terrain = stats(fields[text(view.height)]!);
    assert.ok(terrain.max - terrain.min > 0.08, `the terrain has relief: ${terrain.min} to ${terrain.max}`);
    assert.ok(terrain.min > -0.05 && terrain.max < 1.3, `and lies about the height range: ${terrain.min} to ${terrain.max}`);
    if (view.overlay) {
      assert.equal(fields[text(view.overlay.ref)]!.kind, 'color');
      const color = stats(fields[text(view.overlay.ref)]!);
      assert.ok(color.max - color.min > 0.05, 'the color map is not one color');
    }
    for (const [node, from] of layers) {
      const mask = fields[text(from)]!;
      assert.equal(mask.kind, 'field', `${node} takes a field`);
      // A data output that drives a layer went through a node that makes a mask of it.
      expectMask(mask);
      const cover = stats(mask).mean;
      assert.ok(cover > 0.01 && cover < 0.99, `the layer of ${node} covers ${(100 * cover).toFixed(1)} % of the terrain`);
    }

    // The picture the Examples tab shows is the 3D picture of this view (tests/ui/library/make-thumbnails.ts
    // draws it at the preview resolution). A node that was recalibrated since, or an example that was edited,
    // leaves a picture of a terrain the project no longer makes.
    const image = name.replace(/\.orogen$/, '.png');
    const scale = { terrainSize: doc.settings.terrainSize, heightRange: doc.settings.heightRange };
    const fresh = view.overlay
      ? drawPreview(fields[text(view.overlay.ref)]!, { style: '3d', height: fields[text(view.height)]!, ...scale })
      : drawPreview(fields[text(view.height)]!, { style: '3d', ...scale });
    const held = decode(fs.readFileSync(path.join(FOLDER, image)));
    assert.deepEqual([held.width, held.height, held.channels, held.depth], [384, 256, 3, 8], image);
    const now = blockMeans(fresh), then = blockMeans({ width: held.width, height: held.height, rgb: held.data });
    let sum = 0, worst = 0;
    for (let i = 0; i < now.length; i++) {
      const off = Math.abs(now[i]! - then[i]!);
      sum += off;
      worst = Math.max(worst, off);
    }
    const mean = sum / now.length;
    assert.ok(mean < PICTURE_MEAN && worst < PICTURE_WORST,
      `examples/${image} is no longer the picture of the project: its blocks are off by ${mean.toFixed(1)} on average and ${worst.toFixed(1)} at the worst. Draw it again: tools/guard --mem=4G node tests/ui/library/make-thumbnails.ts ${name.replace(/\.orogen$/, '')}`);
  });

  test(`examples/${name}: builds at ${BUILD}, and its layers total 255 on every texel`, async () => {
    const doc = load(name);
    const { result, sink } = await buildGraph(doc, { resolution: BUILD });
    assert.deepEqual(result.problems.map((problem) => `${problem.code}: ${problem.message}`), []);
    assert.equal(result.status, 'ok');
    const manifestFile = result.files.at(-1)!.path;
    assert.match(manifestFile, /^[A-Z][A-Za-z]*\.orogen\.json$/);
    for (const file of result.files) assert.equal(sink.files.get(file.path)?.length, file.bytes, `${file.path} is in the folder at its size`);

    const manifest = JSON.parse(new TextDecoder().decode(sink.files.get(manifestFile)!)) as {
      resolution: { x: number; y: number };
      landscape: { layers: { name: string; r8: string; png: string; blend: string; base: boolean; meanWeight: number }[] } | null;
    };
    assert.deepEqual(manifest.resolution, { x: BUILD, y: BUILD });
    assert.ok(manifest.landscape, 'the build wrote a landscape');
    const layers = manifest.landscape.layers;
    if (name === MINIMAL) {
      assert.deepEqual(layers, [], 'a landscape without Landscape Layer nodes has no layer');
      assert.deepEqual(result.files.map((file) => file.path).filter((file) => file.startsWith('Layer')), []);
      return;
    }
    assert.equal(layers.filter((layer) => layer.base).length, 1, 'one base layer');
    assert.ok(layers.every((layer) => layer.blend !== 'none'), 'every layer of an example is weight-blended');

    const raw = layers.map((layer) => {
      const bytes = sink.files.get(layer.r8);
      assert.ok(bytes && bytes.length === BUILD * BUILD, `${layer.name}: one byte for every vertex`);
      return bytes;
    });
    let off = 0;
    for (let i = 0; i < BUILD * BUILD; i++) {
      let total = 0;
      for (const bytes of raw) total += bytes[i]!;
      if (total !== 255) off++;
    }
    assert.equal(off, 0, 'texels whose layer weights do not total 255');
    for (const [at, layer] of layers.entries()) {
      let sum = 0;
      for (let i = 0; i < BUILD * BUILD; i++) sum += raw[at]![i]!;
      const mean = sum / (255 * BUILD * BUILD);
      assert.ok(Math.abs(mean - layer.meanWeight) < 1e-6, `${layer.name}: the manifest says a mean weight of ${layer.meanWeight}, the file holds ${mean}`);
      // A layer that paints nothing, or everything, teaches nothing: every layer of an example shows.
      assert.ok(mean > 0.005 && mean < 0.995, `${layer.name} has a mean weight of ${mean.toFixed(4)}`);
    }
  });
}
