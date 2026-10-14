// What the inspector shows, worked out without a window: which nodes it edits, how their parameters are laid out
// in sections, which are hidden, which differ from their defaults, and how a number is shown, dragged and typed
// for its unit (engine.md 1.6, 4.3; runtime.md 8.7 rules 5 and 6). No DOM and no React.

import type { Category, FloatParam, IntParam, NodeDef, ParamDef, ParamValue, PortRole, Unit, Vec2Param } from '../../../core/api.ts';
import {
  normalizeParams,
  type GraphDoc, type NodeError, type NodeErrorKind, type NodeInstance, type NodeRegistry, type PortRef, type ProjectSettings, type WgslDiagnostic,
} from '../../../core/runtime.ts';
import type { NodeRuntime } from '../../state/engine-store.ts';
import { formatMetres, metricUnits, type NumberRange, type NumberUnits } from '../../ui/number.ts';

// ---- what is being inspected -------------------------------------------------------------------------------------

export type Target =
  | { readonly kind: 'settings' }
  | {
      /** One node, or several of one type: their parameters are edited together. */
      readonly kind: 'nodes';
      readonly def: NodeDef;
      readonly nodes: readonly NodeInstance[];
      readonly ids: readonly string[];
      /** Why the parameters cannot be edited, as one sentence; null: they can. */
      readonly locked: string | null;
    }
  | {
      /** Nodes of several types, or nodes whose type this build does not have. */
      readonly kind: 'summary';
      readonly nodes: readonly NodeInstance[];
      readonly ids: readonly string[];
      readonly types: readonly TypeCount[];
    };

export interface TypeCount {
  readonly type: string;
  /** The definition's title; the type id for a type this build does not have. */
  readonly title: string;
  readonly category: Category | null;
  readonly count: number;
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** The selection as the inspector takes it. Ids the document does not hold are left out; nothing left is the project settings. */
export function targetOf(nodes: GraphDoc['nodes'], registry: NodeRegistry, selection: readonly string[]): Target {
  const held: NodeInstance[] = [];
  for (const id of new Set(selection)) {
    const node = own(nodes, id);
    if (node) held.push(node);
  }
  if (held.length === 0) return { kind: 'settings' };
  const ids = held.map((node) => node.id);
  const first = held[0]!;
  const def = held.every((node) => node.type === first.type) ? registry.get(first.type) : undefined;
  if (def) {
    const version = def.version ?? 1;
    const other = held.find((node) => node.version !== version);
    // The sentence setParam refuses such a node with (runtime.md 4.5): its parameters are in another format.
    const locked = other ? `Saved with version ${other.version} of this node; this build has version ${version}` : null;
    return { kind: 'nodes', def, nodes: held, ids, locked };
  }
  const counts = new Map<string, number>();
  for (const node of held) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const types = [...counts].map(([type, count]): TypeCount => {
    const known = registry.get(type);
    return { type, title: known?.title ?? type, category: known?.category ?? null, count };
  });
  return { kind: 'summary', nodes: held, ids, types };
}

/** No chain of nodes that pass their input's kind on is followed further than this. */
const SAME_AS_DEPTH = 64;

/**
 * The role of the field an output carries (engine.md 1.7), or null when it carries a color or nothing that is
 * known. An output that has the kind of an input (`sameAs`) carries what is connected there, role and all: a
 * blurred terrain is still heights.
 */
export function outputRole(doc: Pick<GraphDoc, 'nodes' | 'edges'>, registry: NodeRegistry, ref: PortRef, depth: number = SAME_AS_DEPTH): PortRole | null {
  const node = own(doc.nodes, ref.node);
  const port = node ? registry.get(node.type)?.outputs.find((output) => output.name === ref.port) : undefined;
  if (!port) return null;
  if (port.type === 'field') return port.role ?? 'height';
  if (typeof port.type !== 'object' || depth <= 0) return null;
  const input = port.type.sameAs;
  const edge = Object.values(doc.edges).find((candidate) => candidate.to.node === ref.node && candidate.to.port === input);
  return edge ? outputRole(doc, registry, edge.from, depth - 1) : null;
}

// ---- values --------------------------------------------------------------------------------------------------------

/** Nesting a parameter value has at most: a gradient, its stop, the stop's colour. */
const VALUE_DEPTH = 4;

/** Whether two parameter values are the same value: numbers, texts and booleans as they are, lists and points member by member. */
export function sameValue(a: unknown, b: unknown, depth: number = VALUE_DEPTH): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth <= 0) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index], depth - 1));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((key) => Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1));
}

