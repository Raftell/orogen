#!/usr/bin/env node
// Writes docs/user/nodes.md, the node reference of the user documentation, from the registry the product runs
// with: every node's title, description, ports and parameters with units, defaults and ranges.
//
//   tools/guard node tools/node-reference.ts            writes docs/user/nodes.md
//   tools/guard node tools/node-reference.ts --check    writes nothing; exit code 1 when the file is out of date
//
// The text of a node comes from its definition alone. What is written here by hand is the introduction and the
// one paragraph per category. tests/unit/docs.test.ts makes the comparison of --check in the unit layer, so the
// page cannot fall behind the registry unnoticed.

import fs from 'node:fs';
import path from 'node:path';

import type { Category, NodeDef, ParamDef, PortDef } from '../src/core/api.ts';
import { nodes } from '../src/core/nodes/index.ts';
import { createRegistry } from '../src/core/runtime.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
/** The page this tool writes. */
export const REFERENCE_FILE = path.join(ROOT, 'docs', 'user', 'nodes.md');

/** The categories in the order of engine.md 4.1, with the sentence the reference says of each. */
const CATEGORIES: readonly (readonly [Category, string, string])[] = [
  ['generate', 'Generate', 'Nodes that need no input and make a terrain or a mask: noises, gradients, shapes and whole landforms.'],
  ['adjust', 'Adjust', 'Changes to single values and combinations of two inputs: levels, curves, clamping, arithmetic and blends.'],
  ['filter', 'Filter', 'Operations on a neighbourhood and on the geometry of the picture: blurring, sharpening, warping, moving and turning.'],
  ['simulate', 'Simulate', 'Simulations that run in steps, and the routing of water: erosion, snow, depression filling, flow, rivers, lakes and the sea.'],
  ['select', 'Select', 'Masks and measurements read from a terrain: height, slope, curvature, exposure, distance.'],
  ['color', 'Color', 'Everything that makes or changes a colour map.'],
  ['surface', 'Surface', 'Detail and structure added to a terrain without simulation: terraces, strata, rocks, scattered stamps.'],
  ['io', 'Import and export', 'Nodes that read image files, and the export nodes that say what a build writes. An export node has no output: it is the end of a branch of the graph.'],
  ['ref', 'Reference nodes', 'Small nodes the engine itself ships with. They are the templates node authors copy and the fixtures the tests use; the product registers them like any other node.'],
];

const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
/** A number as the reference prints it: six significant digits at the most. */
const num = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6))));
/** Text for one table cell. */
const cell = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
const code = (text: string): string => `\`${text}\``;
const anchor = (type: string): string => type.replace('/', '-');

function carries(port: PortDef): string {
  if (typeof port.type === 'object') return `the kind connected to ${code(port.type.sameAs)}`;
  if (port.type === 'color') return 'a colour map';
  if (port.type === 'any') return 'a field or a colour map';
  const role = port.role ?? 'height';
  return role === 'height' ? 'a terrain (heights)' : role === 'mask' ? 'a mask (0 to 1)' : 'data';
}

function portRows(def: NodeDef): string[] {
  const rows: string[] = [];
  for (const port of def.inputs) {
    rows.push(`| Input | ${code(port.name)} | ${cell(port.label ?? capital(port.name))} | ${carries(port)} | ${port.optional ? 'optional' : 'required'} |`);
  }
  // engine.md 4.13: the evaluator gives every maskable node this input; the definition does not list it.
  if (def.maskable) rows.push(`| Input | ${code('mask')} | Mask | a mask (0 to 1) | optional; limits the node's effect on ${code('out')} to where the mask is set |`);
  for (const port of def.outputs) {
    rows.push(`| Output | ${code(port.name)} | ${cell(port.label ?? capital(port.name))} | ${carries(port)} | |`);
  }
  return rows;
}

function kindOf(param: ParamDef): string {
  switch (param.kind) {
    case 'float': return 'number';
    case 'int': return 'whole number';
    case 'bool': return 'switch';
    case 'enum': return 'choice';
    case 'seed': return 'seed';
    case 'vec2': return 'two numbers';
    case 'color': return 'colour';
    case 'curve': return 'curve';
    case 'gradient': return 'gradient';
    case 'file': return 'file';
    case 'text': return 'text';
  }
}

