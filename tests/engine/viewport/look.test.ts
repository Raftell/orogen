// The picture as a picture (testing.md 5.4): what a viewer notices first, each held by a number that the renderer
// as it was before does not reach. The scenes and their numbers are in look-rig.ts; the pictures these tests write
// are for a person, <OROGEN_TEST_OUTPUT>/viewport-engine/look-*.png.
//
// Measured against the renderer of the commit before (its files copied beside this one for the comparison):
// the fringe of the shore was 40 steps of 255 brighter than the land beside it and is 4 darker; water over a bed
// three metres down kept 94 % of the bed's red against its blue and keeps 68 %; the ground beside the slab was as
// bright behind it as in the open (54 of 255) and is 14 against 69; grey ground of the albedo 0.18 under a sun at
// 45 degrees was drawn at 152 147 141 and is at 122 121 120; level ground of the default material differed by one
// step across the terrain and differs by fifteen.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { exposureFor, keyLight, luminance, skyLight, whiteBalance } from '../../../src/viewport/atmosphere.ts';
import { TONE_SHOULDER } from '../../../src/viewport/shaders.ts';
import { crestJaggedness, grey, levelGround, ridge, seaAtAGlance, seaColours, tableShade } from './look-rig.ts';
import { readField, sample, startView, writePicture, type ViewRig } from './rig.ts';

const reported: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]): void => {
  reported.push(args.map(String).join(' '));
  consoleError(...args);
};
after(() => {
  console.error = consoleError;
  assert.deepEqual(reported, [], 'no frame reported an error');
});

async function withView(body: (rig: ViewRig) => Promise<void>, renderer: object = {}): Promise<void> {
  const rig = await startView({ renderer });
  try {
    await body(rig);
  } finally {
    await rig.dispose();
  }
}

const encode = (linear: number): number => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
const shown = (colour: readonly number[]): string => colour.map((c) => c.toFixed(1)).join(' ');

test('a sharp ridge from near: the skyline is a smooth line, not the teeth of the texels, and the pointer still reads the field', async (t) => {
  if ((await startViewCaps()).software) {
    t.skip('four pictures from fourteen metres are for a GPU');
    return;
  }
  const jagged: Record<string, number[]> = { smooth: [], plain: [] };
  const picks: Record<string, (readonly number[])[]> = { smooth: [], plain: [] };
  for (const [name, renderer] of [['smooth', {}], ['plain', { smooth: false }]] as const) {
    await withView(async (rig) => {
      for (const angle of [100, 30]) {
        const crest = await crestJaggedness(rig, angle);
        assert.ok(crest.columns > 1000, `the crest is the skyline across the picture: ${crest.columns} columns`);
        jagged[name]!.push(crest.jagged);
        t.diagnostic(`${name}, a ridge across ${angle} degrees: the skyline is ${crest.jagged.toFixed(2)} px from a straight line; ${await writePicture(`look-crest-${name}-${angle}`, crest.picture)}`);
        // What lies under a pixel a little below the crest: the field's own height at the place found, which is
        // not the height the smooth surface has there.
        const hit = await rig.session.viewport.pick(800, 620);
        assert.ok(hit !== null, 'the slope is under the pixel');
        const field = await readField(rig.gpu, ridge(angle), { node: 'ridge', port: 'out' }, 253);
        assert.ok(Math.abs(hit.height - sample(field, hit.uv[0], hit.uv[1])) < 1e-5, `the readout is the field's: ${hit.height} at ${hit.uv.join(' ')}`);
        picks[name]!.push([...hit.uv, hit.height]);
        // The mesh has vertices between the texels there, and a bounded number of them.
        const state = rig.renderer.state;
        assert.ok(state.triangles > 10_000 && state.triangles < 3_500_000, `${state.triangles} triangles`);
      }
    }, renderer);
  }
  for (const i of [0, 1]) {
    // Measured: 18.3 and 16.2 px for the field's own patches, 7.3 and 3.0 for the smooth surface. What is left is the
    // field's own: a crest that runs across the grid is sampled now on a texel, now between two.
    assert.ok(jagged.smooth![i]! < 0.55 * jagged.plain![i]!, `the skyline is ${jagged.smooth![i]} px from straight, against ${jagged.plain![i]} for the texels' patches`);
    assert.ok(jagged.plain![i]! > 8, `the texels' patches have teeth: ${jagged.plain![i]}`);
    assert.ok(picks.smooth![i]!.every((value, k) => Math.abs(value - picks.plain![i]![k]!) < 1e-6), 'the pointer reads the same of both pictures');
  }
});

