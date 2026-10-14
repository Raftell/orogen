// The numbers Unreal needs, read from a manifest and laid out as the import by hand asks for them
// (export-unreal.md section 6 and 7.2), against the worked example of the contract: the build of 5.6, whose
// manifest is printed in 6.2. And how a build ended, said with what was and was not written.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { landscapeTransform } from '../../../../src/export/unreal.ts';
import { exact, importGroups, importText, parseManifest, parseReport, reportStages, type ImportGroup, type ManifestView } from '../../../../src/app/panels/build/model/manifest.ts';
import { describeOutcome, unwrittenFiles } from '../../../../src/app/panels/build/model/outcome.ts';
import { docOf, FULL, plan, read, resultOf, SOURCES } from './_docs.ts';

const CONTRACT = read('docs/contract/export-unreal.md');

/** The manifest of 6.2: the first JSON block after its heading. */
function exampleManifest(): string {
  const at = CONTRACT.indexOf('### 6.2 Example');
  const open = CONTRACT.indexOf('```json', at);
  const close = CONTRACT.indexOf('```', open + 7);
  assert.ok(at > 0 && open > at && close > open, 'the contract prints the example manifest');
  return CONTRACT.slice(open + 7, close);
}

/** A line of the worked example of 5.6, as the numbers it holds: 'scaleCm (98.4, 98.4, 468.7)' gives the three. */
function worked(name: string): number[] {
  const at = CONTRACT.indexOf('### 5.6 Worked example');
  const block = CONTRACT.slice(at, CONTRACT.indexOf('### 5.7', at));
  const line = block.split('\n').find((candidate) => candidate.startsWith(name));
  assert.ok(line, `5.6 has a line "${name}"`);
  // The contract writes a minus sign as the typographic one.
  return [...line.slice(name.length).replaceAll('−', '-').matchAll(/-?\d+(?:\.\d+)?/g)].map((found) => Number(found[0]));
}

const example = (): ManifestView => {
  const parsed = parseManifest(exampleManifest());
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed.value;
};
const rowsOf = (groups: readonly ImportGroup[]): Record<string, { label: string; value: string; copy: string | null }> =>
  Object.fromEntries(groups.flatMap((group) => group.rows.map((row) => [row.id, { label: row.label, value: row.value, copy: row.copy }])));

// ---- the worked example --------------------------------------------------------------------------------------------------

