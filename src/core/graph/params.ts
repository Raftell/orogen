import type { CurvePoint, GradientStop } from './curves.ts';
import { cloneJson, isPlainObject } from './doc.ts';
import type { NodeDef } from './node.ts';
import type { ParamDef, ParamValue } from './param-types.ts';

/** The length of a `text` value when the definition gives none (engine.md 4.3). */
export const TEXT_MAX_LENGTH = 256;
const SEED_RANGE = 2 ** 32;

interface One {
  readonly value: ParamValue;
  readonly problem: string | null;    // the value differs from the stored one
  readonly error: string | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const numbers = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && v.every(finite);

function show(v: unknown): string {
  const text = typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const same = (value: ParamValue): One => ({ value, problem: null, error: null });
const changed = (def: ParamDef, value: ParamValue, why: string): One => ({ value, problem: `param "${def.name}": ${why}`, error: null });
const useDefault = (def: ParamDef, stored: unknown, expected: string): One =>
  changed(def, def.default, `${show(stored)} is not ${expected}; the default is used`);

function curve(def: ParamDef & { kind: 'curve' }, stored: unknown): One {
  const valid = Array.isArray(stored) && stored.every((p) => isPlainObject(p) && finite(p.x) && finite(p.y));
  if (!valid) return useDefault(def, stored, 'a list of points');
  const raw = stored as readonly CurvePoint[];
  const points = raw
    .map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }))
    .sort((a, b) => a.x - b.x)                                 // stable: of two points with one x, the earlier stays first
    .filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x);
  if (points.length < 2) return changed(def, def.default, 'a curve needs 2 points with different x; the default is used');
  const equal = points.length === raw.length && points.every((p, i) => p.x === raw[i]!.x && p.y === raw[i]!.y);
  return equal ? same(points) : changed(def, points, 'the points were clamped to 0..1, sorted by x, and points repeating an x dropped');
}

function gradient(def: ParamDef & { kind: 'gradient' }, stored: unknown): One {
  const valid = Array.isArray(stored) && stored.every((s) => isPlainObject(s) && finite(s.t) && numbers(s.color, 3));
  if (!valid) return useDefault(def, stored, 'a list of stops');
  const raw = stored as readonly GradientStop[];
  if (raw.length < 2) return changed(def, def.default, 'a gradient needs 2 stops; the default is used');
  const stops = raw
    .map((s): GradientStop => ({ t: clamp(s.t, 0, 1), color: [clamp(s.color[0], 0, 1), clamp(s.color[1], 0, 1), clamp(s.color[2], 0, 1)] }))
    .sort((a, b) => a.t - b.t);
  const equal = stops.every((s, i) => s.t === raw[i]!.t && s.color.every((c, j) => c === raw[i]!.color[j]));
  return equal ? same(stops) : changed(def, stops, 'the stops were clamped to 0..1 and sorted');
}

