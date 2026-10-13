// `orogen` as a user runs it (testing.md 8.6): every subcommand as a child process, started through
// tools/guard.mjs, with its exit code, what it prints, and the pictures it writes decoded again. This process
// opens no device; each child opens its own, one at a time, on the adapter the environment selects and, like
// the harness, with the profile `core` unless OROGEN_GPU_PROFILE says otherwise.
//
// Sizes: evaluations at 129 x 129; pictures of at most 1808 x 512 pixels, read in loops. What is written stays
// in <OROGEN_TEST_OUTPUT>/cli for a person to look at.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decode } from 'fast-png';

import { nodes } from '../../../src/core/nodes/index.ts';
import { nodes as refNodes } from '../../../src/core/nodes/ref/index.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUTPUT = path.join(path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output')), 'cli');
const PROFILE = process.env.OROGEN_GPU_PROFILE || 'core';
const RES = 129;
/** The first terrain a rendered node is given: the product's eroded noise where it has one, else ref/fbm (testing.md 2.4). */
const FIRST_TERRAIN = nodes.some((def) => def.type === 'generate/eroded-noise') ? 'generate/eroded-noise' : 'ref/fbm';

// Pictures of an earlier run would stand in for pictures this one failed to write.
fs.rmSync(OUTPUT, { recursive: true, force: true });

interface Done { readonly code: number | null; readonly out: string; readonly err: string }

/** Runs `orogen` with the arguments. `set` replaces variables of the environment. */
function orogen(args: readonly string[], set: Readonly<Record<string, string>> = {}): Done {
  const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_GPU_PROFILE: PROFILE, ...set };
  delete env.NODE_TEST_CONTEXT;
  const done = spawnSync(process.execPath, [path.join('tools', 'guard.mjs'), 'node', path.join('src', 'cli', 'main.ts'), ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 << 20,
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

interface RenderLine {
  readonly type: string; readonly res: number; readonly wallMs: number; readonly gpuMs: number | null;
  readonly longestSliceMs: number; readonly peakBytes: number; readonly files: readonly string[];
}

/** The one JSON line `render` prints on standard output, and that it prints nothing else there. */
function lineOf(done: Done): RenderLine {
  const lines = done.out.split('\n').filter((text) => text !== '');
  assert.equal(lines.length, 1, `standard output holds one line: ${JSON.stringify(done.out.slice(0, 400))}\n${done.err}`);
  const line = JSON.parse(lines[0]!) as RenderLine;
  assert.deepEqual(Object.keys(line), ['type', 'res', 'wallMs', 'gpuMs', 'longestSliceMs', 'peakBytes', 'files']);
  return line;
}

/** What `render` says on standard error when a slice measured above the hard ceiling (testing.md 8.6). */
const OVER_CEILING = /^orogen render: a slice took \d+ ms, above the hard ceiling of 500 ms/m;

/**
 * The JSON line of a render that drew its node. Such a run ends with 0, or with 1 when it says that a slice
 * measured above the hard ceiling: a software adapter on a busy machine can take that long over any slice, and
 * how long a slice takes is not for a test to say (testing.md 8.3).
 */
function rendered(done: Done): RenderLine {
  const over = OVER_CEILING.test(done.err);
  assert.equal(done.code, over ? 1 : 0, done.err);
  const line = lineOf(done);
  assert.ok(over ? line.longestSliceMs >= 500 : line.longestSliceMs <= 500, `longestSliceMs ${line.longestSliceMs}\n${done.err}`);
  return line;
}

interface Png { readonly width: number; readonly height: number; readonly data: ArrayLike<number> }
function read(file: string): Png {
  const png = decode(fs.readFileSync(file));
  assert.deepEqual([png.channels, png.depth], [3, 8], `${file} is an 8-bit RGB PNG`);
  return png;
}

/** Over the columns x0 <= x < x1 of a picture: the darkest and the brightest red value, and how many pixels are not the background of a 3d view. */
function look(png: Png, x0: number, x1: number): { readonly spread: number; readonly drawn: number; readonly tinted: number } {
  let lo = 255, hi = 0, drawn = 0, tinted = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * png.width + x) * 3;
      const r = png.data[at]!, g = png.data[at + 1]!, b = png.data[at + 2]!;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
      if (r !== 0x1a || g !== 0x1a || b !== 0x1a) drawn++;
      if (r > b + 30) tinted++;
    }
  }
  return { spread: hi - lo, drawn: drawn / (png.height * (x1 - x0)), tinted: tinted / (png.height * (x1 - x0)) };
}

