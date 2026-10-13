// How the inspector shows, drags and takes a number for its unit (engine.md 1.6, runtime.md 8.7 rules 5 and 6):
// a length and a height in metres beside the stored fraction, typed in either; an angle in degrees; a direction
// as the top view draws it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { param, type FloatParam } from '../../../../src/core/api.ts';
import { nodes } from '../../../../src/core/nodes/index.ts';
import { clampValue, formatNumber, parseEntry, scrubMove, scrubStart, scrubValue } from '../../../../src/app/ui/number.ts';
import {
  angleFromPointer, baseName, dialHand, fileNameParts, floatSpec, formatMemory, formatRunTime, formatStat, formatStatMetres, intSpec, isDirection, metresOf,
  paramTooltip, secondaryOf, SEED_SPEC, shownPrecision, vec2Spec, wrapAngle,
} from '../../../../src/app/panels/inspector/model.ts';

const near = (actual: number | null, expected: number, what: string): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not ${expected}`);
};

const TERRAINS = [{ terrainSize: 1000, heightRange: 250 }, { terrainSize: 4032, heightRange: 1008 }, { terrainSize: 5000, heightRange: 2500 }, { terrainSize: 8128, heightRange: 600 }, { terrainSize: 100_000, heightRange: 8848 }];

test('a fraction of the terrain is metres and back, for a length by the width and for a height by the range', () => {
  const length = param.size();
  const height = param.height();
  for (const settings of TERRAINS) {
    assert.equal(metresOf('length', settings), settings.terrainSize);
    assert.equal(metresOf('height', settings), settings.heightRange);
    for (const unit of ['angle', 'ratio', 'none'] as const) assert.equal(metresOf(unit, settings), null, unit);
    // The two ways the field converts: the factor a typed "m" multiplies with, and the metres a stored 1 stands for.
    for (const spec of [floatSpec(length, settings), floatSpec(height, settings)]) {
      const whole = spec.metres!;
      assert.ok(whole === settings.terrainSize || whole === settings.heightRange);
      for (const fraction of [0, 0.001, 0.1, 0.25, 1, 2.5]) {
        const metres = fraction * whole;
        near(parseEntry(`${metres}m`, { units: spec.units }), fraction, `${fraction} of ${whole} m, in metres and back`);
        near(parseEntry(`${metres / 1000}km`, { units: spec.units }), fraction, `${fraction} of ${whole} m, in kilometres and back`);
      }
    }
  }
  const fiveKilometres = floatSpec(length, { terrainSize: 5000, heightRange: 1000 });
  near(parseEntry('500m', { units: fiveKilometres.units }), 0.1, 'engine.md 1.6 rule 3: 500m on a 5 km terrain stores 0.1');
  assert.equal(secondaryOf(fiveKilometres, 0.1), '500 m');
});

test('a length is typed in metres, kilometres or as the fraction, and shown in metres beside it', () => {
  const size = param.size();
  for (const settings of TERRAINS) {
    const spec = floatSpec(size, settings);
    const typed = (text: string, current?: number): number | null => parseEntry(text, { units: spec.units, current });
    assert.equal(spec.metres, settings.terrainSize);
    near(typed('500m'), 500 / settings.terrainSize, `500m on ${settings.terrainSize}`);
    near(typed('500 m'), 500 / settings.terrainSize, 'with a space');
    near(typed('1.5km'), 1500 / settings.terrainSize, '1.5km');
    near(typed('250 cm'), 2.5 / settings.terrainSize, 'centimetres');
    near(typed('0.25'), 0.25, 'the fraction itself');
    near(typed('0.1 + 100m'), 0.1 + 100 / settings.terrainSize, 'a fraction and metres');
    near(typed('+=50m', 0.2), 0.2 + 50 / settings.terrainSize, 'a change in metres');
    assert.equal(typed('500 ft'), null, 'no other unit');
    // What is shown beside a fraction is the metres that, typed, give the fraction back, as far as its three digits go.
    for (const fraction of [0.05, 0.25, 1]) {
      const shown = secondaryOf(spec, fraction)!;
      const back = typed(shown);
      assert.ok(back !== null && Math.abs(back - fraction) <= 0.006 * fraction, `"${shown}" typed back on ${settings.terrainSize} is ${back}, near ${fraction}`);
    }
  }
  assert.equal(secondaryOf(floatSpec(size, { terrainSize: 5000, heightRange: 1000 }), 0.1), '500 m');
  assert.equal(secondaryOf(floatSpec(size, { terrainSize: 4032, heightRange: 1008 }), 0.25), '1008 m');
  assert.equal(secondaryOf(floatSpec(size, { terrainSize: 100_000, heightRange: 1000 }), 0.25), '25 km');
});

test('a height is typed and shown in metres of the height range, whatever the terrain is wide', () => {
  const height = param.height();
  const spec = floatSpec(height, { terrainSize: 5000, heightRange: 2000 });
  assert.equal(spec.metres, 2000);
  near(parseEntry('500m', { units: spec.units }), 0.25, '500 m of 2000 m');
  assert.equal(secondaryOf(spec, 0.75), '1500 m');
  assert.equal(secondaryOf(floatSpec(height, { terrainSize: 100, heightRange: 1008 }), 0.75), '756 m');
});

test('a soft parameter takes any typed value and is dragged within its range; a hard one is held to its limits', () => {
  const settings = TERRAINS[1]!;
  const soft = floatSpec(param.size(), settings);
  assert.deepEqual([soft.range.min, soft.range.max, soft.range.softMin, soft.range.softMax, soft.range.scale], [undefined, undefined, 0.001, 4, 'log']);
  assert.equal(clampValue(parseEntry('40000m', { units: soft.units })!, soft.range), 40000 / 4032, 'ten times the terrain, as typed');
  // A drag across the whole field is the soft range, in equal ratios on a log scale.
  const start = scrubStart(0.001, soft.range);
  near(scrubValue(scrubMove(start, 200, soft.range, { trackWidth: 200, fine: false }), soft.range, { snap: false }), 4, 'the far end of the drag');
  near(scrubValue(scrubMove(start, 100, soft.range, { trackWidth: 200, fine: false }), soft.range, { snap: false }), Math.sqrt(0.001 * 4), 'half way is the geometric mean');

  const hard = floatSpec(param.strength(), settings);
  assert.deepEqual([hard.range.min, hard.range.max, hard.range.softMin, hard.range.softMax], [0, 1, undefined, undefined]);
  assert.equal(clampValue(parseEntry('7')!, hard.range), 1);
  assert.equal(parseEntry('25%', { units: hard.units }), 0.25, 'a ratio is typed in percent as well');
  assert.equal(secondaryOf(hard, 0.5), undefined, 'and has no metres');
});

test('an angle is shown and typed in degrees; a count is whole; a seed is any unsigned 32-bit integer', () => {
  const settings = TERRAINS[0]!;
  const slope = floatSpec(param.slope('slopeMin'), settings);
  assert.deepEqual([slope.unit, slope.range.min, slope.range.max, slope.precision], ['°', 0, 90, 1]);
  assert.equal(parseEntry('35°', { units: slope.units }), 35);
  assert.equal(parseEntry('35 deg', { units: slope.units }), 35);
  assert.equal(formatNumber(35, slope.precision), '35.0');

  const octaves = intSpec(param.octaves());
  assert.deepEqual([octaves.range.min, octaves.range.max, octaves.range.integer, octaves.precision], [1, 16, true, 0]);
  assert.equal(clampValue(parseEntry('11.6')!, octaves.range), 12);
  assert.equal(clampValue(99, octaves.range), 16);

  assert.equal(clampValue(-5, SEED_SPEC.range), 0);
  assert.equal(clampValue(2 ** 40, SEED_SPEC.range), 2 ** 32 - 1);
  assert.equal(clampValue(123456.4, SEED_SPEC.range), 123456);
});

test('small lengths keep their digits: the decimals follow the lower end of a log range', () => {
  const settings = TERRAINS[1]!;
  const radius = floatSpec(param.radius(), settings);
  assert.equal(formatNumber(0.005, radius.precision), '0.00500');
  assert.equal(formatNumber(0.0001, radius.precision), '0.00010');
  const size = floatSpec(param.size(), settings);
  assert.equal(formatNumber(0.25, size.precision), '0.2500');
  const lacunarity = floatSpec({ unit: 'none', min: 1.5, max: 4, step: 0.1 }, settings);
  assert.equal(formatNumber(2, lacunarity.precision), '2.0', 'a step gives its own decimals');
});

test('a value is shown with the decimals that say something: three digits on a log scale, none it has no room for, and never 0 for what is not 0', () => {
  const settings = TERRAINS[1]!;
  const show = (spec: Parameters<typeof shownPrecision>[0], value: number): string => formatNumber(value, shownPrecision(spec, value));
  // A log scale spans decades: three significant digits wherever the value lies, and never fewer than two decimals.
  const radius = floatSpec(param.radius(), settings);
  assert.deepEqual([0.0001, 0.005, 0.08, 0.25].map((value) => show(radius, value)), ['0.00010', '0.00500', '0.0800', '0.250']);
  const size = floatSpec(param.size(), settings);
  assert.deepEqual([0.001, 0.0123, 0.125, 0.25, 0.3954, 1.3, 4].map((value) => show(size, value)), ['0.0010', '0.0123', '0.125', '0.250', '0.395', '1.30', '4.00']);
  // A linear range keeps the decimals of its range, so that a drag does not change the width of the number.
  const ratio = floatSpec(param.gain(), settings);
  assert.deepEqual([0, 0.5, 0.004, 1].map((value) => show(ratio, value)), ['0.000', '0.500', '0.004', '1.000']);
  const angle = floatSpec(param.angle(), settings);
  assert.deepEqual([0, 45, 359.9].map((value) => show(angle, value)), ['0.0', '45.0', '359.9']);
  // A soft parameter takes any typed value. One too small for the decimals of its range would read as 0.
  assert.equal(show(size, 1e-7), '0.00000010');
  assert.equal(show(ratio, 0.00042), '0.00042');
  assert.equal(show(ratio, -0.00042), '-0.00042');
  assert.equal(show(size, 3e-12), '0.00000000', 'eight decimals are the most a field shows');
  // One too large loses the decimals it has no room for.
  assert.deepEqual([999.5, 12345.678, 1234567.8, 1e9, -1e9].map((value) => show(ratio, value)), ['999.500', '12345.68', '1234568', '1000000000', '-1000000000']);
  assert.equal(show(size, 1e9), '1000000000');
  // Whole numbers have none to lose, and a value that is not a number is left to the field.
  assert.equal(shownPrecision(intSpec({ min: 1, max: 16 }), 12345678), 0);
  assert.equal(shownPrecision(SEED_SPEC, 2 ** 32 - 1), 0);
  assert.equal(shownPrecision(ratio, Number.NaN), ratio.precision);
  // Never more decimals than the range has, except for a value they would hide.
  for (const node of nodes) {
    for (const p of node.params) {
      if (p.kind !== 'float') continue;
      const spec = floatSpec(p, settings);
      for (const value of [p.min, p.default, p.max]) {
        const decimals = shownPrecision(spec, value);
        assert.ok(Number.isInteger(decimals) && decimals >= 0 && decimals <= 8, `${node.type}.${p.name}: ${decimals} decimals for ${value}`);
        if (value !== 0) assert.notEqual(Number(formatNumber(value, decimals)), 0, `${node.type}.${p.name}: ${value} is not shown as 0`);
      }
    }
  }
});

test('a file name that does not fit is cut in its stem: the extension is its own part', () => {
  assert.deepEqual(fileNameParts('terrain/heights-253.png'), { stem: 'heights-253', extension: '.png' });
  assert.deepEqual(fileNameParts('C:\\Users\\ada\\Terrains\\alps_16.final.tif'), { stem: 'alps_16.final', extension: '.tif' });
  assert.deepEqual(fileNameParts('/data/N46E007.hgt'), { stem: 'N46E007', extension: '.hgt' });
  assert.deepEqual(fileNameParts('heights'), { stem: 'heights', extension: '' });
  assert.deepEqual(fileNameParts('.hidden'), { stem: '.hidden', extension: '' }, 'a name that begins with its only dot has no extension');
  assert.deepEqual(fileNameParts('name.'), { stem: 'name.', extension: '' });
  assert.deepEqual(fileNameParts('v1.a-very-long-suffix'), { stem: 'v1.a-very-long-suffix', extension: '' }, 'what follows the dot is too long for an extension');
  assert.deepEqual(fileNameParts(''), { stem: '', extension: '' });
  for (const path of ['a/b/c.png', 'x.tar.gz', 'plain', 'dir.v2/file']) {
    const parts = fileNameParts(path);
    assert.equal(parts.stem + parts.extension, baseName(path), `${path}: the two parts are the name`);
  }
});

test('the components of a vector in lengths have metres like any length', () => {
  const settings = { terrainSize: 2000, heightRange: 500 };
  const offset = vec2Spec({ unit: 'length', min: -1, max: 1, soft: true }, settings);
  assert.deepEqual([offset.range.softMin, offset.range.softMax, offset.range.min, offset.metres], [-1, 1, undefined, 2000]);
  assert.equal(secondaryOf(offset, -0.25), '-500 m');
  near(parseEntry('-300m', { units: offset.units }), -0.15, 'a negative offset in metres');
  const plain = vec2Spec({ unit: 'none', min: 0, max: 10 }, settings);
  assert.deepEqual([plain.range.min, plain.range.max, plain.metres, plain.units], [0, 10, undefined, undefined]);
});

test('every float of the product has a field whose default lies in its range and shows as a number', () => {
  const settings = TERRAINS[1]!;
  let checked = 0;
  for (const def of nodes) {
    for (const p of def.params) {
      if (p.kind !== 'float') continue;
      const spec = floatSpec(p, settings);
      const lo = spec.range.softMin ?? spec.range.min!;
      const hi = spec.range.softMax ?? spec.range.max!;
      assert.ok(lo < hi && p.default >= lo && p.default <= hi, `${def.type}.${p.name}: ${lo}..${hi}`);
      assert.match(formatNumber(p.default, spec.precision), /^-?\d+(\.\d+)?$/, `${def.type}.${p.name}`);
      assert.equal(spec.metres !== undefined, p.unit === 'length' || p.unit === 'height', `${def.type}.${p.name} has metres exactly when it is a length or a height`);
      if (spec.range.scale === 'log') assert.ok(lo > 0, `${def.type}.${p.name}: a log scale above 0`);
      checked++;
    }
  }
  assert.ok(checked > 200, `${checked} float parameters`);
});

test('a direction is an angle over the whole turn, and its dial draws 0° to the right and 90° down the screen', () => {
  const direction = param.angle();
  assert.equal(isDirection(direction), true);
  assert.equal(isDirection(param.slope('talus')), false, 'a slope threshold is no direction');
  assert.equal(isDirection(param.strength()), false);
  assert.equal(isDirection({ ...direction, max: 180 } as FloatParam), false);

  // The screen's y grows downwards, as +Y does in every top view (engine.md 1.8).
  assert.equal(angleFromPointer(10, 0), 0, 'to the right');
  assert.equal(angleFromPointer(0, 10), 90, 'down the screen');
  assert.equal(angleFromPointer(-10, 0), 180, 'to the left');
  assert.equal(angleFromPointer(0, -10), 270, 'up the screen');
  assert.equal(angleFromPointer(10, 10), 45);
  assert.equal(angleFromPointer(0, 0), 0, 'the centre has no direction');
  assert.equal(angleFromPointer(10, 1, 15), 0, 'snapped');
  assert.equal(angleFromPointer(10, 9, 15), 45);
  assert.equal(angleFromPointer(10, -0.5, 15), 0, '357° snaps to the whole turn, which is 0°');
  assert.equal(angleFromPointer(100, 1, 1), 1, 'whole degrees');
  assert.equal(angleFromPointer(100, 1), 0.6, 'tenths without a snap');

  assert.deepEqual(dialHand(0, 10), { x: 10, y: 0 });
  assert.deepEqual(dialHand(90, 10), { x: 0, y: 10 });
  assert.deepEqual(dialHand(180, 10), { x: -10, y: 0 });
  assert.deepEqual(dialHand(270, 10), { x: 0, y: -10 });
  for (const degrees of [0, 30, 135, 200, 359]) {
    const hand = dialHand(degrees, 100);
    near(angleFromPointer(hand.x, hand.y, 1), degrees, `the hand of ${degrees}° points where a pointer gives ${degrees}°`);
  }
  assert.deepEqual([wrapAngle(360), wrapAngle(-90), wrapAngle(725), wrapAngle(Number.NaN)], [0, 270, 5, 0]);
});

test('the tooltip of a parameter is its help, then the default and the range the help leaves out', () => {
  const settings = { terrainSize: 4000, heightRange: 1000 };
  const size = param.size();
  assert.equal(paramTooltip(size, settings), `${size.help} Default 0.25 (1000 m). Slider 0.001 to 4; any typed value is accepted.`);
  const strength = param.strength();
  assert.equal(paramTooltip(strength, settings), `${strength.help} Default 1. Range 0 to 1.`);
  const slope = param.slope('talus');
  assert.equal(paramTooltip(slope, settings), `${slope.help} Default 30°. Range 0° to 90°.`);
  assert.equal(paramTooltip({ kind: 'bool', name: 'clamp', help: 'Limits the result.', default: true }, settings), 'Limits the result. Default on.');
  assert.equal(
    paramTooltip({ kind: 'enum', name: 'mode', help: 'Chooses the look.', default: 'b', options: [{ value: 'a', label: 'Soft' }, { value: 'b', label: 'Hard' }] }, settings),
    'Chooses the look. Default Hard.',
  );
  assert.equal(paramTooltip({ kind: 'curve', name: 'curve', help: 'Remaps heights.', default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, settings), 'Remaps heights.');
});

test('times, sizes and field values are written for a person', () => {
  assert.deepEqual([0.2, 7, 145.4, 999.6, 1250, 12_340, 125_000].map(formatRunTime), ['<1 ms', '7 ms', '145 ms', '1.00 s', '1.25 s', '12.3 s', '2 min 05 s']);
  assert.equal(formatRunTime(-1), '');
  assert.deepEqual([0, 500, 1_020_000, 11.4 * 2 ** 20, 1.25 * 2 ** 30].map(formatMemory), ['0 MB', '1 KB', '996 KB', '11 MB', '1.3 GB']);
  assert.deepEqual([0, 0.74712, -0.00001, 1, Number.NaN].map(formatStat), ['0.000', '0.747', '0.000', '1.000', 'n/a']);
  assert.deepEqual([0, 0.0000628, 0.0123, 0.0996, 0.5, 0.747, 12, -0.00001].map((height) => formatStatMetres(height, 1008)), ['0 m', '0.1 m', '12.4 m', '100 m', '504 m', '753 m', '12.1 km', '0 m']);
  assert.deepEqual(['maps/heights.png', 'C:\\maps\\heights.png', 'heights.png', ''].map(baseName), ['heights.png', 'heights.png', 'heights.png', '']);
});
