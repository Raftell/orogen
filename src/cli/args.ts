// The arguments of `orogen` (testing.md 8.6; export-unreal.md 3.11 for `build` and `unreal-test`, whose
// arguments are handed to src/export/cli.ts unread). Pure: nothing here opens a device, reads a file or
// prints, so a usage error is found before anything starts.

import path from 'node:path';

import type { Category } from '../core/api.ts';
import type { GpuProfile } from '../core/runtime.ts';

export type Subcommand = 'probe' | 'render' | 'gallery' | 'build' | 'unreal-test';

/** A mistake in the arguments: exit code 2. `subcommand` selects the synopsis printed with the message. */
export class UsageError extends Error {
  override name = 'UsageError';
  readonly subcommand: Subcommand | null;

  constructor(message: string, subcommand: Subcommand | null = null) {
    super(message);
    this.subcommand = subcommand;
  }
}

export interface DeviceOptions {
  readonly profile: GpuProfile;
  /** A case-sensitive part of the adapter's name; undefined: the default adapter. */
  readonly adapter: string | undefined;
}

export interface ParamArg { readonly name: string; readonly value: unknown }

export interface ProbeCommand { readonly command: 'probe'; readonly device: DeviceOptions }

export interface RenderCommand {
  readonly command: 'render';
  readonly device: DeviceOptions;
  /** The output folder, absolute. */
  readonly out: string;
  /** null: the budget of runtime.md 2.4 with default preferences. */
  readonly budgetBytes: number | null;
  readonly source:
    | { readonly kind: 'type'; readonly type: string }
    | { readonly kind: 'project'; readonly file: string; readonly node: string };   // `file` is absolute
  /** null, for a project file only: the project's preview resolution. */
  readonly res: number | null;
  readonly params: readonly ParamArg[];
  readonly maxParams: boolean;
  readonly seed: number | null;
  readonly crop: number | null;
}

export interface GalleryCommand {
  readonly command: 'gallery';
  readonly device: DeviceOptions;
  readonly out: string;
  readonly budgetBytes: number | null;
  readonly category: Category | null;
  readonly res: number;
}

export interface ExportCommand { readonly command: 'export'; readonly subcommand: 'build' | 'unreal-test'; readonly args: readonly string[] }
export interface HelpCommand { readonly command: 'help'; readonly subcommand: Subcommand | null }

export type Command = ProbeCommand | RenderCommand | GalleryCommand | ExportCommand | HelpCommand;

const SUBCOMMANDS: readonly Subcommand[] = ['probe', 'render', 'gallery', 'build', 'unreal-test'];

const CATEGORIES = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref'] as const satisfies readonly Category[];
// A category added to engine.md 4.1 and not to the list above fails the type check here.
const everyCategory: Exclude<Category, (typeof CATEGORIES)[number]> extends never ? true : never = true;
void everyCategory;

const NODE_TYPE = /^[a-z]+\/[a-z][a-z0-9-]*$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]*$/;
const SEED_MAX = 2 ** 32 - 1;
/** The resolution of `render <type>` and of `gallery` when --res is not given. */
export const DEFAULT_RES = 513;

const SYNOPSIS: Readonly<Record<Subcommand, string>> = {
  probe: 'orogen probe [--profile <core|max>] [--adapter <substring>]',
  render: [
    'orogen render <type> [--res <n>] [--param <name>=<json>]... [--max-params] [--seed <n>] [--crop <size>]',
    'orogen render <project.orogen> --node <id> [--res <n>] [--crop <size>]',
    '              [--out <dir>] [--budget-mb <n>] [--profile <core|max>] [--adapter <substring>]',
  ].join('\n'),
  gallery: [
    'orogen gallery [--category <category>] [--res <n>]',
    '               [--out <dir>] [--budget-mb <n>] [--profile <core|max>] [--adapter <substring>]',
  ].join('\n'),
  build: [
    'orogen build <project.orogen> --out <dir> [--res <n>] [--seed <n>] [--budget-mb <n>]',
    '             [--profile <core|max>] [--adapter <substring>] [--json] [--quiet]',
  ].join('\n'),
  'unreal-test': 'orogen unreal-test --out <dir> [--res <n>]\norogen unreal-test --check <file> [--res <n>]',
};