export const isChanged = (param: ParamDef, value: unknown): boolean => !sameValue(value, param.default);

export interface SharedValue {
  /** The value shown: the first node's. */
  readonly value: ParamValue;
  /** The nodes do not all hold this value. An edit gives it to all of them. */
  readonly mixed: boolean;
  /** At least one node holds another value than the default. */
  readonly changed: boolean;
}

/**
 * The value of every declared parameter of a node, as the evaluator reads it (runtime.md 4.4). An enum value this
 * build does not know is kept as it is stored, so that it can be seen and replaced.
 */
export function nodeValues(def: NodeDef, node: NodeInstance): Readonly<Record<string, ParamValue>> {
  const shown: Record<string, ParamValue> = { ...normalizeParams(def, node.params).values };
  const stored: Readonly<Record<string, unknown>> = typeof node.params === 'object' && node.params !== null ? node.params : {};
  for (const param of def.params) {
    const held = own(stored, param.name);
    if (param.kind === 'enum' && typeof held === 'string') shown[param.name] = held;
  }
  return shown;
}

/** What the controls of several nodes of one type show, from the values of each (`nodeValues`). */
export function shareValues(def: NodeDef, all: readonly Readonly<Record<string, ParamValue>>[]): Readonly<Record<string, SharedValue>> {
  const out: Record<string, SharedValue> = {};
  for (const param of def.params) {
    const value = all[0]?.[param.name] ?? param.default;
    out[param.name] = {
      value,
      mixed: all.some((values) => !sameValue(values[param.name], value)),
      changed: all.some((values) => isChanged(param, values[param.name])),
    };
  }
  return out;
}

export const sharedValues = (def: NodeDef, nodes: readonly NodeInstance[]): Readonly<Record<string, SharedValue>> =>
  shareValues(def, nodes.map((node) => nodeValues(def, node)));

// ---- layout ---------------------------------------------------------------------------------------------------------

export const paramLabel = (param: Pick<ParamDef, 'name' | 'label'>): string => param.label ?? param.name.charAt(0).toUpperCase() + param.name.slice(1);

/** engine.md 4.3: the control is shown only while the parameter `visibleWhen` names has the value, or one of the values, it gives. */
export function isVisible(param: Pick<ParamDef, 'visibleWhen'>, values: Readonly<Record<string, unknown>>): boolean {
  const when = param.visibleWhen;
  if (!when) return true;
  const actual = values[when.param];
  const wanted: readonly unknown[] = Array.isArray(when.equals) ? when.equals : [when.equals];
  return wanted.includes(actual);
}

export interface Section {
  /** Null: the parameters without a group, which come first (engine.md 4.3). */
  readonly title: string | null;
  readonly params: readonly ParamDef[];
}

/** The parameters in sections: those without a group first, then each group where its first parameter is declared. */
export function layoutParams(params: readonly ParamDef[]): Section[] {
  const loose: ParamDef[] = [];
  const groups = new Map<string, ParamDef[]>();
  for (const param of params) {
    if (param.group === undefined || param.group === '') {
      loose.push(param);
      continue;
    }
    const members = groups.get(param.group);
    if (members) members.push(param);
    else groups.set(param.group, [param]);
  }
  const sections: Section[] = loose.length > 0 ? [{ title: null, params: loose }] : [];
  for (const [title, members] of groups) sections.push({ title, params: members });
  return sections;
}

/**
 * The sections with the hidden parameters left out, and without the sections that have none left. With several
 * nodes a parameter is shown when it is visible on any of them.
 */
export function visibleSections(params: readonly ParamDef[], values: readonly Readonly<Record<string, unknown>>[]): Section[] {
  return layoutParams(params.filter((param) => values.some((held) => isVisible(param, held))));
}

// ---- numbers and their units ----------------------------------------------------------------------------------------

export interface NumberSpec {
  /** The limits and the soft range of the number field. A `soft` parameter has no hard limits (engine.md 4.3). */
  readonly range: NumberRange;
  readonly precision: number;
  /** Drawn after the value. */
  readonly unit?: string;
  /** The suffixes a typed entry may carry. */
  readonly units?: NumberUnits;
  /** The metres a stored 1 stands for: the terrain's width for a length, the height range for a height. */
  readonly metres?: number;
}

