// tests/nodes/simulate/rivers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectMask, expectStats, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/rivers.ts';
import { BANK_RISE, RIVER_DEPTH_EXPONENT, RIVER_TAPER, RIVER_WIDTH_EXPONENT, VALLEY_REACH } from '../../../src/core/nodes/simulate/_water-constants.ts';
import { R, RIVER_DEFAULTS, T, riversOf, type Rivers } from './_water-sites.ts';

conformance(def, {
  skip: {
    resolution: 'River and depth are lines a few texels wide, which finer detail moves: at shared vertices 257 and 513 differ by 1.1 standard deviations in both, and by 0.009 in out. The test below compares the width and the depth of one river at the two levels.',
  },
});

const DRY = { seaLevel: -1 };
const alone = { headwaters: null } as const;

/** A valley along the line v = 0.6 u + 0.2 that falls towards +u by 20 %, with sides at 30 %: its river is a stair of texels. */
const askew = (res: number): FieldData => fieldOf(res, (u, v) => 0.95 - 0.8 * u + 1.2 * Math.abs(v - 0.6 * u - 0.2));

/** The sum of the river mask over the texels of column x between two rows: the river's width there, in texels. */
function across(river: FieldData, x: number, from: number, to: number): number {
  let sum = 0;
  for (let y = from; y <= to; y++) sum += at(river, x, y);
  return sum;
}

/** 1 for every texel within `reach` texels of a site of the rivers. */
function within(rivers: Rivers, reach: number): Uint8Array {
  const res = rivers.res, near = new Uint8Array(res * res), span = Math.ceil(reach);
  for (const site of rivers.sites.values()) {
    const x = site.texel % res, y = Math.floor(site.texel / res);
    for (let v = Math.max(y - span, 0); v <= Math.min(y + span, res - 1); v++) {
      for (let u = Math.max(x - span, 0); u <= Math.min(x + span, res - 1); u++) if ((u - x) ** 2 + (v - y) ** 2 <= reach * reach) near[v * res + u] = 1;
    }
  }
  return near;
}

test('simulate/rivers: the terrain is only ever cut, the water is never below the bed, and depth is never below 0', async () => {
  for (const name of ['terrain', 'notch', 'cone'] as const) {
    const input = fixtures[name](257);
    const { out, river, depth, surface } = await renderNode(def, { inputs: { in: input, ...alone } });
    expectMask(river);
    let raised = 0, under = 0, negative = 0, stray = 0;
    for (let i = 0; i < out.data.length; i++) {
      if (out.data[i]! > input.data[i]!) raised++;
      if (surface.data[i]! < out.data[i]!) under++;
      if (depth.data[i]! < 0) negative++;
      // Away from every river there is no water: no depth, and the surface is the ground.
      if (river.data[i] === 0 && (depth.data[i] !== 0 || surface.data[i] !== out.data[i])) stray++;
    }
    assert.equal(raised, 0, `${name}: texels above the input`);
    assert.equal(under, 0, `${name}: texels whose water surface lies below the ground`);
    assert.equal(negative, 0, `${name}: texels with a depth below 0`);
    assert.equal(stray, 0, `${name}: dry texels with water`);
    assert.ok(stats(river).mean > 0.001, `${name}: ${stats(river).mean} of the terrain is river`);
  }
});

