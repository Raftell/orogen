// The node catalog against the product (nodes.md): the tables of docs/contract/nodes.md are parsed, and every
// category that has registered nodes is held to them. Each listed node is registered with the title, the ports
// and the flags of its row and has every parameter and option the row names; no node is registered that no row
// lists, unless the category lists it under "Added by owners".
//
// Each category index is imported by its own test case, so a category that fails to load fails that case only.
// A category without registered nodes has nothing to compare: its rows are parsed, and wait.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NodeDef, PortDef } from '../../src/core/api.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = 'docs/contract/nodes.md';
/** The categories the catalog lists: every one of engine.md 4.1 but `ref`, whose nodes testing.md 10.1 lists. */
const CATEGORIES = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io'] as const;

interface CatalogPort { readonly name: string; readonly type: string; readonly optional: boolean }
interface CatalogParam { readonly name: string; readonly options: readonly string[] | null }
interface CatalogNode {
  readonly id: string;
  readonly line: number;
  /** Listed under "Added by owners". */
  readonly added: boolean;
  /** null: the row names the node only; another document specifies it. */
  readonly detail: {
    readonly title: string;
    readonly inputs: readonly CatalogPort[];
    readonly outputs: readonly CatalogPort[];
    readonly params: readonly CatalogParam[];
    readonly flags: readonly string[];
  } | null;
}
interface Catalog {
  /** By category, in the order of the document. */
  readonly nodes: ReadonlyMap<string, readonly CatalogNode[]>;
  /** The number of nodes each category's heading states. */
  readonly counts: ReadonlyMap<string, number>;
}

const NODE_ID = /^[a-z]+\/[a-z][a-z0-9-]*$/;
const PORT_NAME = /^[a-z][A-Za-z0-9]{0,23}$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]*$/;
const PORT_TYPE = /^(field|field, mask|field, data|color|any|same as [a-z][A-Za-z0-9]*)$/;
const FLAGS = ['maskable', 'resolutionDependent'];

/** The cells of a table row, without the outer bars. */
const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const isSeparator = (cells: readonly string[]): boolean => cells.every((cell) => /^:?-+:?$/.test(cell));

/** Splits at `separator` where it is outside parentheses and backticks. */
function split(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quoted = false, current = '';
  for (const char of text) {
    if (char === '`') quoted = !quoted;
    else if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')') depth--;
    if (char === separator && depth === 0 && !quoted) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** `` `name` type[, optional] ``, separated by `;`. Throws with the place for what is no port. */
function portsOf(cell: string, side: 'input' | 'output', where: string): CatalogPort[] {
  return split(cell, ';').map((text) => {
    const found = /^`([^`]+)` (.+)$/.exec(text);
    if (!found) throw new Error(`${where}: "${text}" is no ${side}; a port is written \`name\` type`);
    const [, name, rest] = found as unknown as [string, string, string];
    const optional = rest.endsWith(', optional');
    const type = optional ? rest.slice(0, -', optional'.length) : rest;
    if (!PORT_NAME.test(name)) throw new Error(`${where}: "${name}" is no port name`);
    if (!PORT_TYPE.test(type)) throw new Error(`${where}: the ${side} "${name}" has the type "${type}"; it is field, "field, mask", "field, data", color, any or "same as <input>"`);
    if (optional && side === 'output') throw new Error(`${where}: the output "${name}" is marked optional`);
    if ((type === 'any') === (side === 'output') && (type === 'any' || type.startsWith('same as'))) {
      throw new Error(`${where}: the ${side} "${name}" has the type "${type}"; an input is "any" and an output "same as <input>"`);
    }
    return { name, type, optional };
  });
}

