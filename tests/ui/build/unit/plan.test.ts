// The plan and its problems as the panel presents them (export-unreal.md 2.5, 3.3): every export target with
// its files, their format and size; every problem with its code in plain words and the node it concerns; the
// resolutions the panel offers; and what a build needs of the graphics memory. The plans are the pipeline's own.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BuildProblem } from '../../../../src/core/runtime.ts';
import { landscapeLayout } from '../../../../src/export/unreal.ts';
import { ENCODING_LABEL, exportNodes, knownProblems, viewPlan } from '../../../../src/app/panels/build/model/plan.ts';
import { firstProblemNode, PROBLEM_TEXT, viewProblems } from '../../../../src/app/panels/build/model/problems.ts';
import {
  colorBytes, describeLayout, describeSpacing, estimateMemory, fieldBytes, LANDSCAPE_SIZES, metresPerVertex, presetLayout, resolutionOptions,
} from '../../../../src/app/panels/build/model/sizes.ts';
import { docOf, FULL, plan, read, REGISTRY, SOURCES } from './_docs.ts';

const CONTRACT = read('docs/contract/export-unreal.md');

// ---- the plan ----------------------------------------------------------------------------------------------------------

test('a plan is shown target by target: each export node with its files, their format, pixels and size', () => {
  const doc = docOf(FULL);
  const made = plan(doc);
  assert.equal(made.ok, true, JSON.stringify(made.problems));
  const view = viewPlan(made, doc, REGISTRY);

  assert.deepEqual(view.targets.map((target) => `${target.kind} ${target.title}: ${target.files.map((file) => file.path).join(' ')}`), [
    'landscape Unreal Landscape: RidgeHeight.png RidgeHeight.r16',
    'base Base: LayerBase.png LayerBase.r8',
    'layer Rock Layer: LayerRock.png LayerRock.r8',
    'layer Landscape Layer: LayerFlow.png LayerFlow.r8',
    'texture Color Texture: T_Color_1024.png',
    'texture Mask Texture: T_Mask_1024.png',
    'texture Normal Texture: T_Normal_1024.png',
    'image Image File: Heights.exr',
    'manifest Manifest: Ridge.orogen.json',
  ]);
  // Every file of the plan is under exactly one target, in the plan's order within it.
  assert.deepEqual(view.targets.flatMap((target) => target.files.map((file) => file.path)).sort(), made.files.map((file) => file.path).sort());
  assert.equal(view.fileCount, made.files.length);

  const files = new Map(view.targets.flatMap((target) => target.files.map((file) => [file.path, file] as const)));
  assert.deepEqual(files.get('RidgeHeight.png'), { path: 'RidgeHeight.png', format: 'PNG, 16-bit gray', pixels: '1009 × 1009', bytes: null });
  assert.deepEqual(files.get('RidgeHeight.r16'), { path: 'RidgeHeight.r16', format: 'Raw, 16-bit', pixels: '1009 × 1009', bytes: 2 * 1009 * 1009 });
  assert.deepEqual(files.get('LayerRock.r8'), { path: 'LayerRock.r8', format: 'Raw, 8-bit', pixels: '1009 × 1009', bytes: 1009 * 1009 });
  assert.deepEqual(files.get('T_Color_1024.png'), { path: 'T_Color_1024.png', format: 'PNG, 8-bit RGB', pixels: '1024 × 1024', bytes: null });
  assert.deepEqual(files.get('T_Mask_1024.png')!.format, 'PNG, 16-bit gray');
  assert.deepEqual(files.get('Heights.exr')!.format, 'OpenEXR, 32-bit float');
  assert.deepEqual(files.get('Ridge.orogen.json'), { path: 'Ridge.orogen.json', format: 'JSON', pixels: '', bytes: null });

  // What is known in advance is the plan's own sum; the files a PNG or JSON makes are counted, not guessed.
  assert.equal(view.knownBytes, made.estimate.knownFileBytes);
  assert.equal(view.unsizedFiles, made.files.filter((file) => file.bytes === null).length);
  assert.equal(view.planeBytes, 2 * 1009 * 1009, 'one weight-blended layer is held in main memory as 16-bit codes');
  assert.equal(view.layout, '8 × 8 components of 2 × 2 sections, 63 × 63 quads each');

  // An export node can be selected; the base layer and the manifest are no node.
  assert.deepEqual(view.targets.filter((target) => target.selectable).map((target) => target.nodeId), ['outland', 'outrock', 'outflow', 'outpaint', 'outmask', 'outnormal', 'outexr']);
  assert.deepEqual(view.targets.filter((target) => !target.selectable).map((target) => target.kind), ['base', 'manifest']);

  const detail = Object.fromEntries(view.targets.map((target) => [target.key.replace(/^\d+:/, ''), target.detail]));
  assert.equal(detail.outland, 'Landscape Ridge: heights over the measured range, dithered');
  assert.equal(detail.outrock, 'Layer Rock: weight-blended (advanced)');
  assert.equal(detail.outflow, 'Layer Flow: an independent mask');
  assert.match(detail.base!, /^The base layer: what the weight-blended layers leave \(advanced\)/);
  assert.match(detail.outpaint!, /^Color texture: sRGB/);
  assert.match(detail.outmask!, /^Mask texture: 16 bits/);
});

