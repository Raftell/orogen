import * as api from '../api.ts';
import type { AnyKernel } from '../gpu/kernel.ts';
import type { WgslLib } from '../gpu/lib.ts';
import type { NodeDef } from './node.ts';
import type { ParamDef } from './param-types.ts';
import type { PortDef } from './ports.ts';

// The registry lint of testing.md section 4, as pure functions over definitions, source text and file lists.
// Reading the files and importing the modules is done by tests/unit/registry.test.ts; the rules about what a
// file imports (import-node, import-src, import-tests, import-ext) are tests/unit/boundaries.test.ts.

export interface LintProblem {
  readonly rule: string;        // the rule id: 'title', 'param-words', 'kernel-name', ...
  readonly subject: string;     // the node type, or the file
  readonly message: string;     // begins with the rule id and the subject
}

/** Everything api.ts exports: the kernels, tasks and libraries of core, which the naming rules exempt. */
const CORE: ReadonlySet<unknown> = new Set(Object.values(api));
const isLib = (v: unknown): v is WgslLib => typeof v === 'object' && v !== null && 'deps' in v && 'code' in v && 'name' in v;
const CORE_LIB_NAMES: readonly string[] = [...CORE].filter(isLib).map((lib) => lib.name);

const KEYWORD = /^[a-z0-9][a-z0-9 -]*$/;
const ENUM_VALUE = /^[a-z0-9][A-Za-z0-9-]*$/;
const STARTS_CAPITAL_OR_DIGIT = /^[\p{Lu}\p{N}]/u;
const ENDS_IN_PUNCTUATION = /\p{P}$/u;
const REFERENCE = ' (Reference)';
/** The words Title Case leaves small inside a title, and the signs that join two names: "Bias and Gain", "Hue / Saturation". */
const SMALL_WORDS: readonly string[] = ['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', '/', '&'];
const FORBIDDEN_WORDS: readonly string[] = ['px', 'pixel', 'pixels', 'texel', 'texels', 'iterations', 'iters', 'steps', 'passes'];
/** First words that end in "s" and are no verb in the third person. */
const NOT_VERBS: readonly string[] = ['This', 'Its', 'Thus', 'Always', 'Plus', 'Various', 'Across', 'Is', 'Was', 'Has'];

/** engine.md 4.4: the kind and unit of each canonical concept, by exact name and by the ending of a name. */
const CONCEPTS: Readonly<Record<string, { readonly kind: 'float' | 'int'; readonly unit?: string }>> = {
  size: { kind: 'float', unit: 'length' },
  radius: { kind: 'float', unit: 'length' },
  strength: { kind: 'float', unit: 'ratio' },
  height: { kind: 'float', unit: 'height' },
  angle: { kind: 'float', unit: 'angle' },
  octaves: { kind: 'int' },
  gain: { kind: 'float', unit: 'ratio' },
};
const CONCEPT_ENDINGS: readonly string[] = ['Size', 'Radius', 'Strength', 'Angle'];

const UNIT_RANGES: Readonly<Record<string, { readonly float: readonly [number, number]; readonly vec2: readonly [number, number] }>> = {
  ratio: { float: [0, 1], vec2: [0, 1] },
  angle: { float: [0, 360], vec2: [0, 360] },
  length: { float: [0, 4], vec2: [-4, 4] },
  height: { float: [-1, 1], vec2: [-1, 1] },
};

const labelOf = (item: { readonly name: string; readonly label?: string }): string =>
  item.label ?? item.name.charAt(0).toUpperCase() + item.name.slice(1);
const camelWords = (name: string): string[] => (name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []).map((w) => w.toLowerCase());

/** The code a kernel is assembled from that a node author wrote: its own and that of the category's libraries. */
function authorCode(kernel: AnyKernel): string[] {
  const texts = [kernel.def.code];
  const seen = new Set<WgslLib>();
  const visit = (lib: WgslLib): void => {
    if (seen.has(lib) || CORE.has(lib)) return;
    seen.add(lib);
    texts.push(lib.code);
    lib.deps.forEach(visit);
  };
  (kernel.def.includes ?? []).forEach(visit);
  return texts;
}

function labelProblem(label: string): string | null {
  if (label.length > 24) return `has ${label.length} characters; a label has at most 24`;
  if (!STARTS_CAPITAL_OR_DIGIT.test(label)) return 'does not begin with a capital or a digit';
  if (ENDS_IN_PUNCTUATION.test(label)) return 'ends in punctuation';
  return null;
}