const OPTIONS_HELP = `options of probe, render and gallery:
  --profile <core|max>    the device profile (default: OROGEN_GPU_PROFILE, else max)
  --adapter <substring>   a part of the adapter's name, case-sensitive (default: OROGEN_GPU_ADAPTER, else the default adapter)
  --out <dir>             where render and gallery write (default: OROGEN_TEST_OUTPUT, else test-output)
  --budget-mb <n>         the GPU memory budget of render and gallery in MiB (default: 60 % of the video memory,
                          2457 MiB where the amount is unknown)

exit codes: 0 success, 1 a node failed, 2 usage error, 3 no usable GPU device or device lost, 130 cancelled`;

/** The usage text of one subcommand, or of the program. */
export function usageOf(subcommand: Subcommand | null): string {
  if (subcommand !== null) return `usage: ${SYNOPSIS[subcommand].replaceAll('\n', '\n       ')}`;
  return [
    'usage: orogen <subcommand> [options]',
    '',
    '  probe        print the capabilities of the GPU device as JSON',
    '  render       draw the outputs of one node to PNG files',
    '  gallery      draw every node and write gallery/index.html',
    '  build        build a project into the files Unreal Engine imports',
    '  unreal-test  write or check the acceptance pattern for Unreal Engine',
    '',
    ...SUBCOMMANDS.map((name) => SYNOPSIS[name]),
    '',
    OPTIONS_HELP,
  ].join('\n');
}

/** engine.md 1.5: a level of at least 33 of the ladder of a build resolution, which is 129 .. 8192 with (B − 1) divisible by 16. */
export function isLadderResolution(res: number): boolean {
  if (!Number.isInteger(res) || res < 33 || res > 8192) return false;
  // `res` is level k of B = (res − 1)·2^k + 1. The span doubles, so the loop ends after at most eight rounds.
  for (let span = res - 1; span + 1 <= 8192; span *= 2) {
    if (span + 1 >= 129 && span % 16 === 0) return true;
  }
  return false;
}

type OptionKind = 'flag' | 'value' | 'list';
interface Scanned {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

/** Sorts the arguments of one subcommand into options and positionals. `--name value` and `--name=value` are the same. */
function scan(subcommand: Subcommand, args: readonly string[], spec: Readonly<Record<string, OptionKind>>): Scanned {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const fail = (message: string): never => { throw new UsageError(message, subcommand); };

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
    const kind = Object.hasOwn(spec, name) ? spec[name]! : undefined;
    if (kind === undefined) fail(`orogen ${subcommand} has no option "${name}"`);
    if (kind === 'flag') {
      if (equals >= 0) fail(`${name} takes no value`);
      flags.add(name);
      continue;
    }
    let value: string;
    if (equals >= 0) value = token.slice(equals + 1);
    else {
      const next = args[i + 1];
      if (next === undefined || next === '--' || Object.hasOwn(spec, next.split('=')[0]!)) fail(`${name} needs a value`);
      value = next!;
      i++;
    }
    const given = values.get(name);
    if (given && kind === 'value') fail(`${name} is given twice`);
    if (given) given.push(value);
    else values.set(name, [value]);
  }
  return { positionals, flags, values };
}

const DEVICE_OPTIONS = { '--profile': 'value', '--adapter': 'value' } as const satisfies Record<string, OptionKind>;
const OUTPUT_OPTIONS = { '--out': 'value', '--budget-mb': 'value' } as const satisfies Record<string, OptionKind>;

type Environment = Readonly<Record<string, string | undefined>>;

