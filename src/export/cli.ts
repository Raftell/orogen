// The `build` and `unreal-test` subcommands of the command-line program `orogen` (export-unreal.md 3.11 and
// section 9). The entry point, src/cli/main.ts, owns the process and calls runExportCli.

import fs from 'node:fs';
import path from 'node:path';

import { decodeImage, decodeRaw } from '../core/api.ts';
import {
  budgetBytes as budgetOf, createEngine, createRegistry, DEFAULT_PREFERENCES, DocFormatError, GpuUnavailableError, parseDoc,
  type BuildEvent, type BuildProblem, type BuildResult, type Engine, type EvalEvent, type GpuContext, type GpuProfile, type GraphDoc,
} from '../core/runtime.ts';
import { NodeFileSink, NodeFileSource } from '../platform/node/files.ts';
import { budgetLine } from '../platform/node/vram.ts';
import { buildToFolder, intoFolder } from './folder.ts';
import { checkMarker, isMarkerResolution, MARKER_DEFAULT_RES, MARKER_STEPS, writeMarkerBuild } from './unreal-test.ts';

const USAGE = {
  build: [
    'usage: orogen build <project.orogen> --out <dir> [--res <n>] [--seed <n>] [--budget-mb <n>]',
    '                    [--profile <core|max>] [--adapter <substring>] [--json] [--quiet]',
  ].join('\n'),
  'unreal-test': 'usage: orogen unreal-test --out <dir> [--res <n>]\n       orogen unreal-test --check <file> [--res <n>]',
} as const;

const EXIT = { ok: 0, errors: 1, usage: 2, noDevice: 3, cancelled: 130 } as const;
const SEED_MAX = 2 ** 32 - 1;

class UsageError extends Error {}

type OptionKind = 'flag' | 'value';
interface Scanned { readonly positionals: readonly string[]; readonly flags: ReadonlySet<string>; readonly values: ReadonlyMap<string, string> }

/** Sorts the arguments into options and positionals. `--name value` and `--name=value` are the same. */
function scan(args: readonly string[], spec: Readonly<Record<string, OptionKind>>): Scanned {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new UsageError(`there is no option "${name}"`);
    if (kind === 'flag') {
      if (equals >= 0) throw new UsageError(`${name} takes no value`);
      flags.add(name);
      continue;
    }
    let value: string;
    if (equals >= 0) value = token.slice(equals + 1);
    else {
      const next = args[i + 1];
      if (next === undefined || next === '--' || Object.hasOwn(spec, next.split('=')[0]!)) throw new UsageError(`${name} needs a value`);
      value = next;
      i++;
    }
    if (values.has(name)) throw new UsageError(`${name} is given twice`);
    values.set(name, value);
  }
  return { positionals, flags, values };
}

function integer(scanned: Scanned, name: string, min: number, max: number, what: string): number | null {
  const text = scanned.values.get(name);
  if (text === undefined) return null;
  const value = /^(0|[1-9]\d*)$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) throw new UsageError(`${name} ${JSON.stringify(text)} is not ${what}`);
  return value;
}

function folder(scanned: Scanned, name: string): string | null {
  const text = scanned.values.get(name);
  if (text === undefined) return null;
  if (text === '') throw new UsageError(`${name} needs a path`);
  return path.resolve(process.cwd(), text);
}

// ---- build -------------------------------------------------------------------------------------------------------

interface BuildCommand {
  readonly project: string;
  readonly out: string;
  readonly res: number | null;
  readonly seed: number | null;
  readonly budgetBytes: number | null;
  readonly profile: GpuProfile;
  readonly adapter: string | undefined;
  readonly json: boolean;
  readonly quiet: boolean;
}

function parseBuild(args: readonly string[]): BuildCommand {
  const scanned = scan(args, {
    '--out': 'value', '--res': 'value', '--seed': 'value', '--budget-mb': 'value', '--profile': 'value', '--adapter': 'value', '--json': 'flag', '--quiet': 'flag',
  });
  if (scanned.positionals.length !== 1) {
    throw new UsageError(scanned.positionals.length === 0 ? 'name the project file to build' : `one project file is built at a time, not ${scanned.positionals.length}`);
  }
  const out = folder(scanned, '--out');
  if (out === null) throw new UsageError('--out <dir> names the folder the build is written into');
  const profile = scanned.values.get('--profile') ?? (process.env.OROGEN_GPU_PROFILE || 'max');
  if (profile !== 'core' && profile !== 'max') throw new UsageError(`the profile is "core" or "max", not "${profile}"`);
  const adapter = scanned.values.get('--adapter') ?? (process.env.OROGEN_GPU_ADAPTER || undefined);
  if (adapter === '') throw new UsageError('--adapter needs a part of an adapter name');
  const megabytes = scanned.values.get('--budget-mb');
  const budgetBytes = megabytes === undefined ? null : Math.floor((/^\d+(\.\d+)?$/.test(megabytes) ? Number(megabytes) : NaN) * 2 ** 20);
  if (budgetBytes !== null && (!(budgetBytes >= 1) || !Number.isSafeInteger(budgetBytes))) throw new UsageError(`--budget-mb ${JSON.stringify(megabytes)} is not a number of MiB above 0`);
  return {
    project: path.resolve(process.cwd(), scanned.positionals[0]!), out,
    res: integer(scanned, '--res', 1, 65536, 'a number of vertices per side'),
    seed: integer(scanned, '--seed', 0, SEED_MAX, `an integer in 0..${SEED_MAX}`),
    budgetBytes, profile, adapter,
    json: scanned.flags.has('--json'), quiet: scanned.flags.has('--quiet'),
  };
}