test('simulate/rivers: a river is whole from where the catchment drains through a texel to its end', async () => {
  // Closed under taking receivers (8.6 item 2): the receiver of a river texel of the router is a river texel.
  // The mask follows the smoothed course, which lies up to two texels from a narrow river's texels: along the
  // whole of every river some texel within that reach is marked.
  for (const name of ['notch', 'terrain'] as const) {
    const input = fixtures[name](257);
    const catchment = 0.002;
    const { river } = await renderNode(def, { inputs: { in: input, ...alone }, params: { catchment }, settings: DRY, wants: ['river'] });
    const rivers = riversOf(input.data, 257, -1, { catchment });
    const offsets = [1, 257, -1, -257];
    let texels = 0, broken = 0, unmarked = 0, marked = 0;
    for (let i = 0; i < river.data.length; i++) {
      if (river.data[i]! >= 0.5) marked++;
      if (rivers.area[i]! < catchment) continue;
      texels++;
      if (rivers.receivers[i] !== 4 && rivers.area[i + offsets[rivers.receivers[i]!]!]! < catchment) broken++;
      // A river begins without width: where it drains less than twice the catchment it may still be too thin to mark a texel.
      if (rivers.area[i]! < 2 * catchment) continue;
      const x = i % 257, y = Math.floor(i / 257);
      let most = 0;
      for (let v = Math.max(y - 3, 0); v <= Math.min(y + 3, 256); v++) for (let u = Math.max(x - 3, 0); u <= Math.min(x + 3, 256); u++) most = Math.max(most, at(river, u, v));
      if (!(most > 0.2)) unmarked++;
    }
    assert.ok(texels > 100, `${name}: ${texels} texels drain the catchment`);
    assert.equal(broken, 0, `${name}: river texels whose receiver is no river`);
    assert.equal(unmarked, 0, `${name}: stretches of river the mask leaves out`);
    assert.ok(marked < 12 * texels, `${name}: the mask marks ${marked} texels for ${texels} river texels`);
  }
});

test('simulate/rivers: where no river is within reach the terrain is unchanged, exactly', async () => {
  const input = fixtures.terrain(257);
  const params = { catchment: 0.005, riverWidth: 0.03, riverDepth: 0.02, valleyDepth: 0.05, bank: 30 };
  const { out, river } = await renderNode(def, { inputs: { in: input, ...alone }, params });
  const rivers = riversOf(input.data, 257, 0.25, params);
  // The farthest a river lowers the terrain, in texels (8.5), and a texel more for the stretch between two sites.
  const reach = (0.5 * params.riverWidth * T + (VALLEY_REACH * (params.riverDepth * R + BANK_RISE * rivers.deepest)) / Math.tan((30 * Math.PI) / 180)) / rivers.cell + 2;
  const near = within(rivers, reach);
  let changed = 0, far = 0, cut = 0;
  for (let i = 0; i < near.length; i++) {
    if (out.data[i]! < input.data[i]!) cut++;
    if (near[i]) continue;
    far++;
    if (out.data[i] !== input.data[i] || river.data[i] !== 0) changed++;
  }
  assert.ok(far > 1000, `${far} texels lie beyond the reach of every river`);
  assert.equal(changed, 0, 'texels beyond reach that changed');
  assert.ok(cut > 300, `${cut} texels were cut`);
});

test('simulate/rivers: the channel is as deep and as wide as the share of the terrain it drains makes it', async () => {
  // The notch fixture: one straight channel along v = 0.5, which gathers the water of its banks on the way to
  // +x. Without a valley the water stands at the routing surface, which is the ground on the centre line, but
  // for what the smoothing of the long profile takes off it: the bed lies one river depth below the water.
  // The catchment is larger than what any texel of the banks drains: the centre line is the one river.
  const input = fixtures.notch(257);
  const params = { catchment: 0.02, riverWidth: 0.05, riverDepth: 0.1, valleyDepth: 0 };
  const { out, river, depth, surface } = await renderNode(def, { inputs: { in: input, ...alone }, params, settings: DRY });
  const rivers = riversOf(input.data, 257, -1, params);
  let worst = 0;
  const widths: number[] = [];
  for (const x of [170, 190, 210, 230, 245]) {
    // The river as the course task gives it at this column: far enough from its beginning to have the width of its share.
    const site = rivers.sites.get(128 * 257 + x)!;
    const share = rivers.area[128 * 257 + x]!;
    assert.ok(Math.abs(site.width - params.riverWidth * T * share ** RIVER_WIDTH_EXPONENT) < 0.05 * site.width, `at column ${x} the river is full grown`);
    const deep = params.riverDepth * R * site.share ** RIVER_DEPTH_EXPONENT * Math.min(site.width / 16, 1);
    const water = at(surface, x, 128);
    assert.ok(water <= at(input, x, 128) && (at(input, x, 128) - water) * R < 2.5, `column ${x}: the water stands ${(at(input, x, 128) - water) * R} m below the ground`);
    const bed = (water - at(out, x, 128)) * R;
    worst = Math.max(worst, Math.abs(bed - deep) / deep);
    // As deep over the bed as the bed lies below the water.
    assert.ok(Math.abs(at(depth, x, 128) * R - bed) < 1e-2, `column ${x}: the depth is ${at(depth, x, 128) * R} m, the bed lies ${bed} m below the water`);
    const wide = across(river, x, 100, 156) * 16;
    widths.push(wide);
    assert.ok(Math.abs(wide - site.width) < 0.25 * site.width + 8, `column ${x}: the mask is ${wide} m wide, the river ${site.width} m`);
  }
  assert.ok(worst < 0.02, `the bed is off by ${worst} of the river's depth at the most`);
  assert.ok(widths.every((w, i) => i === 0 || w > widths[i - 1]!), `the river widens downstream: ${widths.map((w) => w.toFixed(0)).join(', ')} m`);
  // The banks of the notch are gentler than the bank slope: beyond the channel nothing is cut.
  assert.equal(at(out, 200, 60), at(input, 200, 60));
});