/** The capabilities of the device the tests run on. */
async function startViewCaps(): Promise<{ software: boolean }> {
  const rig = await startView();
  try {
    return { software: rig.gpu.caps.software };
  } finally {
    await rig.dispose();
  }
}

test('the sea: its colour is graded by the depth of its bed, the shore has no line, and at a glance it mirrors the sky', async (t) => {
  await withView(async (rig) => {
    const sea = await seaColours(rig);
    t.diagnostic(`shallow ${shown(sea.shallow)} (dry ${shown(sea.shallowDry)}), deep ${shown(sea.deep)}, shore ${shown(sea.shore)}, land ${shown(sea.land)}; ${await writePicture('look-sea-from-above', sea.picture)}`);
    assert.ok(sea.counts.every((count) => count > 50), `every depth has its places: ${sea.counts.join(' ')}`);
    // Water takes the red of the light first: over a bed two to five metres down the bed is seen, turned green and blue.
    const redOverBlue = (colour: readonly number[]): number => colour[0]! / colour[2]!;
    assert.ok(redOverBlue(sea.shallow) < 0.8 * redOverBlue(sea.shallowDry), `the bed under shallow water has lost its red: ${shown(sea.shallow)} over ${shown(sea.shallowDry)}`);
    assert.ok(grey(sea.shallow) > 0.6 * grey(sea.shallowDry), 'and is still seen');
    // Deep water is its own dark blue, whatever lies under it.
    assert.ok(grey(sea.shallow) > grey(sea.deep) + 25 && sea.deep[2] > sea.deep[0] + 40 && sea.deep[2] > sea.deep[1] + 10, `deep water is dark and blue: ${shown(sea.deep)}`);
    // Where the water is thinnest it is no brighter than the land it meets: a fringe, never a pale line.
    assert.ok(grey(sea.shore) < grey(sea.land) + 10, `the shore is ${shown(sea.shore)} beside land of ${shown(sea.land)}`);
    assert.ok(grey(sea.shore) > grey(sea.deep) + 25, 'and paler than the open water');

    const glance = await seaAtAGlance(rig);
    t.diagnostic(`open water from above ${shown(glance.above)}, at a glance ${shown(glance.glance)}; ${await writePicture('look-sea-at-a-glance', glance.picture)}`);
    assert.ok(grey(glance.glance) > 1.5 * grey(glance.above), 'seen along its surface the water mirrors the sky above the horizon');
    assert.ok(glance.glance[2]! > glance.glance[0]!, 'whose blue it has');
  });
});

test('the slab stands on the ground: it shades the ground behind it from the sun and the ground beside it from the sky', async (t) => {
  await withView(async (rig) => {
    const table = await tableShade(rig);
    t.diagnostic(`behind the slab ${table.behind.toFixed(1)}, beside it ${table.beside.toFixed(1)}, in the open ${table.open.toFixed(1)}; ${await writePicture('look-table', table.picture)}`);
    assert.ok(table.behind < 0.5 * table.open, 'the ground behind the slab is in its shadow');
    assert.ok(table.beside < 0.9 * table.open && table.beside > 1.5 * table.behind, 'the ground beside it is shaded by it, and is in the sun');
    assert.ok(table.behind > 4, 'and no shadow is black');
  });
});