const megabytes = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

function printProblem(problem: BuildProblem): void {
  process.stderr.write(`orogen build: ${problem.severity} ${problem.code}: ${problem.message}\n`);
}

async function build(args: readonly string[], signal: AbortSignal): Promise<number> {
  const command = parseBuild(args);
  const say = (line: string): void => {
    if (!command.quiet && !command.json) process.stderr.write(`orogen build: ${line}\n`);
  };

  // The node list, the GPU package and the CPU runner are loaded here and not at the top: the arguments are checked
  // before any of them is touched, and `unreal-test` needs none.
  const { nodes } = await import('../core/nodes/index.ts');
  // The project: an unreadable file and a file that is no project are usage errors, found before a device is opened.
  const registry = createRegistry(nodes);
  let doc: GraphDoc;
  try {
    const parsed = parseDoc(fs.readFileSync(command.project, 'utf8'), registry);
    doc = parsed.doc;
    for (const problem of parsed.problems) process.stderr.write(`orogen build: warning: ${command.project}: ${problem.message}\n`);
  } catch (thrown) {
    if (thrown instanceof DocFormatError) throw new UsageError(`${command.project} is not a project file: ${thrown.message}`);
    throw new UsageError(`Cannot read the project file ${command.project}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  if (command.seed !== null) doc = { ...doc, settings: { ...doc.settings, seed: command.seed } };

  const { createNodeGpu } = await import('../platform/node/gpu.ts');
  const { createNodeCpuRunner } = await import('../platform/node/cpu.ts');
  let gpu: GpuContext;
  try {
    gpu = await createNodeGpu({ profile: command.profile, ...(command.adapter !== undefined ? { adapter: command.adapter } : {}) });
  } catch (thrown) {
    if (!(thrown instanceof GpuUnavailableError)) throw thrown;
    process.stderr.write(`orogen build: ${thrown.message}\n`);
    return EXIT.noDevice;
  }
  const budgetBytes = command.budgetBytes ?? budgetOf(gpu.caps, DEFAULT_PREFERENCES);
  let engine: Engine;
  try {
    engine = await createEngine({ gpu, registry, files: NodeFileSource(path.dirname(command.project)), cpu: createNodeCpuRunner(), budgetBytes });
  } catch (thrown) {
    gpu.destroy();
    throw thrown;
  }
  say(budgetLine(gpu.caps, budgetBytes, command.budgetBytes !== null));

  let lastTenth = -1;
  const started = performance.now();
  const titles = new Map(Object.values(doc.nodes).map((node) => [node.id, node.title || registry.get(node.type)?.title || node.type]));
  const onEvent = (event: EvalEvent | BuildEvent): void => {
    if (command.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'build-problem') printProblem(event.problem);
      if (event.type === 'build-plan') event.plan.problems.forEach(printProblem);
      return;
    }
    switch (event.type) {
      case 'build-plan': {
        event.plan.problems.forEach(printProblem);
        if (event.plan.ok) say(`${event.plan.files.length} files at ${event.plan.resolution} x ${event.plan.resolution} into ${command.out}`);
        break;
      }
      case 'eval-start': say(`evaluating ${event.plan.filter((node) => node.state === 'run').length} nodes`); break;
      case 'node-done':
        if (!event.cached) say(`  ${titles.get(event.nodeId) ?? event.nodeId}: ${seconds(event.wallMs)}, ${megabytes(event.peakBytes)}`);
        break;
      case 'build-target': say(`[${event.index + 1}/${event.count}] ${event.label}`); break;
      case 'build-progress': {
        const tenth = Math.floor(event.fraction * 10);
        if (tenth > lastTenth) {
          lastTenth = tenth;
          say(`  ${event.phase} ${Math.round(event.fraction * 100)} %`);
        }
        break;
      }
      case 'build-problem': printProblem(event.problem); break;
      default:
    }
  };

  let result: BuildResult;
  try {
    result = await buildToFolder(engine, {
      doc, outDir: command.out, createSink: NodeFileSink, requestId: 1, signal, onEvent,
      ...(command.res !== null ? { resolution: command.res } : {}),
    });
  } finally {
    // runtime.md 1.5 rule 5: the engine first, then the device.
    try {
      await engine.dispose();
    } finally {
      gpu.destroy();
    }
  }

  const peakProcessBytes = process.resourceUsage().maxRSS * 1024;
  switch (result.status) {
    case 'ok': {
      const bytes = result.files.reduce((sum, file) => sum + file.bytes, 0);
      say(`done in ${seconds(performance.now() - started)}: ${result.files.length} files, ${megabytes(bytes)}; peak GPU pool ${megabytes(result.peakPoolBytes ?? 0)}, peak process memory ${megabytes(peakProcessBytes)}`);
      if (!command.json) process.stdout.write(`${path.join(result.outDir!, result.manifest!)}\n`);
      return EXIT.ok;
    }
    case 'errors':
      if (result.report !== null && result.outDir !== null) process.stderr.write(`orogen build: failed; the report is ${path.join(result.outDir, result.report)}\n`);
      else process.stderr.write('orogen build: failed; nothing was written\n');
      return EXIT.errors;
    case 'device-lost':
      process.stderr.write('orogen build: the GPU device was lost during the build\n');
      return EXIT.noDevice;
    case 'aborted':
      process.stderr.write('orogen build: cancelled\n');
      return EXIT.cancelled;
  }
}

// ---- unreal-test -------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function unrealTest(args: readonly string[]): Promise<number> {
  const scanned = scan(args, { '--out': 'value', '--check': 'value', '--res': 'value' });
  if (scanned.positionals.length > 0) throw new UsageError(`unreal-test takes no argument such as ${JSON.stringify(scanned.positionals[0])}`);
  const out = folder(scanned, '--out');
  const check = folder(scanned, '--check');
  if ((out === null) === (check === null)) throw new UsageError(out === null ? 'give --out <dir> to write the pattern, or --check <file> to compare a heightmap with it' : '--out and --check are two forms of the command; give one');
  const given = integer(scanned, '--res', 1, 65536, 'a resolution of the pattern');
  const sizes = Object.keys(MARKER_STEPS).join(', ');
  if (given !== null && !isMarkerResolution(given)) throw new UsageError(`--res ${given} is not a resolution of the pattern; it is ${sizes}`);

  if (out !== null) {
    const res = given ?? MARKER_DEFAULT_RES;
    const result = await intoFolder(out, 0, async (staging) => ({ result: await writeMarkerBuild(NodeFileSink(staging), res), planFailed: false }));
    for (const problem of result.problems) process.stderr.write(`orogen unreal-test: ${problem.severity} ${problem.code}: ${problem.message}\n`);
    if (result.status !== 'ok') return EXIT.errors;
    process.stdout.write(`${path.join(result.outDir!, result.manifest!)}\n`);
    return EXIT.ok;
  }

  // --check: a 16-bit PNG, recognised by its first bytes, or a headerless .r16 of the pattern's size.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(fs.readFileSync(check!));
  } catch (thrown) {
    throw new UsageError(`Cannot read ${check}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  const isPng = PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
  let image;
  try {
    image = isPng ? await decodeImage.run({ bytes }, { progress() {} }) : decodeRaw.run({ bytes, sample: 'u16' }, { progress() {} });
  } catch (thrown) {
    process.stderr.write(`orogen unreal-test: ${check} is not a heightmap that can be compared: ${thrown instanceof Error ? thrown.message : String(thrown)}\n`);
    return EXIT.errors;
  }
  const res = given ?? (isMarkerResolution(image.width) ? image.width : MARKER_DEFAULT_RES);
  if (image.width !== res || image.height !== res || image.channels !== 1) {
    process.stderr.write(`orogen unreal-test: ${check} is ${image.width} x ${image.height} with ${image.channels} ${image.channels === 1 ? 'channel' : 'channels'}; the pattern at ${res} is ${res} x ${res} with one\n`);
    return EXIT.errors;
  }
  // The decoders give code / 65535 as float32, from which the code is recovered exactly.
  const codes = new Uint16Array(image.data.length);
  for (let i = 0; i < codes.length; i++) codes[i] = Math.round(image.data[i]! * 65535);
  const found = checkMarker(codes, res);
  process.stdout.write(`${found.differing} of ${res * res} samples differ from the pattern; the largest difference is ${found.largest} ${found.largest === 1 ? 'code' : 'codes'}\n`);
  if (found.first) {
    const { x, y, found: got, expected } = found.first;
    process.stdout.write(`the first is at column ${x}, row ${y}: ${got} where the pattern has ${expected}\n`);
  }
  return found.differing === 0 ? EXIT.ok : EXIT.errors;
}

/** `args` are the arguments after the subcommand. Resolves with the exit code; does not end the process. */
export async function runExportCli(subcommand: 'build' | 'unreal-test', args: readonly string[], signal: AbortSignal): Promise<number> {
  try {
    return subcommand === 'build' ? await build(args, signal) : await unrealTest(args);
  } catch (thrown) {
    if (!(thrown instanceof UsageError)) throw thrown;
    process.stderr.write(`orogen ${subcommand}: ${thrown.message}\n${USAGE[subcommand]}\n`);
    return EXIT.usage;
  }
}