/**
 * The rules that one definition decides: kernel-name, generator-frame, the text rules (title, description, help,
 * label, keywords, enum-value) and the parameter and port rules (param-words, param-canonical, unit-range,
 * log-scale, role-select, role-generate, has-output). This is the `meta` check of the conformance suite.
 *
 * Of kernel-name it decides the category prefix; that a name carries its file's name is lintNodeSource's part.
 */
export function lintNode(def: NodeDef): LintProblem[] {
  const out: LintProblem[] = [];
  const fail = (rule: string, detail: string): void => {
    out.push({ rule, subject: def.type, message: `${rule} ${def.type}: ${detail}` });
  };

  for (const [what, items] of [['kernel', def.kernels], ['CPU task', def.cpuTasks ?? []]] as const) {
    for (const item of items) {
      if (!CORE.has(item) && !item.name.startsWith(`${def.category}/`)) {
        fail('kernel-name', `the name of ${what} "${item.name}" does not begin with "${def.category}/"`);
      }
    }
  }

  if (def.inputs.every((input) => input.optional)) {
    for (const kernel of def.kernels) {
      const code = authorCode(kernel).join('\n');
      for (const member of ['frame.res', 'frame.cellSize']) {
        if (code.includes(member)) fail('generator-frame', `kernel "${kernel.name}" mentions ${member}; a node without required inputs is a function of uv`);
      }
    }
  }

  lintTitle(def, (detail) => fail('title', detail));
  lintDescription(def.description, (detail) => fail('description', detail));

  const keywords = def.keywords ?? [];
  if (keywords.length > 12) fail('keywords', `${keywords.length} keywords; at most 12`);
  for (const [i, keyword] of keywords.entries()) {
    if (!KEYWORD.test(keyword)) fail('keywords', `"${keyword}" is not lower-case letters, digits, spaces and hyphens`);
    if (keywords.indexOf(keyword) !== i) fail('keywords', `"${keyword}" is listed twice`);
  }

  for (const param of def.params) lintParam(param, fail);

  const ports: readonly (readonly [string, PortDef])[] = [
    ...def.inputs.map((port) => ['input', port] as const),
    ...def.outputs.map((port) => ['output', port] as const),
  ];
  for (const [side, port] of ports) {
    const problem = labelProblem(labelOf(port));
    if (problem) fail('label', `the label "${labelOf(port)}" of ${side} "${port.name}" ${problem}`);
  }

  const primary = def.outputs[0];
  if (!primary) {
    if (!def.export) fail('has-output', 'the node has no output and is not an export node');
  } else if (def.category === 'select') {
    if (primary.type !== 'field' || (primary.role !== 'mask' && primary.role !== 'data')) {
      fail('role-select', `output "${primary.name}" of a select node has role "mask" or "data"`);
    }
  } else if (def.category === 'generate') {
    if (primary.type !== 'field' || primary.role === 'data') {
      fail('role-generate', `output "${primary.name}" of a generate node is a field of role "height" or "mask"`);
    }
  }
  return out;
}

function lintTitle(def: NodeDef, fail: (detail: string) => void): void {
  let title = def.title;
  if (def.category === 'ref') {
    if (!title.endsWith(REFERENCE)) fail(`the title "${title}" of a ref node does not end in "${REFERENCE}"`);
    else title = title.slice(0, -REFERENCE.length);
  }
  if (title.trim() === '') {
    fail('the title is empty');
    return;
  }
  if (title.length > 24) fail(`"${title}" has ${title.length} characters; a title has at most 24`);
  const words = title.split(/\s+/).filter((word) => word !== '');
  // Title Case: the first and the last word are capitalised whatever they are.
  const small = words.find((word, i) => !STARTS_CAPITAL_OR_DIGIT.test(word) && (i === 0 || i === words.length - 1 || !SMALL_WORDS.includes(word)));
  if (small !== undefined) fail(`the word "${small}" of "${title}" does not begin with a capital letter or a digit`);
  if (ENDS_IN_PUNCTUATION.test(title)) fail(`"${title}" ends in punctuation`);
}

function lintDescription(description: string, fail: (detail: string) => void): void {
  if (description.length > 140) fail(`${description.length} characters; a description has at most 140`);
  if (/[\r\n]/.test(description)) fail('the description has a line break');
  if (!description.endsWith('.')) fail('the description does not end with a full stop');
  const first = /^\S*/.exec(description)![0];
  if (!/^[A-Z][a-z]+(-[a-z]+)*s$/.test(first) || NOT_VERBS.includes(first)) {
    fail(`the description begins with "${first}", not with a capitalised verb in the third person such as "Generates"`);
  }
  if (/[.!?]\s/.test(description.trimEnd().slice(0, -1))) fail('the description is more than one sentence');
}

