// normalizeParams, row by row of the table of runtime.md 4.4, and the canonical parameters of engine.md 4.4.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { param, type ParamDef, type ParamValue } from '../../src/core/api.ts';
import { normalizeStored } from '../../src/core/graph/params.ts';
import { normalizeParams } from '../../src/core/runtime.ts';
import { everyKind, gen, node } from './graph-fixtures.ts';

/** The normalised value of one param of `gen`, with the problems and the error of the call. */
function one(name: string, stored: unknown): { value: ParamValue | undefined; problems: readonly string[]; error: string | null } {
  const result = normalizeParams(gen, { [name]: stored });
  return { value: result.values[name], problems: result.problems, error: result.error };
}
const accepted = (name: string, stored: unknown, value: unknown = stored): void => {
  assert.deepEqual(one(name, stored), { value, problems: [], error: null }, `${name} = ${JSON.stringify(stored)}`);
};
const changed = (name: string, stored: unknown, value: unknown, problem: string): void => {
  assert.deepEqual(one(name, stored), { value, problems: [problem], error: null }, `${name} = ${JSON.stringify(stored)}`);
};

test('every declared name is present, in declaration order, with defaults for missing names and no problem', () => {
  const result = normalizeParams(gen, {});
  assert.deepEqual(Object.keys(result.values), everyKind.map((p) => p.name));
  for (const p of everyKind) assert.deepEqual(result.values[p.name], p.default);
  assert.deepEqual(result.problems, []);
  assert.equal(result.error, null);
  assert.deepEqual(normalizeParams(gen, { hard: undefined }).problems, []);
});

test('stored params that are no object hold no value: every name takes its default', () => {
  for (const stored of [undefined, null, [0.9], 'hard']) {
    const result = normalizeParams(gen, stored as never);
    assert.deepEqual(Object.keys(result.values), everyKind.map((p) => p.name));
    assert.equal(result.values.hard, 0.5);
    assert.deepEqual(result.problems, []);
    assert.equal(normalizeStored(gen, stored as never).params, stored);
  }
});

test('a stored name the node does not declare is ignored', () => {
  const result = normalizeParams(gen, { removed: 7, constructor: 'x' });
  assert.equal('removed' in result.values, false);
  assert.equal(Object.hasOwn(result.values, 'constructor'), false);
  assert.deepEqual(result.problems, []);
});

test('normalisation does not change what it is given', () => {
  const stored = Object.freeze({ hard: 7, profile: Object.freeze([Object.freeze({ x: 1, y: 0 }), Object.freeze({ x: 0, y: 2 })]) });
  const before = JSON.stringify(stored);
  normalizeParams(gen, stored);
  assert.equal(JSON.stringify(stored), before);
});

test('float: a finite number, clamped to min..max unless soft; otherwise the default', () => {
  accepted('hard', 0.25);
  accepted('hard', 0);
  accepted('hard', 1);
  changed('hard', 7, 1, 'param "hard": 7 is outside 0..1; clamped to 1');
  changed('hard', -0.5, 0, 'param "hard": -0.5 is outside 0..1; clamped to 0');
  changed('hard', '0.3', 0.5, 'param "hard": "0.3" is not a finite number; the default is used');
  changed('hard', null, 0.5, 'param "hard": null is not a finite number; the default is used');
  assert.equal(one('hard', NaN).value, 0.5);
  assert.equal(one('hard', Infinity).value, 0.5);
  accepted('soft', 100);
  accepted('soft', -3);
  accepted('soft', 0);
  assert.equal(one('soft', Infinity).value, 0.25);
});

test('int: rounded to the nearest integer, then clamped', () => {
  accepted('count', 7);
  changed('count', 2.5, 3, 'param "count": 2.5 is not an integer; rounded to 3');
  changed('count', 2.4, 2, 'param "count": 2.4 is not an integer; rounded to 2');
  changed('count', 40, 16, 'param "count": 40 is outside 1..16; clamped to 16');
  changed('count', 0.2, 1, 'param "count": 0.2 is outside 1..16; clamped to 1');
  changed('count', true, 4, 'param "count": true is not a finite number; the default is used');
});

