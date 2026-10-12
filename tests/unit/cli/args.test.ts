// The arguments of `orogen` (testing.md 8.6): what each subcommand's options and defaults come to, and every
// usage error with what it says. Nothing here starts a process or opens a device.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_RES, isLadderResolution, parseCommand, usageOf, UsageError, type Command, type Subcommand } from '../../../src/cli/args.ts';

const CWD = path.resolve('/work/here');
type Env = Readonly<Record<string, string | undefined>>;

const parse = (line: string, env: Env = {}): Command => parseCommand(line.split(' ').filter((word) => word !== ''), env, CWD);

/** The command line is refused as a usage error of `subcommand` whose message matches. */
function refused(line: string | readonly string[], message: RegExp, subcommand: Subcommand | null, env: Env = {}): void {
  const argv = typeof line === 'string' ? line.split(' ').filter((word) => word !== '') : line;
  assert.throws(() => parseCommand(argv, env, CWD), (thrown: unknown) => {
    assert.ok(thrown instanceof UsageError, `${argv.join(' ')}: threw ${String(thrown)}`);
    assert.match(thrown.message, message, argv.join(' '));
    assert.equal(thrown.subcommand, subcommand, argv.join(' '));
    return true;
  });
}

test('probe: the profile and the adapter come from the options, then the environment, then max and the default adapter', () => {
  assert.deepEqual(parse('probe'), { command: 'probe', device: { profile: 'max', adapter: undefined } });
  assert.deepEqual(parse('probe', { OROGEN_GPU_PROFILE: 'core', OROGEN_GPU_ADAPTER: 'llvmpipe' }), { command: 'probe', device: { profile: 'core', adapter: 'llvmpipe' } });
  assert.deepEqual(parse('probe --profile max --adapter NVIDIA', { OROGEN_GPU_PROFILE: 'core', OROGEN_GPU_ADAPTER: 'llvmpipe' }), { command: 'probe', device: { profile: 'max', adapter: 'NVIDIA' } });
  assert.deepEqual(parse('probe --profile=core --adapter=Microsoft'), { command: 'probe', device: { profile: 'core', adapter: 'Microsoft' } });
  // An empty variable is an unset one.
  assert.deepEqual(parse('probe', { OROGEN_GPU_PROFILE: '', OROGEN_GPU_ADAPTER: '' }), { command: 'probe', device: { profile: 'max', adapter: undefined } });
  // An adapter name may hold spaces: it is one argument.
  assert.deepEqual(parseCommand(['probe', '--adapter', 'Basic Render'], {}, CWD), { command: 'probe', device: { profile: 'max', adapter: 'Basic Render' } });
});

test('probe: usage errors', () => {
  refused('probe --profile fastest', /^--profile is "fastest"; it is "core" or "max"$/, 'probe');
  refused('probe', /^OROGEN_GPU_PROFILE is "fastest"; it is "core" or "max"$/, 'probe', { OROGEN_GPU_PROFILE: 'fastest' });
  // The option wins: a wrong variable is not read when the option is given.
  assert.deepEqual(parse('probe --profile core', { OROGEN_GPU_PROFILE: 'fastest' }), { command: 'probe', device: { profile: 'core', adapter: undefined } });
  refused('probe extra', /orogen probe takes no argument such as "extra"/, 'probe');
  refused('probe --out there', /orogen probe has no option "--out"/, 'probe');
  refused('probe --profile', /--profile needs a value/, 'probe');
  refused('probe --profile --adapter x', /--profile needs a value/, 'probe');
  refused('probe --profile core --profile max', /--profile is given twice/, 'probe');
  refused('probe --adapter=', /--adapter needs a part of an adapter name/, 'probe');
  refused('probe -x', /orogen probe has no option "-x"/, 'probe');
});

