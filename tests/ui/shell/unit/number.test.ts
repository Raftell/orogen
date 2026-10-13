// The arithmetic of the number field (src/app/ui/number.ts): what a typed entry means, how a value is written,
// and how a drag, a snap and a step change it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampValue, editText, fillFraction, formatMetres, formatNumber, metricUnits, parseEntry, precisionOf, scrubMove, scrubStart, scrubValue,
  stepOf, stepValue, type NumberRange,
} from '../../../../src/app/ui/number.ts';

const near = (actual: number | null, expected: number, what = ''): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what} ${actual} is not ${expected}`);
};

test('an entry is a number, with or without a sign, a fraction or an exponent', () => {
  assert.equal(parseEntry('12'), 12);
  assert.equal(parseEntry('  0.25 '), 0.25);
  assert.equal(parseEntry('.5'), 0.5);
  assert.equal(parseEntry('5.'), 5);
  assert.equal(parseEntry('-3'), -3);
  assert.equal(parseEntry('+3'), 3);
  assert.equal(parseEntry('1e3'), 1000);
  assert.equal(parseEntry('2.5e-1'), 0.25);
  assert.equal(Object.is(parseEntry('-0'), 0), true, 'never -0');
});

test('an entry is arithmetic with the usual precedence and brackets', () => {
  near(parseEntry('1024/3'), 1024 / 3);
  assert.equal(parseEntry('2+3*4'), 14);
  assert.equal(parseEntry('(2+3)*4'), 20);
  assert.equal(parseEntry('10 - 4 - 3'), 3);
  assert.equal(parseEntry('-(2+3)'), -5);
  assert.equal(parseEntry('2*-3'), -6);
  assert.equal(parseEntry('8/2/2'), 2);
  assert.equal(parseEntry('3 × 4 − 2'), 10, 'the signs a person may paste');
});

test('an entry may change the current value', () => {
  assert.equal(parseEntry('+=5', { current: 10 }), 15);
  assert.equal(parseEntry('-=2.5', { current: 10 }), 7.5);
  assert.equal(parseEntry('*=2', { current: 10 }), 20);
  assert.equal(parseEntry('/=4', { current: 10 }), 2.5);
  assert.equal(parseEntry('*= 1+1', { current: 10 }), 20);
  assert.equal(parseEntry('+=5'), null, 'without a current value there is nothing to change');
});

test('a number may carry a unit that the field knows: 500m on a terrain 5 km wide is 0.1', () => {
  const units = metricUnits(5000);
  near(parseEntry('500m', { units }), 0.1);
  near(parseEntry('500 m', { units }), 0.1);
  near(parseEntry('0.5km', { units }), 0.1);
  near(parseEntry('2.5 KM', { units }), 0.5);
  near(parseEntry('250m + 250m', { units }), 0.1);
  near(parseEntry('0.05 + 250m', { units }), 0.1, 'a bare number is the stored value');
  near(parseEntry('+=500m', { units, current: 0.1 }), 0.2);
  near(parseEntry('25%', { units: { '%': 0.01 } }), 0.25);
  assert.equal(parseEntry('45°', { units: { '°': 1 } }), 45);
  assert.equal(parseEntry('500m'), null, 'a unit the field does not know is no entry');
  assert.equal(parseEntry('500ft', { units }), null);
  assert.deepEqual(metricUnits(0), {});
});

test('what is no entry is null, and so is what has no finite value', () => {
  for (const text of ['', '   ', 'abc', '1+', '(1+2', '1+2)', '2**3', '1 2', '--', '1,5', '=5', '5=', 'NaN', 'Infinity', '1/0', '0/0', '1e999']) {
    assert.equal(parseEntry(text, { current: 1 }), null, JSON.stringify(text));
  }
  assert.equal(parseEntry('1+'.repeat(100) + '1'), null, 'an entry has a length');
  assert.equal(parseEntry(`${'('.repeat(40)}1${')'.repeat(40)}`), null, 'and a depth');
  assert.equal(parseEntry(`${'('.repeat(10)}1${')'.repeat(10)}`), 1);
});

test('a value is shown with a fixed number of decimals, and never as -0', () => {
  assert.equal(formatNumber(0.5, 2), '0.50');
  assert.equal(formatNumber(12, 0), '12');
  assert.equal(formatNumber(-0.0001, 2), '0.00');
  assert.equal(formatNumber(-0.004, 2), '0.00');
  assert.equal(formatNumber(-0.006, 2), '-0.01');
  assert.equal(formatNumber(Number.NaN, 2), '');
  assert.equal(editText(0.1 + 0.2), '0.3');
  assert.equal(editText(1 / 3), '0.3333333');
  assert.equal(editText(7.6, { integer: true }), '8');
});

test('the decimals shown and the step follow the step, else the soft range', () => {
  assert.equal(precisionOf({ step: 0.01 }), 2);
  assert.equal(precisionOf({ step: 0.001 }), 3);
  assert.equal(precisionOf({ step: 1 }), 0);
  assert.equal(precisionOf({ step: 0.25 }), 1);
  assert.equal(precisionOf({ integer: true }), 0);
  assert.equal(precisionOf({ min: 0, max: 1 }), 3);
  assert.equal(precisionOf({ min: 0, max: 360 }), 1);
  assert.equal(precisionOf({ min: 0, max: 5000 }), 0);
  assert.equal(precisionOf({}), 3);
  assert.equal(stepOf({ step: 0.05 }), 0.05);
  assert.equal(stepOf({ min: 0, max: 2 }), 0.02);
  assert.equal(stepOf({ softMin: 0, softMax: 1, min: 0, max: 100 }), 0.01, 'the soft range, not the hard one');
  assert.equal(stepOf({ integer: true, step: 0.3 }), 1);
  assert.equal(stepOf({}), 0.01);
});

test('clampValue keeps a value within the hard limits and whole where the range is of integers', () => {
  assert.equal(clampValue(1.5, { min: 0, max: 1 }), 1);
  assert.equal(clampValue(-2, { min: 0, max: 1 }), 0);
  assert.equal(clampValue(5, { min: 0 }), 5);
  assert.equal(clampValue(7.6, { integer: true }), 8);
  assert.equal(clampValue(99, { integer: true, max: 10.5 }), 10);
  assert.equal(clampValue(-99, { integer: true, min: 0.5 }), 1);
  assert.ok(Number.isNaN(clampValue(Number.NaN, { min: 0, max: 1 })));
});

test('the fill runs from the soft minimum to the value, in ratios on a log scale', () => {
  assert.equal(fillFraction(0.25, { min: 0, max: 1 }), 0.25);
  assert.equal(fillFraction(2, { min: 0, max: 4, softMax: 1 }), 1, 'a value beyond the soft range fills the field');
  assert.equal(fillFraction(-1, { min: -5, softMin: 0, max: 1 }), 0);
  assert.equal(fillFraction(5, {}), null, 'a range without ends has nothing to fill');
  near(fillFraction(4, { softMin: 1, softMax: 16, scale: 'log' }), 0.5);
  near(fillFraction(8, { softMin: 0.5, softMax: 128, scale: 'log' }), 0.5);
});

/** A drag of `dx` pixels in `steps` moves from `value`; returns the value it ends on. */
function dragged(value: number, dx: number, range: NumberRange, how: { fine?: boolean; snap?: boolean; trackWidth?: number; steps?: number } = {}): number {
  const steps = how.steps ?? 10;
  let position = scrubStart(value, range);
  for (let step = 0; step < steps; step++) position = scrubMove(position, dx / steps, range, { trackWidth: how.trackWidth ?? 200, fine: how.fine === true });
  return scrubValue(position, range, { snap: how.snap === true });
}

test('a drag across the width of the field is the soft range', () => {
  near(dragged(0, 200, { min: 0, max: 1 }), 1);
  near(dragged(0.5, 50, { min: 0, max: 1 }), 0.75);
  near(dragged(0.5, -50, { min: 0, max: 1 }), 0.25);
  near(dragged(0.5, 50, { min: 0, max: 100, softMin: 0, softMax: 1 }), 0.75, 'the soft range, not the hard one');
  near(dragged(90, 100, { min: 0, max: 360 }, { trackWidth: 100 }), 360, 'and no further');
});

test('Shift slows a drag to a tenth', () => {
  near(dragged(0.5, 100, { min: 0, max: 1 }, { fine: true }), 0.55);
  near(dragged(0.5, 100, { min: 0, max: 1 }), 1);
});

test('a drag stays within the soft range, and typed values beyond it are not pulled back by a touch', () => {
  const range: NumberRange = { min: 0, max: 4, softMax: 1 };
  near(dragged(0.5, 1000, range), 1, 'a drag ends at the soft maximum');
  near(dragged(0.5, -1000, range), 0);
  near(dragged(2.5, 2, range), 2.5, 'a value typed beyond the soft range stays when the drag does not go back');
  near(dragged(2.5, -100, range), 2, 'and comes back when it does');
  near(dragged(2.5, 1000, range), 2.5, 'but goes no further out');
  // The excess of a drag beyond the end is not owed on the way back.
  let position = scrubStart(0.9, range);
  position = scrubMove(position, 500, range, { trackWidth: 200, fine: false });
  position = scrubMove(position, -20, range, { trackWidth: 200, fine: false });
  near(scrubValue(position, range, { snap: false }), 0.9);
});

test('Ctrl snaps a drag to the step, or to tenths of the soft range where there is no step', () => {
  near(dragged(0.5, 33, { min: 0, max: 1, step: 0.25 }, { snap: true }), 0.75);
  near(dragged(0.5, 13, { min: 0, max: 1 }, { snap: true }), 0.6, 'tenths of the range');
  near(dragged(10, 26, { min: 0, max: 360, step: 15 }, { snap: true, trackWidth: 360 }), 30);
  near(dragged(0.5, 33, { min: 0, max: 1, step: 0.25 }), 0.665, 'without Ctrl the step does not hold the value');
  assert.equal(dragged(0.1, 40, { min: 0, max: 1, step: 0.1 }, { snap: true }), 0.3, 'a snapped value is the step, not 0.30000000000000004');
});

test('a drag of a field of integers adds small movements up', () => {
  const range: NumberRange = { min: 1, max: 64, softMax: 16, integer: true };
  assert.equal(dragged(8, 40, range, { trackWidth: 150, steps: 40 }), 12);
  assert.equal(dragged(8, 4, range, { trackWidth: 150, steps: 4 }), 8, 'less than half a step is none');
  assert.equal(dragged(8, 1000, range, { trackWidth: 150 }), 16);
});

test('a drag on a log scale moves in equal ratios', () => {
  const range: NumberRange = { min: 0.01, max: 1024, softMin: 1, softMax: 16, scale: 'log' };
  near(dragged(1, 100, range), 4);
  near(dragged(4, 100, range), 16);
  near(dragged(16, -200, range), 1);
  near(dragged(2, 50, range, { fine: true }), 2 * 16 ** 0.025);
});

test('a drag of a range without ends moves a step for every two pixels', () => {
  near(dragged(0, 20, { step: 0.1 }), 1);
  near(dragged(5, -40, { step: 0.5 }), -5);
  near(dragged(0, 20, {}), 0.1);
  near(dragged(0, 20, { step: 0.1 }, { fine: true }), 0.1);
  assert.equal(dragged(3, 20, { integer: true }), 13);
  near(dragged(0, 20, { step: 0.1, max: 0.5 }), 0.5, 'the hard limit holds');
});

test('an arrow key adds a step; Shift ten, Alt a tenth', () => {
  assert.equal(stepValue(0.5, 1, { min: 0, max: 1, step: 0.01 }), 0.51);
  assert.equal(stepValue(0.5, -1, { min: 0, max: 1, step: 0.01 }), 0.49);
  assert.equal(stepValue(0.5, 1, { min: 0, max: 1, step: 0.01 }, { coarse: true }), 0.6);
  assert.equal(stepValue(0.5, 1, { min: 0, max: 1, step: 0.01 }, { fine: true }), 0.501);
  assert.equal(stepValue(0.995, 1, { min: 0, max: 1, step: 0.01 }), 1, 'within the hard limits');
  assert.equal(stepValue(8, 1, { integer: true, min: 1, max: 64 }), 9);
  assert.equal(stepValue(8, 1, { integer: true, min: 1, max: 64 }, { fine: true }), 9, 'an integer has no finer step');
  assert.equal(stepValue(0.1, 1, { step: 0.1 }), 0.2);
  assert.equal(stepValue(0.2, 1, { step: 0.1 }), 0.3);
});

test('the metric text of a length reads as a person writes it', () => {
  assert.equal(formatMetres(0.1, 5000), '500 m');
  assert.equal(formatMetres(0.0025, 5000), '12.5 m');
  assert.equal(formatMetres(1, 4032), '4032 m');
  assert.equal(formatMetres(0.5, 50000), '25 km');
  assert.equal(formatMetres(0.25, 1008), '252 m');
  assert.equal(formatMetres(Number.NaN, 5000), '');
});