function lintParam(param: ParamDef, fail: (rule: string, detail: string) => void): void {
  const at = `param "${param.name}"`;
  const label = labelOf(param);

  if (param.help.length > 200) fail('help', `the help of ${at} has ${param.help.length} characters; at most 200`);
  if (!/^\p{Lu}/u.test(param.help)) fail('help', `the help of ${at} does not begin with a capital`);
  if (!param.help.endsWith('.')) fail('help', `the help of ${at} does not end with a full stop`);
  const plain = (text: string): string => text.trim().replace(/\.$/, '').toLowerCase();
  if (plain(param.help) === plain(label)) fail('help', `the help of ${at} repeats its label`);

  const problem = labelProblem(label);
  if (problem) fail('label', `the label "${label}" of ${at} ${problem}`);
  if (param.kind === 'enum') {
    for (const option of param.options) {
      const optionProblem = labelProblem(option.label);
      if (optionProblem) fail('label', `the label "${option.label}" of option "${option.value}" of ${at} ${optionProblem}`);
      if (!ENUM_VALUE.test(option.value)) fail('enum-value', `the value "${option.value}" of ${at} does not match [a-z0-9][A-Za-z0-9-]*`);
    }
  }

  const word = camelWords(param.name).find((w) => FORBIDDEN_WORDS.includes(w));
  if (word !== undefined) fail('param-words', `${at} contains "${word}"; a stored value is never in texels or iterations`);

  if (param.kind === 'float' || param.kind === 'int' || param.kind === 'vec2') {
    const ending = CONCEPT_ENDINGS.find((e) => param.name.endsWith(e));
    const concept = CONCEPTS[param.name] ?? (ending ? CONCEPTS[ending.toLowerCase()] : undefined);
    const unit = param.kind === 'int' ? undefined : param.unit;
    if (concept && (param.kind !== concept.kind || unit !== concept.unit)) {
      const want = concept.unit ? `${concept.kind} of unit "${concept.unit}"` : concept.kind;
      const have = unit ? `${param.kind} of unit "${unit}"` : param.kind;
      fail('param-canonical', `${at} is a ${have}; that name is a ${want}`);
    }
  }

  if (param.kind === 'float' || param.kind === 'vec2') {
    const range = UNIT_RANGES[param.unit]?.[param.kind];
    if (range && (param.min < range[0] || param.max > range[1])) {
      fail('unit-range', `${at} has the range ${param.min}..${param.max}; a ${param.kind} of unit "${param.unit}" lies within ${range[0]}..${range[1]}`);
    }
    if (param.unit === 'ratio' && param.soft) fail('unit-range', `${at} is a ratio and cannot be soft`);
  }
  if (param.kind === 'float' && param.min > 0 && param.max / param.min >= 100 && param.scale !== 'log') {
    fail('log-scale', `${at} spans ${param.min}..${param.max} and does not declare scale: 'log'`);
  }
}

/** The rules across definitions: title-unique. */
export function lintNodes(defs: readonly NodeDef[]): LintProblem[] {
  const out: LintProblem[] = [];
  const first = new Map<string, string>();
  for (const def of defs) {
    const other = first.get(def.title);
    if (other === undefined) first.set(def.title, def.type);
    else out.push({ rule: 'title-unique', subject: def.type, message: `title-unique ${def.type}: the title "${def.title}" is also the title of ${other}` });
  }
  return out;
}

const NODE_SOURCE = /^src\/core\/nodes\/([a-z]+)\/(_?)([^/]+)\.ts$/;
const CLOCKS: readonly RegExp[] = [/\bMath\s*\.\s*random\b/g, /\bDate\s*\.\s*now\b/g, /\bnew\s+Date\b/g, /\bperformance\s*\.\s*now\b/g];