test('render <type>: defaults', () => {
  assert.deepEqual(parse('render ref/fbm'), {
    command: 'render', device: { profile: 'max', adapter: undefined }, out: path.join(CWD, 'test-output'), budgetBytes: null,
    source: { kind: 'type', type: 'ref/fbm' }, res: DEFAULT_RES, params: [], maxParams: false, seed: null, crop: null, masked: false,
  });
  assert.equal(DEFAULT_RES, 513);
});

test('render <type>: every option', () => {
  const command = parseCommand([
    'render', 'simulate/hydraulic-erosion', '--res', '4033', '--param', 'reach=0.05', '--param=mode="add"', '--param', 'offset=[0.5, -0.25]',
    '--param', 'invert=true', '--max-params', '--seed', '4294967295', '--masked', '--crop', '768', '--out', 'pictures', '--budget-mb', '4096', '--profile', 'core', '--adapter', 'llvmpipe',
  ], { OROGEN_TEST_OUTPUT: 'elsewhere', OROGEN_GPU_PROFILE: 'max' }, CWD);
  assert.deepEqual(command, {
    command: 'render', device: { profile: 'core', adapter: 'llvmpipe' }, out: path.join(CWD, 'pictures'), budgetBytes: 4096 * 2 ** 20,
    source: { kind: 'type', type: 'simulate/hydraulic-erosion' }, res: 4033,
    params: [{ name: 'reach', value: 0.05 }, { name: 'mode', value: 'add' }, { name: 'offset', value: [0.5, -0.25] }, { name: 'invert', value: true }],
    maxParams: true, seed: 4294967295, crop: 768, masked: true,
  });
});

test('render: the output folder is --out, then OROGEN_TEST_OUTPUT, then test-output, each taken from the working directory', () => {
  const out = (line: string, env: Env = {}): string => (parse(line, env) as { out: string }).out;
  assert.equal(out('render ref/fbm'), path.join(CWD, 'test-output'));
  assert.equal(out('render ref/fbm', { OROGEN_TEST_OUTPUT: 'from-env' }), path.join(CWD, 'from-env'));
  assert.equal(out('render ref/fbm --out given', { OROGEN_TEST_OUTPUT: 'from-env' }), path.join(CWD, 'given'));
  const absolute = path.resolve('/somewhere/else');
  assert.equal(out(`render ref/fbm --out ${absolute}`), absolute);
  assert.equal(out('gallery', { OROGEN_TEST_OUTPUT: absolute }), absolute);
});

test('render: the budget is a number of MiB', () => {
  const budget = (text: string): number | null => (parse(`render ref/fbm --budget-mb ${text}`) as { budgetBytes: number | null }).budgetBytes;
  assert.equal(budget('1'), 1_048_576);
  assert.equal(budget('2457.6'), Math.floor(2457.6 * 2 ** 20));
  for (const text of ['0', '-5', 'lots', '1e3', '']) refused(['render', 'ref/fbm', `--budget-mb=${text}`], /--budget-mb .* is not a number of MiB above 0/, 'render');
});

test('render <project.orogen>: the file is taken from the working directory and the resolution is the project\'s unless --res is given', () => {
  assert.deepEqual(parse('render graphs/island.orogen --node talus'), {
    command: 'render', device: { profile: 'max', adapter: undefined }, out: path.join(CWD, 'test-output'), budgetBytes: null,
    source: { kind: 'project', file: path.join(CWD, 'graphs', 'island.orogen'), node: 'talus' }, res: null, params: [], maxParams: false, seed: null, crop: null, masked: false,
  });
  const given = parse('render Island.OROGEN --node=a.b --res 1009 --crop 768') as Extract<Command, { command: 'render' }>;
  assert.deepEqual([given.source, given.res, given.crop], [{ kind: 'project', file: path.join(CWD, 'Island.OROGEN'), node: 'a.b' }, 1009, 768]);
  // Without --res the resolution is not known yet: the crop is checked against it once the project is read.
  assert.equal((parse('render island.orogen --node talus --crop 2000') as { crop: number | null }).crop, 2000);
  refused('render island.orogen --node talus --res 1009 --crop 2000', /--crop 2000 is larger than the resolution 1009/, 'render');
});