test('bool: a boolean, otherwise the default', () => {
  accepted('invert', true);
  accepted('invert', false);
  changed('invert', 1, false, 'param "invert": 1 is not true or false; the default is used');
  changed('invert', 'true', false, 'param "invert": "true" is not true or false; the default is used');
});

test('enum: one of the option values, otherwise the error of the contract', () => {
  accepted('mode', 'add');
  assert.deepEqual(one('mode', 'screen'), { value: 'mix', problems: [], error: 'param "mode": unknown value "screen"' });
  assert.equal(one('mode', 3).error, 'param "mode": unknown value "3"');
  assert.equal(one('mode', null).error, 'param "mode": unknown value "null"');
  // The first error is reported, and the other values are still normalised.
  const two = node({
    type: 'ref/two',
    params: [
      { kind: 'enum', name: 'first', help: 'A.', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { kind: 'enum', name: 'second', help: 'B.', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { kind: 'int', name: 'count', help: 'C.', default: 1, min: 0, max: 4 },
    ],
  });
  const result = normalizeParams(two, { first: 'x', second: 'y', count: 9 });
  assert.equal(result.error, 'param "first": unknown value "x"');
  assert.deepEqual(result.values, { first: 'a', second: 'a', count: 4 });
});

test('seed: floor modulo 2^32, as an unsigned integer', () => {
  accepted('seed', 0);
  accepted('seed', 4294967295);
  changed('seed', 4294967296, 0, 'param "seed": 4294967296 is not an integer in 0..4294967295; 0 is used');
  changed('seed', -1, 4294967295, 'param "seed": -1 is not an integer in 0..4294967295; 4294967295 is used');
  assert.equal(one('seed', 3.9).value, 3);
  assert.equal(one('seed', -0.5).value, 4294967295);
  assert.equal(one('seed', 4294967296 * 5 + 17).value, 17);
  assert.equal(one('seed', 'abc').value, 0);
});

test('vec2: two finite numbers, each clamped unless soft', () => {
  accepted('offset', [0.5, -1]);
  changed('offset', [3, -0.25], [1, -0.25], 'param "offset": [3,-0.25] is outside -1..1; clamped to [1,-0.25]');
  changed('offset', [1, 2, 3], [0, 0], 'param "offset": [1,2,3] is not a pair of finite numbers; the default is used');
  assert.deepEqual(one('offset', [1, '2']).value, [0, 0]);
  assert.deepEqual(one('offset', 1).value, [0, 0]);
  accepted('center', [5, -5]);
});

test('color: three finite numbers, each clamped to 0..1', () => {
  accepted('tint', [0.25, 0.5, 1]);
  changed('tint', [2, -1, 0.5], [1, 0, 0.5], 'param "tint": [2,-1,0.5] is outside 0..1; clamped to [1,0,0.5]');
  assert.deepEqual(one('tint', [1, 1]).value, [1, 1, 1]);
  assert.deepEqual(one('tint', '#fff').value, [1, 1, 1]);
});

test('curve: clamped to 0..1, sorted by x, later points with an equal x dropped', () => {
  const repaired = 'param "profile": the points were clamped to 0..1, sorted by x, and points repeating an x dropped';
  accepted('profile', [{ x: 0, y: 1 }, { x: 0.5, y: 0.25 }, { x: 1, y: 0 }]);
  changed('profile', [{ x: 1, y: 0 }, { x: 0, y: 2 }], [{ x: 0, y: 1 }, { x: 1, y: 0 }], repaired);
  changed('profile', [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }], repaired);
  // -2 and -1 both clamp to 0: the one stored first stays.
  changed('profile', [{ x: -2, y: 0.3 }, { x: -1, y: 0.6 }, { x: 1, y: 1 }], [{ x: 0, y: 0.3 }, { x: 1, y: 1 }], repaired);
  const defaults = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  changed('profile', [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }], defaults, 'param "profile": a curve needs 2 points with different x; the default is used');
  changed('profile', [{ x: 0.5, y: 0 }], defaults, 'param "profile": a curve needs 2 points with different x; the default is used');
  assert.deepEqual(one('profile', [{ x: 0, y: 0 }, { x: '1', y: 1 }]).value, defaults);
  assert.deepEqual(one('profile', [{ x: 0, y: 0 }, null]).value, defaults);
  assert.deepEqual(one('profile', 'linear').value, defaults);
});

