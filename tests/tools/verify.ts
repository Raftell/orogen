// What a node author runs before a node is done (testing.md 5.3):
//
//   npm run verify -- <category>/<name>
//
// Eight steps, in order, stopping at the first that fails: the type check, the unit layer, the node's test
// file on the default adapter under `core`, under `max`, and on the machine's software adapter, then
// `orogen render` at 513 (and with --masked for a node that has a masked variant), at 4033 with a one-to-one
// crop, and at 4033 with every parameter at its maximum.
// It ends with the summary the change description carries. A step whose adapter the machine lacks is reported
// as `missing` and does not fail the run; the node is not done until someone has run it.
//
// Every step is a process of its own. Those that run project code start through tools/guard.mjs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output'));
const GUARD = path.join('tools', 'guard.mjs');
const CLI = path.join('src', 'cli', 'main.ts');
/** runtime.md 3.5: no slice of a build-scale render may take longer. A process of its own: the constant is not imported with the engine. */
const HARD_CEILING_MS = 500;
/** How much of a step's output is kept for reading its counts and its JSON line. */
const KEPT_OUTPUT = 4 << 20;
const BUILD_SCALE = 4033;

type Status = 'passed' | 'failed' | 'missing' | 'not run';
interface Step {
  readonly number: number;
  readonly title: string;
  status: Status;
  /** One line for the summary: counts, the adapter, or why the step failed or is missing. */
  note: string;
}

interface Device { readonly adapter: string; readonly software: boolean; readonly profile: string; readonly compactFormats: boolean }
interface ConformanceReport {
  readonly adapter: { readonly description: string; readonly device: string; readonly software: boolean } | null;
  readonly profile: string | null;
  readonly checks: Readonly<Record<string, { readonly result: string; readonly reason?: string }>>;
  readonly optOuts: readonly { readonly check: string; readonly kind: string; readonly value?: number; readonly reason: string }[];
  readonly budget: { readonly estimateBytes: number; readonly asserted: boolean } | null;
  /** The `params` of the node's conformance call; a file as an absolute path. */
  readonly params?: Readonly<Record<string, unknown>>;
}
interface RenderLine {
  readonly type: string; readonly res: number; readonly wallMs: number; readonly gpuMs: number | null;
  readonly longestSliceMs: number; readonly peakBytes: number; readonly files: readonly string[];
}