const unitOf = (param: ParamDef): string => (param.kind === 'float' || param.kind === 'vec2' ? (param.unit === 'none' ? '' : param.unit) : '');

function defaultOf(param: ParamDef): string {
  switch (param.kind) {
    case 'float': case 'int': case 'seed': return num(param.default);
    case 'bool': return param.default ? 'on' : 'off';
    case 'enum': return param.options.find((option) => option.value === param.default)?.label ?? param.default;
    case 'vec2': return `${num(param.default[0])}, ${num(param.default[1])}`;
    case 'color': return `linear RGB ${param.default.map(num).join(', ')}`;
    case 'curve': return param.default.map((point) => `(${num(point.x)}, ${num(point.y)})`).join(' ');
    case 'gradient': return param.default.map((stop) => `${num(stop.t)}: ${stop.color.map(num).join(', ')}`).join('; ');
    case 'file': return 'no file';
    case 'text': return param.default === '' ? 'empty' : code(param.default);
  }
}

function rangeOf(param: ParamDef): string {
  switch (param.kind) {
    case 'float': return `${num(param.min)} to ${num(param.max)}${param.soft ? ' on the slider; any number can be typed' : ''}`;
    case 'int': return `${num(param.min)} to ${num(param.max)}`;
    case 'vec2': return `each ${num(param.min)} to ${num(param.max)}${param.soft ? ' on the slider; any number can be typed' : ''}`;
    case 'enum': return param.options.map((option) => `${option.label} (${code(option.value)})`).join(', ');
    case 'seed': return '0 to 4294967295';
    case 'color': return 'each channel 0 to 1';
    case 'curve': return 'points with x and y in 0 to 1';
    case 'gradient': return 'stops at 0 to 1, colours in linear RGB';
    case 'file': return param.filters.map((filter) => `.${filter}`).join(', ');
    case 'text': return `at most ${param.maxLength ?? 256} characters`;
    case 'bool': return '';
  }
}

function helpOf(def: NodeDef, param: ParamDef): string {
  const parts = [param.help];
  if (param.visibleWhen !== undefined) {
    const controller = def.params.find((other) => other.name === param.visibleWhen!.param);
    const values = (Array.isArray(param.visibleWhen.equals) ? param.visibleWhen.equals : [param.visibleWhen.equals]) as readonly (string | number | boolean)[];
    const shown = values.map((value) => {
      if (typeof value === 'boolean') return value ? 'on' : 'off';
      if (controller?.kind === 'enum') return controller.options.find((option) => option.value === value)?.label ?? String(value);
      return String(value);
    });
    parts.push(`Shown while ${controller?.label ?? capital(param.visibleWhen.param)} is ${shown.join(' or ')}.`);
  }
  if (param.group !== undefined) parts.push(`Section ${param.group}.`);
  return parts.join(' ');
}

function paramRows(def: NodeDef): string[] {
  return def.params.map((param) => [
    `| ${cell(param.label ?? capital(param.name))}`,
    code(param.name),
    kindOf(param),
    unitOf(param),
    cell(defaultOf(param)),
    cell(rangeOf(param)),
    `${cell(helpOf(def, param))} |`,
  ].join(' | '));
}

function notesOf(def: NodeDef): string[] {
  const notes: string[] = [];
  if (def.export !== undefined) notes.push('An export node: it has no output and takes part in a build while its Enabled switch is on.');
  if (def.maskable) notes.push('Maskable: connect a mask to limit where the node acts.');
  if (def.resolutionDependent) notes.push('Its result depends on measurements of the whole field, so a preview and the build can differ slightly.');
  if (def.uses?.includes('seaLevel')) notes.push("Reads the project's sea level.");
  if (def.params.some((param) => param.kind === 'seed')) notes.push("Random: the node's seed is combined with the project seed.");
  if (def.params.some((param) => param.kind === 'file')) notes.push('Reads a file: until one is selected the node reports "No file selected".');
  if ((def.version ?? 1) > 1) notes.push(`Version ${def.version}: a project file stores this number as the node's ${code('version')}.`);
  return notes;
}