function parser(subcommand: Subcommand, scanned: Scanned, env: Environment, cwd: string) {
  const fail = (message: string): never => { throw new UsageError(message, subcommand); };
  const one = (name: string): string | undefined => scanned.values.get(name)?.[0];

  /** A whole number without sign, in `min..max`. */
  const integer = (name: string, min: number, max: number, what: string): number | null => {
    const text = one(name);
    if (text === undefined) return null;
    const value = /^(0|[1-9]\d*)$/.test(text) ? Number(text) : NaN;
    if (!(value >= min && value <= max)) fail(`${name} ${JSON.stringify(text)} is not ${what}`);
    return value;
  };

  return {
    fail, one,
    integer,

    device(): DeviceOptions {
      const given = one('--profile');
      const profile = given ?? (env.OROGEN_GPU_PROFILE || 'max');
      if (profile !== 'core' && profile !== 'max') {
        fail(`${given !== undefined ? '--profile' : 'OROGEN_GPU_PROFILE'} is "${profile}"; it is "core" or "max"`);
      }
      const adapter = one('--adapter') ?? (env.OROGEN_GPU_ADAPTER || undefined);
      if (adapter === '') fail('--adapter needs a part of an adapter name');
      return { profile: profile as GpuProfile, adapter };
    },

    out(): string {
      const given = one('--out');
      if (given === '') fail('--out needs a folder');
      return path.resolve(cwd, given ?? (env.OROGEN_TEST_OUTPUT || 'test-output'));
    },

    budgetBytes(): number | null {
      const text = one('--budget-mb');
      if (text === undefined) return null;
      const megabytes = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
      const bytes = Math.floor(megabytes * 2 ** 20);
      if (!(bytes >= 1) || !Number.isSafeInteger(bytes)) fail(`--budget-mb ${JSON.stringify(text)} is not a number of MiB above 0`);
      return bytes;
    },

    res(): number | null {
      const text = one('--res');
      if (text === undefined) return null;
      const value = /^[1-9]\d*$/.test(text) ? Number(text) : NaN;
      if (!isLadderResolution(value)) {
        fail(`--res ${JSON.stringify(text)} is not a resolution: it is a level of at least 33 of the ladder of a build resolution, such as 129, 257, 513, 1009, 2017, 4033 or 8129 (engine.md 1.5)`);
      }
      return value;
    },

    noPositionals(): void {
      if (scanned.positionals.length > 0) fail(`orogen ${subcommand} takes no argument such as ${JSON.stringify(scanned.positionals[0])}`);
    },
  };
}

function parseParam(text: string, fail: (message: string) => never): ParamArg {
  const equals = text.indexOf('=');
  const name = equals < 0 ? text : text.slice(0, equals);
  if (equals < 0 || !PARAM_NAME.test(name)) fail(`--param ${JSON.stringify(text)} is not <name>=<json>, such as octaves=4 or mode='"add"'`);
  const json = text.slice(equals + 1);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail(`--param ${name}: ${JSON.stringify(json)} is not JSON. A number is written 0.25, a text '"add"', a pair '[0.5,0.5]'`);
  }
  if (value === null) fail(`--param ${name}: null is not a parameter value`);
  return { name, value };
}