/** Runs one command, passing its output through, and keeps the end of it. */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, quiet = false): Promise<{ readonly code: number; readonly output: string }> {
  return new Promise((resolve) => {
    // npm is a script on Windows: it is started through the shell there, with arguments that hold no space.
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: command === 'npm' });
    let output = '';
    const keep = (stream: NodeJS.WriteStream) => (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-KEPT_OUTPUT);
      if (!quiet) stream.write(chunk);
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    child.on('error', (thrown) => resolve({ code: 127, output: `${output}\n${thrown.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 137, output }));
  });
}

/** The environment of a GPU step: the profile and the adapter are set here, whatever the caller's shell holds. */
function deviceEnv(profile: 'core' | 'max', adapter: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_GPU_PROFILE: profile };
  delete env.OROGEN_GPU_ADAPTER;
  delete env.NODE_TEST_CONTEXT;
  if (adapter !== null) env.OROGEN_GPU_ADAPTER = adapter;
  return env;
}

/** The device a configuration gives on this machine, from a process of its own; null when it gives none. */
async function probe(env: NodeJS.ProcessEnv): Promise<Device | null> {
  const { code, output } = await run(process.execPath, [GUARD, 'node', path.join('tests', 'tools', 'verify.ts'), '--probe'], env, true);
  const line = output.split('\n').find((text) => text.startsWith('{"adapter"'));
  if (code !== 0 || line === undefined) return null;
  return JSON.parse(line) as Device;
}

/** `--probe`: opens the device the environment selects, as the harness does, and prints what it is. */
async function probeHere(): Promise<number> {
  const { getEngine } = await import('../helpers/index.ts');
  const { GpuUnavailableError } = await import('../../src/core/runtime.ts');
  try {
    const { engine, gpu } = await getEngine();
    const device: Device = { adapter: gpu.caps.adapter.description || gpu.caps.adapter.device, software: gpu.caps.software, profile: gpu.profile, compactFormats: gpu.caps.compactFormats };
    console.log(JSON.stringify(device));
    await engine.dispose();
    gpu.destroy();
    return 0;
  } catch (thrown) {
    if (!(thrown instanceof GpuUnavailableError)) throw thrown;
    console.error(thrown.message);
    return 3;
  }
}

/** The last count the test runner printed for `name`, in either of its report formats. */
function count(output: string, name: string): number | null {
  const found = [...output.matchAll(new RegExp(`^(?:ℹ|#) ${name} (\\d+)$`, 'gm'))].at(-1);
  return found ? Number(found[1]) : null;
}
const cases = (output: string): string => {
  const tests = count(output, 'tests'), skipped = count(output, 'skipped'), failed = count(output, 'fail');
  if (tests === null) return 'no test count was printed';
  return `${tests} cases${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`;
};

/** The adapter name of a tests/env file: the single source of what selects the machine's software adapter. */
function adapterOf(envFile: string): string | null {
  const text = fs.readFileSync(path.join(ROOT, 'tests', 'env', envFile), 'utf8');
  return /^OROGEN_GPU_ADAPTER=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
}

async function verify(type: string): Promise<number> {
  const [category, name] = type.split('/') as [string, string];
  const testFile = path.posix.join('tests', 'nodes', category, `${name}.test.ts`);
  const reportFile = path.join(OUTPUT, 'conformance', category, `${name}.json`);
  const steps: Step[] = [
    'npm run check', 'npm run test:unit', 'the node\'s tests, default adapter, profile core', 'the node\'s tests, default adapter, profile max',
    'the node\'s tests, software adapter, profile core', `orogen render ${type} --res 513`, `orogen render ${type} --res ${BUILD_SCALE} --crop 768`,
    `orogen render ${type} --res ${BUILD_SCALE} --max-params`,
  ].map((title, i) => ({ number: i + 1, title, status: 'not run', note: '' }));
  const reports: (ConformanceReport | null)[] = [];
  const renders: (RenderLine | null)[] = [];
  /** The pictures of the masked variant, which step 6 draws for a node that has one. */
  const maskedFiles: string[] = [];
  let failed = false;

  const begin = (step: Step): void => console.log(`\n=== verify ${type}: step ${step.number} of ${steps.length}: ${step.title}`);
  const finish = (step: Step, ok: boolean, note: string): void => {
    step.status = ok ? 'passed' : 'failed';
    step.note = note;
    if (!ok) failed = true;
  };

  // Steps 1 and 2.
  for (const [i, script] of (['check', 'test:unit'] as const).entries()) {
    if (failed) break;
    const step = steps[i]!;
    begin(step);
    const { code, output } = await run('npm', ['run', script], { ...process.env });
    finish(step, code === 0, script === 'check' ? (code === 0 ? 'no type error' : 'type errors') : cases(output));
  }

  // Steps 3 to 5: the node's test file under three devices.
  const softwareFile = process.platform === 'linux' ? 'lavapipe.env' : process.platform === 'win32' ? 'warp.env' : null;
  const software = softwareFile ? adapterOf(softwareFile) : null;
  const devices: readonly { readonly env: NodeJS.ProcessEnv | null; readonly needs: 'any' | 'hardware' | 'software'; readonly absent: string }[] = [
    { env: deviceEnv('core', null), needs: 'any', absent: 'this machine has no WebGPU adapter' },
    { env: deviceEnv('max', null), needs: 'hardware', absent: 'the profile max is run on a hardware adapter, and the default adapter of this machine is none' },
    {
      env: software ? deviceEnv('core', software) : null, needs: 'software',
      absent: software ? `this machine has no adapter named "${software}" (tests/env/${softwareFile})` : 'no software adapter is defined for this platform',
    },
  ];
  for (const [i, device] of devices.entries()) {
    if (failed) break;
    const step = steps[2 + i]!;
    begin(step);
    const found = device.env ? await probe(device.env) : null;
    if (!device.env || !found || (device.needs === 'hardware' && found.software) || (device.needs === 'software' && !found.software)) {
      step.status = 'missing';
      step.note = device.absent;
      console.log(`missing: ${device.absent}`);
      reports.push(null);
      continue;
    }
    fs.rmSync(reportFile, { force: true });
    const { code, output } = await run(process.execPath, [GUARD, 'node', '--test', '--test-concurrency=1', '--test-timeout=300000', testFile], device.env);
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) as ConformanceReport : null;
    reports.push(report);
    finish(step, code === 0, `${cases(output)}; ${found.adapter}`);
  }

  // Steps 6 to 8: pictures, and the only runs at a build-scale resolution before integration. The node is
  // rendered with the parameters its conformance call gave it: one whose defaults cannot run (an import node
  // without a file) is rendered the way the suite ran it.
  const given = Object.entries(reports.findLast((r) => r !== null)?.params ?? {}).flatMap(([name, value]) => ['--param', `${name}=${JSON.stringify(value)}`]);
  // The pictures of step 8 go to a folder of their own: its file names are those of step 7, whose pictures at
  // the defaults are the ones the change description shows (5.5).
  const maxOut = path.join(OUTPUT, 'max-params');
  const renderArgs: readonly (readonly string[])[] = [
    ['--res', '513', '--out', OUTPUT], ['--res', String(BUILD_SCALE), '--crop', '768', '--out', OUTPUT],
    ['--res', String(BUILD_SCALE), '--max-params', '--out', maxOut],
  ];
  for (const [i, args] of renderArgs.entries()) {
    if (failed) break;
    const step = steps[5 + i]!;
    begin(step);
    if (!fs.existsSync(path.join(ROOT, CLI))) {
      finish(step, false, `${CLI} does not exist: \`orogen render\` belongs to the command-line stage`);
      renders.push(null);
      continue;
    }
    const out = args.at(-1)!;
    const { code, output } = await run(process.execPath, [GUARD, 'node', CLI, 'render', type, ...given, ...args], { ...process.env });
    // render prints one JSON line on standard output (testing.md 8.6).
    const line = output.split('\n').reverse().find((text) => text.startsWith('{') && text.includes('"files"'));
    let render: RenderLine | null = null;
    try {
      render = line ? JSON.parse(line) as RenderLine : null;
    } catch {
      render = null;
    }
    renders.push(render);
    const problems: string[] = [];
    if (code !== 0) problems.push(`render exited with ${code}`);
    if (!render) problems.push('render printed no JSON line');
    else {
      const absent = render.files.filter((file) => !fs.existsSync(path.resolve(out, file)));
      if (render.files.length === 0) problems.push('no picture was written');
      if (absent.length > 0) problems.push(`${absent.length} pictures it names do not exist`);
      if (args.includes('--crop') && !render.files.some((file) => file.endsWith('-crop.png'))) problems.push('no one-to-one crop was written');
      if (i > 0 && render.longestSliceMs > HARD_CEILING_MS) problems.push(`the longest slice took ${render.longestSliceMs.toFixed(0)} ms, above the hard ceiling of ${HARD_CEILING_MS} ms`);
    }
    // Step 6 also draws the masked variant (testing.md 2.4). A node without one is refused as a usage error, which says so.
    if (i === 0 && problems.length === 0) {
      const masked = await run(process.execPath, [GUARD, 'node', CLI, 'render', type, ...given, ...args, '--masked'], { ...process.env });
      const none = masked.code === 2 && masked.output.includes('--masked connects the optional mask inputs of a node');
      if (!none) {
        const maskedLine = masked.output.split('\n').reverse().find((text) => text.startsWith('{') && text.includes('"files"'));
        let files: readonly string[] = [];
        try {
          files = maskedLine ? (JSON.parse(maskedLine) as RenderLine).files : [];
        } catch {
          files = [];
        }
        if (masked.code !== 0) problems.push(`render --masked exited with ${masked.code}`);
        else if (files.length === 0 || files.some((file) => !fs.existsSync(path.resolve(out, file)))) problems.push('render --masked wrote no picture');
        else maskedFiles.push(...files.map((file) => path.resolve(out, file)));
      }
    }
    const measured = render ? `${(render.wallMs / 1000).toFixed(1)} s, longest slice ${render.longestSliceMs.toFixed(0)} ms, peak ${(render.peakBytes / 1e9).toFixed(2)} GB` : '';
    finish(step, problems.length === 0, problems.length === 0 ? measured : problems.join('; '));
  }

  // ---- the summary -----------------------------------------------------------------------------------------------
  console.log(`\n=== verify ${type}: summary`);
  for (const step of steps) console.log(`${String(step.number).padStart(2)}  ${step.status.padEnd(8)} ${step.title}${step.note ? `: ${step.note}` : ''}`);
  const report = reports.findLast((r) => r !== null) ?? null;
  if (report) {
    console.log(report.optOuts.length === 0 ? 'opt-outs: none' : 'opt-outs:');
    for (const optOut of report.optOuts) {
      console.log(`  ${optOut.check} ${optOut.kind === 'tolerance' ? `with the tolerance ${optOut.value}` : 'skipped'}: ${optOut.reason}`);
    }
    // The estimate that counts is the one a device with the compact formats asserted (step 4).
    const asserted = reports.find((r) => r?.budget?.asserted) ?? null;
    const budget = (asserted ?? report).budget;
    if (budget) {
      console.log(`budget: ${(budget.estimateBytes / 1e9).toFixed(2)} GB at 8129, ${asserted ? `asserted on ${asserted.adapter?.description ?? 'a device with the compact formats'}` : 'not asserted: no step ran on a device with the compact formats'}`);
    }
    const previews = path.join(OUTPUT, 'nodes', category, name);
    if (fs.existsSync(previews)) console.log(`pictures of the conformance suite: ${previews}`);
  }
  const pictures = [...renders.flatMap((render, i) => (render?.files ?? []).map((file) => path.resolve(renderArgs[i]!.at(-1)!, file))), ...maskedFiles];
  if (pictures.length > 0) console.log(`pictures of orogen render:\n${pictures.map((file) => `  ${file}`).join('\n')}`);
  const missing = steps.filter((step) => step.status === 'missing');
  const notRun = steps.filter((step) => step.status === 'not run');
  if (failed) console.log(`NOT DONE: step ${steps.find((step) => step.status === 'failed')!.number} failed${notRun.length > 0 ? `; ${notRun.length} steps were not run` : ''}.`);
  else if (missing.length > 0) console.log(`Every step that ran passed. NOT DONE: step${missing.length > 1 ? 's' : ''} ${missing.map((step) => step.number).join(', ')} still ha${missing.length > 1 ? 've' : 's'} to be run on a machine with that adapter.`);
  else console.log('Every step passed.');
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--probe') process.exit(await probeHere());
  const type = args[0];
  const problem = args.length !== 1 || type === undefined || !/^[a-z]+\/[a-z][a-z0-9-]*$/.test(type) ? 'name one node type, <category>/<name>'
    : !fs.existsSync(path.join(ROOT, 'src', 'core', 'nodes', `${type}.ts`)) ? `src/core/nodes/${type}.ts does not exist`
    : !fs.existsSync(path.join(ROOT, 'tests', 'nodes', `${type}.test.ts`)) ? `tests/nodes/${type}.test.ts does not exist: a node has a test file (testing.md 5.2)`
    : null;
  if (problem !== null) {
    console.error(`verify: ${problem}`);
    console.error('usage: npm run verify -- <category>/<name>');
    process.exit(2);
  }
  process.exit(await verify(type!));
}