test('every encoding a plan can name has a label', () => {
  const declared = /type FileEncoding =([^;]+);/.exec(CONTRACT)![1]!.match(/'[a-z0-9-]+'/g)!.map((quoted) => quoted.slice(1, -1));
  assert.deepEqual(Object.keys(ENCODING_LABEL).sort(), [...declared].sort());
});

test('a plan of a node that is gone, and a plan without a landscape, are shown as they are', () => {
  const doc = docOf({ ...SOURCES, outexr: { type: 'io/export-field', params: { name: 'Heights', format: 'tiff16' }, in: 'land.out' } });
  const view = viewPlan(plan(doc), docOf(SOURCES), REGISTRY);
  assert.deepEqual(view.targets.map((target) => [target.kind, target.title, target.selectable]), [['image', 'outexr', false], ['manifest', 'Manifest', false]]);
  assert.equal(view.layout, null);
  assert.equal(view.targets[0]!.files[0]!.format, 'TIFF, 16-bit');
  assert.equal(view.planeBytes, 0);
});

test('a plan with an error is shown as one, and a plan of nothing lists no file: a build never writes a manifest alone', () => {
  // One export has no input: the plan has an error, and the rest of it is what a build would write once that is mended.
  const broken = plan(docOf({ ...FULL, outloose: { type: 'io/export-normal', params: { name: 'Loose' } } }));
  assert.equal(broken.ok, false);
  const view = viewPlan(broken, docOf(FULL), REGISTRY);
  assert.equal(view.ok, false);
  assert.equal(view.fileCount, broken.files.length);
  assert.ok(view.targets.some((target) => target.kind === 'landscape'));
  // Nothing to export: the pipeline's plan still names the manifest; shown, it would read as a file the build writes.
  const empty = plan(docOf(SOURCES));
  assert.deepEqual([empty.ok, empty.items.length, empty.files.map((file) => file.encoding)], [false, 0, ['json']]);
  assert.deepEqual(viewPlan(empty, docOf(SOURCES), REGISTRY), { ok: false, resolution: 1009, layout: null, targets: [], fileCount: 0, knownBytes: 0, unsizedFiles: 0, planeBytes: 0 });
});

test('before any plan: the export nodes of the document, each by what it exports, whether it is switched on and what feeds it', () => {
  const fbm = REGISTRY.get('ref/fbm')!.title;
  const slope = REGISTRY.get('ref/slope-mask')!.title;
  const doc = docOf({
    ...SOURCES,
    outland: { type: 'io/export-landscape', in: 'land.out', title: 'Alps' },
    outrock: { type: 'io/export-layer', params: { enabled: false }, in: 'steep.out' },
    outloose: { type: 'io/export-normal' },
    outstale: { type: 'io/export-mask', in: 'gone.out' },
  });
  assert.deepEqual(exportNodes(doc, REGISTRY), [
    // The landscape first, then its layers, then the textures and the images, whatever the ids are.
    { nodeId: 'outland', title: 'Alps', typeTitle: 'Unreal Landscape', name: 'Orogen', enabled: true, source: fbm },
    { nodeId: 'outrock', title: 'Landscape Layer', typeTitle: 'Landscape Layer', name: 'Layer', enabled: false, source: slope },
    // An edge from a node the document does not hold is no connection, to the evaluator and here.
    { nodeId: 'outstale', title: 'Mask Texture', typeTitle: 'Mask Texture', name: 'Mask', enabled: true, source: null },
    { nodeId: 'outloose', title: 'Normal Texture', typeTitle: 'Normal Texture', name: 'Normal', enabled: true, source: null },
  ]);
  assert.deepEqual(exportNodes(docOf(SOURCES), REGISTRY), [], 'a document without an export node has none');
});