/** A sheet of a terrain: 1808 x 512, with a grey picture, a hillshade and a 3d view that all show relief. */
function expectSheet(file: string, what: string): Png {
  const png = read(file);
  assert.deepEqual([png.width, png.height], [1808, 512], what);
  const grey = look(png, 0, 512), shade = look(png, 520, 1032), view = look(png, 1040, 1808);
  assert.ok(grey.spread >= 60, `${what}: the grey picture spans ${grey.spread} of 255 levels; a flat field spans none`);
  assert.ok(shade.spread >= 60, `${what}: the hillshade spans ${shade.spread} of 255 levels`);
  assert.ok(view.drawn > 0.2 && view.drawn < 0.95, `${what}: the 3d view covers ${(100 * view.drawn).toFixed(0)} % of its panel`);
  return png;
}

const fileOf = (out: string, type: string, name: string): string => path.join(out, 'nodes', ...type.split('/'), name);

test('orogen probe prints the capabilities of the device as indented JSON, and nothing else on standard output', () => {
  const done = orogen(['probe', '--profile', 'core']);
  assert.equal(done.code, 0, done.err);
  const caps = JSON.parse(done.out) as {
    adapter: { description: string; device: string }; software: boolean; features: string[]; compactFormats: boolean; timestampQuery: boolean;
    limits: { maxTextureDimension2D: number; maxStorageTexturesPerShaderStage: number }; formats: Record<string, string>; vramBytes: number | null;
  };
  assert.equal(done.out, `${JSON.stringify(caps, null, 2)}\n`);
  assert.ok(caps.adapter.description.length + caps.adapter.device.length > 0, 'the adapter is named');
  assert.equal(typeof caps.software, 'boolean');
  // --profile core: default limits and no optional feature, whatever the adapter offers and the environment says.
  assert.deepEqual([caps.compactFormats, caps.timestampQuery, caps.limits.maxTextureDimension2D, caps.limits.maxStorageTexturesPerShaderStage], [false, false, 8192, 4]);
  assert.deepEqual([caps.formats.field, caps.formats.half, caps.formats.mask8], ['r32float', 'r32float', 'r32float']);

  // The profile of the environment, as every CI job runs it first.
  const ambient = orogen(['probe']);
  assert.equal(ambient.code, 0, ambient.err);
  assert.ok((JSON.parse(ambient.out) as typeof caps).limits.maxTextureDimension2D >= 8192);

  // The line a device logs when OROGEN_GPU_LOG asks for it goes to standard error: the output is still one document.
  const logged = orogen(['probe', '--profile', 'core'], { OROGEN_GPU_LOG: '1' });
  assert.equal(logged.code, 0, logged.err);
  assert.deepEqual(JSON.parse(logged.out), caps);
  assert.match(logged.err, /^\[orogen\] gpu \{/m);
});

test('orogen: an adapter nobody has ends with exit code 3, before anything is printed or written', () => {
  const probe = orogen(['probe', '--adapter', 'no-adapter-has-this-name']);
  assert.deepEqual([probe.code, probe.out], [3, ''], probe.err);
  assert.match(probe.err, /^orogen: No WebGPU adapter is available.*adapter "no-adapter-has-this-name" was asked for/m);

  const out = path.join(OUTPUT, 'no-device');
  const render = orogen(['render', 'ref/fbm', '--res', String(RES), '--out', out, '--adapter', 'no-adapter-has-this-name']);
  assert.deepEqual([render.code, render.out], [3, ''], render.err);
  assert.equal(fs.existsSync(out), false);
  const gallery = orogen(['gallery', '--category', 'ref', '--res', String(RES), '--out', out], { OROGEN_GPU_ADAPTER: 'no-adapter-has-this-name' });
  assert.deepEqual([gallery.code, gallery.out], [3, ''], gallery.err);
  assert.equal(fs.existsSync(path.join(out, 'gallery')), false);
});

test('orogen render ref/fbm: a sheet of the output, and one JSON line that says what was measured', () => {
  const out = path.join(OUTPUT, 'fbm');
  const line = rendered(orogen(['render', 'ref/fbm', '--res', String(RES), '--out', out]));
  assert.deepEqual([line.type, line.res, line.files], ['ref/fbm', RES, [fileOf(out, 'ref/fbm', 'out-129.png')]]);
  // One r32float field of 129 x 129 at least: the output itself.
  assert.ok(line.peakBytes >= RES * RES * 4, `peakBytes ${line.peakBytes}`);
  // The longest slice the device measured: 0 where a slice this short is not resolved by wall clock (runtime.md 3.5).
  assert.ok(line.wallMs > 0 && line.longestSliceMs >= 0, `wallMs ${line.wallMs}, longestSliceMs ${line.longestSliceMs}`);
  assert.ok(line.gpuMs === null || line.gpuMs >= 0, `gpuMs ${String(line.gpuMs)}`);
  expectSheet(line.files[0]!, 'ref/fbm.out');
  assert.deepEqual(fs.readdirSync(path.join(out, 'nodes', 'ref', 'fbm')), ['out-129.png'], 'nothing else is left in the folder');
});

test('orogen render ref/talus --crop --param: every output as a sheet and as a one-to-one crop, the data output over the terrain the node made', () => {
  const out = path.join(OUTPUT, 'talus');
  // A low talus angle and a long reach: much of a fractal terrain collapses, so `moved` is not empty.
  const line = rendered(orogen(['render', 'ref/talus', '--res', String(RES), '--crop', '64', '--param', 'talus=20', '--param', 'reach=0.05', '--out', out]));
  assert.deepEqual([line.type, line.res], ['ref/talus', RES]);
  assert.deepEqual(line.files, ['out-129.png', 'out-129-crop.png', 'moved-129.png', 'moved-129-crop.png'].map((name) => fileOf(out, 'ref/talus', name)));

  expectSheet(line.files[0]!, 'ref/talus.out');
  const crop = read(line.files[1]!);
  assert.deepEqual([crop.width, crop.height], [64, 64]);
  assert.ok(look(crop, 0, 64).spread >= 40, 'the crop shows relief');

  // `moved` is a data output: drawn with the range of its own values, over `out`, the terrain the node made of its input.
  const moved = expectSheet(line.files[2]!, 'ref/talus.moved');
  assert.ok(look(moved, 0, 512).spread >= 250, 'the grey picture reaches from nothing moved to the most that moved');
  const tinted = look(moved, 520, 1032).tinted;
  assert.ok(tinted > 0.01 && tinted < 0.99, `${(100 * tinted).toFixed(1)} % of the terrain is tinted by what moved`);
  const movedCrop = read(line.files[3]!);
  assert.deepEqual([movedCrop.width, movedCrop.height], [64, 64]);
  assert.ok(look(movedCrop, 0, 64).tinted > 0.01);
});

test('orogen render --max-params --seed: the parameters reach the node', () => {
  const picture = (name: string, args: readonly string[]): Png => {
    const out = path.join(OUTPUT, name);
    return read(rendered(orogen(['render', 'ref/fbm', '--res', String(RES), '--out', out, ...args])).files[0]!);
  };
  /** The share of the grey picture's pixels that differ between two sheets. */
  const differing = (a: Png, b: Png): number => {
    let count = 0;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (a.data[(y * a.width + x) * 3] !== b.data[(y * b.width + x) * 3]) count++;
    return count / (512 * 512);
  };
  const plain = picture('fbm-plain', []);
  const again = picture('fbm-again', []);
  assert.equal(differing(plain, again), 0, 'the same arguments give the same picture');
  const seeded = picture('fbm-seed', ['--seed', '7']);
  assert.ok(differing(plain, seeded) > 0.5, `--seed 7 changes ${(100 * differing(plain, seeded)).toFixed(0)} % of the picture`);
  // size 4, octaves 16, gain 1: another terrain again, and not the seeded one.
  const maxed = picture('fbm-max', ['--max-params']);
  assert.ok(differing(plain, maxed) > 0.5 && differing(seeded, maxed) > 0.5);
  const octave = picture('fbm-param', ['--param', 'octaves=1']);
  assert.ok(differing(plain, octave) > 0.5);
});

/** The share of the grey picture's pixels that differ between two sheets. */
function differingGrey(a: Png, b: Png): number {
  let count = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (a.data[(y * a.width + x) * 3] !== b.data[(y * b.width + x) * 3]) count++;
  return count / (512 * 512);
}

test('orogen render of a node with two inputs: each is fed a terrain of its own, and --connected connects the optional mask', () => {
  const sheet = (name: string, type: string, args: readonly string[]): { readonly png: Png; readonly files: readonly string[] } => {
    const out = path.join(OUTPUT, name);
    const { files } = rendered(orogen(['render', type, '--res', String(RES), '--out', out, ...args]));
    return { png: expectSheet(files[0]!, `${type} ${args.join(' ')}`), files };
  };
  // mode mix at strength 1 gives the second input: the node is shown its `b`, which is not its `a`.
  const second = sheet('combine-b', 'ref/combine', ['--param', 'strength=1']);
  const first = sheet('combine-a', 'ref/combine', ['--param', 'strength=0']);
  assert.ok(differingGrey(first.png, second.png) > 0.5, 'the two inputs are two terrains');
  // The first is the first terrain at its defaults, the second ref/fbm with seed 1 and feature size 0.1 (testing.md 2.4).
  assert.equal(differingGrey(first.png, sheet('combine-first', FIRST_TERRAIN, []).png), 0);
  assert.equal(differingGrey(second.png, sheet('combine-fbm1', 'ref/fbm', ['--seed', '1', '--param', 'size=0.1']).png), 0);
  assert.deepEqual(second.files, [fileOf(path.join(OUTPUT, 'combine-b'), 'ref/combine', 'out-129.png')], 'without --connected the optional mask is unconnected');

  // --connected: `b` only where the slope mask of the first terrain selects, in files of their own.
  const masked = sheet('combine-connected', 'ref/combine', ['--param', 'strength=1', '--connected']);
  assert.deepEqual(masked.files, [fileOf(path.join(OUTPUT, 'combine-connected'), 'ref/combine', 'out-129-connected.png')]);
  const fromB = differingGrey(masked.png, second.png), fromA = differingGrey(masked.png, first.png);
  assert.ok(fromB > 0.05 && fromA > 0.05, `under the mask ${(100 * fromB).toFixed(0)} % of the picture differs from b and ${(100 * fromA).toFixed(0)} % from a`);

  // The mask the evaluator gives a maskable node: the blur acts on the steep ground alone.
  const blurred = sheet('blur-plain', 'ref/blur', ['--param', 'radius=0.05']);
  const partly = sheet('blur-connected', 'ref/blur', ['--param', 'radius=0.05', '--connected', '--crop', '64']);
  assert.deepEqual(partly.files, ['out-129-connected.png', 'out-129-connected-crop.png'].map((name) => fileOf(path.join(OUTPUT, 'blur-connected'), 'ref/blur', name)));
  assert.ok(differingGrey(blurred.png, partly.png) > 0.05);

  // A node without an optional input that is not maskable has no connected variant.
  const refused = orogen(['render', 'ref/fbm', '--connected', '--out', path.join(OUTPUT, 'refused')]);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /--connected connects the optional inputs of a node and the mask of a maskable one, and ref\/fbm has no optional input and is not maskable/);
});