type Scale = Pick<ProjectSettings, 'terrainSize' | 'heightRange'>;

/** The metres a stored 1 of this unit stands for (engine.md 1.6); null for a unit that is not a fraction of the terrain. */
export function metresOf(unit: Unit, settings: Scale): number | null {
  return unit === 'length' ? settings.terrainSize : unit === 'height' ? settings.heightRange : null;
}

const ANGLE_UNITS: NumberUnits = { '°': 1, deg: 1 };
const RATIO_UNITS: NumberUnits = { '%': 0.01 };

/** Decimals for a range: three significant digits at its lower end on a log scale, where the values span decades. */
function precisionFor(min: number, max: number, step: number | undefined, log: boolean): number {
  if (step !== undefined && step > 0) return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  if (log && min > 0) return Math.min(6, Math.max(2, Math.ceil(-Math.log10(min) - 1e-9) + 1));
  const span = max - min;
  return span >= 1000 ? 0 : span >= 100 ? 1 : span >= 10 ? 2 : 3;
}

function unitSpec(unit: Unit, settings: Scale): Pick<NumberSpec, 'unit' | 'units' | 'metres'> {
  const metres = metresOf(unit, settings);
  if (metres !== null) return { units: metricUnits(metres), metres };
  if (unit === 'angle') return { unit: '°', units: ANGLE_UNITS };
  if (unit === 'ratio') return { units: RATIO_UNITS };
  return {};
}

export function floatSpec(param: Pick<FloatParam, 'unit' | 'min' | 'max' | 'soft' | 'scale' | 'step'>, settings: Scale): NumberSpec {
  const log = param.scale === 'log' && param.min > 0;
  const ends = param.soft ? { softMin: param.min, softMax: param.max } : { min: param.min, max: param.max };
  return {
    range: { ...ends, step: param.step, scale: log ? 'log' : 'linear' },
    precision: param.unit === 'angle' && param.step === undefined ? 1 : precisionFor(param.min, param.max, param.step, log),
    ...unitSpec(param.unit, settings),
  };
}

export function intSpec(param: Pick<IntParam, 'min' | 'max'>): NumberSpec {
  return { range: { min: param.min, max: param.max, integer: true, step: 1 }, precision: 0 };
}

export function vec2Spec(param: Pick<Vec2Param, 'unit' | 'min' | 'max' | 'soft'>, settings: Scale): NumberSpec {
  const ends = param.soft ? { softMin: param.min, softMax: param.max } : { min: param.min, max: param.max };
  return { range: ends, precision: precisionFor(param.min, param.max, undefined, false), ...unitSpec(param.unit, settings) };
}

export const SEED_MAX = 2 ** 32 - 1;
export const SEED_SPEC: NumberSpec = { range: { min: 0, max: SEED_MAX, integer: true, step: 1 }, precision: 0 };

/** No value is shown with more decimals. */
const DECIMALS_MAX = 8;

/**
 * The decimals one value is shown with: those of its range (`spec.precision`), fewer where they would say nothing
 * and more where they would hide the value.
 * - On a log scale, three significant digits: 0.250, 0.0800, 0.00500 and not 0.25000, 0.08000, 0.00500.
 * - A value too small for the decimals of its range would read as 0: it gets two significant digits.
 * - A value of five digits and more before the point loses decimals it has no room for: 1000000000, not 1000000000.0000.
 */
export function shownPrecision(spec: Pick<NumberSpec, 'precision' | 'range'>, value: number): number {
  const base = spec.precision;
  if (spec.range.integer || !Number.isFinite(value) || value === 0) return base;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  if (magnitude < -base) return Math.min(DECIMALS_MAX, 1 - magnitude);
  if (magnitude >= 4) return Math.max(0, Math.min(base, 6 - magnitude));
  if (spec.range.scale === 'log') return Math.min(base, Math.max(2, 2 - magnitude));
  return base;
}

/** The metric text beside a stored length or height (runtime.md 8.7 rule 6); undefined for any other unit. */
export function secondaryOf(spec: NumberSpec, value: number): string | undefined {
  return spec.metres === undefined ? undefined : formatMetres(value, spec.metres);
}

/** runtime.md 8.7 rule 5: a direction is an angle whose range is the whole turn, 0..360. */
export function isDirection(param: ParamDef): param is FloatParam {
  return param.kind === 'float' && param.unit === 'angle' && param.min === 0 && param.max === 360;
}

