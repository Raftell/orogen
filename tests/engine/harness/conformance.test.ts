// The conformance suite, proved on nodes that break it (testing.md section 3). bad-nodes.ts holds one small
// broken node for each check and a few sound ones; this file runs it as a test file of its own, in a child
// process, and reads which cases failed and what they said. The checks that are decided at registration are
// tested here directly.
//
// This process opens no device: the child has the GPU to itself. Its output is kept to its last megabyte.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';

import fbm from '../../../src/core/nodes/ref/fbm.ts';
import talus from '../../../src/core/nodes/ref/talus.ts';
import { conformance } from '../../helpers/index.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BASE = process.env.OROGEN_TEST_OUTPUT ? path.resolve(process.env.OROGEN_TEST_OUTPUT) : path.join(ROOT, 'test-output');
/** Where the child writes its previews and reports: apart from those of the real nodes. */
const OUTPUT = path.join(BASE, 'harness', 'conformance');
const CHILD_TIMEOUT_MS = 240_000;
const KEPT_OUTPUT = 1 << 20;

type Result = 'passed' | 'failed' | 'skipped' | 'not-applicable' | 'not-run';
interface Report {
  readonly type: string;
  readonly adapter: { readonly description: string; readonly device: string; readonly software: boolean } | null;
  readonly profile: string | null;
  readonly compactFormats: boolean | null;
  readonly checks: Readonly<Record<string, { readonly result: Result; readonly reason?: string; readonly message?: string }>>;
  readonly optOuts: readonly { readonly check: string; readonly kind: string; readonly value?: number; readonly reason: string }[];
  readonly budget: { readonly estimateBytes: number; readonly asserted: boolean } | null;
}

let child: { readonly code: number | null; readonly output: string } | null = null;

