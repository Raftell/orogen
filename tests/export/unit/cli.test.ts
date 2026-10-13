// `orogen unreal-test` as a user runs it (export-unreal.md 3.11, section 9): the two forms as child processes,
// with their exit codes and what they print. It needs no GPU.
//
// What is written stays under <OROGEN_TEST_OUTPUT>/export-unreal-test-<process id> until the file has run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRATCH = path.join(path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output')), `export-unreal-test-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

interface Done { readonly code: number | null; readonly out: string; readonly err: string }
function orogen(args: readonly string[]): Done {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const done = spawnSync(process.execPath, [path.join('tools', 'guard.mjs'), 'node', path.join('src', 'cli', 'main.ts'), 'unreal-test', ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 << 20,
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

const N = 1009;
const OUT = path.join(SCRATCH, 'marker');
const FILES = [
  'LayerBase.png', 'LayerBase.r8', 'LayerLeft.png', 'LayerLeft.r8', 'LayerTop.png', 'LayerTop.r8', 'Marker.orogen.json', 'Marker.report.json',
  'MarkerHeight.png', 'MarkerHeight.r16', 'T_Marker_1024.png',
];

test('unreal-test --out writes the build Marker into the folder and prints the path of its manifest', () => {
  const done = orogen(['--out', OUT]);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, `${path.join(OUT, 'Marker.orogen.json')}\n`, 'standard output carries the path of the manifest and nothing else');
  assert.deepEqual(fs.readdirSync(OUT).sort(), FILES);
  assert.deepEqual([fs.existsSync(`${OUT}.partial`), fs.existsSync(`${OUT}.previous`)], [false, false]);
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'Marker.orogen.json'), 'utf8')) as { resolution: { x: number }; landscape: { transform: { uiLocationCm: { x: number } } } };
  assert.deepEqual([manifest.resolution.x, manifest.landscape.transform.uiLocationCm.x], [N, 50400]);
  assert.equal(fs.statSync(path.join(OUT, 'MarkerHeight.r16')).size, 2 * N * N);

  // A relative folder is taken from the working directory, and --res chooses another size of the pattern; the folder is replaced.
  const relative = path.relative(ROOT, OUT);
  const larger = orogen(['--out', relative, '--res=2017']);
  assert.equal(larger.code, 0, larger.err);
  assert.equal(larger.out, `${path.join(OUT, 'Marker.orogen.json')}\n`);
  assert.equal(fs.statSync(path.join(OUT, 'MarkerHeight.r16')).size, 2 * 2017 * 2017);
  assert.deepEqual(fs.readdirSync(OUT).sort(), FILES);
  // Back to 1009 for the checks below.
  assert.equal(orogen(['--out', OUT]).code, 0);
});

test('unreal-test --check accepts the heightmap of the pattern, as PNG and as .r16, and reports a planted difference with exit code 1', () => {
  for (const name of ['MarkerHeight.png', 'MarkerHeight.r16']) {
    const same = orogen(['--check', path.join(OUT, name)]);
    assert.equal(same.code, 0, same.err);
    assert.equal(same.out, `0 of ${N * N} samples differ from the pattern; the largest difference is 0 codes\n`, name);
  }
  // Two samples changed: the first of the file, in the tower, and one on the plain.
  const changed = fs.readFileSync(path.join(OUT, 'MarkerHeight.r16'));
  changed.writeUInt16LE(65535 - 300, 0);
  changed.writeUInt16LE(32768 + 1, 2 * (700 * N + 40));
  const planted = path.join(SCRATCH, 'changed.r16');
  fs.writeFileSync(planted, changed);
  const differs = orogen(['--check', planted, '--res', String(N)]);
  assert.equal(differs.code, 1, differs.err);
  assert.equal(differs.out, `2 of ${N * N} samples differ from the pattern; the largest difference is 300 codes\nthe first is at column 0, row 0: 65235 where the pattern has 65535\n`);

  // A heightmap of another size than the pattern asked for, and a file that is no heightmap.
  const size = orogen(['--check', path.join(OUT, 'MarkerHeight.r16'), '--res', '2017']);
  assert.equal(size.code, 1);
  assert.match(size.err, /is 1009 x 1009 with 1 channel; the pattern at 2017 is 2017 x 2017 with one/);
  const color = orogen(['--check', path.join(OUT, 'T_Marker_1024.png')]);
  assert.equal(color.code, 1);
  assert.match(color.err, /is 1024 x 1024 with 3 channels/);
  const text = orogen(['--check', path.join(OUT, 'Marker.orogen.json')]);
  assert.equal(text.code, 1);
  assert.match(text.err, /is not a heightmap that can be compared/);
  for (const done of [size, color, text]) assert.equal(done.out, '');
});

test('unreal-test refuses a folder that is not its own with exit code 1, and wrong arguments with exit code 2', () => {
  const foreign = path.join(SCRATCH, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
  const refused = orogen(['--out', foreign]);
  assert.equal(refused.code, 1);
  assert.equal(refused.out, '');
  assert.match(refused.err, /^orogen unreal-test: error E_OUT_DIR: Cannot build into this folder: /m);
  assert.deepEqual(fs.readdirSync(foreign), ['notes.txt']);

  const usage: readonly (readonly [readonly string[], RegExp])[] = [
    [[], /give --out <dir> to write the pattern, or --check <file>/],
    [['--out', OUT, '--check', path.join(OUT, 'MarkerHeight.png')], /--out and --check are two forms of the command/],
    [['--out', path.join(SCRATCH, 'never'), '--res', '1000'], /--res 1000 is not a resolution of the pattern; it is 1009, 2017, 4033, 8129/],
    [['--out', path.join(SCRATCH, 'never'), '--res', 'big'], /--res "big" is not a resolution of the pattern/],
    [['--out', path.join(SCRATCH, 'never'), '--fast'], /there is no option "--fast"/],
    [['--out', path.join(SCRATCH, 'never'), 'extra'], /takes no argument such as "extra"/],
    [['--out'], /--out needs a value/],
    [['--check', path.join(SCRATCH, 'no-such-file.r16')], /Cannot read .*no-such-file\.r16/],
  ];
  for (const [args, message] of usage) {
    const done = orogen(args);
    assert.equal(done.code, 2, `orogen unreal-test ${args.join(' ')}: ${done.err}`);
    assert.equal(done.out, '', 'nothing on standard output');
    assert.match(done.err, message);
    assert.match(done.err, /^usage: orogen unreal-test --out <dir> \[--res <n>\]$/m);
  }
  assert.equal(fs.existsSync(path.join(SCRATCH, 'never')), false, 'a usage error writes nothing');
});
