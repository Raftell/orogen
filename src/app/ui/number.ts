// The arithmetic of the number field (NumberField.tsx): what a typed entry means, how a value is written, and
// how a drag, a snap and a step change it. No DOM and no React, so that it is tested without a window.

/** The numbers that say where a value may go. */
export interface NumberRange {
  /** Hard limits: no value leaves them, typed or dragged. */
  readonly min?: number;
  readonly max?: number;
  /** The range a drag covers and the fill shows; default the hard limits. A typed value may lie outside it. */
  readonly softMin?: number;
  readonly softMax?: number;
  /** What Ctrl snaps to and an arrow key adds. */
  readonly step?: number;
  /** `log`: a drag moves through the soft range in equal ratios. Needs a soft range above 0. */
  readonly scale?: 'linear' | 'log';
  readonly integer?: boolean;
}

/**
 * Unit suffixes a typed number may carry, each with the factor that turns the typed number into the stored
 * value: `{ m: 1 / terrainSize, km: 1000 / terrainSize }` for a length, `{ '%': 0.01 }` for a ratio. A number
 * without a suffix is the stored value itself. Suffixes are compared without regard to case.
 */
export type NumberUnits = Readonly<Record<string, number>>;

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

function softRange(range: NumberRange): { readonly lo: number; readonly hi: number } | null {
  const lo = finite(range.softMin) ? range.softMin : range.min;
  const hi = finite(range.softMax) ? range.softMax : range.max;
  return finite(lo) && finite(hi) && hi > lo ? { lo, hi } : null;
}

const isLog = (range: NumberRange, soft: { readonly lo: number; readonly hi: number } | null): boolean =>
  range.scale === 'log' && soft !== null && soft.lo > 0;

/** A value inside the hard limits, whole when the range is of integers. NaN stays NaN. */
export function clampValue(value: number, range: NumberRange): number {
  let out = range.integer ? Math.round(value) : value;
  if (finite(range.max) && out > range.max) out = range.integer ? Math.floor(range.max) : range.max;
  if (finite(range.min) && out < range.min) out = range.integer ? Math.ceil(range.min) : range.min;
  return out === 0 ? 0 : out;
}

/** The step of an arrow key and of a snap: the range's own, else a hundredth of the soft range, else 1 or 0.01. */
export function stepOf(range: NumberRange): number {
  if (finite(range.step) && range.step > 0) return range.integer ? Math.max(1, Math.round(range.step)) : range.step;
  if (range.integer) return 1;
  const soft = softRange(range);
  return soft ? (soft.hi - soft.lo) / 100 : 0.01;
}

/** Decimals a value of this range is shown with. */
export function precisionOf(range: NumberRange): number {
  if (range.integer) return 0;
  if (finite(range.step) && range.step > 0) return Math.min(6, Math.max(0, Math.ceil(-Math.log10(range.step) - 1e-9)));
  const soft = softRange(range);
  if (!soft) return 3;
  const span = soft.hi - soft.lo;
  return span >= 1000 ? 0 : span >= 100 ? 1 : span >= 10 ? 2 : 3;
}

/** The value as the field shows it: a fixed number of decimals, and never "-0". */
export function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '';
  const text = value.toFixed(Math.min(20, Math.max(0, precision)));
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

/** The value as the text a person edits: every digit that matters, no padding. */
export function editText(value: number, range: NumberRange = {}): string {
  if (!Number.isFinite(value)) return '';
  return String(range.integer ? Math.round(value) : Number(value.toPrecision(7)));
}

/** How full the field is drawn: 0 at the soft minimum, 1 at the soft maximum. Null: the range has no ends to fill between. */
export function fillFraction(value: number, range: NumberRange): number | null {
  const soft = softRange(range);
  if (!soft || !Number.isFinite(value)) return null;
  const t = isLog(range, soft) ? (value > 0 ? Math.log(value / soft.lo) / Math.log(soft.hi / soft.lo) : 0) : (value - soft.lo) / (soft.hi - soft.lo);
  return Math.min(1, Math.max(0, t));
}

// ---- dragging -------------------------------------------------------------------------------------------------
// A drag keeps a position of its own, unrounded: the value is that position snapped, rounded and limited. Small
// movements then add up for a field of integers, and letting go of Ctrl gives back the value under the pointer.

/** The position a drag starts at for a value: the value itself, or its logarithm on a log scale. */
export function scrubStart(value: number, range: NumberRange): number {
  return isLog(range, softRange(range)) && value > 0 ? Math.log(value) : value;
}

/** Pixels a drag takes for one step of a range without ends. */
const PIXELS_PER_STEP = 2;
const FINE = 0.1;

/**
 * The position after the pointer moved `dx` pixels. With a soft range the width of the field is the range; without,
 * two pixels are a step. `fine` (Shift) slows the drag to a tenth. The position stays within the soft range, or
 * within what the drag started outside of it: a typed value beyond the soft range is not pulled back by touching it.
 */
export function scrubMove(position: number, dx: number, range: NumberRange, how: { readonly trackWidth: number; readonly fine: boolean }): number {
  const soft = softRange(range);
  const speed = how.fine ? FINE : 1;
  if (!soft) return position + (dx / PIXELS_PER_STEP) * stepOf(range) * speed;
  const width = Math.max(1, how.trackWidth);
  const log = isLog(range, soft);
  const lo = log ? Math.log(soft.lo) : soft.lo;
  const hi = log ? Math.log(soft.hi) : soft.hi;
  const next = position + (dx / width) * (hi - lo) * speed;
  return Math.min(Math.max(hi, position), Math.max(Math.min(lo, position), next));
}