test('simulate/rivers: a river begins as a trickle and widens along its course', async () => {
  const input = fixtures.notch(257);
  const params = { catchment: 0.02, riverWidth: 0.2, valleyDepth: 0 };
  const { river } = await renderNode(def, { inputs: { in: input, ...alone }, params, settings: DRY, wants: ['river'] });
  // Where the centre line first drains the catchment, and the width of the mask from there on.
  const rivers = riversOf(input.data, 257, -1, params);
  let first = 0;
  while (rivers.area[128 * 257 + first]! < params.catchment) first++;
  const widths: number[] = [];
  for (let x = first; x < 250; x++) widths.push(across(river, x, 90, 166) * 16);
  // By its share alone the river would begin 116 m wide: riverWidth * T * catchment^0.5.
  const blunt = params.riverWidth * T * params.catchment ** RIVER_WIDTH_EXPONENT;
  assert.ok(widths[2]! < 0.2 * blunt, `three texels from its beginning the river is ${widths[2]} m wide; its share would make it ${blunt} m`);
  let steep = 0;
  for (let k = 8; k < widths.length; k++) if (widths[k]! - widths[k - 8]! > 1.5 * RIVER_TAPER * 8 * 16 + 8) steep++;
  assert.equal(steep, 0, 'stretches of eight texels over which the river widens much faster than the taper');
  assert.ok(widths.at(-1)! > 3 * widths[10]!, `the river grows from ${widths[10]} m to ${widths.at(-1)} m`);
});

test('simulate/rivers: a valley as deep as the share makes it, whose sides ease out from the bank slope at the water', async () => {
  // The notch again, now with a valley: the river lies below the ground it ran on. Beside it the ground is
  // lowered by the depth of the valley, less with the square of the way to where the valley ends, and within a
  // bank's width of the water its height above the water is scaled down too, to nothing at the waterline.
  const input = fixtures.notch(257);
  const params = { catchment: 0.02, riverWidth: 0.05, riverDepth: 0.02, valleyDepth: 0.3, bank: 30 };
  const { out, river, surface } = await renderNode(def, { inputs: { in: input, ...alone }, params, settings: DRY });
  const rivers = riversOf(input.data, 257, -1, params);
  const tan = Math.tan(Math.PI / 6);
  for (const x of [190, 220, 245]) {
    const site = rivers.sites.get(128 * 257 + x)!;
    const deep = params.valleyDepth * R * site.share ** RIVER_DEPTH_EXPONENT;
    const level = at(surface, x, 128);
    assert.ok(Math.abs((at(input, x, 128) - level) * R - deep) < 0.05 * deep, `column ${x}: the water lies ${(at(input, x, 128) - level) * R} m below the ground, the valley is ${deep} m deep`);
    // The depth of the valley and of the channel in it, and how far the valley reaches beyond the bank.
    const total = params.riverDepth * R * site.share ** RIVER_DEPTH_EXPONENT + BANK_RISE * site.rise;
    const reach = (VALLEY_REACH * total) / tan;
    let checked = 0, before = Infinity;
    for (let y = 129; y < 200; y++) {
      const beyond = (y - 128) * 16 - 0.5 * site.width;
      if (at(river, x, y) > 0 || beyond < 8) continue;
      const over = (at(input, x, y) - level) * R, cut = (at(input, x, y) - at(out, x, y)) * R;
      if (beyond > reach + 16) {
        assert.equal(at(out, x, y), at(input, x, y), `column ${x}, ${beyond} m beyond the channel: past the valley the ground is as it was`);
        continue;
      }
      const left = Math.max(1 - beyond / reach, 0), near = Math.max(1 - (beyond * tan) / total, 0);
      const high = Math.min(over / total, 2);
      const wide = total * left * left * (high - 0.25 * high * high);
      const expected = wide + (over - wide) * near * near;
      checked++;
      assert.ok(Math.abs(cut - expected) < 0.04 * deep + 0.5, `column ${x}, ${beyond} m beyond the channel: the ground is lowered by ${cut} m; the valley is ${expected} m deep there`);
      assert.ok(cut <= before + 0.5, `column ${x}, ${beyond} m beyond the channel: the valley is no deeper than nearer the river`);
      before = cut;
    }
    assert.ok(checked >= 6, `column ${x}: ${checked} texels of the valley's side were measured`);
    // At the waterline the side rises at the bank slope, or less where the ground stood lower than the valley is deep.
    const first = Math.ceil((0.5 * site.width) / 16) + 1;
    const rise = (at(out, x, 128 + first + 1) - at(out, x, 128 + first)) * R / 16;
    assert.ok(rise > 0 && rise < 1.6 * tan, `column ${x}: beside the water the side rises by ${rise}, the bank slope is ${tan}`);
  }
  // No valley: no cut a bank's width beyond the channel, which is as it was in the test before.
  const flat = await renderNode(def, { inputs: { in: input, ...alone }, params: { ...params, valleyDepth: 0 }, settings: DRY, wants: ['out'] });
  assert.equal(at(flat.out, 220, 140), at(input, 220, 140));
  assert.ok(at(out, 220, 140) < at(input, 220, 140) - 0.02);
});