test('the layers of a project are told apart by their names, and stand in the order a plan lists them in', () => {
  // Six layers whose nodes bear one title and read one mask: the name each gives its layer is all that differs.
  const names = ['Scree', 'rock', 'Grass', 'Snow', 'Cliff', 'Mud'];
  const doc = docOf({
    ...SOURCES,
    outland: { type: 'io/export-landscape', params: { name: 'Ridge' }, in: 'land.out' },
    ...Object.fromEntries(names.map((layer, i) => [`z${9 - i}`, { type: 'io/export-layer', params: { layer }, in: 'steep.out' }])),
    outheights: { type: 'io/export-field', params: { name: 'Heights' }, in: 'land.out' },
  });
  const found = exportNodes(doc, REGISTRY);
  assert.deepEqual(found.map((node) => `${node.typeTitle}: ${node.name}`), [
    'Unreal Landscape: Ridge',
    'Landscape Layer: Cliff', 'Landscape Layer: Grass', 'Landscape Layer: Mud', 'Landscape Layer: rock', 'Landscape Layer: Scree', 'Landscape Layer: Snow',
    'Image File: Heights',
  ]);
  // The plan's own order of the same layers (3.3 step 4), and the names it gives them: the first text parameter is the name.
  const planned = plan(doc);
  assert.deepEqual(planned.items.map(({ item }) => (item.kind === 'layer' ? item.layer : item.kind === 'texture' ? '' : item.name)), found.map((node) => node.name));
  assert.deepEqual(planned.items.map(({ nodeId }) => nodeId), found.map((node) => node.nodeId));
  // Every export node of the product names what it exports in a text parameter: none is listed without a name.
  for (const type of ['io/export-landscape', 'io/export-layer', 'io/export-color', 'io/export-mask', 'io/export-normal', 'io/export-field']) {
    const [node] = exportNodes(docOf({ one: { type } }), REGISTRY);
    assert.ok(node!.name !== '', `${type} has a name`);
  }
});

test('what the document alone settles of a plan is what the plan says of it, in the plan\'s codes', () => {
  /** The problems the panel says before a build, and those of them the pipeline's plan reports, by code and node. */
  const both = (doc: ReturnType<typeof docOf>): [string[], string[]] => {
    const key = (problem: BuildProblem): string => `${problem.severity} ${problem.code} ${problem.nodeId ?? ''}`.trim();
    const known = knownProblems(exportNodes(doc, REGISTRY)).map(key).sort();
    return [known, plan(doc).problems.map(key).filter((problem) => /E_NOTHING_TO_EXPORT|E_INPUT_MISSING/.test(problem)).sort()];
  };
  // Nothing to export: no export node at all, and every export node switched off.
  for (const doc of [docOf(SOURCES), docOf({ ...SOURCES, outland: { type: 'io/export-landscape', params: { enabled: false }, in: 'land.out' } })]) {
    const [known, planned] = both(doc);
    assert.deepEqual(known, ['error E_NOTHING_TO_EXPORT']);
    assert.deepEqual(planned, known);
  }
  assert.match(knownProblems([])[0]!.message, /^The project has no export node/);
  assert.match(knownProblems(exportNodes(docOf({ outland: { type: 'io/export-landscape', params: { enabled: false } } }), REGISTRY))[0]!.message, /^Every export node is switched off/);

  // Inputs that are missing: one problem per node, each naming its node; a node that is switched off is no problem.
  const loose = docOf({
    ...FULL,
    outloose: { type: 'io/export-normal', params: { name: 'Loose' }, title: 'Cliff Normals' },
    outstale: { type: 'io/export-mask', params: { name: 'Stale' }, in: 'gone.out' },
    outoff: { type: 'io/export-field', params: { enabled: false } },
  });
  const [known, planned] = both(loose);
  assert.deepEqual(known, ['error E_INPUT_MISSING outloose', 'error E_INPUT_MISSING outstale']);
  assert.deepEqual(planned, known);
  assert.equal(knownProblems(exportNodes(loose, REGISTRY)).find((problem) => problem.nodeId === 'outloose')!.message, 'Cliff Normals: nothing is connected to its input.');
  // They are shown as the problems of a build are: in plain words, with the node to select.
  const shown = viewProblems(knownProblems(exportNodes(loose, REGISTRY)), loose);
  assert.deepEqual(shown.map((problem) => [problem.title, problem.code, problem.nodeId]), [
    ['An export node has no input', 'E_INPUT_MISSING', 'outstale'], ['An export node has no input', 'E_INPUT_MISSING', 'outloose'],
  ]);

  // A project a build can plan: the document says nothing against it, and neither does the plan.
  assert.deepEqual(both(docOf(FULL)), [[], []]);
  // What only a plan can know is not guessed at: two layers that would write one file are no problem here.
  const collide = docOf({ ...FULL, outrock2: { type: 'io/export-layer', params: { layer: 'Rock1' }, in: 'steep.out' }, outrock3: { type: 'io/export-layer', params: { layer: 'Rock2' }, in: 'steep.out' } });
  assert.deepEqual(knownProblems(exportNodes(collide, REGISTRY)), []);
  assert.ok(plan(collide).problems.some((problem) => problem.code === 'E_FILE_COLLISION'));
});