test('the worked example of the contract, as the New Landscape panel asks for it: 8129, 8 km, 2400 m of relief', () => {
  const manifest = example();
  const groups = importGroups(manifest, 'D:\\Build\\Alps');
  // The order of the import by hand: the file, the layout, the scale, the location, the layers, World Partition, the check, the textures.
  assert.deepEqual(groups.map((group) => [group.id, group.step]), [
    ['heightmap', '3 to 5'], ['layout', '6'], ['scale', '7'], ['location', '8'], ['layers', '10'], ['partition', '11'], ['check', '13'], ['textures', '16'],
  ]);
  const rows = rowsOf(groups);

  // 5.6: "layout 127 quads per section, 2x2 sections, 32 x 32 components"; 8129 vertices per side.
  assert.deepEqual(rows['section-size'], { label: 'Section Size', value: '127x127 quads', copy: '127' });
  assert.deepEqual(rows.sections, { label: 'Sections Per Component', value: '2x2', copy: '2' });
  assert.deepEqual(rows.components, { label: 'Number of Components', value: '32 x 32', copy: '32' });
  assert.deepEqual(rows.resolution, { label: 'Overall Resolution', value: '8129 x 8129', copy: '8129' });

  // 5.6: scaleCm, uiLocationCm and actorLocationCm, each digit of each.
  const [scaleX, scaleY, scaleZ] = worked('scaleCm');
  assert.deepEqual([scaleX, scaleY, scaleZ], [98.4251968503937, 98.4251968503937, 468.75715266651406]);
  assert.deepEqual([rows['scale-x']!.copy, rows['scale-y']!.copy, rows['scale-z']!.copy], ['98.4251968503937', '98.4251968503937', '468.75715266651406']);
  assert.deepEqual([rows['scale-x']!.value, rows['scale-z']!.value], ['98.4251968503937', '468.75715266651406'], 'what is shown is what is copied');
  assert.deepEqual(worked('uiLocationCm'), [0, 0, 105001.8310826276]);
  assert.deepEqual([rows['location-x']!.copy, rows['location-y']!.copy, rows['location-z']!.copy], ['0', '0', '105001.8310826276']);
  assert.deepEqual(worked('actorLocationCm'), [-400000, -400000, 105001.8310826276]);
  assert.deepEqual([rows['actor-x']!.copy, rows['actor-y']!.copy, rows['actor-z']!.copy], ['-400000', '-400000', '105001.8310826276']);
  assert.deepEqual(rows.rotation, { label: 'Rotation', value: '0, 0, 0', copy: null });

  // The text copied reads back to the number of the contract, and is the text the manifest itself holds.
  const source = exampleManifest();
  for (const id of ['scale-x', 'scale-z', 'location-z', 'actor-x', 'actor-z']) {
    assert.ok(source.includes(rows[id]!.copy!), `${id}: ${rows[id]!.copy} is in the manifest as it stands`);
  }
  assert.equal(Number(rows['scale-z']!.copy), scaleZ);

  // 6.2: the layers in the manifest's order, the base first. A row says the kind of layer info and its method on
  // one line; what Unreal calls the two stands in full behind it, and in the note that says what to do with them.
  const layers = groups.find((group) => group.id === 'layers')!;
  assert.deepEqual(
    layers.rows.map((row) => `${row.label} | ${row.value} | ${row.copy}`),
    [
      '1. Base | Weight-Blended, Advanced | Base', 'File | LayerBase.png | D:\\Build\\Alps\\LayerBase.png',
      '2. Grass | Weight-Blended, Advanced | Grass', 'File | LayerGrass.png | D:\\Build\\Alps\\LayerGrass.png',
      '3. Rock | Weight-Blended, Advanced | Rock', 'File | LayerRock.png | D:\\Build\\Alps\\LayerRock.png',
      '4. Flow | Non Weight-Blended | Flow', 'File | LayerFlow.png | D:\\Build\\Alps\\LayerFlow.png',
      'Layer Alphamap Type | Additive | null',
    ],
  );
  assert.deepEqual(layers.rows.filter((row) => row.full !== undefined).map((row) => row.full), [
    'Weight-Blended Layer, Advanced Weight Blending', 'Weight-Blended Layer, Advanced Weight Blending', 'Weight-Blended Layer, Advanced Weight Blending',
    'Non Weight-Blended Layer, No Weight Blending',
  ]);
  assert.equal(
    layers.note,
    'For each layer, in the row of the target layer with the same name: create its layer info, set its Weight Blending Method, and choose its file by hand. '
    + 'Weight-Blended, Advanced: a Weight-Blended Layer info with the method Advanced Weight Blending. '
    + 'Non Weight-Blended: a Non Weight-Blended Layer info with the method No Weight Blending.',
  );
  // The words of the import by hand (7.2 step 10): every kind and every method the rows name is one of its.
  const step = CONTRACT.slice(CONTRACT.indexOf('10. Layers. For each entry'), CONTRACT.indexOf('11. World Partition levels only'));
  for (const words of ['Weight-Blended Layer', 'Non Weight-Blended Layer', 'Advanced Weight Blending', 'Final Weight Blending (Legacy)', 'No Weight Blending', 'Weight Blending Method']) {
    assert.ok(step.includes(words), `step 10 says "${words}"`);
  }
  assert.deepEqual(rows['heightmap-file'], { label: 'Heightmap File', value: 'AlpsHeight.png', copy: 'D:\\Build\\Alps\\AlpsHeight.png' });
  assert.deepEqual(rows['flip-y'], { label: 'Flip Y Axis', value: 'Off', copy: null });
  assert.deepEqual([rows['grid-size']!.copy, rows['region-size']!.copy], ['4', '32']);
  // The textures: sRGB for the color, off for the normal; and the terrain's size, for the sampling formula.
  assert.deepEqual([rows['texture-0'], rows['texture-1']], [
    { label: 'T_Color_8192.png', value: 'sRGB on', copy: 'D:\\Build\\Alps\\T_Color_8192.png' },
    { label: 'T_Normal_8192.png', value: 'sRGB off', copy: 'D:\\Build\\Alps\\T_Normal_8192.png' },
  ]);
  assert.deepEqual(rows['terrain-size'], { label: 'Terrain size', value: '8000 m', copy: '8000' });
});