test('orogen render ref/distance: a node whose input is a mask is drawn over the terrain the mask was made of', () => {
  const out = path.join(OUTPUT, 'distance');
  const line = rendered(orogen(['render', 'ref/distance', '--res', String(RES), '--out', out]));
  assert.deepEqual(line.files, [fileOf(out, 'ref/distance', 'out-129.png')]);
  const png = read(line.files[0]!);
  assert.deepEqual([png.width, png.height], [1808, 512]);
  // The data output with the range of its own values, then the terrain shaded and tinted by it, flat and in 3d.
  assert.ok(look(png, 0, 512).spread >= 250, 'the grey picture reaches from 0 to the largest distance');
  const shade = look(png, 520, 1032);
  assert.ok(shade.spread >= 60, `the hillshade shows the relief of the terrain under the mask (${shade.spread} levels)`);
  assert.ok(shade.tinted > 0.01 && shade.tinted < 0.99, `${(100 * shade.tinted).toFixed(1)} % of that terrain is tinted by the distance`);
  const view = look(png, 1040, 1808);
  assert.ok(view.drawn > 0.2 && view.drawn < 0.95, 'the 3d view is a terrain, not a plane');
});

/** A project file with a ref/fbm feeding a ref/talus, and a ref/talus nothing is connected to. */
function writeProject(file: string): void {
  const node = (id: string, type: string, params: Record<string, unknown> = {}): Record<string, unknown> => ({ id, type, version: 1, position: { x: 0, y: 0 }, params });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    format: 'orogen', version: 1,
    // The preview resolution is level 2 of 513: 129.
    settings: { terrainSize: 2048, heightRange: 512, seed: 3, buildResolution: 513, previewLevel: 2, seaLevel: 0 },
    nodes: { noise: node('noise', 'ref/fbm', { octaves: 5 }), talus: node('talus', 'ref/talus', { talus: 25 }), lonely: node('lonely', 'ref/talus') },
    edges: { e1: { id: 'e1', from: { node: 'noise', port: 'out' }, to: { node: 'talus', port: 'in' } } },
    groups: {}, ui: {},
  }, null, 2));
}