function parseRender(args: readonly string[], env: Environment, cwd: string): RenderCommand {
  const scanned = scan('render', args, {
    ...DEVICE_OPTIONS, ...OUTPUT_OPTIONS,
    '--res': 'value', '--param': 'list', '--max-params': 'flag', '--seed': 'value', '--crop': 'value', '--node': 'value',
  });
  const p = parser('render', scanned, env, cwd);
  if (scanned.positionals.length !== 1) {
    p.fail(scanned.positionals.length === 0 ? 'name a node type or a project file' : `one node type or one project file is rendered at a time, not ${scanned.positionals.length}`);
  }
  const subject = scanned.positionals[0]!;
  const isProject = /\.orogen$/i.test(subject);
  if (!isProject && !NODE_TYPE.test(subject)) {
    p.fail(`${JSON.stringify(subject)} is neither a node type (<category>/<name>, such as ref/fbm) nor a project file (*.orogen)`);
  }

  const params = (scanned.values.get('--param') ?? []).map((text) => parseParam(text, p.fail));
  const maxParams = scanned.flags.has('--max-params');
  const seed = p.integer('--seed', 0, SEED_MAX, `an integer in 0..${SEED_MAX}`);
  const node = p.one('--node');
  let source: RenderCommand['source'];
  if (isProject) {
    const refused = params.length > 0 ? '--param' : maxParams ? '--max-params' : seed !== null ? '--seed' : null;
    if (refused !== null) p.fail(`${refused} applies to a node type; the nodes of a project file are rendered with the parameters it stores`);
    if (node === undefined || node === '') p.fail('--node <id> names the node of the project file to render');
    source = { kind: 'project', file: path.resolve(cwd, subject), node: node! };
  } else {
    if (node !== undefined) p.fail('--node names a node of a project file; a node type is rendered as one instance');
    source = { kind: 'type', type: subject };
  }

  const res = p.res() ?? (isProject ? null : DEFAULT_RES);
  const crop = p.integer('--crop', 1, 8192, 'a window size in texels, an integer of at least 1');
  if (crop !== null && res !== null && crop > res) p.fail(`--crop ${crop} is larger than the resolution ${res}`);
  return { command: 'render', device: p.device(), out: p.out(), budgetBytes: p.budgetBytes(), source, res, params, maxParams, seed, crop };
}

function parseGallery(args: readonly string[], env: Environment, cwd: string): GalleryCommand {
  const scanned = scan('gallery', args, { ...DEVICE_OPTIONS, ...OUTPUT_OPTIONS, '--res': 'value', '--category': 'value' });
  const p = parser('gallery', scanned, env, cwd);
  p.noPositionals();
  const category = p.one('--category');
  if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) {
    p.fail(`--category "${category}" is not a category; the categories are ${CATEGORIES.join(', ')}`);
  }
  return {
    command: 'gallery', device: p.device(), out: p.out(), budgetBytes: p.budgetBytes(),
    category: (category as Category | undefined) ?? null, res: p.res() ?? DEFAULT_RES,
  };
}

function parseProbe(args: readonly string[], env: Environment, cwd: string): ProbeCommand {
  const scanned = scan('probe', args, DEVICE_OPTIONS);
  const p = parser('probe', scanned, env, cwd);
  p.noPositionals();
  return { command: 'probe', device: p.device() };
}

/**
 * What the arguments after `orogen` ask for. `env` supplies the defaults of testing.md 8.6 and `cwd` is what a
 * relative path is taken from. Throws UsageError.
 */
export function parseCommand(argv: readonly string[], env: Environment, cwd: string): Command {
  const [first, ...rest] = argv;
  if (first === undefined) throw new UsageError('name a subcommand');
  if (first === '--help' || first === '-h' || first === 'help') {
    const topic = rest[0];
    if (topic !== undefined && !(SUBCOMMANDS as readonly string[]).includes(topic)) throw new UsageError(`"${topic}" is not a subcommand`);
    return { command: 'help', subcommand: (topic as Subcommand | undefined) ?? null };
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(first.startsWith('-') ? `the subcommand comes first, before ${JSON.stringify(first)}` : `"${first}" is not a subcommand`);
  }
  const subcommand = first as Subcommand;
  // Only before `--`: what follows it is never an option.
  const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (options.includes('--help') || options.includes('-h')) return { command: 'help', subcommand };
  switch (subcommand) {
    case 'probe': return parseProbe(rest, env, cwd);
    case 'render': return parseRender(rest, env, cwd);
    case 'gallery': return parseGallery(rest, env, cwd);
    case 'build': case 'unreal-test': return { command: 'export', subcommand, args: rest };
  }
}