test('render: usage errors', () => {
  refused('render', /name a node type or a project file/, 'render');
  refused('render ref/fbm ref/talus', /one node type or one project file is rendered at a time, not 2/, 'render');
  for (const subject of ['fbm', 'Ref/Fbm', 'ref/fbm/extra', 'project.json', 'ref/']) {
    refused(`render ${subject}`, /is neither a node type \(<category>\/<name>, such as ref\/fbm\) nor a project file \(\*\.orogen\)/, 'render');
  }
  refused('render ref/fbm --frobnicate', /orogen render has no option "--frobnicate"/, 'render');
  refused('render ref/fbm --max-params=1', /--max-params takes no value/, 'render');

  for (const res of ['600', '514', '32', '0', '8193', '9000', '257.5', 'big', '-513', '0513']) {
    refused(`render ref/fbm --res ${res}`, /--res .* is not a resolution: it is a level of at least 33 of the ladder of a build resolution/, 'render');
  }
  refused('render ref/fbm --res', /--res needs a value/, 'render');
  refused('render ref/fbm --res 257 --res 513', /--res is given twice/, 'render');

  refused('render ref/fbm --crop 0', /--crop "0" is not a window size in texels/, 'render');
  refused('render ref/fbm --crop half', /--crop "half" is not a window size in texels/, 'render');
  refused('render ref/fbm --crop 514', /--crop 514 is larger than the resolution 513/, 'render');
  refused('render ref/fbm --res 257 --crop 513', /--crop 513 is larger than the resolution 257/, 'render');
  assert.equal((parse('render ref/fbm --crop 513') as { crop: number | null }).crop, 513);

  for (const seed of ['-1', '4294967296', '1.5', 'seven']) refused(`render ref/fbm --seed ${seed}`, /--seed .* is not an integer in 0\.\.4294967295/, 'render');

  refused('render ref/fbm --param size', /--param "size" is not <name>=<json>/, 'render');
  refused('render ref/fbm --param =1', /--param "=1" is not <name>=<json>/, 'render');
  refused('render ref/fbm --param 9lives=1', /--param "9lives=1" is not <name>=<json>/, 'render');
  refused('render ref/fbm --param mode=add', /--param mode: "add" is not JSON\. A number is written 0\.25, a text '"add"'/, 'render');
  refused('render ref/fbm --param size=', /--param size: "" is not JSON/, 'render');
  refused('render ref/fbm --param size=null', /--param size: null is not a parameter value/, 'render');

  refused('render a.orogen', /--node <id> names the node of the project file to render/, 'render');
  refused('render a.orogen --node x --param size=1', /--param applies to a node type/, 'render');
  refused('render a.orogen --node x --max-params', /--max-params applies to a node type/, 'render');
  refused('render a.orogen --node x --seed 3', /--seed applies to a node type/, 'render');
  refused('render a.orogen --node x --masked', /--masked applies to a node type; the nodes of a project file are rendered with the connections it stores/, 'render');
  refused('render ref/blur --masked=1', /--masked takes no value/, 'render');
  refused('render ref/fbm --node x', /--node names a node of a project file/, 'render');
});

test('gallery: defaults and options', () => {
  assert.deepEqual(parse('gallery'), {
    command: 'gallery', device: { profile: 'max', adapter: undefined }, out: path.join(CWD, 'test-output'), budgetBytes: null, category: null, res: 513,
  });
  assert.deepEqual(parse('gallery --category simulate --res 257 --out g --budget-mb 512 --profile core'), {
    command: 'gallery', device: { profile: 'core', adapter: undefined }, out: path.join(CWD, 'g'), budgetBytes: 512 * 2 ** 20, category: 'simulate', res: 257,
  });
  for (const category of ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref']) {
    assert.equal((parse(`gallery --category ${category}`) as { category: string | null }).category, category);
  }
  refused('gallery --category rocks', /--category "rocks" is not a category; the categories are generate, adjust, filter, simulate, select, color, surface, io, ref/, 'gallery');
  refused('gallery ref', /orogen gallery takes no argument such as "ref"/, 'gallery');
  refused('gallery --res 1000', /--res "1000" is not a resolution/, 'gallery');
  refused('gallery --crop 64', /orogen gallery has no option "--crop"/, 'gallery');
});