test('orogen render <project.orogen> --node: a node of a project at the project\'s preview resolution, or at --res', () => {
  const out = path.join(OUTPUT, 'project');
  const project = path.join(out, 'small.orogen');
  writeProject(project);

  const line = rendered(orogen(['render', project, '--node', 'talus', '--out', out]));
  assert.deepEqual([line.type, line.res], ['ref/talus', 129]);
  assert.deepEqual(line.files, ['out-129.png', 'moved-129.png'].map((name) => fileOf(out, 'ref/talus', name)));
  expectSheet(line.files[0]!, 'talus.out of the project');
  expectSheet(line.files[1]!, 'talus.moved of the project');

  const fine = rendered(orogen(['render', project, '--node', 'noise', '--res', '257', '--crop', '100', '--out', out]));
  assert.deepEqual([fine.type, fine.res, fine.files], ['ref/fbm', 257, ['out-257.png', 'out-257-crop.png'].map((name) => fileOf(out, 'ref/fbm', name))]);
  const crop = read(fine.files[1]!);
  assert.deepEqual([crop.width, crop.height], [100, 100]);
});

test('orogen render: a node that fails ends with exit code 1, its error on standard error, and the JSON line without pictures', () => {
  const out = path.join(OUTPUT, 'failed');
  const project = path.join(out, 'small.orogen');
  writeProject(project);
  const done = orogen(['render', project, '--node', 'lonely', '--out', out]);
  assert.equal(done.code, 1, done.err);
  assert.match(done.err, /^orogen render: ref\/talus \(node "lonely"\) failed, missing-input: missing input "in"$/m);
  const line = lineOf(done);
  assert.deepEqual([line.type, line.res, line.wallMs, line.gpuMs, line.peakBytes, line.files], ['ref/talus', 129, 0, null, 0, []]);
  assert.equal(fs.existsSync(path.join(out, 'nodes')), false, 'no picture of a node that did not run');
});