/** `` `name` `` or `` `name` (`option`, `option`) ``, separated by commas. */
function paramsOf(cell: string, where: string): CatalogParam[] {
  return split(cell, ',').map((text) => {
    const found = /^`([^`]+)`(?: \((.+)\))?$/.exec(text);
    if (!found || !PARAM_NAME.test(found[1]!)) throw new Error(`${where}: "${text}" is no parameter; one is written \`name\`, an enum \`name\` (\`option\`, ...)`);
    const options = found[2] === undefined ? null : split(found[2], ',').map((option) => {
      const value = /^`([^`]+)`$/.exec(option);
      if (!value) throw new Error(`${where}: "${option}" is no option of "${found[1]}"; an option is written in backticks`);
      return value[1]!;
    });
    return { name: found[1]!, options };
  });
}

/** The catalog a text holds. Throws for a row it cannot read: a catalog nobody can check is no catalog. */
function parseCatalog(text: string): Catalog {
  const nodes = new Map<string, CatalogNode[]>();
  const counts = new Map<string, number>();
  let category: string | null = null;
  let added = false;
  let columns: string[] | null = null;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const where = `${CATALOG}:${index + 1}`;
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      columns = null;
      if (heading[1] === '##') {
        const section = /^\d+\. `([a-z]+)`: (\d+) nodes$/.exec(heading[2]!);
        category = section ? section[1]! : null;
        added = false;
        if (section) {
          counts.set(section[1]!, Number(section[2]));
          nodes.set(section[1]!, []);
        }
      } else added = heading[2]!.trim() === 'Added by owners';
      continue;
    }
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = cellsOf(line);
    if (columns === null) {
      columns = cells;
      continue;
    }
    if (isSeparator(cells) || category === null || columns[0] !== 'Id') continue;
    if (cells.length !== columns.length) throw new Error(`${where}: the row has ${cells.length} cells and its table ${columns.length} columns`);
    const cell = (name: string): string => cells[columns!.indexOf(name)]!;
    const ids = split(cells[0]!, ',').map((id) => /^`([^`]+)`$/.exec(id)?.[1] ?? '');
    for (const id of ids) {
      if (!NODE_ID.test(id) || !id.startsWith(`${category}/`)) throw new Error(`${where}: "${id}" is no node type of the category ${category}`);
    }
    const listed = nodes.get(category)!;
    if (!columns.includes('Inputs')) {
      for (const id of ids) listed.push({ id, line: index + 1, added, detail: null });
      continue;
    }
    for (const name of ['Title', 'Inputs', 'Outputs', 'Parameters', 'Flags']) {
      if (!columns.includes(name)) throw new Error(`${where}: the table has no column "${name}"`);
    }
    if (ids.length !== 1) throw new Error(`${where}: a row with ports lists one node, not ${ids.length}`);
    const flags = split(cell('Flags'), ',').map((flag) => /^`([^`]+)`$/.exec(flag)?.[1] ?? flag);
    for (const flag of flags) if (!FLAGS.includes(flag)) throw new Error(`${where}: "${flag}" is no flag; the flags are ${FLAGS.join(' and ')}`);
    if (cell('Title') === '') throw new Error(`${where}: ${ids[0]} has no title`);
    listed.push({
      id: ids[0]!, line: index + 1, added,
      detail: {
        title: cell('Title'), inputs: portsOf(cell('Inputs'), 'input', where), outputs: portsOf(cell('Outputs'), 'output', where),
        params: paramsOf(cell('Parameters'), where), flags,
      },
    });
  }
  return { nodes, counts };
}

/** A port of a definition as the catalog writes its type. */
function typeOf(port: PortDef): string {
  if (typeof port.type === 'object') return `same as ${port.type.sameAs}`;
  if (port.type !== 'field') return port.type;
  const role = port.role ?? 'height';
  return role === 'height' ? 'field' : `field, ${role}`;
}
const written = (ports: readonly { readonly name: string; readonly type: string; readonly optional?: boolean }[]): string =>
  ports.map((port) => `\`${port.name}\` ${port.type}${port.optional ? ', optional' : ''}`).join('; ') || 'none';