/** The name a `defineKernel(`, `defineCpuTask(` or `defineLib(` call at `from` gives, up to the first `${` of a template; null when it is no literal. */
function literalName(text: string, from: number): string | null {
  const rest = text.slice(from, from + 400);
  const next = rest.slice(1).search(/\bdefine(?:Kernel|CpuTask|Lib|Node)\s*\(/);
  const m = /\bname\s*:\s*(['"`])/.exec(next < 0 ? rest : rest.slice(0, next + 1));
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = rest.slice(start).search(m[1] === '`' ? /`|\$\{/ : new RegExp(`${m[1]}|\\n`));
  return end < 0 ? null : rest.slice(start, start + end);
}

/**
 * The rules decided by the text of a node file or private module of a category: no-clock, no-catch,
 * no-float-hash, no-tanh, stats-flag, lib-name, and of kernel-name that a kernel or task defined in `<name>.ts` or
 * `_<name>.ts` is named `<category>/<name>`, with an optional `.pass` and `#variant`. `path` is relative to
 * the repository root.
 */
export function lintNodeSource(path: string, text: string): LintProblem[] {
  const out: LintProblem[] = [];
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  const fail = (rule: string, index: number | null, detail: string): void => {
    const where = index === null ? path : `${path}:${lineOf(index)}`;
    out.push({ rule, subject: path, message: `${rule} ${where}: ${detail}` });
  };

  for (const clock of CLOCKS) {
    for (const m of text.matchAll(clock)) fail('no-clock', m.index, `"${m[0]}": a node does not depend on the time or on Math.random`);
  }
  for (const m of text.matchAll(/(\.\s*)?\bcatch\s*[({]/g)) {
    fail('no-catch', m.index, `${m[1] ? '.catch(' : 'a catch clause'}: a node lets cancellation, budget and device errors propagate`);
  }
  for (const m of text.matchAll(/\bfract\s*\(\s*sin\s*\(/g)) fail('no-float-hash', m.index, 'fract(sin( differs between GPU drivers; use the hash library');
  // Math.tanh on the CPU is exact enough and is not meant: only the call of the WGSL builtin.
  for (const m of text.matchAll(/(?<![.\w])tanh\s*\(/g)) {
    fail('no-tanh', m.index, 'tanh( is not the hyperbolic tangent of a large argument on every device; write (1 - e) / (1 + e) with e = exp(-2 |x|)');
  }

  const source = NODE_SOURCE.exec(path);
  if (!source) return out;
  const [, category, underscore, name] = source as unknown as [string, string, string, string];
  const isNodeFile = underscore === '' && name !== 'index';

  if (isNodeFile && /\.\s*stats\s*\(|\bminMax\s*\(/.test(text) && !/\bresolutionDependent\s*:\s*true\b/.test(text)) {
    fail('stats-flag', null, 'the file mentions .stats( or minMax( and does not declare resolutionDependent: true');
  }

  for (const m of text.matchAll(/\bdefineLib\s*\(/g)) {
    const lib = literalName(text, m.index);
    if (lib === null) continue;
    if (CORE_LIB_NAMES.includes(lib)) fail('lib-name', m.index, `"${lib}" is the name of a core library`);
    else if (!lib.startsWith(category)) fail('lib-name', m.index, `the library "${lib}" does not begin with the category id "${category}"`);
  }

  const base = `${category}/${name}`;
  for (const m of text.matchAll(/\bdefine(Kernel|CpuTask)\s*\(/g)) {
    const given = literalName(text, m.index);
    if (given === null) continue;
    const tail = given.startsWith(base) ? given.charAt(base.length) : null;
    if (tail !== '' && tail !== '.' && tail !== '#') {
      fail('kernel-name', m.index, `the ${m[1] === 'Kernel' ? 'kernel' : 'CPU task'} "${given}" defined in this file is not named "${base}", "${base}.<pass>" or "${base}#<variant>"`);
    }
  }
  return out;
}

/** What registry.test.ts has read of one category. File names are relative to the two folders. */
export interface CategorySources {
  readonly category: string;
  /** src/core/nodes/<category>/: file name → text. */
  readonly files: Readonly<Record<string, string>>;
  /** Node file name → its default export. */
  readonly defaults: Readonly<Record<string, unknown>>;
  /** The `nodes` export of index.ts. */
  readonly index: unknown;
  /** tests/nodes/<category>/: file name → text. */
  readonly tests: Readonly<Record<string, string>>;
}

const isNodeFile = (file: string): boolean => file.endsWith('.ts') && file !== 'index.ts' && !file.startsWith('_');
const isDef = (v: unknown): v is NodeDef => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every rule one category decides: file-name, index and test-file over its files, lintNodeSource over the text
 * of each, and lintNode over each definition its node files export.
 */
export function lintCategory(sources: CategorySources): LintProblem[] {
  const { category } = sources;
  const out: LintProblem[] = [];
  const folder = `src/core/nodes/${category}`;
  const fail = (rule: string, subject: string, detail: string): void => {
    out.push({ rule, subject, message: `${rule} ${subject}: ${detail}` });
  };

  const nodeFiles = Object.keys(sources.files).filter(isNodeFile).sort();
  const exported: NodeDef[] = [];
  for (const file of nodeFiles) {
    const path = `${folder}/${file}`;
    const type = `${category}/${file.slice(0, -3)}`;
    const def = sources.defaults[file];
    if (!isDef(def)) fail('file-name', path, 'the file does not default-export a NodeDef');
    else {
      exported.push(def);
      if (def.type !== type) fail('file-name', path, `the default export has the type "${def.type}"; the file name makes it "${type}"`);
    }
    const calls = withoutComments(sources.files[file]!).match(/\bdefineNode\s*\(/g)?.length ?? 0;
    if (calls !== 1) fail('file-name', path, `the file contains ${calls} defineNode( calls; a node file holds exactly one node`);

    const testPath = `tests/nodes/${category}/${file.slice(0, -3)}.test.ts`;
    const test = sources.tests[`${file.slice(0, -3)}.test.ts`];
    if (test === undefined) fail('test-file', type, `${testPath} does not exist`);
    else {
      const imports = new RegExp(`\\bfrom\\s*['"](?:\\.\\./)+src/core/nodes/${escapeRegExp(category)}/${escapeRegExp(file)}['"]`);
      if (!imports.test(withoutComments(test))) fail('test-file', type, `${testPath} does not import ${path}`);
      if (!/^conformance\s*\(/m.test(withoutComments(test))) fail('test-file', type, `${testPath} has no conformance( call at module scope`);
    }
  }

  const indexPath = `${folder}/index.ts`;
  if (!Array.isArray(sources.index)) fail('index', indexPath, 'the file does not export the list `nodes`');
  else {
    const listed: readonly unknown[] = sources.index;
    for (const def of exported) if (!listed.includes(def)) fail('index', indexPath, `nodes lacks ${def.type}`);
    for (const [i, item] of listed.entries()) {
      const name = isDef(item) ? item.type : `entry ${i}`;
      if (!exported.includes(item as NodeDef)) fail('index', indexPath, `nodes holds ${name}, which is not the default export of a node file of the folder`);
      else if (listed.indexOf(item) !== i) fail('index', indexPath, `nodes holds ${name} twice`);
    }
    const types = listed.filter(isDef).map((def) => def.type);
    if (types.some((type, i) => i > 0 && types[i - 1]! > type)) fail('index', indexPath, 'nodes is not sorted by type');
  }

  for (const file of Object.keys(sources.files).filter((name) => name.endsWith('.ts')).sort()) {
    out.push(...lintNodeSource(`${folder}/${file}`, sources.files[file]!));
  }
  for (const def of exported) out.push(...lintNode(def));
  return out;
}

/** The layer patterns of testing.md 8.1, as `node --test` expands them. */
const LAYERS: readonly RegExp[] = [
  /^tests\/unit\/(?:.+\/)?[^/]+\.test\.ts$/,
  /^tests\/nodes\/[^/]+\/unit\/[^/]+\.test\.ts$/,
  /^tests\/export\/unit\/[^/]+\.test\.ts$/,
  /^tests\/ui\/[^/]+\/unit\/[^/]+\.test\.ts$/,
  /^tests\/engine\/(?:.+\/)?[^/]+\.test\.ts$/,
  /^tests\/nodes\/[^/]+\/[^/]+\.test\.ts$/,
  /^tests\/export\/[^/]+\.test\.ts$/,
  /^tests\/graphs\/[^/]+\.test\.ts$/,
  /^tests\/electron\/[^/]+\.test\.ts$/,
  /^tests\/ui\/[^/]+\/[^/]+\.test\.ts$/,
];

/** test-location: every `*.test.ts` path under tests/, relative to the repository root, is matched by exactly one layer pattern. */
export function lintTestLocations(paths: readonly string[]): LintProblem[] {
  const out: LintProblem[] = [];
  for (const path of paths) {
    if (!path.endsWith('.test.ts')) continue;
    const matches = LAYERS.filter((layer) => layer.test(path)).length;
    if (matches === 1) continue;
    const detail = matches === 0 ? 'no layer of testing.md 8.1 matches the file, so it is never run' : `${matches} layers of testing.md 8.1 match the file`;
    out.push({ rule: 'test-location', subject: path, message: `test-location ${path}: ${detail}` });
  }
  return out;
}