/** An angle in 0..360, where 360 is 0 again; a value that is not finite is 0. */
export function wrapAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  // An angle that is in the range already is returned as it is: arithmetic would cost its last digits.
  if (degrees > 0 && degrees < 360) return degrees;
  const turned = degrees % 360;
  const wrapped = turned < 0 ? turned + 360 : turned;
  return wrapped === 0 || wrapped === 360 ? 0 : wrapped;
}

/**
 * The direction from the centre of a dial to a pointer, by engine.md 1.8: 0° points right and 90° down the
 * screen, as every top view shows it. `snap` rounds to that many degrees.
 */
export function angleFromPointer(dx: number, dy: number, snap: number = 0): number {
  if (dx === 0 && dy === 0) return 0;
  const degrees = wrapAngle((Math.atan2(dy, dx) * 180) / Math.PI);
  const rounded = snap > 0 ? Math.round(degrees / snap) * snap : Number(degrees.toFixed(1));
  return wrapAngle(rounded);
}

/** The end of a dial's hand for an angle, on a circle of radius `r` about (0, 0), y down. */
export function dialHand(degrees: number, r: number): { readonly x: number; readonly y: number } {
  const radians = (wrapAngle(degrees) * Math.PI) / 180;
  // + 0: a coordinate is never -0, which an SVG attribute would write as "-0".
  return { x: Number((Math.cos(radians) * r).toFixed(3)) + 0, y: Number((Math.sin(radians) * r).toFixed(3)) + 0 };
}

// ---- texts ----------------------------------------------------------------------------------------------------------

const plain = (value: number): string => String(Number(value.toPrecision(4)));

/** One value of a parameter as a short text: for the tooltip's default and range. */
function valueText(param: ParamDef, value: unknown, settings: Scale): string {
  switch (param.kind) {
    case 'float': {
      if (typeof value !== 'number') return '';
      const metres = metresOf(param.unit, settings);
      if (metres !== null) return `${plain(value)} (${formatMetres(value, metres)})`;
      return param.unit === 'angle' ? `${plain(value)}°` : plain(value);
    }
    case 'int':
    case 'seed':
      return typeof value === 'number' ? String(value) : '';
    case 'bool':
      return value === true ? 'on' : 'off';
    case 'enum':
      return param.options.find((option) => option.value === value)?.label ?? String(value);
    case 'vec2':
      return Array.isArray(value) ? value.map((c) => plain(Number(c))).join(', ') : '';
    case 'text':
      return typeof value === 'string' && value !== '' ? `"${value}"` : 'empty';
    case 'file':
      return 'no file';
    default:
      return '';
  }
}

/**
 * What the tooltip of a parameter says: its help, then what the help leaves to the inspector (testing.md 6.2), the
 * default and the range.
 */
export function paramTooltip(param: ParamDef, settings: Scale): string {
  const parts: string[] = [];
  const fallback = valueText(param, param.default, settings);
  if (fallback !== '') parts.push(`Default ${fallback}`);
  if (param.kind === 'float' || param.kind === 'int' || param.kind === 'vec2') {
    const soft = param.kind !== 'int' && param.soft === true;
    const suffix = param.kind === 'float' && param.unit === 'angle' ? '°' : '';
    parts.push(`${soft ? 'Slider' : 'Range'} ${plain(param.min)}${suffix} to ${plain(param.max)}${suffix}${soft ? '; any typed value is accepted' : ''}`);
  }
  return parts.length > 0 ? `${param.help} ${parts.join('. ')}.` : param.help;
}

/** A duration of a node's run: '<1 ms', '12 ms', '1.25 s', '12.3 s', '2 min 05 s'. */
export function formatRunTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 9995) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 59950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A byte count: '640 KB', '48 MB', '1.2 GB'. */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / KIB))} KB`;
  if (bytes < GIB) return `${Math.round(bytes / MIB)} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** A value of a field for the header: three decimals, without a padded '-0.000'. */
export function formatStat(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const text = value.toFixed(3);
  return /^-0\.0+$/.test(text) ? text.slice(1) : text;
}