test('simulate/rivers: beside a steep river that runs askew to the grid the valley\'s side is even', async () => {
  // A river that is a stair of texels and falls by a fifth: its level changes by more than a metre from one
  // river texel to the next. The side of its valley is a smooth hollow, so along a row its bend changes little
  // from texel to texel. Cut from the nearest river texel alone it would stand in rungs a metre high, and
  // measured to a course that kept a trace of the stair, in ripples: there the bend changes its sign at every texel.
  const res = 513, input = askew(res);
  const params = { catchment: 0.05, valleyDepth: 0.2, riverWidth: 0.05 };
  const { out, river } = await renderNode(def, { res, inputs: { in: input, ...alone }, params, settings: DRY, wants: ['out', 'river'] });
  let checked = 0, uneven = 0, worst = 0;
  for (let x = 250; x < 420; x++) {
    const line = (0.6 * (x / (res - 1)) + 0.2) * (res - 1);
    // The channel's half width at this column, from the mask; then the rows 3 to 9 texels beyond its edge.
    const half = 0.5 * across(river, x, Math.round(line) - 40, Math.round(line) + 40);
    for (let k = 3; k <= 9; k++) {
      const y = Math.round(line + (half + k) / Math.cos(Math.atan(0.6)));
      const i = y * res + x;
      if (!(out.data[i]! < input.data[i]! - 1e-4)) continue;
      const bendAt = (j: number): number => (out.data[j - 1]! - 2 * out.data[j]! + out.data[j + 1]!) * R;
      const bend = Math.abs(bendAt(i + 1) - bendAt(i));
      checked++;
      worst = Math.max(worst, bend);
      if (bend > 0.25) uneven++;
    }
  }
  assert.ok(checked > 800, `${checked} texels of the side were measured`);
  assert.equal(uneven, 0, `texels at which the bend of the side changes by more than 0.25 m along a row; the most is ${worst} m`);
});