// ---- problems ----------------------------------------------------------------------------------------------------------

test('every problem code of the contract is explained in plain words, as a title and what to do', () => {
  const declared = /type BuildProblemCode =([^;]+);/.exec(CONTRACT)![1]!.match(/'[EW]_[A-Z_]+'/g)!.map((quoted) => quoted.slice(1, -1));
  assert.equal(declared.length, 27);
  assert.deepEqual(Object.keys(PROBLEM_TEXT).sort(), [...declared].sort());
  // And every code the user documentation lists (building.md, section 9).
  const documented = read('docs/user/building.md').match(/`[EW]_[A-Z_]+`/g)!.map((quoted) => quoted.slice(1, -1));
  for (const code of new Set(documented)) assert.ok(Object.hasOwn(PROBLEM_TEXT, code), code);

  for (const [code, text] of Object.entries(PROBLEM_TEXT)) {
    // testing.md 6.2: a title is capitalised and has no full stop; the advice is one or two sentences that end with one.
    assert.match(text.title, /^[A-Z][^.]*$/, `${code}: ${text.title}`);
    assert.ok(text.title.length <= 60, `${code}: the title is short`);
    assert.match(text.advice, /^[A-Z].*\.$/, `${code}: ${text.advice}`);
    assert.ok(text.advice.length <= 200, `${code}: the advice has ${text.advice.length} characters`);
    assert.doesNotMatch(`${text.title} ${text.advice}`, /\b(colour|centre|grey|normalise)\b/i, `${code}: American spelling (testing.md section 6)`);
    assert.doesNotMatch(`${text.title} ${text.advice}`, /E_|W_|planBuild|nodeId/, `${code}: no internal names`);
  }
});

test('the problems of a plan: errors first, each with its node when the document still holds it', () => {
  const doc = docOf({
    ...SOURCES,
    outland: { type: 'io/export-landscape', params: { name: 'Ridge', regionComponents: 4 }, in: 'land.out' },
    outa: { type: 'io/export-layer', params: { layer: 'Rock1' }, in: 'steep.out', title: 'First Rock' },
    outb: { type: 'io/export-layer', params: { layer: 'Rock2' }, in: 'steep.out' },
    outloose: { type: 'io/export-normal' },
  });
  const made = plan(doc);
  assert.equal(made.ok, false);
  const views = viewProblems(made.problems, doc);
  assert.deepEqual(views.map((view) => view.severity), [...views.filter((v) => v.severity === 'error').map(() => 'error'), ...views.filter((v) => v.severity === 'warning').map(() => 'warning')]);
  assert.deepEqual([...new Set(views.map((view) => view.code))].sort(), ['E_FILE_COLLISION', 'E_INPUT_MISSING', 'W_REGION_SIZE']);

  const missing = views.find((view) => view.code === 'E_INPUT_MISSING')!;
  assert.deepEqual([missing.title, missing.nodeId, missing.severity], ['An export node has no input', 'outloose', 'error']);
  assert.match(missing.message, /^Normal Texture: nothing is connected/, 'the pipeline\'s sentence names the node by its title');
  assert.equal(missing.advice, PROBLEM_TEXT.E_INPUT_MISSING.advice);
  // Two layers of one file name collide in their PNG and in their raw file: two problems, both shown.
  assert.equal(views.filter((view) => view.code === 'E_FILE_COLLISION').length, 2);
  assert.equal(views.find((view) => view.code === 'W_REGION_SIZE')!.nodeId, 'outland');

  assert.equal(firstProblemNode(made.problems, doc), views.find((view) => view.nodeId !== null)!.nodeId);
  // A node that was deleted since cannot be selected; the problem is still said.
  const { outloose: _gone, ...rest } = doc.nodes;
  const after = viewProblems(made.problems, { nodes: rest });
  assert.equal(after.find((view) => view.code === 'E_INPUT_MISSING')!.nodeId, null);
  assert.equal(after.length, views.length);
});