/** A normalised height of a field in metres, for the header: whole metres from 100 m, tenths below, never "-0". */
export function formatStatMetres(height: number, heightRange: number): string {
  const value = height * heightRange;
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 10000) return `${Number((value / 1000).toPrecision(4))} km`;
  const text = Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text === '-0' ? '0' : text} m`;
}

/** The last segment of a path, whichever separator it is written with. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** An extension is short: what follows a later dot is part of the name. */
const EXTENSION_MAX = 8;

/**
 * A file's name in two parts, so that a name too long for its place is cut in the middle and keeps its extension:
 * the stem is what gives way. A name that begins with its only dot has no extension.
 */
export function fileNameParts(path: string): { readonly stem: string; readonly extension: string } {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot - 1 > EXTENSION_MAX || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

// ---- what the engine says of a node ---------------------------------------------------------------------------------

export interface StatusLine {
  readonly tone: 'idle' | 'running' | 'ok' | 'error' | 'skipped';
  readonly text: string;
  /** What is known beside the state: the time and the memory of the last run, the step and the time left of a running one. */
  readonly facts: readonly string[];
}

/** What is known of the engine beside the node's own record: it says why a node has no result. */
export interface EngineSituation {
  /** `EngineState.device.state`. */
  readonly device: 'starting' | 'ready' | 'lost' | 'failed';
  /** An evaluation is running: a node that waits will be reached, or was left out of it. */
  readonly evaluating: boolean;
  /** A build runs: previews wait until it has ended (runtime.md 7.3). */
  readonly building: boolean;
  /** The node is an export node: it runs when the project is built, and in no preview. */
  readonly exports: boolean;
  /** Previews are paused (`EngineState.paused`): nothing is computed until they are resumed. */
  readonly paused: boolean;
  /** The resolution the viewport shows the project at: its preview resolution (runtime.md 4.2), which no draft changes. Null: not known. */
  readonly viewResolution: number | null;
}

export const SETTLED: EngineSituation = { device: 'ready', evaluating: false, building: false, exports: false, paused: false, viewResolution: null };

export const PAUSED_TEXT = 'Paused';

/** Why a node without a result has none, from what the engine is doing. */
function pendingText(situation: EngineSituation, waiting: boolean): string {
  if (situation.device === 'lost') return 'Waiting for the GPU device';
  if (situation.device === 'failed') return 'No GPU device';
  if (situation.device === 'starting') return 'Waiting for the engine';
  if (situation.building) return 'Waiting for the build';
  if (waiting && situation.evaluating) return 'Waiting';
  // The user paused the previews: that, and no fault of the node, is why it has no result.
  if (situation.paused) return PAUSED_TEXT;
  // Nothing runs and nothing will: the evaluation that would have reached the node was stopped, or shows another node.
  return 'Not computed';
}

/**
 * At which resolution a record's time and memory were measured, when that is not the preview resolution, at
 * which the viewport shows the project: a node outside the view is computed for its thumbnail, on a much coarser
 * grid, and its milliseconds say nothing of what it costs in the view; a node a build ran was measured at the
 * build resolution. Null when the record is of the view's resolution, or holds none.
 */
export function measuredAt(runtime: Pick<NodeRuntime, 'resolution'>, viewResolution: number | null): string | null {
  const { resolution } = runtime;
  if (resolution === null || !Number.isFinite(resolution) || resolution === viewResolution) return null;
  return `at ${resolution} × ${resolution}`;
}

/** The state of a node as one line. `upstream` is the title of the failed node a skipped one waits for. */
export function statusLine(runtime: NodeRuntime | undefined, upstream: string | null = null, situation: EngineSituation = SETTLED): StatusLine {
  // Without a device nothing is computed, whatever the last device reported: its results went with it. A device
  // that is merely lost is back within a second (runtime.md 7.8), and until then what was said of a node stays.
  if (situation.device === 'failed' || situation.device === 'starting') return { tone: 'idle', text: pendingText(situation, false), facts: [] };
  if (!runtime) {
    if (situation.exports && situation.device === 'ready' && !situation.building) return { tone: 'idle', text: 'Runs when the project is built', facts: [] };
    return { tone: 'idle', text: pendingText(situation, false), facts: [] };
  }
  switch (runtime.state) {
    case 'running': {
      const facts: string[] = [];
      if (runtime.label) facts.push(runtime.label);
      if (runtime.etaMs !== null && runtime.etaMs >= 1000) facts.push(`${formatRunTime(runtime.etaMs)} left`);
      return { tone: 'running', text: `Computing ${Math.round(Math.min(1, Math.max(0, runtime.fraction)) * 100)} %`, facts };
    }
    case 'done': {
      const facts: string[] = [];
      if (runtime.wallMs !== null) facts.push(formatRunTime(runtime.wallMs));
      if (runtime.peakBytes !== null) facts.push(formatMemory(runtime.peakBytes));
      // Said only beside the figures it qualifies.
      const at = runtime.wallMs !== null || runtime.peakBytes !== null ? measuredAt(runtime, situation.viewResolution) : null;
      if (at !== null) facts.push(at);
      if (runtime.cached) facts.push('from cache');
      return { tone: 'ok', text: 'Computed', facts };
    }
    case 'error':
      return { tone: 'error', text: 'Failed', facts: [] };
    case 'skipped':
      return { tone: 'skipped', text: `Skipped: ${upstream ?? 'a node before it'} failed`, facts: [] };
    default:
      return { tone: 'idle', text: pendingText(situation, true), facts: [] };
  }
}

/**
 * Whether the head takes a record as it comes. It does not while the record is of a draft, whose time and memory
 * are those of a coarse grid and change with every step of a drag, and not at once while the node waits or runs:
 * during a drag a node does both many times a second, and a line that said so each time could not be read. Such a
 * record is shown when it has lasted (NodeHeader.tsx), and until then the head keeps the last one it took.
 */
export function isSteady(runtime: NodeRuntime | undefined, drafting: boolean): boolean {
  if (!runtime) return true;
  if (runtime.state === 'error' || runtime.state === 'skipped') return true;
  return runtime.state === 'done' && !drafting;
}

/** The states of several nodes as one line: '3 computed, 1 failed'. With the previews paused, a node without a result is 'paused'. */
export function statusSummary(runtimes: readonly (NodeRuntime | undefined)[], paused: boolean = false): string {
  const names: Readonly<Record<StatusLine['tone'], string>> = { ok: 'computed', running: 'computing', error: 'failed', skipped: 'skipped', idle: paused ? 'paused' : 'not computed' };
  const counts = new Map<string, number>();
  for (const runtime of runtimes) {
    const name = names[statusLine(runtime).tone];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.values(names).filter((name) => counts.has(name)).map((name) => `${counts.get(name)} ${name}`).join(', ');
}

const ERROR_KINDS: Readonly<Record<NodeErrorKind, string>> = {
  'unknown-type': 'Unknown node type',
  version: 'Node version',
  param: 'Parameter',
  'missing-input': 'Missing input',
  cycle: 'Cycle',
  'shader-compile': 'Shader error',
  binding: 'Kernel binding',
  validation: 'GPU validation',
  budget: 'Memory budget',
  'out-of-memory': 'Out of GPU memory',
  watchdog: 'Too slow',
  io: 'File',
  'node-exception': 'Node error',
  'device-lost': 'Device lost',
  internal: 'Internal error',
};

export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** Where a shader error lies, in words: the kernel's own code, generated code, or a library by its name. */
function originText(origin: WgslDiagnostic['origin']): string {
  if (origin === 'code') return 'kernel code';
  if (origin === 'generated') return 'generated code';
  return `library ${origin.slice('library:'.length)}`;
}

/** What an error says beside its message: its kind, the kernel, and for a shader error the place. */
export function errorFacts(error: NodeError): Fact[] {
  const facts: Fact[] = [{ label: 'Kind', value: ERROR_KINDS[error.kind] ?? error.kind }];
  if (error.kernel) facts.push({ label: 'Kernel', value: error.kernel });
  if (error.wgsl) facts.push({ label: 'Line', value: `${error.wgsl.line}, column ${error.wgsl.column}, in ${originText(error.wgsl.origin)}` });
  return facts;
}

export interface ExcerptLine {
  readonly number: number;
  readonly text: string;
  /** The line the compiler names. */
  readonly failing: boolean;
}

/** The excerpt of a shader error with its line numbers: the failing line and up to two lines either side (runtime.md 5.8). */
export function excerptLines(wgsl: WgslDiagnostic): ExcerptLine[] {
  // The excerpt begins two lines before the failing one, or at the first line of its segment.
  const before = Math.min(2, Math.max(0, wgsl.line - 1), Math.max(0, wgsl.excerpt.length - 1));
  return wgsl.excerpt.map((text, index) => ({ number: wgsl.line - before + index, text, failing: index === before }));
}