test('simulate/rivers: a larger catchment leaves fewer rivers; no width leaves the terrain alone, no depth and no valley leave a strip of water', async () => {
  const input = fixtures.terrain(257);
  const share = async (params: Record<string, number>): Promise<Readonly<Record<string, FieldData>>> => renderNode(def, { inputs: { in: input, ...alone }, params, wants: ['river', 'out'] });
  const many = await share({ catchment: 0.0005 }), few = await share({ catchment: 0.01 });
  assert.ok(stats(many.river!).mean > 1.5 * stats(few.river!).mean, `${stats(many.river!).mean} against ${stats(few.river!).mean} of the terrain is river`);
  const removed = (out: FieldData): number => { let sum = 0; for (let i = 0; i < out.data.length; i++) sum += input.data[i]! - out.data[i]!; return sum; };
  const flat = await share({ riverWidth: 0 });
  expectIdentical(flat.out!, input);
  expectStats(flat.river!, { min: [0, 0], max: [0, 0] });
  // A river without depth and without a valley is still a level strip of water as wide as the river: it is
  // marked, and only the ground that stood above its water within that width is cut.
  const shallow = await share({ catchment: 0.01, riverDepth: 0, valleyDepth: 0 });
  assert.ok(stats(shallow.river!).mean > 0.0005, 'a river without depth is still marked');
  assert.ok(removed(shallow.out!) < 0.3 * removed(few.out!) && removed(few.out!) > 0, `no depth removes ${removed(shallow.out!)}, the defaults ${removed(few.out!)}`);
  // A deeper valley removes more.
  const slight = await share({ catchment: 0.01, valleyDepth: 0.1 }), deep = await share({ catchment: 0.01, valleyDepth: 0.4 });
  assert.ok(removed(deep.out!) > 2 * removed(slight.out!), `a valley four times as deep removes ${removed(deep.out!)} against ${removed(slight.out!)}`);
});

test('simulate/rivers: a steeper bank keeps the valley narrow', async () => {
  // A valley with sides at 45 degrees that falls towards +x: the river cuts its sides back to the bank slope.
  const input = fieldOf(257, (u, v) => 0.9 - 0.3 * u + 4 * Math.abs(v - 0.5) * (1 - 0.3 * u) * 0.25);
  const cut = async (bank: number): Promise<number> => {
    const { out } = await renderNode(def, { inputs: { in: input, ...alone }, params: { bank, valleyDepth: 0.2 }, settings: DRY, wants: ['out'] });
    let n = 0;
    for (let i = 0; i < out.data.length; i++) if (out.data[i]! < input.data[i]! - 1e-5) n++;
    return n;
  };
  const gentle = await cut(15), steep = await cut(70);
  assert.ok(steep > 50 && gentle > 1.3 * steep, `${gentle} texels are cut with a bank of 15 degrees and ${steep} with one of 70`);
});

test('simulate/rivers: a river that crosses a lake lies level in it, lower by its valley, and leaves the lake\'s bed', async () => {
  // The basin fixture without a sea: a slope with one hollow, which fills to where it spills. The ground under
  // the lake lies below any channel, so it is not cut; the water in the river there is the lake's, lowered by
  // what the river cuts the lake's outlet: without a valley, by what the smoothing of its long profile takes
  // off the rim.
  const input = fixtures.basin(257);
  const rivers = riversOf(input.data, 257, 0, { catchment: 0.0005 });
  const lake = (i: number): number => rivers.filled[i]! - input.data[i]!;
  const crossing = async (valleyDepth: number): Promise<{ texels: number; cut: number; least: number; most: number }> => {
    const { out, river, depth, surface } = await renderNode(def, { inputs: { in: input, ...alone }, params: { catchment: 0.0005, riverWidth: 0.02, valleyDepth }, settings: { seaLevel: 0 } });
    let texels = 0, cut = 0, least = Infinity, most = -Infinity, wrong = 0;
    for (let i = 0; i < out.data.length; i++) {
      if (!(lake(i) > 0.05) || !(river.data[i]! >= 1)) continue;
      texels++;
      if (out.data[i] !== input.data[i]) cut++;
      const drop = rivers.filled[i]! - surface.data[i]!;
      least = Math.min(least, drop);
      most = Math.max(most, drop);
      if (Math.abs(depth.data[i]! - (surface.data[i]! - out.data[i]!)) > 1e-6) wrong++;
    }
    assert.equal(wrong, 0, 'river texels in the lake whose depth is not that of the water over the bed');
    return { texels, cut, least, most };
  };
  const level = await crossing(0);
  assert.ok(level.texels > 20, `${level.texels} river texels lie over deep water`);
  assert.equal(level.cut, 0, 'lake bed that was cut');
  // Level but for the fall of the routing surface along the river, a millimetre per texel, and a metre or two lower.
  assert.ok(level.least > -1e-5 && level.most < 0.004 && level.most - level.least < 0.002, `the river lies ${level.least} to ${level.most} below the lake's surface`);
  const lowered = await crossing(0.03);
  assert.ok(lowered.texels > 20 && lowered.cut === 0, `${lowered.texels} river texels over deep water, ${lowered.cut} of them cut`);
  assert.ok(lowered.least > level.most + 0.002 && lowered.most < 0.05, `with a valley the river lies ${lowered.least} to ${lowered.most} below the lake's old surface`);
});