test('light and exposure: level ground in the sun has the colour that is draped on it, neutral grey is neutral, and nothing is burnt out', async (t) => {
  // The numbers behind it (atmosphere.ts): the key is what white level ground sends back; the exposure brings 0.18 of it to 0.18.
  const light = skyLight(45);
  assert.ok(Math.abs(exposureFor(light, 45) * 0.18 * luminance(keyLight(light, 45)) - 0.18) < 1e-9);
  const balance = whiteBalance(light, 45), key = keyLight(light, 45);
  const balanced = key.map((c, i) => c * balance[i]!);
  assert.ok(Math.abs(luminance(balanced as never) - luminance(key)) < 1e-9 * luminance(key), 'the balance leaves the light as bright as it is');
  assert.ok(key[0] / key[2] > 1.08 && balanced[0]! / balanced[2]! < 1.03 && balanced[0]! / balanced[2]! > 1, `the light of the day is shown all but white: ${key.map((c) => c.toFixed(4)).join(' ')} as ${balanced.map((c) => c.toFixed(4)).join(' ')}`);

  await withView(async (rig) => {
    // Grey of 0.18 is drawn at 0.18, and a little more for what the ground around throws back: 118 to 125 of 255.
    const middle = await levelGround(rig, [0.18, 0.18, 0.18]);
    t.diagnostic(`grey ground of 0.18 is drawn at ${shown(middle.mean)}`);
    assert.ok(middle.mean.every((c) => c >= encode(0.18) - 1 && c <= encode(0.18) + 7), `${shown(middle.mean)} for ${encode(0.18).toFixed(1)}`);
    assert.ok(Math.abs(middle.mean[0] - middle.mean[2]) <= 4, 'and without a hue');
    assert.ok(middle.spread <= 3, 'a draped colour is drawn as it is: no pattern of the renderer lies over it');
    // A colour keeps its own: green of (0.1, 0.4, 0.1) is that green, as much brighter as the grey was.
    const green = await levelGround(rig, [0.1, 0.4, 0.1]);
    const lift = (middle.mean[1] / 255) ** 2.2 / 0.18;      // near enough to compare two colours by
    t.diagnostic(`green ground of 0.1 0.4 0.1 is drawn at ${shown(green.mean)}`);
    assert.ok(Math.abs(green.mean[1] - encode(0.4 * lift)) <= 6 && Math.abs(green.mean[0] - encode(0.1 * lift)) <= 6 && Math.abs(green.mean[0] - green.mean[2]) <= 4, `${shown(green.mean)}`);
    // What is above the straight part of the curve is brought in below white, with its light and shade left.
    const bright = await levelGround(rig, [0.8, 0.8, 0.8]);
    assert.ok(0.8 > TONE_SHOULDER && bright.mean.every((c) => c > encode(TONE_SHOULDER) && c < 245), `snow is not burnt out: ${shown(bright.mean)}`);

    // The default material: level ground is not one colour, and clay is.
    const plain = await levelGround(rig, null);
    t.diagnostic(`level ground of the default material: ${shown(plain.mean)}, ${plain.spread.toFixed(1)} steps from its darkest to its lightest; ${await writePicture('look-level-ground', plain.picture)}`);
    assert.ok(plain.spread >= 8 && plain.spread <= 70, `level ground has patches: ${plain.spread}`);
    assert.ok(plain.mean[1] >= plain.mean[2] + 10 && grey(plain.mean) > 70 && grey(plain.mean) < 150, `and the colour of dry turf: ${shown(plain.mean)}`);
    const clay = await levelGround(rig, null, { shading: 'clay' });
    assert.ok(clay.spread <= 3 && Math.abs(clay.mean[0] - clay.mean[2]) < 12, `clay is one colour: ${shown(clay.mean)}`);
  });
});