/** What the registered nodes of one category and its rows of the catalog disagree about; one sentence each. */
function compare(category: string, listed: readonly CatalogNode[], registered: readonly NodeDef[]): string[] {
  const problems: string[] = [];
  const byType = new Map(registered.map((def) => [def.type, def]));
  const rows = new Map(listed.map((row) => [row.id, row]));
  for (const def of registered) {
    if (!rows.has(def.type)) {
      problems.push(`${def.type} is registered and ${CATALOG} does not list it: list it in the section of ${category} under "### Added by owners", or do not register it`);
    }
  }
  for (const row of listed) {
    const where = `${CATALOG}:${row.line}`;
    const def = byType.get(row.id);
    if (!def) {
      problems.push(`${where} lists ${row.id}, which is not registered`);
      continue;
    }
    if (!row.detail) continue;
    if (def.title !== row.detail.title) problems.push(`${where}: ${row.id} is titled "${def.title}"; the catalog says "${row.detail.title}"`);
    const inputs = def.inputs.map((port) => ({ name: port.name, type: typeOf(port), optional: port.optional === true }));
    if (written(inputs) !== written(row.detail.inputs)) problems.push(`${where}: the inputs of ${row.id} are ${written(inputs)}; the catalog says ${written(row.detail.inputs)}`);
    const outputs = def.outputs.map((port) => ({ name: port.name, type: typeOf(port) }));
    if (written(outputs) !== written(row.detail.outputs)) problems.push(`${where}: the outputs of ${row.id} are ${written(outputs)}; the catalog says ${written(row.detail.outputs)}`);
    for (const named of row.detail.params) {
      const param = def.params.find((candidate) => candidate.name === named.name);
      if (!param) {
        problems.push(`${where}: ${row.id} has no parameter "${named.name}"; it has ${def.params.map((candidate) => candidate.name).join(', ') || 'none'}`);
        continue;
      }
      if (named.options === null) continue;
      if (param.kind !== 'enum') {
        problems.push(`${where}: the parameter "${named.name}" of ${row.id} is listed with options and is a ${param.kind}`);
        continue;
      }
      const missing = named.options.filter((option) => !param.options.some((candidate) => candidate.value === option));
      if (missing.length > 0) problems.push(`${where}: "${named.name}" of ${row.id} lacks the option${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; it has ${param.options.map((candidate) => candidate.value).join(', ')}`);
    }
    const flags = [...(def.maskable ? ['maskable'] : []), ...(def.resolutionDependent ? ['resolutionDependent'] : [])];
    if (flags.join(', ') !== row.detail.flags.join(', ')) {
      problems.push(`${where}: ${row.id} is ${flags.join(' and ') || 'neither maskable nor resolutionDependent'}; the catalog says ${row.detail.flags.join(' and ') || 'neither'}`);
    }
  }
  return problems;
}

const catalog = parseCatalog(readFileSync(path.join(ROOT, CATALOG), 'utf8'));

test('the catalog: every category has its section, the number of nodes its heading states, and no node twice', () => {
  assert.deepEqual([...catalog.nodes.keys()], [...CATEGORIES]);
  const seen = new Set<string>();
  for (const category of CATEGORIES) {
    const listed = catalog.nodes.get(category)!;
    // The count of a heading is that of the release: what owners added is beside it.
    assert.equal(listed.filter((row) => !row.added).length, catalog.counts.get(category), `the heading of ${category} against its rows`);
    for (const row of listed) {
      assert.ok(!seen.has(row.id), `${CATALOG}:${row.line}: ${row.id} is listed twice`);
      seen.add(row.id);
    }
  }
  // The rows of a table with ports are complete: every one has a title, an output, and names that are names.
  for (const row of [...catalog.nodes.values()].flat()) {
    if (!row.detail) continue;
    assert.ok(row.detail.outputs.length >= 1 && row.detail.outputs[0]!.name === 'out', `${CATALOG}:${row.line}: ${row.id} has an output named out first`);
    for (const output of row.detail.outputs) {
      if (output.type.startsWith('same as ')) assert.ok(row.detail.inputs.some((input) => input.name === output.type.slice('same as '.length) && input.type === 'any' && !input.optional), `${CATALOG}:${row.line}: "${output.type}" names a required input of type any`);
    }
  }
});

for (const category of CATEGORIES) {
  test(`${category}: the registered nodes are those of the catalog, with its titles, ports, parameters and flags`, async (t) => {
    const module = await import(pathToFileURL(path.join(ROOT, 'src/core/nodes', category, 'index.ts')).href) as { readonly nodes: readonly NodeDef[] };
    if (module.nodes.length === 0) {
      t.diagnostic(`no node of ${category} is registered yet: ${catalog.nodes.get(category)!.length} rows wait`);
      return;
    }
    const problems = compare(category, catalog.nodes.get(category)!, module.nodes);
    assert.equal(problems.length, 0, `${problems.length} differences between ${CATALOG} and src/core/nodes/${category}:\n${problems.slice(0, 30).join('\n')}`);
  });
}

// ---- the reader and the comparison, on a catalog made for them ---------------------------------------------------