test('simulate/rivers: headwaters say where rivers may gather their water', async () => {
  const input = fixtures.terrain(257);
  const plain = await renderNode(def, { inputs: { in: input, ...alone } });
  const everywhere = await renderNode(def, { inputs: { in: input, headwaters: 'one' } });
  for (const name of ['out', 'river', 'depth', 'surface'] as const) expectIdentical(everywhere[name]!, plain[name]!);
  // No water anywhere: no river, and the terrain as it was.
  const none = await renderNode(def, { inputs: { in: input, headwaters: 'zero' } });
  expectIdentical(none.out, input);
  expectStats(none.river, { min: [0, 0], max: [0, 0] });
  expectStats(none.depth, { min: [0, 0], max: [0, 0] });
  // Water from the disc of the mask fixture only: less river than with water from everywhere.
  const disc = await renderNode(def, { inputs: { in: input, headwaters: 'mask' }, wants: ['river'] });
  assert.ok(stats(disc.river).mean > 0 && stats(disc.river).mean < 0.8 * stats(plain.river).mean, `${stats(disc.river).mean} against ${stats(plain.river).mean}`);
});

test('simulate/rivers: the seed moves the small rivers and leaves the large ones', async () => {
  const input = fixtures.terrain(257);
  const a = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 1 }, wants: ['river'] });
  const b = await renderNode(def, { inputs: { in: input, ...alone }, params: { seed: 2 }, wants: ['river'] });
  let both = 0, either = 0;
  for (let i = 0; i < a.river.data.length; i++) {
    const ra = a.river.data[i]! >= 0.5, rb = b.river.data[i]! >= 0.5;
    if (ra && rb) both++;
    if (ra || rb) either++;
  }
  assert.ok(both < 0.98 * either, 'the two seeds give different courses');
  assert.ok(both > 0.3 * either, `the two seeds share ${both} of ${either} river texels: the same valleys hold rivers`);
});

test('simulate/rivers: one river is as wide and as deep at 513 as at 257', async () => {
  const params = { catchment: 0.02, riverWidth: 0.1, riverDepth: 0.1, valleyDepth: 0.1 };
  const measure = async (res: number): Promise<{ width: number; depth: number }[]> => {
    const input = fixtures.notch(res);
    const { river, out } = await renderNode(def, { res, inputs: { in: input, ...alone }, params, settings: DRY, wants: ['river', 'out'] });
    const last = res - 1, cell = T / last, row = last / 2;
    return [0.75, 0.85, 0.95].map((u) => {
      const x = Math.round(u * last);
      return { width: across(river, x, Math.round(0.35 * last), Math.round(0.65 * last)) * cell, depth: (at(input, x, row) - at(out, x, row)) * R };
    });
  };
  const coarse = await measure(257), fine = await measure(513);
  for (let i = 0; i < coarse.length; i++) {
    assert.ok(Math.abs(coarse[i]!.width - fine[i]!.width) < 0.2 * fine[i]!.width, `width ${coarse[i]!.width} m at 257 and ${fine[i]!.width} m at 513`);
    assert.ok(Math.abs(coarse[i]!.depth - fine[i]!.depth) < 0.1 * fine[i]!.depth, `depth ${coarse[i]!.depth} m at 257 and ${fine[i]!.depth} m at 513`);
  }
});

test('simulate/rivers: the tests run the course task with the node\'s own defaults', () => {
  for (const [name, value] of Object.entries(RIVER_DEFAULTS)) {
    const param = def.params.find((candidate) => candidate.name === name);
    assert.ok(param && 'default' in param && param.default === value, `${name} is ${String(value)} in the tests`);
  }
});