test('the numbers shown are those the pipeline computes for the worked example (export-unreal.md 5.5)', () => {
  // The project of 5.6, through the pipeline's own arithmetic: what a manifest of that build holds.
  const transform = landscapeTransform({ resolution: 8129, terrainSize: 8000, heightRange: 3000, seaLevel: 0.1, a: 0.05, b: 0.85, zeroAt: 'seaLevel', origin: 'center' });
  const rows = rowsOf(importGroups(example(), null));
  assert.equal(rows['scale-x']!.copy, JSON.stringify(transform.scaleCm.x));
  assert.equal(rows['scale-z']!.copy, JSON.stringify(transform.scaleCm.z));
  assert.equal(rows['location-z']!.copy, JSON.stringify(transform.uiLocationCm.z));
  assert.equal(rows['actor-x']!.copy, JSON.stringify(transform.actorLocationCm.x));
  // Without a folder a file is named, not located.
  assert.equal(rows['heightmap-file']!.copy, 'AlpsHeight.png');
});

test('a number is written as the manifest writes it: the shortest text that reads back to the same value', () => {
  for (const value of [98.4251968503937, 468.75715266651406, 105001.8310826276, -400000, 0, 73.20720416198763, 1e-7, 1.5e21, 0.1 + 0.2]) {
    assert.equal(exact(value), JSON.stringify(value));
    assert.equal(Number(exact(value)), value);
  }
  // JSON has one zero.
  assert.equal(exact(-0), JSON.stringify(-0));
});

test('every row as text for the clipboard: a label, a tab and the value to type', () => {
  const said = importText(importGroups(example(), null)).split('\n');
  assert.deepEqual(said.slice(0, 3), ['Heightmap', 'Heightmap File\tAlpsHeight.png', 'Flip Y Axis\tOff']);
  assert.ok(said.includes('Scale Z\t468.75715266651406'));
  assert.ok(said.includes('Location Z\t105001.8310826276'));
  // A layer's line says what to create for it, in Unreal's words: its button copies the layer's name, which the line has already.
  assert.ok(said.includes('1. Base\tWeight-Blended Layer, Advanced Weight Blending'));
  assert.ok(said.includes('4. Flow\tNon Weight-Blended Layer, No Weight Blending'));
  assert.ok(said.includes('File\tLayerBase.png'));
  assert.ok(said.includes('Section Size\t127'));
  assert.equal(said.at(-1), 'Terrain size\t8000');
});