test('build and unreal-test: the arguments are handed over unread', () => {
  assert.deepEqual(parse('build island.orogen --out there --res 8129 --json --no-such-option'), {
    command: 'export', subcommand: 'build', args: ['island.orogen', '--out', 'there', '--res', '8129', '--json', '--no-such-option'],
  });
  assert.deepEqual(parse('unreal-test --check file.r16'), { command: 'export', subcommand: 'unreal-test', args: ['--check', 'file.r16'] });
  assert.deepEqual(parse('build'), { command: 'export', subcommand: 'build', args: [] });
});

test('the subcommand comes first, and help is asked for by name or by option', () => {
  refused('', /^name a subcommand$/, null);
  refused('frobnicate', /"frobnicate" is not a subcommand/, null);
  refused('--res 513 render ref/fbm', /the subcommand comes first, before "--res"/, null);
  refused('help frobnicate', /"frobnicate" is not a subcommand/, null);

  assert.deepEqual(parse('--help'), { command: 'help', subcommand: null });
  assert.deepEqual(parse('-h'), { command: 'help', subcommand: null });
  assert.deepEqual(parse('help'), { command: 'help', subcommand: null });
  assert.deepEqual(parse('help render'), { command: 'help', subcommand: 'render' });
  assert.deepEqual(parse('render ref/fbm --res nonsense --help'), { command: 'help', subcommand: 'render' });
  assert.deepEqual(parse('build -h'), { command: 'help', subcommand: 'build' });
  // After `--` nothing is an option: this is an argument named --help, which probe refuses.
  refused('probe -- --help', /orogen probe takes no argument such as "--help"/, 'probe');
});

test('the usage text names every subcommand, option and exit code', () => {
  const whole = usageOf(null);
  for (const word of ['probe', 'render', 'gallery', 'build', 'unreal-test', '--profile', '--adapter', '--out', '--budget-mb', '--res', '--param', '--max-params', '--seed', '--crop', '--node', '--category']) {
    assert.ok(whole.includes(word), `the usage text lacks ${word}`);
  }
  assert.match(whole, /exit codes: 0 success, 1 a node failed, 2 usage error, 3 no usable GPU device or device lost, 130 cancelled/);
  assert.match(usageOf('render'), /^usage: orogen render <type>/);
  assert.ok(usageOf('render').includes('orogen render <project.orogen> --node <id>'));
  assert.ok(!usageOf('probe').includes('gallery'));
});

test('a resolution is a level of at least 33 of the ladder of a build resolution', () => {
  // 1009, 2017, 4033 and 8129 with their levels, the test resolutions, and levels of custom build resolutions:
  // 500 is level 4 of 7985, 512 level 4 of 8177.
  for (const res of [33, 64, 127, 128, 129, 253, 255, 257, 500, 505, 509, 512, 513, 1009, 1017, 1025, 2017, 2033, 2049, 4033, 4065, 8129, 8177]) {
    assert.equal(isLadderResolution(res), true, String(res));
  }
  // Below 33; above 8192; (res − 1)·2^k is never divisible by 16 below 8192; not an integer.
  for (const res of [0, 1, 2, 32, 514, 600, 1000, 4034, 8192, 8193, 16385, -513, 256.5, NaN, Infinity]) {
    assert.equal(isLadderResolution(res), false, String(res));
  }
});