before(async () => {
  rmSync(OUTPUT, { recursive: true, force: true });
  child = await new Promise((resolve, reject) => {
    // The child is a test runner of its own: it must not inherit the marks of this one.
    const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_TEST_OUTPUT: OUTPUT };
    delete env.NODE_TEST_CONTEXT;
    const started = spawn(process.execPath, ['--test', '--test-reporter=tap', 'tests/engine/harness/bad-nodes.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8').replaceAll('\r\n', '\n')).slice(-KEPT_OUTPUT); };
    started.stdout.on('data', keep);
    started.stderr.on('data', keep);
    const timer = setTimeout(() => started.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    started.on('error', (thrown) => { clearTimeout(timer); reject(thrown); });
    started.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
});

function report(name: string): Report {
  const file = path.join(OUTPUT, 'conformance', 'ref', `${name}.json`);
  assert.ok(existsSync(file), `the suite of ref/${name} wrote its report. The end of the child's output:\n${child?.output.slice(-3000)}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Report;
}
const withResult = (r: Report, result: Result): string[] => Object.keys(r.checks).filter((check) => r.checks[check]!.result === result);

interface Expectation {
  /** The checks that fail, all of them. */
  readonly fails: readonly string[];
  /** Checks that may fail as well: what the mistake does to them depends on the pool or on the timing. */
  readonly mayFail?: readonly string[];
  /** What the message of a failed check says. */
  readonly says?: Readonly<Record<string, RegExp>>;
}

const BASIC = ['finite', 'deterministic', 'resolution', 'short-ladder', 'budget', 'abort', 'slicing'];
const BROKEN: Readonly<Record<string, Expectation>> = {
  'bad-meta': { fails: ['meta'], says: { meta: /^The node breaks a rule of testing\.md section 4:\ndescription ref\/bad-meta: the description begins with "This"/ } },
  // A value that is not finite, or a mask outside 0..1, fails every run: each asserts the basic assertions.
  'bad-finite': { fails: BASIC, says: { finite: /^R257: output "out": 1 of 66049 values are not finite; the first is NaN at \(7, 9\)$/, 'short-ladder': /^at 33, where ctx\.ladder is \[33\]: output "out": 1 of 1089 values/ } },
  'bad-mask': { fails: [...BASIC, 'mask-range'], says: { 'mask-range': /^R257: output "out": \d+ of 66049 values are outside \[0, 1\]; the first is 1\.\d+ at \(\d+, \d+\)$/ } },
  'bad-alpha': { fails: ['alpha'], says: { alpha: /^output "out": alpha is not 1 on 66049 of 66049 texels; the first is 0\.5 at \(0, 0\)$/ } },
  'bad-range': { fails: ['generator-range'], says: { 'generator-range': /^output "out" at 257: the span max - min is 0\.(1|09)\d*, below 0\.5$/ } },
  'bad-recycled': {
    fails: ['deterministic'], mayFail: ['resolution', 'abort', 'slicing'],
    says: { deterministic: /^output "out", the second run at 257 against the first \(the first runs on new textures, the second on recycled ones\): 66049 of 66049 values are not bit-identical/ },
  },
  'bad-px': { fails: ['resolution'], says: { resolution: /^output "out", 513 against 257 at shared vertices: max difference 0\.\d+; a generator is a function of uv, allowed 1e-6$/ } },
  'bad-tolerance': { fails: ['resolution'], says: { resolution: /^output "out", 513 against 257 at shared vertices: rms difference \S+ is 0\.0[23]\d* of the standard deviation \S+; allowed 0\.01 of it/ } },
  'bad-divide': { fails: ['params'], says: { params: /^at 129 with \{"size":0\}: the node failed \([a-z-]+\): .*Infinity/ } },
  'bad-optional': { fails: ['optional-unbound'], says: { 'optional-unbound': /^at 129 with the optional inputs guide unconnected: the node failed \(binding\): kernel "ref\/bad-optional" \(node node, ref\/bad-optional\): .*guide/ } },
  'bad-ladder': { fails: ['short-ladder'], says: { 'short-ladder': /^at 33, where ctx\.ladder is \[33\]: the node failed \([a-z-]+\): / } },
  'bad-neutral': { fails: ['mask-neutral'], says: { 'mask-neutral': /^output "out", `mask` unconnected against a mask of ones: max difference 0\.4\d* at \(\d+, \d+\): \S+ vs \S+; allowed 1e-6$/ } },
  'bad-seed': { fails: ['seed'], says: { seed: /^with the node seed raised from 0 to 1 no output differs in more than 1 % of its values \("out": 0 %\)$/ } },
  'bad-wants': { fails: ['wants'], says: { wants: /^output "out" wanted alone against wanted with the others: 16641 of 16641 values are not bit-identical/ } },
  'bad-abort': { fails: ['abort'], says: { abort: /^output "out", the run after the aborted one against R129: 16641 of 16641 values are not bit-identical/ } },
  // Batches also differ between 257 and 513: a kernel new to a ladder level fills its first slices by texels (runtime.md 3.4).
  'bad-slicing': { fails: ['slicing'], mayFail: ['abort', 'deterministic', 'resolution'], says: { slicing: /^output "out" with slices "small" against R129: 16641 of 16641 values are not bit-identical/ } },
};
const SOUND = ['good-shelf', 'good-tolerance', 'good-any', 'good-tone'];

test('the child ran every suite and failed, as a run with broken nodes does', () => {
  assert.ok(child, 'the child was started');
  assert.equal(child.code, 1, `node --test exits with 1 when a case fails. The end of its output:\n${child.output.slice(-3000)}`);
  for (const name of [...Object.keys(BROKEN), ...SOUND, 'bad-race', 'bad-budget', 'bad-export']) report(name);
});

test('each broken node fails the check it breaks, and the message says what was found', () => {
  for (const [name, expected] of Object.entries(BROKEN)) {
    const r = report(name);
    const failed = withResult(r, 'failed');
    const unexpected = failed.filter((check) => !expected.fails.includes(check) && !(expected.mayFail ?? []).includes(check));
    const missing = expected.fails.filter((check) => !failed.includes(check));
    assert.deepEqual([unexpected, missing], [[], []], `ref/${name}: checks that failed and should not have, and checks that should have failed (failed: ${failed.join(', ')})`);
    for (const [check, pattern] of Object.entries(expected.says ?? {})) assert.match(r.checks[check]!.message ?? '', pattern, `ref/${name} / ${check}`);
    assert.equal(r.checks.leaks!.result, 'passed', `ref/${name}: a node cannot leak, and none of these runs did`);
    // A case is named <type> / <check>.
    for (const check of expected.fails) assert.match(child!.output, new RegExp(`^\\s*not ok \\d+ - ref/${name} / ${check}$`, 'm'));
  }
});

test('every check that applies to a sound node passes, in both variants of an `any` input', () => {
  for (const name of SOUND) {
    const r = report(name);
    assert.deepEqual(withResult(r, 'failed'), [], `ref/${name}: ${JSON.stringify(Object.fromEntries(withResult(r, 'failed').map((c) => [c, r.checks[c]!.message])))}`);
    assert.deepEqual(withResult(r, 'not-run'), [], `ref/${name}: every case that applies ran`);
  }
  const any = report('good-any');
  assert.deepEqual(withResult(any, 'not-applicable'), ['generator-range', 'deterministic-large'], 'an input, and no kernel with unsafeReadWrite');
  assert.deepEqual(withResult(any, 'passed').length + withResult(any, 'skipped').length, 16);
  // The colour variant has its own pictures.
  for (const picture of ['out', 'out-color', 'level', 'level-color']) assert.ok(existsSync(path.join(OUTPUT, 'nodes', 'ref', 'good-any', `${picture}.png`)), `${picture}.png`);
  assert.deepEqual(withResult(report('good-tone'), 'not-applicable'), ['mask-range', 'generator-range', 'deterministic-large', 'optional-unbound', 'mask-neutral', 'seed', 'wants']);
  assert.ok(existsSync(path.join(OUTPUT, 'nodes', 'ref', 'good-tone', 'out.png')));
});

test('an opt-out is reported as skipped with its reason, and listed in the report', () => {
  const shelf = report('good-shelf');
  const reason = 'Outputs a single shallow shape by design; its span is 0.1.';
  assert.deepEqual(shelf.checks['generator-range'], { result: 'skipped', reason });
  assert.deepEqual(shelf.optOuts, [{ check: 'generator-range', kind: 'skip', reason }]);
  assert.match(child!.output, /^\s*ok \d+ - ref\/good-shelf \/ generator-range # SKIP Outputs a single shallow shape by design; its span is 0\.1\.$/m);
  // The same generator without the opt-out fails the check: the opt-out is what stands between.
  assert.equal(report('bad-range').checks['generator-range']!.result, 'failed');

  const tolerance = report('good-tolerance');
  assert.equal(tolerance.checks.resolution!.result, 'passed');
  assert.deepEqual(tolerance.optOuts.map((o) => [o.check, o.kind, o.value]), [['resolution', 'tolerance', 0.2]]);
  assert.deepEqual(report('bad-tolerance').optOuts, []);
});

test('an export node gets the meta check alone, and that check asks the export rules', () => {
  const r = report('bad-export');
  assert.deepEqual(withResult(r, 'failed'), ['meta']);
  assert.equal(withResult(r, 'not-applicable').length, 17, 'no other check applies: an export node is never evaluated');
  assert.equal(r.adapter, null, 'the suite opened no device');
  // The rules are checkExportNode of src/export/plan.ts. Until the export stage has written it, the check says so;
  // from then on it reports that this node is not `io/export-*`. Either way the case fails and names the export rules.
  assert.match(r.checks.meta!.message ?? '', /export/);
  assert.match(child!.output, /^\s*not ok \d+ - ref\/bad-export \/ meta$/m);
});

test('abort is reported as skipped for a node that completes without a slice', () => {
  const meta = report('bad-meta');
  assert.deepEqual(meta.checks.abort, { result: 'skipped', reason: 'the node completes without a slice: there is nothing to abort' });
  assert.equal(report('good-tone').checks.abort!.result, 'passed');
});

test('budget asserts on a device with the compact formats, and prints its estimate everywhere', () => {
  const heavy = report('bad-budget');
  const light = report('good-tone');
  assert.ok(heavy.budget && light.budget);
  // Sixteen fields of 16 bytes a texel, and the output: (16 x 16 + 4) x 8129^2 bytes.
  assert.ok(Math.abs(heavy.budget.estimateBytes - 260 * 8129 ** 2) < 1e6, `${heavy.budget.estimateBytes} bytes at 8129`);
  assert.match(child!.output, /# budget: 17\.18 GB at 8129/);
  assert.equal(heavy.budget.asserted, heavy.compactFormats);
  if (heavy.compactFormats) {
    assert.deepEqual(withResult(heavy, 'failed'), ['budget']);
    assert.match(heavy.checks.budget!.message!, /^budget: 17\.18 GB at 8129: the node's peak memory, \d+ bytes at 129 and \d+ at 257, extrapolates to \d+ bytes; allowed 3500000000$/);
    assert.equal(light.checks.budget!.result, 'passed');
  } else {
    // Without them the estimate counts the fallback formats: it is printed, and the case is reported as skipped.
    assert.deepEqual(withResult(heavy, 'failed'), []);
    for (const r of [heavy, light]) assert.match(r.checks.budget!.reason ?? '', /^budget: \d+\.\d\d GB at 8129; not asserted: this device has no compact formats/);
    assert.equal(light.checks.budget!.result, 'skipped');
  }
});

test('deterministic-large catches a race on a hardware adapter, and is skipped on a software one', () => {
  const race = report('bad-race');
  assert.ok(race.adapter);
  const large = race.checks['deterministic-large']!;
  if (race.adapter.software) {
    assert.equal(large.result, 'skipped');
    assert.match(large.reason ?? '', /is a software adapter$/);
  } else {
    assert.equal(large.result, 'failed', 'the racy kernel gives another result on a second run at 2049');
    assert.match(large.message ?? '', /^output "out", two runs at 2049: \d+ of 4198401 values are not bit-identical/);
    // The same kernel run in tiles one workgroup high reads other neighbours than in one dispatch.
    assert.equal(race.checks.slicing!.result, 'failed');
  }
  // Only a node that lists a kernel with unsafeReadWrite gets the case.
  assert.equal(report('good-any').checks['deterministic-large']!.result, 'not-applicable');
});

test('the report names the adapter and the profile the suite ran on', () => {
  const r = report('good-any');
  assert.equal(r.type, 'ref/good-any');
  assert.equal(r.profile, process.env.OROGEN_GPU_PROFILE || 'core');
  assert.ok(r.adapter && typeof r.adapter.description === 'string' && typeof r.adapter.software === 'boolean');
  if (process.env.OROGEN_GPU_ADAPTER) assert.ok(r.adapter.device.includes(process.env.OROGEN_GPU_ADAPTER), r.adapter.device);
  assert.deepEqual(Object.keys(r.checks), [
    'meta', 'finite', 'mask-range', 'alpha', 'generator-range', 'deterministic', 'deterministic-large', 'resolution', 'params',
    'optional-unbound', 'short-ladder', 'mask-neutral', 'seed', 'wants', 'budget', 'abort', 'slicing', 'leaks',
  ], 'every check, in the order of the cases: the auto runs, then small, then one');
});

// ---- what conformance() refuses at registration (testing.md 3.6 rule 1) ----------------------------------------------

const REASON = 'A reason that a reviewer can check, in one sentence.';

test('an opt-out needs a reason of at least 20 characters, and a tolerance within (0, 0.5]', () => {
  assert.throws(() => conformance(fbm, { skip: { seed: 'because' } }), /skip\["seed"\] needs a reason of at least 20 characters/);
  assert.throws(() => conformance(fbm, { skip: { seed: '                         ' } }), /needs a reason/);
  assert.throws(() => conformance(fbm, { skip: { seed: undefined as never } }), /needs a reason/);
  assert.throws(() => conformance(talus, { resolutionTol: { value: 0.05, reason: 'slopes' } }), /resolutionTol needs a reason of at least 20 characters/);
  for (const value of [0, -0.1, 0.51, 2, Number.NaN]) {
    assert.throws(() => conformance(talus, { resolutionTol: { value, reason: REASON } }), RangeError, `a tolerance of ${value}`);
  }
});

test('only the five skippable checks can be skipped, and only where they apply', () => {
  for (const check of ['meta', 'finite', 'mask-range', 'deterministic', 'deterministic-large', 'params', 'optional-unbound', 'short-ladder', 'mask-neutral', 'wants', 'slicing', 'abort', 'leaks']) {
    assert.throws(() => conformance(fbm, { skip: { [check]: REASON } as never }), new RegExp(`the check "${check}" cannot be skipped`));
  }
  assert.throws(() => conformance(fbm, { skip: { alpha: REASON } }), /skip\["alpha"\] names a check that does not apply to this node/);
  assert.throws(() => conformance(talus, { skip: { seed: REASON } }), /does not apply/);
  assert.throws(() => conformance(talus, { skip: { 'generator-range': REASON } }), /does not apply/);
  // A tolerance replaces 0.01 for a node that reads its input: a generator has none, and a skipped check takes none.
  assert.throws(() => conformance(fbm, { resolutionTol: { value: 0.05, reason: REASON } }), /a generator agrees at shared vertices within 1e-6/);
  assert.throws(() => conformance(talus, { resolutionTol: { value: 0.05, reason: REASON }, skip: { resolution: REASON } }), /both declared/);
});

test('the other options name parameters, inputs and fixtures the node and the suite have', () => {
  assert.throws(() => conformance(fbm, { params: { radius: 1 } }), /the node has no parameter "radius"/);
  assert.throws(() => conformance(talus, { inputs: { height: 'cone' } }), /the node has no input "height"/);
  assert.throws(() => conformance(talus, { inputs: { in: 'fbm' } }), /a fixture name other than "fbm" and "impulse"/);
  assert.throws(() => conformance(talus, { inputs: { in: 'impulse' } }), /other than "fbm" and "impulse"/);
  assert.throws(() => conformance(talus, { inputs: { in: 'color' } }), /takes a field; the fixture "color" is a color/);
  assert.throws(() => conformance(talus, { inputs: { in: fbm as never } }), TypeError);
  assert.throws(() => conformance(fbm, { tolerance: 0.1 } as never), /"tolerance" is not an option/);
  assert.throws(() => conformance({ type: 'ref/x' } as never), /takes a NodeDef/);
  assert.throws(() => conformance(fbm, null as never), TypeError);
});