test('a problem reported twice is shown once, and one of a code this version does not know with its sentence alone', () => {
  const twice: BuildProblem = { severity: 'error', code: 'E_NODE_FAILED', message: 'Erosion: The device ran out of memory.', nodeId: 'n1' };
  const unknown = { severity: 'warning', code: 'W_FROM_THE_FUTURE', message: 'Something new.' } as unknown as BuildProblem;
  const views = viewProblems([unknown, twice, twice], { nodes: {} });
  assert.deepEqual(views.map((view) => [view.code, view.title, view.advice === '', view.nodeId]), [
    ['E_NODE_FAILED', 'A node failed while computing', false, null],
    ['W_FROM_THE_FUTURE', 'A problem this version of Orogen does not know', true, null],
  ]);
  assert.equal(firstProblemNode([twice], { nodes: {} }), null);
  assert.deepEqual(viewProblems([], { nodes: {} }), []);
});

// ---- resolutions -------------------------------------------------------------------------------------------------------

test('the resolutions offered are the rows of the contract\'s table, with the layout the pipeline derives for each', () => {
  // The table of export-unreal.md 5.2: | N | quads per section | sections per component | components | total | quads per side |
  const rows = [...CONTRACT.matchAll(/^\| (\d+) \| (\d+) \| (\d) \(\dx\d\) \| (\d+) × \d+ \| (\d+) \| (\d+) \|$/gm)].map((row) => row.slice(1, 7).map(Number));
  assert.equal(rows.length, 4);
  assert.deepEqual(
    LANDSCAPE_SIZES.map((size) => [size.resolution, size.quadsPerSection, size.sectionsPerComponent, size.components, size.totalComponents, size.resolution - 1]),
    rows,
  );
  for (const size of LANDSCAPE_SIZES) {
    assert.deepEqual({ ...landscapeLayout(size.resolution) }, { quadsPerSection: size.quadsPerSection, sectionsPerComponent: size.sectionsPerComponent, components: size.components, totalComponents: size.totalComponents });
    assert.equal(size.components * size.sectionsPerComponent * size.quadsPerSection + 1, size.resolution);
    assert.deepEqual(presetLayout(size.resolution), size);
  }
  assert.equal(presetLayout(2049), null);
  assert.equal(describeLayout(presetLayout(8129)!), '32 × 32 components of 2 × 2 sections, 127 × 127 quads each');

  assert.deepEqual(resolutionOptions(4033).map((option) => option.label), ['1009 × 1009', '2017 × 2017', '4033 × 4033', '8129 × 8129']);
  // A project's own size is shown as it is stored, so that it can be seen and replaced.
  assert.deepEqual(resolutionOptions(241)[0], { value: '241', label: '241 × 241 (custom)' });
  assert.equal(resolutionOptions(241).length, 5);
  // A size the project had stays in the list when another is chosen: the list does not change under the choice.
  assert.deepEqual(resolutionOptions(1009, [241]).map((option) => option.value), ['241', '1009', '2017', '4033', '8129']);
  assert.deepEqual(resolutionOptions(241, [241, 1009]).map((option) => option.value), resolutionOptions(1009, [241, 1009]).map((option) => option.value));
  assert.deepEqual(resolutionOptions(497, [241, 2017, 241]).map((option) => option.value), ['241', '497', '1009', '2017', '4033', '8129']);
});

