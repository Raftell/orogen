// tests/nodes/filter/twirl.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/filter/twirl.ts';
import { resampled } from './_reference.ts';

conformance(def);

const N = 257;
const L = N - 1;
const SRC = fixtures.terrain(N);

const twirl = async (params: Readonly<Record<string, ParamValue>>, src: FieldData = SRC): Promise<FieldData> =>
  (await renderNode(def, { inputs: { in: src }, params })).out;

/** The source position of an output texel: turned back by angle * (1 - r / radius)^2 about the centre. */
function source(center: readonly [number, number], radius: number, angle: number): (x: number, y: number) => readonly [number, number] {
  return (x, y) => {
    const qx = x - center[0] * L, qy = y - center[1] * L;
    const r = Math.hypot(qx, qy);
    if (r >= radius * L) return [x, y];
    const a = -((angle * Math.PI) / 180) * (1 - r / (radius * L)) ** 2;
    return [center[0] * L + Math.cos(a) * qx - Math.sin(a) * qy, center[1] * L + Math.sin(a) * qx + Math.cos(a) * qy];
  };
}

test('filter/twirl: the picture is turned by the angle at the center, less and less outwards, and not at all beyond the radius', async () => {
  for (const [center, radius, angle] of [[[0.5, 0.5], 0.4, 120], [[0.3, 0.6], 0.25, 300], [[0.9, 0.1], 0.5, 45]] as const) {
    const out = await twirl({ center, radius, angle });
    expectClose(out, resampled(SRC, source(center, radius, angle)), { max: 1e-4 });
  }
  // Beyond the radius, and at the center itself, the texels are the input's own.
  const out = await twirl({ center: [0.5, 0.5], radius: 0.25, angle: 180 });
  let changed = 0, turned = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const same = at(out, x, y) === at(SRC, x, y);
      if (Math.hypot(x - 128, y - 128) >= 64) changed += same ? 0 : 1;
      else turned += same ? 0 : 1;
    }
  }
  assert.equal(changed, 0, 'texels beyond the radius that differ from the input');
  assert.ok(turned > 10000, `${turned} texels within the radius changed`);
  assert.equal(at(out, 128, 128), at(SRC, 128, 128));
});

test('filter/twirl: clockwise carries what lies towards +X towards +Y, counterclockwise the other way', async () => {
  // A bump 0.1 to the right of the center. With a radius of 0.4 it is turned by 90 * 0.75^2 = 50.6 degrees.
  const bump = fieldOf(N, (u, v) => Math.exp(-((u - 0.6) ** 2 + (v - 0.5) ** 2) / 0.0008));
  const place = (f: FieldData): readonly [number, number] => {
    let sum = 0, sx = 0, sy = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const w = at(f, x, y); sum += w; sx += w * x; sy += w * y; }
    return [sx / sum / L - 0.5, sy / sum / L - 0.5];
  };
  const turnOf = (f: FieldData): number => { const [x, y] = place(f); return (Math.atan2(y, x) * 180) / Math.PI; };
  const cw = await twirl({ angle: 90, radius: 0.4 }, bump);
  const ccw = await twirl({ angle: 90, radius: 0.4, mode: 'counterclockwise' }, bump);
  assert.ok(Math.abs(turnOf(cw) - 50.6) < 4, `clockwise: the bump lies at ${turnOf(cw)} degrees`);
  assert.ok(Math.abs(turnOf(ccw) + 50.6) < 4, `counterclockwise: the bump lies at ${turnOf(ccw)} degrees`);
});

test('filter/twirl: a picture that is the same all around the center is left as it is', async () => {
  const dome = fieldOf(N, (u, v) => Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.03));
  expectClose(await twirl({ angle: 270, radius: 0.5 }, dome), dome, { max: 2e-4 });
});

test('filter/twirl: no angle, or no radius, gives the input itself', async () => {
  for (const params of [{ angle: 0 }, { radius: 0 }, { radius: -1 }] as Readonly<Record<string, number>>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: SRC }, params });
    expectIdentical(outputs.out, SRC);
    assert.equal(report.nodes.node.peakBytes, 0);
  }
});

test('filter/twirl: a color is twisted channel by channel and stays opaque', async () => {
  const color = fixtures.color(N);
  const out = await twirl({}, color);
  assert.equal(out.kind, 'color');
  expectClose(channelOf(out, 2), await twirl({}, channelOf(color, 2)), { max: 2e-3 });
  expectIdentical(channelOf(out, 3), fixtures.one(N));
});

test('filter/twirl: the twist is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def);
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});
