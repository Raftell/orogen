// Prints the statistics of an acceptance graph's targets in the format of its expectation file (testing.md
// 8.2, 10.3): the integrator runs it on the hardware adapter under `core` and keeps the output as
// tests/graphs/<name>.expect.json.
//
//   npm run expect -- <graph> [<node>.<port> ...] [--res <n>]
//
// <graph> is the name of a project file in tests/graphs/, or a path. The targets are those given, else those
// of the expectation file that exists, else every output of every node of the graph. The resolution is --res,
// else that of the existing file, else 257. Each statistic is printed as the range of 2e-4 around the measured
// value, the narrowest an expectation may be; the measured values go to standard error. Exit codes are those
// of the command line: 0, 1 a target was not produced, 2 usage, 3 no usable device.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GRAPHS = path.join(ROOT, 'tests', 'graphs');
const STATS = ['min', 'max', 'mean', 'std', 'p01', 'p50', 'p99'] as const;
/** Half the width of a printed range: a statistic in an expectation file is a range at least 2e-4 wide (testing.md 3.4). */
const HALF_WIDTH = 1e-4;

interface GraphExpectation {
  readonly res: number;
  readonly targets: Readonly<Record<string, Partial<Record<(typeof STATS)[number], readonly [lo: number, hi: number]>>>>;
}

function usage(problem: string): never {
  console.error(`expect: ${problem}`);
  console.error('usage: npm run expect -- <graph> [<node>.<port> ...] [--res <n>]');
  process.exit(2);
}

/** The lower and the upper end, each rounded outwards to six decimals. */
function rangeAround(value: number): readonly [number, number] {
  return [Math.floor((value - HALF_WIDTH) * 1e6) / 1e6, Math.ceil((value + HALF_WIDTH) * 1e6) / 1e6];
}

/** The categories of the node types a project file names; none for a text that is no project. */
function categoriesOf(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const nodes = typeof doc === 'object' && doc !== null && 'nodes' in doc && typeof doc.nodes === 'object' && doc.nodes !== null ? Object.values(doc.nodes) : [];
  const types = nodes.map((node) => (typeof node === 'object' && node !== null && 'type' in node && typeof node.type === 'string' ? node.type : ''));
  return [...new Set(types.map((type) => type.split('/')[0]!).filter((category) => /^[a-z]+$/.test(category)))];
}

async function main(args: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let res: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--res') {
      res = Number(args[++i]);
      if (!Number.isInteger(res)) usage('--res takes a resolution');
    } else if (arg.startsWith('--')) usage(`"${arg}" is not an option`);
    else positional.push(arg);
  }
  const [graph, ...given] = positional;
  if (graph === undefined) usage('name the graph');
  const file = [graph, `${graph}.orogen`].flatMap((name) => [path.resolve(name), path.join(GRAPHS, name)]).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (file === undefined) usage(`no project file "${graph}" in tests/graphs/ or at that path`);

  const expectationFile = file.replace(/\.orogen$/, '') + '.expect.json';
  // An empty file is one the shell has just truncated for this run's own output (`npm run expect -- x > x.expect.json`): no file yet.
  const held = fs.existsSync(expectationFile) ? fs.readFileSync(expectationFile, 'utf8') : '';
  const existing: GraphExpectation | null = held.trim() === '' ? null : JSON.parse(held) as GraphExpectation;
  const resolution = res ?? existing?.res ?? 257;

  // The harness is loaded only now: importing it loads the GPU binding.
  const { getEngine, renderGraph, stats, useNodes } = await import('../helpers/index.ts');
  const { GpuUnavailableError, parseDoc } = await import('../../src/core/runtime.ts');
  // An acceptance graph may name any node of the product: graph 05 holds export nodes. The categories its nodes
  // are of are loaded, and no other: a category somebody is working on does not stop the graphs that do not use it.
  for (const category of categoriesOf(fs.readFileSync(file, 'utf8'))) {
    const index = path.join(ROOT, 'src', 'core', 'nodes', category, 'index.ts');
    if (!fs.existsSync(index)) continue;
    useNodes((await import(pathToFileURL(index).href) as { readonly nodes: Parameters<typeof useNodes>[0] }).nodes);
  }

  let engine: Awaited<ReturnType<typeof getEngine>>;
  try {
    engine = await getEngine();
  } catch (thrown) {
    if (!(thrown instanceof GpuUnavailableError)) throw thrown;
    console.error(`expect: ${thrown.message}`);
    return 3;
  }
  let code = 0;
  try {
    let targets = given.length > 0 ? given : Object.keys(existing?.targets ?? {});
    if (targets.length === 0) {
      const { doc } = parseDoc(fs.readFileSync(file, 'utf8'), engine.engine.registry);
      targets = Object.values(doc.nodes).flatMap((node) => (engine.engine.registry.get(node.type)?.outputs ?? []).map((port) => `${node.id}.${port.name}`));
    }
    const { fields, report } = await renderGraph(file, targets, { res: resolution });
    const out: Record<string, Record<string, readonly [number, number]>> = {};
    for (const target of targets) {
      const field = fields[target];
      if (!field) {
        const node = report.nodes[target.slice(0, target.lastIndexOf('.'))];
        console.error(`expect: ${target} was not produced${node ? `: the node ended ${node.state}${node.error ? ` (${node.error.kind}: ${node.error.message})` : ''}` : ''}`);
        code = 1;
        continue;
      }
      // For a colour target the statistics are those of channel 0 (10.3).
      const measured = stats(field);
      if (measured.nonFinite > 0) {
        console.error(`expect: ${target} holds ${measured.nonFinite} values that are not finite`);
        code = 1;
      }
      out[target] = Object.fromEntries(STATS.map((name) => [name, rangeAround(measured[name])]));
      console.error(`${target}: ${STATS.map((name) => `${name} ${measured[name]}`).join(', ')}`);
    }
    const caps = engine.gpu.caps;
    console.error(`measured at ${resolution} on ${caps.adapter.description || caps.adapter.device}, profile ${engine.gpu.profile}${caps.software ? ' (a software adapter: an expectation file is made on hardware)' : ''}`);
    // A GraphExpectation, one target a line: the file is read and widened by a person.
    const lines = Object.entries(out).map(([target, ranges]) => {
      const members = Object.entries(ranges).map(([name, [lo, hi]]) => `${JSON.stringify(name)}: [${lo}, ${hi}]`);
      return `    ${JSON.stringify(target)}: { ${members.join(', ')} }`;
    });
    console.log(`{\n  "res": ${resolution},\n  "targets": {\n${lines.join(',\n')}\n  }\n}`);
  } finally {
    // runtime.md 1.5 rule 5: the engine, then the device, then the exit.
    await engine.engine.dispose();
    engine.gpu.destroy();
  }
  return code;
}

if (import.meta.main) {
  if (process.env.OROGEN_GUARD_ACTIVE !== '1') {
    // Project code runs under the memory guard (testing.md 8.2): this process starts itself again inside it.
    const guarded = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'guard.mjs'), 'node', import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(guarded.status ?? 1);
  }
  const code = await main(process.argv.slice(2)).catch((thrown: unknown) => {
    console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown));
    return 1;
  });
  process.stdout.write('', () => process.exit(code));
}