test('the distance between vertices divides by the quads, not by the vertices (export-unreal.md 5.5)', () => {
  assert.equal(metresPerVertex({ terrainSize: 8000 }, 8129), 8000 / 8128);
  assert.equal(describeSpacing({ terrainSize: 8000 }, 8129), '98.4 cm per vertex');
  assert.equal(describeSpacing({ terrainSize: 8128 }, 8129), '1 m per vertex');
  assert.equal(describeSpacing({ terrainSize: 2000 }, 1009), '1.98 m per vertex');
  assert.equal(describeSpacing({ terrainSize: 4032 }, 1009), '4 m per vertex');
});

// ---- memory ------------------------------------------------------------------------------------------------------------

test('one field and one color map at 8129 are what the contract says they are', () => {
  // export-unreal.md 3.7: "One 8129² field is 264.3 MB on the GPU, one color 528.6 MB" (in millions of bytes).
  assert.equal((fieldBytes(8129) / 1e6).toFixed(1), '264.3');
  assert.equal((colorBytes(8129) / 1e6).toFixed(1), '528.6');
});

test('the memory a build needs at the least: what is held, and the largest node of the preview scaled by the samples', () => {
  const budget = { budgetBytes: 4 * 2 ** 30, reservedBytes: 100 * 2 ** 20, pinnedBytes: 8 * 2 ** 20 };
  const peaks = {
    erosion: { bytes: 60 * 2 ** 20, resolution: 1009 },
    noise: { bytes: 8 * 2 ** 20, resolution: 1009 },
    deleted: { bytes: 900 * 2 ** 20, resolution: 1009 },
    // Measured at a coarser level, as a draft is: scaled from there.
    blur: { bytes: 4 * 2 ** 20, resolution: 505 },
  };
  const at4033 = estimateMemory({ resolution: 4033, budget, peaks, nodeIds: ['erosion', 'noise', 'blur', 'never-ran'] });
  const scaled = Math.round(60 * 2 ** 20 * (4033 * 4033) / (1009 * 1009));
  assert.deepEqual(at4033.largest, { nodeId: 'erosion', bytes: scaled, measuredAt: 1009 });
  assert.equal(at4033.heldBytes, 108 * 2 ** 20);
  assert.equal(at4033.needBytes, 108 * 2 ** 20 + scaled);
  assert.equal(at4033.fieldBytes, 4033 * 4033 * 4);
  assert.equal(at4033.level, 'fits');
  assert.ok(Math.abs(at4033.share! - at4033.needBytes / budget.budgetBytes) < 1e-12);

  // Four times the samples per side doubled: 8129 needs four times as much, which is over this budget.
  const at8129 = estimateMemory({ resolution: 8129, budget, peaks, nodeIds: ['erosion', 'noise', 'blur'] });
  assert.ok(Math.abs(at8129.largest!.bytes / at4033.largest!.bytes - (8129 * 8129) / (4033 * 4033)) < 1e-6);
  assert.equal(at8129.level, 'tight');
  assert.equal(estimateMemory({ resolution: 8129, budget: { ...budget, budgetBytes: 3 * 2 ** 30 }, peaks, nodeIds: ['erosion'] }).level, 'over');

  // The node measured at 505 holds four times as much at 1009.
  const blur = estimateMemory({ resolution: 1009, budget, peaks, nodeIds: ['blur'] });
  assert.equal(blur.largest!.measuredAt, 505);
  assert.ok(Math.abs(blur.largest!.bytes - 4 * 2 ** 20 * (1009 * 1009) / (505 * 505)) <= 1);

  // Nothing measured: one field is the least any build holds. Without a budget nothing is said of fitting.
  const blind = estimateMemory({ resolution: 1009, budget: null, peaks: {}, nodeIds: ['erosion'] });
  assert.deepEqual([blind.largest, blind.needBytes, blind.share, blind.level, blind.budgetBytes], [null, 1009 * 1009 * 4, null, 'unknown', null]);
  // A field that does not fit beside what is held is over, measured or not.
  assert.equal(estimateMemory({ resolution: 8129, budget: { budgetBytes: 300 * 2 ** 20, reservedBytes: 100 * 2 ** 20, pinnedBytes: 0 }, peaks: {}, nodeIds: [] }).level, 'over');
});