test('a build without a landscape has no landscape numbers; one without textures no texture rows', () => {
  const none = JSON.parse(exampleManifest()) as Record<string, unknown>;
  const images = parseManifest(JSON.stringify({ ...none, landscape: null, textures: [] }));
  assert.ok(images.ok);
  assert.deepEqual(importGroups(images.value, '/out'), []);
  const flat = parseManifest(JSON.stringify({ ...none, textures: [] }));
  assert.ok(flat.ok);
  assert.deepEqual(importGroups(flat.value, '/out').map((group) => group.id), ['heightmap', 'layout', 'scale', 'location', 'layers', 'partition', 'check']);
  // A landscape without layers has no layer group; World Partition switched off on the node is said.
  const bare = JSON.parse(exampleManifest()) as { landscape: { layers: unknown[]; worldPartition: { enabled: boolean } } };
  bare.landscape.layers = [];
  bare.landscape.worldPartition.enabled = false;
  const parsed = parseManifest(JSON.stringify(bare));
  assert.ok(parsed.ok);
  const groups = importGroups(parsed.value, '/out');
  assert.equal(groups.some((group) => group.id === 'layers'), false);
  assert.match(groups.find((group) => group.id === 'partition')!.note, /switched off on the Unreal Landscape node/);
});

test('a reader rejects what is no manifest, a major version it does not know and a member it needs, and ignores what it does not know', () => {
  const good = JSON.parse(exampleManifest()) as Record<string, unknown>;
  const reason = (value: unknown): string => {
    const parsed = parseManifest(typeof value === 'string' ? value : JSON.stringify(value));
    assert.equal(parsed.ok, false);
    return parsed.ok ? '' : parsed.reason;
  };
  assert.equal(reason('{ not json'), 'The manifest is not JSON');
  assert.equal(reason('[]'), 'The file is no manifest of Orogen');
  assert.equal(reason({ ...good, schema: 'orogen.build-report/1' }), 'The file is no manifest of Orogen');
  assert.equal(reason({ ...good, schema: 'orogen.unreal.landscape/2' }), 'The manifest has the version 2, which this version of Orogen does not read');
  assert.equal(reason({ ...good, resolution: { x: 8129 } }), 'resolution.y is not a number');
  const land = good.landscape as Record<string, unknown>;
  assert.equal(reason({ ...good, landscape: { ...land, transform: { scaleCm: { x: 1, y: 1, z: '468' } } } }), 'landscape.transform.scaleCm.z is not a number');
  assert.equal(reason({ ...good, landscape: { ...land, layers: [{ name: 'A', png: 'a.png', r8: 'a.r8', blend: 'additive', base: false, meanWeight: 0 }] } }), 'landscape.layers[0].blend is "additive", which is no blend method');
  assert.equal(reason({ ...good, files: 'none' }), 'files is not a list');
  // A member a later minor version adds changes nothing.
  const more = parseManifest(JSON.stringify({ ...good, splines: null, somethingNew: { a: 1 }, landscape: { ...land, nanite: true } }));
  assert.ok(more.ok);
  assert.deepEqual(importGroups(more.value, null), importGroups(example(), null));
});

// ---- the report ----------------------------------------------------------------------------------------------------------

test('the report: the time of each stage and of each target, as the report states them', () => {
  const report = {
    schema: 'orogen.build-report/1', status: 'ok', generator: { name: 'Orogen', version: '0.1.0' }, startedUtc: 'a', endedUtc: 'b', durationMs: 4590.5, resolution: 4033,
    problems: [], weightsMs: 310.25, commitMs: 880, height: null, layers: [],
    targets: [
      { nodeId: 'a', nodeType: 'io/export-landscape', title: 'Unreal Landscape', kind: 'landscape', evaluateMs: 1200, exportMs: 900, min: 0, max: 0.75 },
      { nodeId: 'b', nodeType: 'io/export-layer', title: 'Rock', kind: 'layer', evaluateMs: 300, exportMs: 40, min: null, max: null },
    ],
    files: [{ path: 'RidgeHeight.png', bytes: 12 }],
  };
  const parsed = parseReport(JSON.stringify(report));
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.value.status, parsed.value.durationMs, parsed.value.resolution, parsed.value.weightsMs, parsed.value.commitMs], ['ok', 4590.5, 4033, 310.25, 880]);
  assert.deepEqual(parsed.value.targets.map((target) => [target.title, target.evaluateMs, target.exportMs]), [['Unreal Landscape', 1200, 900], ['Rock', 300, 40]]);
  assert.deepEqual(reportStages(parsed.value), [
    { label: 'Compute the nodes', ms: 1500 }, { label: 'Convert and encode', ms: 940 }, { label: 'Layer weights', ms: 310.25 }, { label: 'Finish the files', ms: 880 },
  ]);

  // A build that was cancelled in its first target: the stages it did not reach are not listed, and count for nothing.
  const cut = parseReport(JSON.stringify({ ...report, status: 'aborted', weightsMs: null, commitMs: null, targets: [{ ...report.targets[0], exportMs: 120 }, { ...report.targets[1], evaluateMs: null, exportMs: null }] }));
  assert.ok(cut.ok);
  assert.deepEqual(reportStages(cut.value), [{ label: 'Compute the nodes', ms: 1200 }, { label: 'Convert and encode', ms: 120 }]);

  const not = parseReport(exampleManifest());
  assert.deepEqual(not, { ok: false, reason: 'The file is no build report of Orogen' });
});