const SAMPLE = `# Sample

## 1. \`filter\`: 2 nodes

Prose, and a table that lists no nodes:

| Owner | Nodes |
| --- | --- |
| someone | \`blur\`, \`warp\` |

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| \`filter/blur\` | Blur | \`in\` any | \`out\` same as in | \`radius\` | \`maskable\` | Blurs, with a \`radius\` |
| \`filter/warp\` | Warp | \`in\` field; \`guide\` field, data, optional; \`mask\` field, mask, optional | \`out\` field; \`moved\` field, data | \`mode\` (\`noise\`, \`guide\`), \`distance\` | | Warps (a note, with a comma) |

### Added by owners

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| \`filter/extra\` | Extra | | \`out\` color | | \`maskable\`, \`resolutionDependent\` | Something the category lacked |

## 2. \`io\`: 3 nodes

| Id | Specified in |
| --- | --- |
| \`io/export-a\`, \`io/export-b\` | elsewhere |
| \`io/export-c\` | elsewhere |

## 3. Not a category
`;

const def = (type: string, over: Partial<NodeDef> = {}): NodeDef => ({
  type, title: 'Blur', category: 'filter', description: 'Blurs.', inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [{ kind: 'float', name: 'radius', unit: 'length', help: 'A radius.', default: 0.01, min: 0.001, max: 0.25 }], kernels: [], maskable: true,
  evaluate() {}, ...over,
});
const warp = def('filter/warp', {
  title: 'Warp', maskable: false,
  inputs: [{ name: 'in', type: 'field' }, { name: 'guide', type: 'field', role: 'data', optional: true }, { name: 'mask', type: 'field', role: 'mask', optional: true }],
  outputs: [{ name: 'out', type: 'field', role: 'height' }, { name: 'moved', type: 'field', role: 'data' }],
  params: [
    { kind: 'enum', name: 'mode', help: 'A mode.', default: 'noise', options: [{ value: 'noise', label: 'Noise' }, { value: 'guide', label: 'Guide' }, { value: 'both', label: 'Both' }] },
    { kind: 'float', name: 'distance', unit: 'length', help: 'A distance.', default: 0.01, min: 0.001, max: 0.25 },
    { kind: 'seed', name: 'seed', help: 'A seed.', default: 0 },
  ],
});
const extra = def('filter/extra', { title: 'Extra', inputs: [], outputs: [{ name: 'out', type: 'color' }], params: [], resolutionDependent: true });

test('the reader: sections, tables with ports and tables of ids, and what owners added', () => {
  const sample = parseCatalog(SAMPLE);
  assert.deepEqual([...sample.nodes.keys()], ['filter', 'io']);
  assert.deepEqual([...sample.counts], [['filter', 2], ['io', 3]]);
  const filter = sample.nodes.get('filter')!;
  assert.deepEqual(filter.map((row) => `${row.id}${row.added ? ' (added)' : ''}`), ['filter/blur', 'filter/warp', 'filter/extra (added)']);
  assert.deepEqual(filter[0]!.detail, {
    title: 'Blur', inputs: [{ name: 'in', type: 'any', optional: false }], outputs: [{ name: 'out', type: 'same as in', optional: false }],
    params: [{ name: 'radius', options: null }], flags: ['maskable'],
  });
  assert.deepEqual(filter[1]!.detail!.inputs, [
    { name: 'in', type: 'field', optional: false }, { name: 'guide', type: 'field, data', optional: true }, { name: 'mask', type: 'field, mask', optional: true },
  ]);
  assert.deepEqual(filter[1]!.detail!.params, [{ name: 'mode', options: ['noise', 'guide'] }, { name: 'distance', options: null }]);
  assert.deepEqual([filter[1]!.detail!.flags, filter[2]!.detail!.flags, filter[2]!.detail!.inputs], [[], ['maskable', 'resolutionDependent'], []]);
  assert.deepEqual(sample.nodes.get('io')!.map((row) => [row.id, row.detail]), [['io/export-a', null], ['io/export-b', null], ['io/export-c', null]]);

  // A row nobody can check is refused, with its line.
  const broken = (row: string, message: RegExp): void => {
    assert.throws(() => parseCatalog(SAMPLE.replace('| `filter/blur` | Blur | `in` any | `out` same as in | `radius` | `maskable` | Blurs, with a `radius` |', row)), message);
  };
  broken('| `filter/blur` | Blur | in any | `out` field | | | x |', /nodes\.md:13: "in any" is no input/);
  broken('| `filter/blur` | Blur | `in` height | `out` field | | | x |', /the input "in" has the type "height"/);
  broken('| `filter/blur` | Blur | `in` field | `out` any | | | x |', /an input is "any" and an output "same as <input>"/);
  broken('| `filter/blur` | Blur | `in` field | `out` field | radius | | x |', /"radius" is no parameter/);
  broken('| `filter/blur` | Blur | `in` field | `out` field | `mode` (fast) | | x |', /"fast" is no option of "mode"/);
  broken('| `filter/blur` | Blur | `in` field | `out` field | | `fast` | x |', /"fast" is no flag/);
  broken('| `select/blur` | Blur | `in` field | `out` field | | | x |', /"select\/blur" is no node type of the category filter/);
  broken('| `filter/blur` | Blur | `in` field | `out` field | | x |', /the row has 6 cells and its table 7 columns/);
});

