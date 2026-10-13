// tests/nodes/adjust/curve.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import { evalCurve, type CurveParam, type CurvePoint } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/adjust/curve.ts';
import { COLOR_TOL, countValues, mapValues, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

const DEFAULT = def.params.find((param): param is CurveParam => param.kind === 'curve')!.default;

async function curved(src: FieldData, curve: readonly CurvePoint[]): Promise<FieldData> {
  return (await renderNode(def, { inputs: { in: src }, params: { curve } })).out;
}

const CURVES: Readonly<Record<string, readonly CurvePoint[]>> = {
  'the default curve': DEFAULT,
  'a curve that rises and falls': [{ x: 0, y: 0.2 }, { x: 0.25, y: 0.9 }, { x: 0.5, y: 0.3 }, { x: 0.8, y: 1 }, { x: 1, y: 0.6 }],
  'a falling curve': [{ x: 0, y: 1 }, { x: 0.4, y: 0.7 }, { x: 1, y: 0 }],
  'a flat curve': [{ x: 0, y: 0.375 }, { x: 1, y: 0.375 }],
  'a curve that begins and ends inside the range': [{ x: 0.2, y: 0.1 }, { x: 0.5, y: 0.8 }, { x: 0.9, y: 0.4 }],
};

for (const [name, points] of Object.entries(CURVES)) {
  test(`adjust/curve: ${name}: every value from -1 to 2 is the curve's, and beyond 0 and 1 the value of its nearer end`, async () => {
    const out = await curved(WIDE, points);
    // evalCurve is the definition of a curve (engine.md 4.9): constant before its first and after its last point.
    expectClose(out, mapValues(WIDE, (x) => evalCurve(points, x)), { max: 2e-6 });
    const first = Math.fround(evalCurve(points, 0)), last = Math.fround(evalCurve(points, 1));
    assert.equal(countValues(out, (v, i) => WIDE.data[i] <= 0 && v !== first), 0, 'a value below 0 did not take the value of the left end');
    assert.equal(countValues(out, (v, i) => WIDE.data[i] >= 1 && v !== last), 0, 'a value above 1 did not take the value of the right end');
  });
}

test('adjust/curve: a straight curve from corner to corner changes nothing between 0 and 1', async () => {
  const out = await curved(WIDE, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  expectClose(out, mapValues(WIDE, (x) => Math.min(1, Math.max(0, x))), { max: 1e-6 });
});

test('adjust/curve: the default curve widens the valley floors and the tops of a terrain and steepens what lies between', async () => {
  const src = fixtures.terrain(257);
  const out = await curved(src, DEFAULT);
  // The curve rises everywhere, so the ground below its second point is the ground below that point's value.
  const low = countValues(src, (v) => v < 0.3), high = countValues(src, (v) => v > 0.7);
  assert.ok(low > 0.1 * src.data.length && high > 0.1 * src.data.length, 'the fixture has ground below 0.3 and above 0.7');
  assert.equal(countValues(out, (v) => v < Math.fround(evalCurve(DEFAULT, Math.fround(0.3)))), low);
  assert.equal(countValues(out, (v) => v > Math.fround(evalCurve(DEFAULT, Math.fround(0.7)))), high);
  // Between 0.4 and 0.6 the curve rises by this much for every unit of height; a terrain crossing that band steepens as much.
  const rise = (evalCurve(DEFAULT, 0.6) - evalCurve(DEFAULT, 0.4)) / 0.2;
  const climb = (f: FieldData): number => {
    let sum = 0;
    for (let i = 1; i < f.data.length; i++) {
      if (i % 257 === 0 || src.data[i] < 0.4 || src.data[i] > 0.6 || src.data[i - 1] < 0.4 || src.data[i - 1] > 0.6) continue;
      sum += Math.abs(f.data[i] - f.data[i - 1]);
    }
    return sum;
  };
  const steepening = climb(out) / climb(src);
  assert.ok(rise > 2.5, `the default curve rises by ${rise} per unit in its middle`);
  assert.ok(Math.abs(steepening / rise - 1) < 0.03, `the middle of the terrain is ${steepening} times as steep; the curve rises by ${rise} there`);
});

test('adjust/curve: a color is remapped channel by channel and keeps its alpha', async () => {
  for (const points of [DEFAULT, CURVES['a curve that rises and falls']]) {
    const out = await curved(WIDE_COLOR, points);
    assert.equal(out.kind, 'color');
    expectClose(out, mapValues(WIDE_COLOR, (x) => evalCurve(points, x)), { max: COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
});