// ---- how a build ended -----------------------------------------------------------------------------------------------------

const PLAN = plan(docOf(FULL));
const OUT = '/home/ada/Builds/Ridge';

test('a build that succeeded: what was written, and where', () => {
  const ok = resultOf('ok', { outDir: OUT, manifest: 'Ridge.orogen.json', report: 'Ridge.report.json', files: [{ path: 'RidgeHeight.png', bytes: 3 * 2 ** 20 }, { path: 'Ridge.orogen.json', bytes: 2048 }] });
  const outcome = describeOutcome(ok, OUT, PLAN);
  assert.deepEqual([outcome.tone, outcome.headline, outcome.kept, outcome.folder, outcome.file], ['ok', 'Build finished', null, OUT, 'Ridge.orogen.json']);
  assert.equal(outcome.written, '2 files, 3.0 MB. The output folder holds this build and nothing else.');
  assert.deepEqual(outcome.places, [{ label: 'Output folder', path: OUT }]);
  assert.deepEqual(unwrittenFiles(ok, PLAN), []);

  const warned = describeOutcome({ ...ok, problems: [{ severity: 'warning', code: 'W_LAYER_EMPTY', message: 'x' }, { severity: 'warning', code: 'W_FLAT', message: 'y' }] }, OUT, PLAN);
  assert.deepEqual([warned.tone, warned.headline], ['warning', 'Build finished with 2 warnings']);
  // A build of textures and images alone "finished" too, and has not exported the terrain: the outcome says so.
  const textures = describeOutcome(ok, OUT, plan(docOf({ ...SOURCES, outpaint: { type: 'io/export-color', in: 'paint.out' } })));
  assert.equal(textures.headline, 'Build finished');
  assert.match(textures.written, /No Unreal Landscape node: this build writes no heightmap\./);
  assert.ok(!outcome.written.includes('No Unreal Landscape'));
  // The build it replaced could not be deleted: said, and the build is still a success.
  const leftover = describeOutcome({ ...ok, problems: [{ severity: 'warning', code: 'E_COMMIT_FAILED', message: 'z' }] }, OUT, PLAN);
  assert.match(leftover.written, /The build it replaced could not be deleted and lies beside it\.$/);
});