test('orogen gallery --category ref: every reference node rendered, the page a reviewer reads, and an index that links it', () => {
  const out = path.join(OUTPUT, 'gallery');
  // A conformance report in the output folder is shown with its node.
  fs.mkdirSync(path.join(out, 'conformance', 'ref'), { recursive: true });
  fs.writeFileSync(path.join(out, 'conformance', 'ref', 'fbm.json'), JSON.stringify({ adapter: { description: 'the adapter of this test' }, profile: 'core', checks: { finite: { result: 'passed' } }, optOuts: [], budget: null }));
  // The page an earlier run left of another category stays, and the index links it; a file that is no such page is not listed.
  fs.mkdirSync(path.join(out, 'gallery'), { recursive: true });
  const earlier = '<!doctype html><html><head><meta name="orogen-gallery" content="{&quot;category&quot;:&quot;filter&quot;,&quot;nodes&quot;:14,&quot;failed&quot;:0,&quot;res&quot;:513,&quot;adapter&quot;:&quot;an earlier adapter&quot;,&quot;software&quot;:false,&quot;profile&quot;:&quot;max&quot;}"></head></html>';
  fs.writeFileSync(path.join(out, 'gallery', 'filter.html'), earlier);
  fs.writeFileSync(path.join(out, 'gallery', 'select.html'), '<!doctype html><html><head><title>Not a gallery page</title></head></html>');

  const done = orogen(['gallery', '--category', 'ref', '--res', String(RES), '--out', out]);
  assert.equal(done.code, 0, done.err);
  // The page of the category asked for is what is printed: gallery/<category>.html, not one page for everything.
  const file = path.join(out, 'gallery', 'ref.html');
  assert.equal(done.out, `${file}\n`);
  const page = fs.readFileSync(file, 'utf8');

  const index = fs.readFileSync(path.join(out, 'gallery', 'index.html'), 'utf8');
  assert.deepEqual([...index.matchAll(/<a href="([a-z]+)\.html">/g)].map((found) => found[1]), ['filter', 'ref'], 'the categories drawn into the folder, in the order of the categories');
  assert.ok(index.includes('<p>14 nodes at 513 × 513</p><p>an earlier adapter · profile max</p>'));
  assert.ok(!index.includes('<article'), 'the index holds no node');
  assert.equal(fs.readFileSync(path.join(out, 'gallery', 'filter.html'), 'utf8'), earlier, 'the page of another category is left as it was');
  assert.ok(page.includes('<a href="index.html">all categories</a>'));

  const withOutputs = refNodes.filter((def) => def.outputs.length > 0);
  assert.ok(withOutputs.some((def) => def.type === 'ref/fbm') && withOutputs.some((def) => def.type === 'ref/talus'));
  assert.equal(page.split('<article ').length - 1, withOutputs.length, 'one article per reference node with outputs');
  const hasSecond = (def: (typeof refNodes)[number]): boolean => def.maskable === true || def.inputs.some((port) => port.optional === true);
  for (const def of withOutputs) {
    assert.ok(page.includes(`id="${def.type.replace('/', '-')}"`) && page.includes(`<code class="type">${def.type}</code>`), `${def.type} is on the page`);
    const picture = fileOf(out, def.type, `out-${RES}.png`);
    if (def.params.some((param) => param.kind === 'file')) {
      // Its defaults select no file: listed with its error, and not what the exit code counts.
      assert.equal(fs.existsSync(picture), false, def.type);
      assert.match(page, new RegExp(`<article class="node broken" id="${def.type.replace('/', '-')}">`));
      continue;
    }
    assert.ok(page.includes(`<img src="../nodes/${def.type}/out-${RES}.png"`), `the page shows outputs[0] of ${def.type}`);
    const png = read(picture);
    const expected = def.outputs[0]!.type === 'color' ? [RES, RES] : [1808, 512];
    assert.deepEqual([png.width, png.height], expected, def.type);
    assert.ok(look(png, 0, Math.min(png.width, 512)).spread >= 40, `${def.type}: the picture of outputs[0] is not flat`);
    // A secondary output is drawn, and shown on the page beside the first: in both variants.
    for (const port of def.outputs.slice(1)) {
      assert.ok(fs.existsSync(fileOf(out, def.type, `${port.name}-${RES}.png`)), `${def.type}.${port.name}`);
      assert.ok(page.includes(`<img src="../nodes/${def.type}/${port.name}-${RES}.png"`), `the page shows ${port.name} of ${def.type}`);
      assert.equal(page.includes(`<img src="../nodes/${def.type}/${port.name}-${RES}-connected.png"`), hasSecond(def), `${def.type}.${port.name}, connected`);
    }
    // The second variant of a node with an optional input or a mask: outputs[0] with them connected, shown below the plain picture.
    assert.equal(fs.existsSync(fileOf(out, def.type, `out-${RES}-connected.png`)), hasSecond(def), `${def.type}: the connected variant`);
    assert.equal(page.includes(`<img src="../nodes/${def.type}/out-${RES}-connected.png"`), hasSecond(def), `${def.type}: the connected picture on the page`);
  }
  assert.deepEqual(withOutputs.filter(hasSecond).map((def) => def.type), ['ref/blur', 'ref/colorize', 'ref/combine', 'ref/talus']);

  // A node with two or more connected inputs shows what each was given: ref/combine its two terrains, and with
  // its mask connected the mask as well. A node with one input shows none in its plain variant.
  for (const [name, size] of [['input-a-129.png', RES], ['input-b-129.png', RES], ['input-a-129-connected.png', RES], ['input-mask-129-connected.png', RES]] as const) {
    const given = read(fileOf(out, 'ref/combine', name));
    assert.deepEqual([given.width, given.height], [size, size], name);
    assert.ok(look(given, 0, size).spread >= 60, `${name} is not flat`);
    assert.ok(page.includes(`<img src="../nodes/ref/combine/${name}"`), `${name} is on the page`);
  }
  assert.equal(fs.existsSync(fileOf(out, 'ref/blur', 'input-in-129.png')), false, 'one input: the terrain every picture starts from');
  assert.ok(fs.existsSync(fileOf(out, 'ref/blur', 'input-mask-129-connected.png')), 'with its mask connected a maskable node has two');
  // The mask is black and white: a picture of where a node is let act.
  const mask = read(fileOf(out, 'ref/combine', 'input-mask-129-connected.png'));
  let black = 0, white = 0;
  for (let i = 0; i < RES * RES * 3; i += 3) {
    if (mask.data[i] === 0) black++;
    if (mask.data[i] === 255) white++;
  }
  assert.ok(black > 0.1 * RES * RES && white > 0.1 * RES * RES, `the mask selects ${white} texels in full and leaves ${black} out, of ${RES * RES}`);

  assert.match(page, new RegExp(`${withOutputs.length} nodes of the category ref at ${RES} × ${RES}`));
  assert.ok(page.includes('Checked on the adapter of this test, profile core.'));
  assert.match(done.err, new RegExp(`^orogen gallery: ${withOutputs.length}/${withOutputs.length} `, 'm'));
});