function section(def: NodeDef): string[] {
  const lines = [`### ${def.title}`, '', `<a id="${anchor(def.type)}"></a>${code(def.type)}`, '', def.description, ''];
  if (def.keywords !== undefined && def.keywords.length > 0) lines.push(`Also found by: ${def.keywords.join(', ')}.`, '');
  for (const note of notesOf(def)) lines.push(`- ${note}`);
  if (notesOf(def).length > 0) lines.push('');
  const ports = portRows(def);
  if (ports.length > 0) lines.push('| | Port | Label | Carries | |', '| --- | --- | --- | --- | --- |', ...ports, '');
  else lines.push('No ports.', '');
  const params = paramRows(def);
  if (params.length > 0) lines.push('| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |', '| --- | --- | --- | --- | --- | --- | --- |', ...params, '');
  else lines.push('No parameters.', '');
  return lines;
}

/** The text of the reference for these definitions, in the order given. */
export function referencePage(defs: readonly NodeDef[]): string {
  const lines: string[] = [
    '# Node reference',
    '',
    'This page is generated from the node registry by `tools/node-reference.ts`. Do not edit it by hand: change the',
    'node, then run `tools/guard node tools/node-reference.ts` (on Windows `node tools/guard.mjs node',
    'tools/node-reference.ts`). It lists the nodes this checkout of Orogen registers: what the command-line program',
    'offers today, and what the Library panel of the desktop application will.',
    '',
    `${defs.length} nodes are registered.`,
    '',
    '## How to read an entry',
    '',
    '- The line under the title is the node\'s type, the name a project file stores and `orogen render` takes.',
    '- **Ports.** A *terrain* is a field of heights, a *mask* a field of values from 0 (unaffected) to 1 (fully',
    '  affected), *data* a field with a meaning of its own that the node states, and a *colour map* a colour per',
    '  point. A field output connects to any field input, and a field connects to a colour input and back: the',
    '  engine converts.',
    '- **Name** is the name of a parameter in a project file and on the command line (`--param name=value`).',
    '- **Unit** says what a stored number means (see [Concepts](concepts.md#units-the-unit-box)):',
    '',
    '  | Unit | A stored value of 1 means |',
    '  | --- | --- |',
    '  | length | the whole width of the terrain: 0.25 is a quarter of it |',
    '  | height | the whole height range of the project: 0.5 is half of it |',
    '  | angle | one degree. Directions run from 0 to 360, slopes from 0 to 90 |',
    '  | ratio | all of it: an amount, strength or share from 0 to 1 |',
    '  | (none) | a plain number |',
    '',
    '- **Range.** A value outside the range is brought back into it. Where the range is that of the slider only,',
    '  a typed value may lie outside it.',
    '',
    '## Contents',
    '',
  ];
  for (const [category, title] of CATEGORIES) {
    const count = defs.filter((def) => def.category === category).length;
    lines.push(`- [${title}](#${category}) (${count})`);
  }
  lines.push('');
  for (const [category, title, about] of CATEGORIES) {
    const own = defs.filter((def) => def.category === category);
    lines.push(`<a id="${category}"></a>`, '', `## ${title}`, '', about, '');
    if (own.length === 0) {
      lines.push('This checkout registers no node of this category.', '');
      continue;
    }
    lines.push(own.map((def) => `[${def.title}](#${anchor(def.type)})`).join(' · '), '');
    for (const def of own) lines.push(...section(def));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The text docs/user/nodes.md has to hold: the reference of the product's registry, which refuses two definitions of one type as the product would. */
export function nodeReference(): string {
  return referencePage(createRegistry(nodes).list());
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) {
    process.stderr.write('usage: node tools/node-reference.ts [--check]\n');
    process.exit(2);
  }
  const text = nodeReference();
  if (args.includes('--check')) {
    const held = fs.existsSync(REFERENCE_FILE) ? fs.readFileSync(REFERENCE_FILE, 'utf8') : null;
    if (held !== text) {
      process.stderr.write(`${path.relative(ROOT, REFERENCE_FILE)} is not what the registry gives: run tools/guard node tools/node-reference.ts\n`);
      process.exit(1);
    }
    process.stdout.write(`${path.relative(ROOT, REFERENCE_FILE)} is up to date\n`);
  } else {
    fs.mkdirSync(path.dirname(REFERENCE_FILE), { recursive: true });
    fs.writeFileSync(REFERENCE_FILE, text);
    process.stdout.write(`${REFERENCE_FILE}\n`);
  }
}