/** The value of a drag position. `snap` (Ctrl) rounds it to the step, or to tenths of the soft range when there is no step. */
export function scrubValue(position: number, range: NumberRange, how: { readonly snap: boolean }): number {
  const soft = softRange(range);
  let value = isLog(range, soft) ? Math.exp(position) : position;
  if (how.snap) {
    const explicit = finite(range.step) && range.step > 0;
    const step = explicit || !soft ? stepOf(range) : (soft.hi - soft.lo) / 10;
    const origin = explicit || !soft ? 0 : soft.lo;
    // Rounded once more so that 0.1 steps read 0.3 and not 0.30000000000000004.
    value = Number((origin + Math.round((value - origin) / step) * step).toPrecision(12));
  }
  return clampValue(value, range);
}

/** The value one step up (`direction` 1) or down (−1). `coarse` is ten steps, `fine` a tenth of one. */
export function stepValue(value: number, direction: 1 | -1, range: NumberRange, how: { readonly coarse?: boolean; readonly fine?: boolean } = {}): number {
  const step = stepOf(range) * (how.coarse ? 10 : 1) * (how.fine && !range.integer ? FINE : 1);
  return clampValue(Number((value + direction * step).toPrecision(12)), range);
}

// ---- typed entry ----------------------------------------------------------------------------------------------

const ENTRY_MAX_LENGTH = 120;
const NESTING_MAX = 16;

/**
 * What a typed entry means: arithmetic with + − * / and brackets on numbers that may carry a unit ("500m",
 * "25 %", "1024/3", "(2+3)*0.1"), or a change of the current value ("+=5", "*=2"). Null: not an entry. The result
 * is not limited to any range; the field does that.
 */
export function parseEntry(text: string, context: { readonly current?: number; readonly units?: NumberUnits } = {}): number | null {
  if (typeof text !== 'string' || text.length > ENTRY_MAX_LENGTH) return null;
  const units = new Map(Object.entries(context.units ?? {}).map(([suffix, factor]) => [suffix.toLowerCase(), factor]));
  const source = text.trim().replace(/−/g, '-').replace(/[×]/g, '*').replace(/÷/g, '/');
  if (source === '') return null;
  let at = 0;
  let depth = 0;

  const space = (): void => { while (source[at] === ' ' || source[at] === '\t') at++; };

  function number(): number | null {
    const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(at));
    if (!match) return null;
    at += match[0].length;
    let value = Number(match[0]);
    const mark = at;
    space();
    const suffix = /^(%|°|[a-z]+)/i.exec(source.slice(at));
    if (suffix) {
      const factor = units.get(suffix[0].toLowerCase());
      if (factor === undefined) return null;
      at += suffix[0].length;
      value *= factor;
    } else {
      at = mark;
    }
    return value;
  }

  function factor(): number | null {
    space();
    const sign = source[at];
    if (sign === '-' || sign === '+') {
      at++;
      if (++depth > NESTING_MAX) return null;
      const value = factor();
      depth--;
      return value === null ? null : sign === '-' ? -value : value;
    }
    if (sign === '(') {
      at++;
      if (++depth > NESTING_MAX) return null;
      const value = sum();
      depth--;
      space();
      if (value === null || source[at] !== ')') return null;
      at++;
      return value;
    }
    return number();
  }

  function product(): number | null {
    let value = factor();
    while (value !== null) {
      space();
      const operator = source[at];
      if (operator !== '*' && operator !== '/') break;
      at++;
      const right = factor();
      if (right === null) return null;
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }

  function sum(): number | null {
    let value = product();
    while (value !== null) {
      space();
      const operator = source[at];
      if (operator !== '+' && operator !== '-') break;
      at++;
      const right = product();
      if (right === null) return null;
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  let result: number | null;
  const relative = /^([-+*/])=/.exec(source);
  if (relative) {
    const { current } = context;
    if (!finite(current)) return null;
    at = 2;
    const operand = sum();
    if (operand === null) return null;
    const operator = relative[1];
    result = operator === '+' ? current + operand : operator === '-' ? current - operand : operator === '*' ? current * operand : current / operand;
  } else {
    result = sum();
  }
  space();
  if (result === null || at !== source.length || !Number.isFinite(result)) return null;
  return result === 0 ? 0 : result;
}

/** The units of a length or a height that is stored as a fraction of `metres` (engine.md 1.6): "500m" on 5000 m is 0.1. */
export function metricUnits(metres: number): NumberUnits {
  return finite(metres) && metres > 0 ? { m: 1 / metres, km: 1000 / metres, cm: 0.01 / metres } : {};
}

/** A stored fraction of `metres` as the metric text shown beside it: "403 m", "1.25 km", "12.5 m". */
export function formatMetres(fraction: number, metres: number): string {
  const value = fraction * metres;
  if (!Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (size >= 10000) return `${Number((value / 1000).toPrecision(4))} km`;
  if (size >= 100) return `${Math.round(value)} m`;
  return `${Number(value.toPrecision(3))} m`;
}