test('a node that fails, a full disk, a lost device and a cancelled build: nothing was put in place, and the folder is as it was', () => {
  const staging = `${OUT}.partial`;
  const cases = [
    ['errors', 'E_NODE_FAILED', 'Build failed', 'error'],
    ['errors', 'E_WRITE_FAILED', 'Build failed', 'error'],
    ['errors', 'E_NON_FINITE', 'Build failed', 'error'],
    ['device-lost', 'E_DEVICE_LOST', 'Build stopped: device lost', 'error'],
    ['aborted', null, 'Build cancelled', 'neutral'],
  ] as const;
  for (const [status, code, headline, tone] of cases) {
    const result = resultOf(status, {
      outDir: staging, report: 'Ridge.report.json',
      problems: code === null ? [] : [{ severity: 'error', code, message: 'Erosion: ENOSPC: no space left on device, write.' }],
    });
    const outcome = describeOutcome(result, OUT, PLAN);
    const where = `${status} ${code}`;
    assert.deepEqual([outcome.headline, outcome.tone], [headline, tone], where);
    assert.equal(outcome.written, 'Nothing was written to the output folder.', where);
    assert.ok(outcome.kept!.startsWith(`None of the ${PLAN.files.length} planned files was put in place: the folder holds what it held before.`), `${where}: ${outcome.kept}`);
    assert.ok(outcome.kept!.endsWith(' The report of this build lies in a folder beside it, which the next build removes.'), where);
    // The two places it speaks of, each with its whole path.
    assert.deepEqual(outcome.places, [{ label: 'Output folder', path: OUT }, { label: 'Report', path: `${staging}/Ridge.report.json` }], where);
    assert.deepEqual([outcome.folder, outcome.file], [staging, 'Ridge.report.json'], where);
    assert.deepEqual(unwrittenFiles(result, PLAN), PLAN.files.map((file) => file.path), where);
  }
  assert.match(describeOutcome(resultOf('device-lost', { outDir: staging }), OUT, PLAN).kept!, /The build is not resumed: build again when the device is ready\.$/);
  // A report that could not be written is not promised.
  const silent = describeOutcome(resultOf('aborted', { outDir: staging, report: null }), OUT, PLAN);
  assert.deepEqual([silent.kept, silent.places], [`None of the ${PLAN.files.length} planned files was put in place: the folder holds what it held before.`, [{ label: 'Output folder', path: OUT }]]);
});

test('a folder that is refused, a plan with an error and a build that could not be put in place', () => {
  const refused = describeOutcome(resultOf('errors', { problems: [{ severity: 'error', code: 'E_OUT_DIR', message: 'Cannot build into this folder: …' }] }), OUT, null);
  assert.deepEqual([refused.headline, refused.written, refused.folder], ['The output folder was refused', 'Nothing was planned, computed or written.', null]);
  assert.ok(refused.kept!.startsWith('The folder was not touched.'));
  assert.deepEqual(refused.places, [{ label: 'Output folder', path: OUT }]);

  const broken = plan(docOf({ ...SOURCES, loose: { type: 'io/export-normal' } }));
  const unplanned = describeOutcome(resultOf('errors', { problems: broken.problems }), OUT, broken);
  assert.deepEqual([unplanned.headline, unplanned.written, unplanned.kept, unplanned.folder], [
    'The build did not start', 'The plan has an error, so nothing was computed and nothing was written.', 'The output folder holds what it held before.', null,
  ]);

  // The complete build stays beside the output folder (export-unreal.md 3.8 rule 5).
  const stuck = describeOutcome(resultOf('errors', { outDir: `${OUT}.partial`, report: 'Ridge.report.json', problems: [{ severity: 'error', code: 'E_COMMIT_FAILED', message: 'The build is complete but could not be moved' }] }), OUT, PLAN);
  assert.deepEqual([stuck.headline, stuck.written, stuck.kept, stuck.folder], [
    'The build could not be put in place', 'What the build wrote lies in a folder beside the output folder.', 'The output folder holds what it held before.', `${OUT}.partial`,
  ]);
  assert.deepEqual(stuck.places, [{ label: 'Output folder', path: OUT }, { label: 'Written to', path: `${OUT}.partial` }]);

  // Nobody recorded which folder the build was asked for: it is still said that it is as it was.
  const blind = describeOutcome(resultOf('aborted'), null, null);
  assert.deepEqual([blind.kept, blind.places], ['No file was put in place: the folder holds what it held before.', []]);
});