/** One row of the table of runtime.md 4.4, for a value that is present. */
function normalizeOne(def: ParamDef, stored: unknown): One {
  switch (def.kind) {
    case 'float': {
      if (!finite(stored)) return useDefault(def, stored, 'a finite number');
      const value = def.soft ? stored : clamp(stored, def.min, def.max);
      return value === stored ? same(value) : changed(def, value, `${stored} is outside ${def.min}..${def.max}; clamped to ${value}`);
    }
    case 'int': {
      if (!finite(stored)) return useDefault(def, stored, 'a finite number');
      const rounded = Math.round(stored) + 0;                  // + 0: Math.round(-0.2) is -0
      const value = clamp(rounded, def.min, def.max);
      if (value === stored) return same(value);
      return value === rounded
        ? changed(def, value, `${stored} is not an integer; rounded to ${value}`)
        : changed(def, value, `${stored} is outside ${def.min}..${def.max}; clamped to ${value}`);
    }
    case 'bool':
      return typeof stored === 'boolean' ? same(stored) : useDefault(def, stored, 'true or false');
    case 'enum': {
      if (typeof stored === 'string' && def.options.some((o) => o.value === stored)) return same(stored);
      const shown = typeof stored === 'string' ? stored : show(stored);
      return { value: def.default, problem: null, error: `param "${def.name}": unknown value "${shown}"` };
    }
    case 'seed': {
      if (!finite(stored)) return useDefault(def, stored, 'a finite number');
      const value = ((Math.floor(stored) % SEED_RANGE) + SEED_RANGE) % SEED_RANGE;
      return value === stored ? same(value) : changed(def, value, `${stored} is not an integer in 0..${SEED_RANGE - 1}; ${value} is used`);
    }
    case 'vec2': {
      if (!numbers(stored, 2)) return useDefault(def, stored, 'a pair of finite numbers');
      if (def.soft) return same([stored[0]!, stored[1]!]);
      const value = [clamp(stored[0]!, def.min, def.max), clamp(stored[1]!, def.min, def.max)] as const;
      return value[0] === stored[0] && value[1] === stored[1]
        ? same(value)
        : changed(def, value, `${show(stored)} is outside ${def.min}..${def.max}; clamped to ${show(value)}`);
    }
    case 'color': {
      if (!numbers(stored, 3)) return useDefault(def, stored, 'three finite numbers');
      const value = [clamp(stored[0]!, 0, 1), clamp(stored[1]!, 0, 1), clamp(stored[2]!, 0, 1)] as const;
      return value.every((c, i) => c === stored[i])
        ? same(value)
        : changed(def, value, `${show(stored)} is outside 0..1; clamped to ${show(value)}`);
    }
    case 'curve':
      return curve(def, stored);
    case 'gradient':
      return gradient(def, stored);
    case 'file':
      return typeof stored === 'string' ? same(stored) : changed(def, '', `${show(stored)} is not a path; no file is selected`);
    case 'text': {
      if (typeof stored !== 'string') return useDefault(def, stored, 'a text');
      const max = def.maxLength ?? TEXT_MAX_LENGTH;
      if (stored.length <= max) return same(stored);
      // Never half of a surrogate pair.
      const cut = /[\uD800-\uDBFF]/.test(stored[max - 1]!) ? max - 1 : max;
      return changed(def, stored.slice(0, cut), `the text is longer than ${max} characters; truncated`);
    }
  }
}

/** Whether the stored params hold a value under `name`. Params that are no object hold none. */
const present = (stored: Readonly<Record<string, unknown>>, name: string): boolean =>
  isPlainObject(stored) && Object.hasOwn(stored, name) && stored[name] !== undefined;

/** Pure. The only implementation of the rules of runtime.md 4.4: the loader, setParam and the evaluator call it. */
export function normalizeParams(def: NodeDef, stored: Readonly<Record<string, unknown>>): {
  readonly values: Readonly<Record<string, ParamValue>>;   // every declared name, in declaration order
  readonly problems: readonly string[];                    // one sentence per value that was changed
  readonly error: string | null;                           // non-null: the node cannot be evaluated
} {
  const values: Record<string, ParamValue> = {};
  const problems: string[] = [];
  let error: string | null = null;
  for (const param of def.params) {
    const one = present(stored, param.name) ? normalizeOne(param, stored[param.name]) : same(param.default);
    values[param.name] = one.value;
    if (one.problem !== null) problems.push(one.problem);
    error ??= one.error;
  }
  return { values, problems, error };
}

/**
 * What the loader stores (runtime.md 4.5): `stored` with every value that normalizeParams reports as changed
 * replaced by the normalised one. Missing names stay missing, undeclared names and a value that is an `error`
 * stay as they are, and members keep their order. `params` is `stored` itself when nothing was changed.
 */
export function normalizeStored(def: NodeDef, stored: Readonly<Record<string, unknown>>): {
  readonly params: Readonly<Record<string, unknown>>;
  readonly problems: readonly string[];
  readonly error: string | null;
} {
  let params: Record<string, unknown> | null = null;
  const problems: string[] = [];
  let error: string | null = null;
  for (const param of def.params) {
    if (!present(stored, param.name)) continue;
    const one = normalizeOne(param, stored[param.name]);
    error ??= one.error;
    if (one.problem === null) continue;
    problems.push(one.problem);
    params ??= { ...stored };
    params[param.name] = cloneJson(one.value);
  }
  return { params: params ?? stored, problems, error };
}