test('orogen gallery: a node that reads a file is drawn with the file of its conformance call, once the output folder holds its report', () => {
  const out = path.join(OUTPUT, 'gallery-file');
  // What the node's test file writes (testing.md 3.6 rule 2): the parameters of its conformance call, the file as an absolute path.
  const image = path.join(ROOT, 'tests', 'graphs', 'assets', 'heights-253.png');
  fs.mkdirSync(path.join(out, 'conformance', 'ref'), { recursive: true });
  fs.writeFileSync(path.join(out, 'conformance', 'ref', 'image.json'), JSON.stringify({ type: 'ref/image', checks: {}, optOuts: [], budget: null, params: { file: image } }));
  // The report of a node without a file parameter holds parameters too: those are not applied, the gallery shows defaults.
  fs.writeFileSync(path.join(out, 'conformance', 'ref', 'fbm.json'), JSON.stringify({ type: 'ref/fbm', checks: {}, optOuts: [], budget: null, params: { size: 0.01 } }));

  const done = orogen(['gallery', '--category', 'ref', '--res', String(RES), '--out', out]);
  assert.equal(done.code, 0, done.err);
  const page = fs.readFileSync(path.join(out, 'gallery', 'ref.html'), 'utf8');
  const article = page.slice(page.indexOf('id="ref-image"'), page.indexOf('</article>', page.indexOf('id="ref-image"')));
  assert.ok(article.includes('<p class="quiet">Drawn with the parameters of its conformance call: <code>file</code> = tests/graphs/assets/heights-253.png.</p>'), 'the page names the file, from the working directory');
  assert.ok(article.includes(`<img src="../nodes/ref/image/out-${RES}.png"`) && !article.includes('Not rendered'));
  // The picture is that of the file: the terrain fixture, which has relief.
  expectSheet(fileOf(out, 'ref/image', `out-${RES}.png`), 'ref/image with the file of its conformance call');
  assert.ok(!page.includes('class="node broken"'), 'no node of the page failed');
  // Only a node with a file parameter is drawn with what its report holds: the others show their defaults.
  assert.ok(!page.slice(page.indexOf('id="ref-fbm"'), page.indexOf('</article>', page.indexOf('id="ref-fbm"'))).includes('Drawn with the parameters'));
});

test('orogen build fails with a message until src/export/cli.ts implements it', () => {
  const out = path.join(OUTPUT, 'built');
  const done = orogen(['build', path.join(OUTPUT, 'project', 'no-such.orogen'), '--out', out]);
  assert.notEqual(done.code, 0, 'a build of a project that does not exist cannot succeed');
  assert.notEqual(done.code, null, 'the program ended by itself');
  assert.equal(done.out, '');
  assert.ok(done.err.trim().length > 0, 'it says why');
  assert.equal(fs.existsSync(out), false, 'nothing was written');
  if (!fs.existsSync(path.join(ROOT, 'src', 'export', 'cli.ts'))) {
    assert.equal(done.code, 2);
    assert.match(done.err, /^orogen build: this build of Orogen has no build pipeline: .*src\/export\/cli\.ts/m);
  }
});