test('the comparison: a node that is missing, unlisted, or differs in title, ports, parameters, options or flags is named', () => {
  const rows = parseCatalog(SAMPLE).nodes.get('filter')!;
  assert.deepEqual(compare('filter', rows, [def('filter/blur'), warp, extra]), [], 'the three nodes as the sample lists them; a parameter and an option beyond the listed ones are the owner\'s');

  const said = (registered: readonly NodeDef[]): string[] => compare('filter', rows, registered);
  assert.deepEqual(said([def('filter/blur'), warp]), ['docs/contract/nodes.md:20 lists filter/extra, which is not registered']);
  assert.deepEqual(said([def('filter/blur'), warp, extra, def('filter/sharp')]), [
    'filter/sharp is registered and docs/contract/nodes.md does not list it: list it in the section of filter under "### Added by owners", or do not register it',
  ]);
  assert.deepEqual(said([def('filter/blur', { title: 'Soften' }), warp, extra]), ['docs/contract/nodes.md:13: filter/blur is titled "Soften"; the catalog says "Blur"']);
  assert.deepEqual(said([def('filter/blur', { inputs: [{ name: 'in', type: 'field' }], outputs: [{ name: 'out', type: 'field' }] }), warp, extra]), [
    'docs/contract/nodes.md:13: the inputs of filter/blur are `in` field; the catalog says `in` any',
    'docs/contract/nodes.md:13: the outputs of filter/blur are `out` field; the catalog says `out` same as in',
  ]);
  // A role, an optional input and the order of the ports are part of a port.
  assert.deepEqual(said([def('filter/blur'), { ...warp, inputs: [warp.inputs[0]!, { ...warp.inputs[1]!, optional: false }, warp.inputs[2]!] }, extra]), [
    'docs/contract/nodes.md:14: the inputs of filter/warp are `in` field; `guide` field, data; `mask` field, mask, optional; the catalog says `in` field; `guide` field, data, optional; `mask` field, mask, optional',
  ]);
  assert.deepEqual(said([def('filter/blur'), { ...warp, outputs: [warp.outputs[0]!, { name: 'moved', type: 'field', role: 'mask' }] }, extra]), [
    'docs/contract/nodes.md:14: the outputs of filter/warp are `out` field; `moved` field, mask; the catalog says `out` field; `moved` field, data',
  ]);
  assert.deepEqual(said([def('filter/blur', { params: [] }), warp, extra]), ['docs/contract/nodes.md:13: filter/blur has no parameter "radius"; it has none']);
  const fewer = { ...warp, params: [{ ...warp.params[0]!, options: [{ value: 'noise', label: 'Noise' }, { value: 'both', label: 'Both' }] } as NodeDef['params'][number], warp.params[1]!] };
  assert.deepEqual(said([def('filter/blur'), fewer, extra]), ['docs/contract/nodes.md:14: "mode" of filter/warp lacks the option guide; it has noise, both']);
  assert.deepEqual(said([def('filter/blur', { maskable: false }), warp, extra]), ['docs/contract/nodes.md:13: filter/blur is neither maskable nor resolutionDependent; the catalog says maskable']);
  assert.deepEqual(said([def('filter/blur'), warp, { ...extra, resolutionDependent: false }]), ['docs/contract/nodes.md:20: filter/extra is maskable; the catalog says maskable and resolutionDependent']);
});