test('curve and gradient values hold their own members only, whatever the document holds', () => {
  const result = normalizeParams(gen, {
    profile: [{ y: 0, x: 0, note: 'a' }, { x: 1, y: 1 }],
    ramp: [{ color: [0, 0, 0], t: 0, note: 'b' }, { t: 1, color: [1, 1, 1] }],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(JSON.stringify(result.values.profile), '[{"x":0,"y":0},{"x":1,"y":1}]');
  assert.equal(JSON.stringify(result.values.ramp), '[{"t":0,"color":[0,0,0]},{"t":1,"color":[1,1,1]}]');
});

test('gradient: clamped to 0..1 and stably sorted by t', () => {
  const repaired = 'param "ramp": the stops were clamped to 0..1 and sorted';
  accepted('ramp', [{ t: 0, color: [1, 0, 0] }, { t: 0.5, color: [0, 1, 0] }, { t: 0.5, color: [0, 0, 1] }, { t: 1, color: [1, 1, 1] }]);
  changed('ramp',
    [{ t: 1, color: [1, 1, 1] }, { t: 0.5, color: [0, 2, 0] }, { t: 0.5, color: [0, 0, 1] }, { t: -1, color: [-1, 0, 0] }],
    [{ t: 0, color: [0, 0, 0] }, { t: 0.5, color: [0, 1, 0] }, { t: 0.5, color: [0, 0, 1] }, { t: 1, color: [1, 1, 1] }],
    repaired);
  const defaults = [{ t: 0, color: [0, 0, 0] }, { t: 1, color: [1, 1, 1] }];
  changed('ramp', [{ t: 0, color: [1, 0, 0] }], defaults, 'param "ramp": a gradient needs 2 stops; the default is used');
  assert.deepEqual(one('ramp', [{ t: 0, color: [1, 0] }, { t: 1, color: [1, 1, 1] }]).value, defaults);
  assert.deepEqual(one('ramp', [{ t: '0', color: [1, 0, 0] }, { t: 1, color: [1, 1, 1] }]).value, defaults);
  assert.deepEqual(one('ramp', {}).value, defaults);
});

test('file: a string, otherwise no file', () => {
  accepted('file', 'assets/heights.png');
  accepted('file', '');
  changed('file', 5, '', 'param "file": 5 is not a path; no file is selected');
});

test('text: a string truncated to maxLength, otherwise the default', () => {
  accepted('label', 'Rock');
  accepted('label', '12345678');
  changed('label', '123456789', '12345678', 'param "label": the text is longer than 8 characters; truncated');
  changed('label', 7, 'Layer', 'param "label": 7 is not a text; the default is used');
  // A character outside the basic plane is two code units: it is dropped whole.
  assert.equal(one('label', '1234567\u{1F600}').value, '1234567');
  const plain = node({ type: 'ref/plain', params: [{ kind: 'text', name: 'label', help: 'A text.', default: '' }] });
  assert.equal((normalizeParams(plain, { label: 'x'.repeat(300) }).values.label as string).length, 256);
});

test('one sentence per changed value, in declaration order', () => {
  const result = normalizeParams(gen, { label: 9, hard: 2, count: 2.5, soft: 9 });
  assert.deepEqual(result.problems, [
    'param "hard": 2 is outside 0..1; clamped to 1',
    'param "count": 2.5 is not an integer; rounded to 3',
    'param "label": 9 is not a text; the default is used',
  ]);
});

test('normalizeStored replaces the changed values only and keeps everything else as stored', () => {
  const stored = { later: 1, count: 40, hard: 0.5, mode: 'screen', profile: [{ x: 0, y: 0, note: 'a' }, { x: 1, y: 1 }] };
  const result = normalizeStored(gen, stored);
  assert.deepEqual(result.params, { later: 1, count: 16, hard: 0.5, mode: 'screen', profile: [{ x: 0, y: 0, note: 'a' }, { x: 1, y: 1 }] });
  assert.deepEqual(Object.keys(result.params), Object.keys(stored));
  assert.deepEqual(result.problems, ['param "count": 40 is outside 1..16; clamped to 16']);
  assert.equal(result.error, 'param "mode": unknown value "screen"');

  const clean = { hard: 0.5, unknown: [1, 2] };
  assert.equal(normalizeStored(gen, clean).params, clean);
});

test('the canonical parameters are the table of engine.md 4.4', () => {
  const table: readonly (readonly [ParamDef, Partial<ParamDef> & Record<string, unknown>])[] = [
    [param.seed(), { kind: 'seed', name: 'seed', label: 'Seed', default: 0 }],
    [param.size(), { kind: 'float', unit: 'length', name: 'size', label: 'Feature size', default: 0.25, min: 0.001, max: 4, scale: 'log', soft: true }],
    [param.radius(), { kind: 'float', unit: 'length', name: 'radius', label: 'Radius', default: 0.005, min: 0.0001, max: 0.25, scale: 'log', soft: true }],
    [param.strength(), { kind: 'float', unit: 'ratio', name: 'strength', label: 'Strength', default: 1, min: 0, max: 1 }],
    [param.height(), { kind: 'float', unit: 'height', name: 'height', label: 'Height', default: 1, min: 0, max: 1, soft: true }],
    [param.angle(), { kind: 'float', unit: 'angle', name: 'angle', label: 'Direction', default: 0, min: 0, max: 360 }],
    [param.slope('talus'), { kind: 'float', unit: 'angle', name: 'talus', label: 'Slope', default: 30, min: 0, max: 90 }],
    [param.octaves(), { kind: 'int', name: 'octaves', label: 'Octaves', default: 8, min: 1, max: 16 }],
    [param.gain(), { kind: 'float', unit: 'ratio', name: 'gain', label: 'Roughness', default: 0.5, min: 0, max: 1 }],
  ];
  for (const [made, expected] of table) {
    const { help, ...rest } = made;
    assert.deepEqual(rest, expected, expected.name as string);
    assert.ok(help.length > 0 && help.length <= 200 && /^[A-Z].*\.$/.test(help), `help of ${made.name}: ${help}`);
  }
});

test('a canonical helper accepts overrides for everything except kind and unit', () => {
  const warp = param.size({ name: 'warpSize', label: 'Warp size', default: 0.1, max: 1, help: 'Larger values bend the terrain over longer distances.' });
  assert.deepEqual(warp, {
    kind: 'float', unit: 'length', name: 'warpSize', label: 'Warp size', default: 0.1, min: 0.001, max: 1, scale: 'log', soft: true,
    help: 'Larger values bend the terrain over longer distances.',
  });
  const forced = param.strength({ kind: 'int', unit: 'none', name: 'detailStrength' } as never);
  assert.equal(forced.kind, 'float');
  assert.equal(forced.unit, 'ratio');
  assert.equal(forced.name, 'detailStrength');
  assert.equal(param.seed({ default: 7, name: 'other' } as never).name, 'seed');
  assert.equal(param.seed({ default: 7 }).default, 7);
  assert.equal(param.octaves({ name: 'layers', max: 8 }).name, 'layers');
  assert.equal(param.octaves({ name: 'layers', max: 8 }).max, 8);
  assert.deepEqual(
    param.slope('talus', { label: 'Talus angle', default: 35, help: 'Slopes steeper than this collapse.' }),
    { kind: 'float', unit: 'angle', name: 'talus', label: 'Talus angle', default: 35, min: 0, max: 90, help: 'Slopes steeper than this collapse.' },
  );
  // Each call returns a new object.
  assert.notEqual(param.size(), param.size());
});
