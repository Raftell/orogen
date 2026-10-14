// The viewport renderer through the session (runtime.md 7.4, 7.5): what it draws of a bound field, the top view
// as the field's image, picking against the field's own numbers, the overlays, the display options, drawing on
// demand, drafts and a failing node. The canvas is a texture (rig.ts); the pictures it writes are for a person.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { pixelRay, project, viewOf } from '../../../src/viewport/camera.ts';
import { BAKE_LOADS_MAX, BAKE_LOADS_MIN, BAKE_LOADS_PER_FRAME } from '../../../src/viewport/lighting.ts';
import { testGpu } from '../gpu/rig.ts';
import { difference, makeDoc, pixel, rangeDoc, readField, region, sample, SIZE, startView, writePicture, type ViewRig } from './rig.ts';

// A GPU validation error in a frame is reported with console.error (5.8): none may be.
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

const BACKGROUND = 22;
const HEIGHT = { node: 'range', port: 'out' };
const TOP = { kind: 'top', center: [0.5, 0.5], span: 1 } as const;
const SQUARE = { width: 800, height: 800, dpr: 1 };
/** One step of 255 is the rounding of the canvas; the dither adds half a step. */
const STEP = 2;

async function withView(body: (rig: ViewRig) => Promise<void>, size = SIZE): Promise<void> {
  const rig = await startView({ size });
  try {
    await body(rig);
  } finally {
    await rig.dispose();
  }
}

test('nothing bound: the canvas is the background, a pick finds nothing, and no frame is drawn while nothing changes', async () => {
  await withView(async (rig) => {
    const picture = await rig.picture();
    assert.deepEqual([picture.width, picture.height], [1600, 1000], 'the backing size is width × dpr by height × dpr');
    const all = region(picture, 0, 0, 1, 1);
    assert.deepEqual([all.mean.map(Math.round), all.spread], [[BACKGROUND, BACKGROUND, BACKGROUND], 0]);
    assert.equal(await rig.session.viewport.pick(800, 500), null);
    const frames = rig.renderer.state.frames;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rig.renderer.state.frames, frames, 'on demand (7.5 rule 6): no free-running loop');
    // A view that names nothing is nothing to show either.
    await rig.show(makeDoc({ range: { type: 'generate/mountain-range' } }, { height: { node: 'gone', port: 'out' } }));
    assert.equal(region(await rig.picture(), 0, 0, 1, 1).spread, 0);
  });
});

test('a terrain in the 3D view: sky above, lit relief in the middle, and one frame per change once the light maps are complete', async () => {
  await withView(async (rig) => {
    const size = 1008;
    rig.setCamera({ kind: 'orbit', target: [size / 2, size / 2, 60], yaw: 300, pitch: 12, distance: 1.5 * size, fovY: 35 });
    await rig.show(rangeDoc(1009));
    const picture = await rig.picture();
    await writePicture('renderer-orbit', picture);
    const sky = region(picture, 0, 0, 1, 0.12), relief = region(picture, 0.3, 0.38, 0.7, 0.6);
    assert.ok(sky.mean[2] > sky.mean[0] + 15 && sky.mean[2] > 90, `the sky is blue: ${sky.mean.map(Math.round).join(' ')}`);
    assert.ok(relief.spread > 100, `the relief has light and shadow: ${relief.spread}`);
    const state = rig.renderer.state;
    assert.ok(state.triangles > 20_000 && state.triangles < 3_000_000, `${state.triangles} triangles`);
    assert.equal(state.lightSize, 1024);
    assert.ok(state.heightRange !== null && state.heightRange[0] >= -0.05 && state.heightRange[1] > 0.4 && state.heightRange[1] <= 1.05, `${state.heightRange}`);
    assert.ok(state.reservedBytes > 0 && rig.engine.memory().reservedBytes >= state.reservedBytes, 'what the renderer holds is in the engine\'s ledger (7.5 rule 4)');

    // A camera change is one frame; the picture of the same camera is the same picture.
    const frames = state.frames;
    rig.setCamera({ kind: 'orbit', target: [size / 2, size / 2, 60], yaw: 320, pitch: 12, distance: 1.5 * size, fovY: 35 });
    const turned = await rig.picture();
    assert.equal(rig.renderer.state.frames, frames + 1);
    assert.ok(difference(turned, picture) > 1, 'another direction is another picture');
    rig.setCamera({ kind: 'orbit', target: [size / 2, size / 2, 60], yaw: 300, pitch: 12, distance: 1.5 * size, fovY: 35 });
    assert.ok(difference(await rig.picture(), picture) < 0.05, 'and the first direction the first picture again');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rig.renderer.state.frames, frames + 2);

    // A resize changes the backing size.
    rig.resize({ width: 640, height: 400, dpr: 1.5 });
    const small = await rig.picture();
    assert.deepEqual([small.width, small.height], [960, 600]);
  });
});

test('a panel with more pixels than the card is given a canvas for keeps its shape, and the pointer is read in the panel\'s pixels', async () => {
  const size = 1008;
  const camera = { kind: 'orbit', target: [size / 2, size / 2, 60], yaw: 300, pitch: 25, distance: 1.8 * size, fovY: 35 } as const;
  const whole = await startView();
  const bounded = await startView({ renderer: { pixelLimit: 400_000 } });
  try {
    for (const rig of [whole, bounded]) {
      rig.setCamera(camera);
      await rig.show(rangeDoc(1009));
    }
    const full = await whole.picture(), small = await bounded.picture();
    assert.deepEqual([full.width, full.height], [1600, 1000]);
    assert.deepEqual([small.width, small.height], [800, 500], 'four hundred thousand pixels of a panel of 1600 by 1000');
    assert.deepEqual([...bounded.renderer.state.canvas], [800, 500]);
    // The same picture with a quarter of the pixels: every part of it has the colour the whole one has there.
    for (const [x0, y0] of [[0.1, 0.05], [0.4, 0.45], [0.55, 0.6], [0.2, 0.8]] as const) {
      const a = region(full, x0, y0, x0 + 0.1, y0 + 0.1).mean, b = region(small, x0, y0, x0 + 0.1, y0 + 0.1).mean;
      assert.ok(a.every((c, i) => Math.abs(c - b[i]!) < 6), `at ${x0} ${y0}: ${a.map(Math.round).join(' ')} against ${b.map(Math.round).join(' ')}`);
    }
    // A pixel holds 12 bytes at the least, the lit picture and its depth, and 56 with four samples (7.5 rule 13):
    // the panel's 1.2 million pixels that are not drawn hold at least that much less. A software adapter draws
    // without samples, which a margin of 50 MiB took for granted.
    const saved = whole.renderer.state.reservedBytes - bounded.renderer.state.reservedBytes;
    assert.ok(saved >= 0.9 * (1600 * 1000 - 800 * 500) * 12, `what is held by the pixel is held for the pixels there are: ${saved} bytes less`);
    // A pick is asked in CSS pixels of the panel (7.5): the same pixel finds the same place.
    for (const [x, y] of [[800, 520], [640, 600], [1000, 470]] as const) {
      const a = await whole.session.viewport.pick(x, y), b = await bounded.session.viewport.pick(x, y);
      assert.ok(a !== null && b !== null && Math.abs(a.uv[0] - b.uv[0]) < 1e-6 && Math.abs(a.uv[1] - b.uv[1]) < 1e-6, `${JSON.stringify(a)} against ${JSON.stringify(b)}`);
    }
    // A panel that grows is still bounded; one that fits is drawn pixel for pixel.
    bounded.resize({ width: 3200, height: 800, dpr: 2 });
    const wide = await bounded.picture();
    assert.ok(wide.width * wide.height <= 404_000 && Math.abs(wide.width / wide.height - 4) < 0.02, `${wide.width} × ${wide.height}`);
    bounded.resize({ width: 500, height: 400, dpr: 1 });
    const fits = await bounded.picture();
    assert.deepEqual([fits.width, fits.height], [500, 400]);
  } finally {
    await whole.dispose();
    await bounded.dispose();
  }
});

test('the top view shows the field as its image: texel (0, 0) at the top left, +X to the right, +Y down the screen', async () => {
  await withView(async (rig) => {
    rig.setCamera(TOP);
    rig.setDisplay({ verticalScale: 1, showSea: false, sunAzimuth: 225, sunElevation: 35, topStyle: 'grey' });
    for (const [angle, axis] of [[0, 'x'], [90, 'y']] as const) {
      const doc = makeDoc({ range: { type: 'generate/gradient', params: { angle } } }, { height: HEIGHT });
      await rig.show(doc);
      const field = await readField(rig.gpu, doc, HEIGHT, 505);
      const picture = await rig.picture();
      await writePicture(`renderer-top-gradient-${angle}`, picture);
      // The canvas shows the terrain exactly: a pixel's grey is the height at its uv.
      for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5], [0.3, 0.7]] as const) {
        const grey = pixel(picture, fx, fy);
        const u = (Math.floor(fx * 800) + 0.5) / 800, v = (Math.floor(fy * 800) + 0.5) / 800;
        const expected = Math.min(1, Math.max(0, sample(field, u, v))) * 255;
        assert.ok(grey.every((c) => Math.abs(c - expected) <= STEP), `angle ${angle}, at ${fx} ${fy}: ${grey.join(' ')} for a height of ${expected / 255}`);
      }
      const low = pixel(picture, axis === 'x' ? 0.1 : 0.5, axis === 'y' ? 0.1 : 0.5)[0], high = pixel(picture, axis === 'x' ? 0.9 : 0.5, axis === 'y' ? 0.9 : 0.5)[0];
      assert.ok(high > low + 100, `a ramp along +${axis.toUpperCase()} rises ${axis === 'x' ? 'to the right' : 'down the screen'}: ${low} to ${high}`);
    }
    // Zoomed out, the terrain is a square in the middle and the panel's colour around it.
    rig.setCamera({ kind: 'top', center: [0.5, 0.5], span: 2 });
    const far = await rig.picture();
    assert.deepEqual(pixel(far, 0.1, 0.5), [BACKGROUND, BACKGROUND, BACKGROUND]);
    assert.ok(pixel(far, 0.5, 0.7)[0] > 100);
  }, SQUARE);
});

test('pick: the point under a pixel is the field\'s own, in the top view and in the 3D view, and beside the terrain there is none', async () => {
  await withView(async (rig) => {
    const settings = { terrainSize: 4032, heightRange: 1008 };
    const doc = makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }, { ...settings, buildResolution: 1009, previewLevel: 0 });
    await rig.show(doc);
    const field = await readField(rig.gpu, doc, HEIGHT, 1009);
    const { viewport } = rig.session;

    // The top view: a pixel's uv is known exactly.
    const top = { kind: 'top', center: [0.45, 0.55], span: 1.2 } as const;
    rig.setCamera(top);
    for (const [x, y] of [[800, 500], [400, 300], [1000, 700], [640, 420.5]] as const) {
      const u = top.center[0] + (x / 1600 - 0.5) * top.span, v = top.center[1] + (y / 1000 - 0.5) * top.span * (1000 / 1600);
      const hit = await viewport.pick(x, y);
      assert.ok(hit !== null, `the pixel ${x} ${y} is on the terrain`);
      assert.ok(Math.abs(hit.uv[0] - u) < 1e-5 && Math.abs(hit.uv[1] - v) < 1e-5, `uv ${hit.uv.join(' ')} for ${u} ${v}`);
      assert.ok(Math.abs(hit.height - sample(field, u, v)) < 1e-5, `height ${hit.height} for ${sample(field, u, v)}`);
      assert.ok(Math.abs(hit.position[0] - u * 4032) < 0.05 && Math.abs(hit.position[1] - v * 4032) < 0.05 && Math.abs(hit.position[2] - sample(field, u, v) * 1008) < 0.01, 'the position is in metres');
    }
    assert.equal(await viewport.pick(20, 500), null, 'left of the terrain');
    assert.equal(await viewport.pick(-5, 500), null, 'off the canvas');

    // The 3D view: what a pick returns is where the pixel's ray first meets the field. The point lies on the
    // field, it is drawn at that pixel, and nothing of the field stands in the ray's way before it.
    const camera = { kind: 'orbit', target: [2016, 2016, 250], yaw: 300, pitch: 35, distance: 7000, fovY: 35 } as const;
    rig.setCamera(camera);
    const first = async (x: number, y: number, verticalScale: number): Promise<void> => {
      const view = viewOf(camera, SIZE);
      const hit = await viewport.pick(x, y);
      assert.ok(hit !== null, `the pixel ${x} ${y} shows terrain`);
      const height = sample(field, hit.uv[0], hit.uv[1]);
      assert.ok(Math.abs(hit.height - height) < 1e-4, `height ${hit.height} at ${hit.uv.join(' ')}, where the field has ${height}`);
      assert.ok(Math.abs(hit.position[0] - hit.uv[0] * 4032) < 0.01 && Math.abs(hit.position[2] - hit.height * 1008) < 0.01, 'the position is in metres, at the terrain\'s own height');
      const drawn: [number, number, number] = [hit.position[0], hit.position[1], hit.height * 1008 * verticalScale];
      const at = project(view, SIZE, drawn, 4032)!;
      assert.ok(Math.hypot(at.x - x, at.y - y) < 0.75, `the point is drawn at ${at.x} ${at.y}, not at ${x} ${y}`);
      const ray = pixelRay(view, SIZE, x, y, 4032);
      const reach = Math.hypot(drawn[0] - ray.origin[0], drawn[1] - ray.origin[1], drawn[2] - ray.origin[2]);
      for (let t = 0; t < reach - 8; t += 2) {
        const p = ray.origin.map((o, i) => o + t * ray.direction[i]!);
        if (p[0]! < 0 || p[1]! < 0 || p[0]! > 4032 || p[1]! > 4032) continue;
        const ground = sample(field, p[0]! / 4032, p[1]! / 4032) * 1008 * verticalScale;
        assert.ok(p[2]! > ground - 0.5, `the ray of ${x} ${y} is under the ground ${Math.round(reach - t)} m before its hit`);
      }
    };
    for (const [x, y] of [[800, 500], [600, 450], [1000, 600], [700, 640], [880, 380]] as const) await first(x, y, 1);
    // The vertical scale is the display's: the picture changes, the readout stays the terrain's.
    rig.setDisplay({ verticalScale: 2.5, showSea: true, sunAzimuth: 225, sunElevation: 35 });
    for (const [x, y] of [[800, 500], [600, 450], [880, 300]] as const) await first(x, y, 2.5);
    assert.equal(await viewport.pick(40, 30), null, 'the sky');
  });
});

test('pick at the ends of the settings\' ranges: a terrain metres high, a thousand kilometres wide or a hundred kilometres high is read as exactly', async () => {
  await withView(async (rig) => {
    const { viewport } = rig.session;
    for (const [terrainSize, heightRange] of [[80, 20], [4032, 1], [1_000_000, 1], [1, 100_000]] as const) {
      const doc = makeDoc({ range: { type: 'generate/mountain-range' } }, { height: HEIGHT }, { terrainSize, heightRange, buildResolution: 1009, previewLevel: 1 });
      await rig.show(doc);
      const field = await readField(rig.gpu, doc, HEIGHT, 505);
      const what = `a terrain ${terrainSize} m wide and ${heightRange} m high`;

      // From above: the eye of the top view is as far away as an eye can be.
      const top = { kind: 'top', center: [0.5, 0.5], span: 1.25 } as const;
      rig.setCamera(top);
      for (const [x, y] of [[800, 500], [520, 380], [1010, 660]] as const) {
        const u = top.center[0] + (x / 1600 - 0.5) * top.span, v = top.center[1] + (y / 1000 - 0.5) * top.span * (1000 / 1600);
        const hit = await viewport.pick(x, y);
        assert.ok(hit !== null, `${what}: the pixel ${x} ${y} of the top view is on it`);
        assert.ok(Math.abs(hit.uv[0] - u) < 1e-5 && Math.abs(hit.uv[1] - v) < 1e-5 && Math.abs(hit.height - sample(field, u, v)) < 1e-5, `${what}: ${JSON.stringify(hit)} for ${u} ${v}`);
        assert.ok(Math.abs(hit.position[2] - hit.height * heightRange) <= 1e-6 * heightRange && Math.abs(hit.position[0] - u * terrainSize) <= 1e-4 * terrainSize);
      }

      // In the 3D view, from a camera that sees the whole of it: the point lies on the field and is drawn at the pixel.
      const reach = Math.max(terrainSize, heightRange);
      const camera = { kind: 'orbit', target: [terrainSize / 2, terrainSize / 2, heightRange * 0.2], yaw: 300, pitch: 40, distance: 2.4 * reach, fovY: 35 } as const;
      rig.setCamera(camera);
      const view = viewOf(camera, SIZE);
      let found = 0;
      for (const [x, y] of [[800, 500], [760, 540], [840, 470], [800, 600]] as const) {
        const hit = await viewport.pick(x, y);
        if (!hit) continue;
        found++;
        assert.ok(Math.abs(hit.height - sample(field, hit.uv[0], hit.uv[1])) < 1e-4, `${what}: height ${hit.height} at ${hit.uv.join(' ')}`);
        const at = project(view, SIZE, [hit.position[0], hit.position[1], hit.height * heightRange], terrainSize)!;
        assert.ok(Math.hypot(at.x - x, at.y - y) < 1, `${what}: the point is drawn at ${at.x} ${at.y}, not at ${x} ${y}`);
      }
      // A needle a metre wide is under few pixels; every other terrain is under the middle of its picture.
      assert.ok(found >= (terrainSize < heightRange ? 0 : 3), `${what}: ${found} of 4 pixels found it`);
    }
  });
});

test('overlays: a colour is draped as it is, a mask tints, and a data field is drawn between its own lowest and highest value', async () => {
  await withView(async (rig) => {
    const nodes = {
      range: { type: 'generate/mountain-range' },
      blue: { type: 'color/constant', params: { color: [0.2, 0.4, 0.8] } },
      high: { type: 'select/height', inputs: { in: 'range.out' }, params: { heightMin: 0.3, heightMax: 2, feather: 0 } },
    };
    const view = (overlay?: object) => makeDoc(nodes, { height: HEIGHT, ...(overlay ? { overlay: overlay as never } : {}) }, { buildResolution: 1009, previewLevel: 1 });
    rig.setCamera(TOP);
    rig.setDisplay({ verticalScale: 1, showSea: false, sunAzimuth: 225, sunElevation: 35, topStyle: 'overlay', palette: 'grey' });

    // A colour, alone: linear (0.2, 0.4, 0.8) is sRGB (124, 170, 231).
    await rig.show(view({ ref: { node: 'blue', port: 'out' }, as: 'color', opacity: 1 }));
    const colour = region(await rig.picture(), 0.05, 0.05, 0.95, 0.95);
    assert.ok([124, 170, 231].every((c, i) => Math.abs(colour.mean[i]! - c) <= STEP) && colour.spread <= 2 * STEP, `${colour.mean.join(' ')}`);

    // A mask, as the image it is: white where the terrain is above the threshold, black on the plain.
    const masked = view({ ref: { node: 'high', port: 'out' }, as: 'mask', opacity: 1 });
    await rig.show(masked);
    const heights = await readField(rig.gpu, masked, HEIGHT, 505);
    const mask = await rig.picture();
    let summit = 0;
    for (let i = 1; i < heights.data.length; i++) if (heights.data[i]! > heights.data[summit]!) summit = i;
    assert.ok(pixel(mask, (summit % 505) / 504, Math.floor(summit / 505) / 504)[0] > 250, 'the summit is in the mask');
    assert.ok(pixel(mask, 0.03, 0.03)[0] < 5, 'the plain is not');

    // The same mask as a tint over the lit terrain, in the palette chosen.
    rig.setDisplay({ verticalScale: 1, showSea: false, sunAzimuth: 225, sunElevation: 35, topStyle: 'hillshade', palette: 'red' });
    const tinted = await rig.picture();
    await writePicture('renderer-top-mask', tinted);
    await rig.show(view());
    const plain = await rig.picture();
    const at = [(summit % 505) / 504, Math.floor(summit / 505) / 504] as const;
    const red = pixel(tinted, ...at), grey = pixel(plain, ...at);
    assert.ok(red[0] > red[2] + 40 && Math.abs(grey[0] - grey[2]) < 12, `red over the summit: ${red.join(' ')} against ${grey.join(' ')}`);
    assert.ok(difference(tinted, plain) > 0.5 && pixel(tinted, 0.03, 0.03).every((c, i) => Math.abs(c - pixel(plain, 0.03, 0.03)[i]!) <= STEP), 'and nothing where the mask is 0');

    // A data field: the range is the field's own, found on the GPU.
    const data = view({ ref: HEIGHT, as: 'heat', opacity: 1 });
    await rig.show(data);
    let lo = Infinity, hi = -Infinity;
    for (const v of heights.data) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const range = rig.renderer.state.overlayRange;
    assert.ok(Math.abs(range[0] - lo) < 1e-6 && Math.abs(range[1] - hi) < 1e-6, `the range ${range.join(' .. ')} of a field from ${lo} to ${hi}`);
    rig.setDisplay({ verticalScale: 1, showSea: false, sunAzimuth: 225, sunElevation: 35, topStyle: 'overlay', palette: 'grey' });
    const heat = await rig.picture();
    assert.ok(pixel(heat, ...at)[0] > 250 && pixel(heat, 0.03, 0.03)[0] < 5, 'the highest value is the palette\'s end, the lowest its beginning');
  }, SQUARE);
});

test('the display: the sun, the vertical scale, the shading and the sea each change the picture, and only what they name', async () => {
  await withView(async (rig) => {
    const island = makeDoc({ island: { type: 'generate/island' } }, { height: { node: 'island', port: 'out' } }, { seaLevel: 0.25 });
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 250], yaw: 300, pitch: 28, distance: 6500, fovY: 35 });
    const display = { verticalScale: 1, showSea: true, sunAzimuth: 225, sunElevation: 35 };
    rig.setDisplay(display);
    await rig.show(island);
    const first = await rig.picture();
    await writePicture('renderer-island', first);
    const sea = pixel(first, 0.3, 0.55);
    assert.ok(sea[2] > sea[0] + 30, `the sea is blue: ${sea.join(' ')}`);

    rig.setDisplay({ ...display, showSea: false });
    const dry = await rig.picture();
    const bed = pixel(dry, 0.3, 0.55);
    assert.ok(bed[2] < bed[0] + 25, `without the sea its bed is ground: ${bed.join(' ')}`);

    rig.setDisplay({ ...display, sunAzimuth: 45 });
    const turned = await rig.picture();
    assert.ok(difference(turned, first) > 1.5, 'the sun from the other side lights the other slopes');
    rig.setDisplay({ ...display, sunElevation: 6 });
    const evening = await rig.picture();
    await writePicture('renderer-island-evening', evening);
    const horizon = region(evening, 0, 0, 1, 0.05);
    assert.ok(difference(evening, first) > 3);
    assert.ok(Number.isFinite(horizon.mean[0]));

    rig.setDisplay({ ...display, verticalScale: 2 });
    const tall = await rig.picture();
    assert.ok(difference(tall, first) > 1, 'twice as high is another picture');
    rig.setDisplay({ ...display, shading: 'clay' });
    const clay = await rig.picture();
    const land = region(clay, 0.42, 0.5, 0.5, 0.56);
    assert.ok(Math.abs(land.mean[0] - land.mean[1]) < 14, `clay has no colour of its own: ${land.mean.map(Math.round).join(' ')}`);
    rig.setDisplay(display);
    assert.ok(difference(await rig.picture(), first) < 0.05, 'the first options give the first picture');
  });
});

test('the rim of a terrain that stands above the sea is the dark cut of the slab: no bright or sea-coloured line runs along it', async () => {
  await withView(async (rig) => {
    // Noise lifted above the sea: every edge of the slab is a cut through ground, some hundred metres above the water.
    const doc = makeDoc({
      noise: { type: 'generate/fractal-noise' },
      lifted: { type: 'adjust/levels', params: { outMin: 0.25, outMax: 0.9 }, inputs: { in: 'noise.out' } },
    }, { height: { node: 'lifted', port: 'out' } }, { seaLevel: 0 });
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 400], yaw: 300, pitch: 14, distance: 7000, fovY: 35 });
    /** Pixels no lit ground, no sky away from the sun and no cut can be: all but white, or the sea's blue-green. */
    const strange = (picture: Awaited<ReturnType<typeof rig.picture>>): { glowing: number; sea: number } => {
      let glowing = 0, sea = 0;
      // The lower three quarters: the slab and the ground before it, without the sky's bright horizon.
      for (let y = Math.floor(picture.height * 0.25); y < picture.height; y++) {
        for (let x = 0; x < picture.width; x++) {
          const at = (y * picture.width + x) * 4;
          const [r, g, b] = [picture.rgba[at]!, picture.rgba[at + 1]!, picture.rgba[at + 2]!];
          if (r > 235 && g > 235 && b > 235) glowing++;
          if (g > r + 50 && b > r + 50) sea++;
        }
      }
      return { glowing, sea };
    };
    for (const showSea of [true, false]) {
      rig.setDisplay({ verticalScale: 1, showSea, sunAzimuth: 195, sunElevation: 38 });
      await rig.show(doc);
      const picture = await rig.picture();
      if (showSea) await writePicture('renderer-rim-above-the-sea', picture);
      assert.deepEqual(strange(picture), { glowing: 0, sea: 0 }, `with the sea ${showSea ? 'shown' : 'hidden'}`);
    }
  });
});

test('the normals are the terrain\'s slopes in metres: a ramp is shaded by its physical slope, the display\'s vertical scale and the sun\'s direction', async () => {
  await withView(async (rig) => {
    rig.setCamera(TOP);
    const encode = (linear: number): number => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
    // The shaded relief of the top view (shaders.ts fsTop): grey ground of albedo 0.4 under the sun, no shadow, and no occlusion on a plane.
    const shaded = (slope: number, azimuth: number, elevation: number): number => {
      const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
      // The ramp rises along +X: its normal is (-slope, 0, 1), normalised; the sun stands at (cos e cos a, cos e sin a, sin e).
      const facing = Math.max(0, (-slope * Math.cos(e) * Math.cos(a) + Math.sin(e)) / Math.hypot(slope, 1));
      return encode(Math.min(1, 0.4 * (0.22 + 1.05 * facing)));
    };
    for (const [terrainSize, heightRange] of [[4032, 1008], [1008, 1008], [8000, 400]] as const) {
      await rig.show(makeDoc({ range: { type: 'generate/gradient', params: { angle: 0 } } }, { height: HEIGHT }, { terrainSize, heightRange, buildResolution: 1009, previewLevel: 0 }));
      for (const [verticalScale, sunAzimuth, sunElevation] of [[1, 0, 35], [1, 180, 35], [2, 180, 35], [0.5, 0, 60], [1, 90, 20]] as const) {
        rig.setDisplay({ verticalScale, showSea: false, sunAzimuth, sunElevation, topStyle: 'hillshade' });
        const middle = region(await rig.picture(), 0.4, 0.4, 0.6, 0.6);
        const expected = shaded((heightRange * verticalScale) / terrainSize, sunAzimuth, sunElevation);
        assert.ok(middle.mean.every((c) => Math.abs(c - expected) <= STEP) && middle.spread <= 2 * STEP,
          `${heightRange} m over ${terrainSize} m at a scale of ${verticalScale}, sun ${sunAzimuth}/${sunElevation}: ${middle.mean.map((c) => c.toFixed(1)).join(' ')} for ${expected.toFixed(1)}`);
      }
    }
  }, SQUARE);
});

test('a mountain casts its shadow away from the sun, by the directions of engine.md 1.8, and a high sun casts none on the plain', async () => {
  await withView(async (rig) => {
    // One massif in the middle of level ground, 907 m high; the ground 900 m from the summit is level and bare.
    const doc = makeDoc({ range: { type: 'generate/mountain', params: { size: 0.3 } } }, { height: HEIGHT }, { buildResolution: 1009, previewLevel: 0 });
    const camera = { kind: 'orbit', target: [2016, 2016, 0], yaw: 270, pitch: 89.9, distance: 9000, fovY: 35 } as const;
    rig.setCamera(camera);
    const view = viewOf(camera, SIZE);
    /** How bright the ground is drawn about a point of the plain, given by its uv. */
    const ground = (picture: Awaited<ReturnType<ViewRig['picture']>>, u: number, v: number): number => {
      const at = project(view, SIZE, [u * 4032, v * 4032, 0], 4032)!;
      const mean = region(picture, (at.x - 6) / 1600, (at.y - 6) / 1000, (at.x + 6) / 1600, (at.y + 6) / 1000).mean;
      return (mean[0] + mean[1] + mean[2]) / 3;
    };
    const sun = (sunAzimuth: number, sunElevation: number) => ({ verticalScale: 1, showSea: false, sunAzimuth, sunElevation, shading: 'clay' as const });

    // The azimuth is the direction towards the sun: 0 is +X, 90 is +Y (1.8). The shadow falls the other way.
    rig.setDisplay(sun(0, 20));
    await rig.show(doc);
    const east = await rig.picture();
    await writePicture('renderer-shadow-sun-at-plus-x', east);
    assert.ok(ground(east, 0.72, 0.5) > 1.6 * ground(east, 0.28, 0.5), `the sun stands towards +X: the plain at -X is in the mountain's shadow (${ground(east, 0.28, 0.5)} against ${ground(east, 0.72, 0.5)})`);
    assert.ok(Math.abs(ground(east, 0.5, 0.28) - ground(east, 0.5, 0.72)) < 0.1 * ground(east, 0.72, 0.5), 'and the plain to either side of that line is lit alike');

    rig.setDisplay(sun(90, 20));
    const south = await rig.picture();
    assert.ok(ground(south, 0.5, 0.72) > 1.6 * ground(south, 0.5, 0.28), `the sun stands towards +Y: the shadow lies at -Y (${ground(south, 0.5, 0.28)} against ${ground(south, 0.5, 0.72)})`);
    assert.ok(Math.abs(ground(south, 0.28, 0.5) - ground(south, 0.72, 0.5)) < 0.1 * ground(south, 0.5, 0.72));

    // A sun at 70 degrees: a shadow 330 m long does not reach ground 900 m away.
    rig.setDisplay(sun(0, 70));
    const noon = await rig.picture();
    assert.ok(Math.abs(ground(noon, 0.28, 0.5) - ground(noon, 0.72, 0.5)) < 0.06 * ground(noon, 0.72, 0.5), `no shadow on either side: ${ground(noon, 0.28, 0.5)} and ${ground(noon, 0.72, 0.5)}`);
  });
});

test('the light maps are refined over frames of their own, and then nothing more is drawn', async () => {
  await withView(async (rig) => {
    rig.setCamera({ kind: 'orbit', target: [1008, 1008, 100], yaw: 300, pitch: 30, distance: 3200, fovY: 35 });
    const before = rig.renderer.state.frames;
    await rig.show(rangeDoc(2017));
    const state = rig.renderer.state;
    assert.equal(state.lightSize, 2048);
    assert.ok(state.frames - before >= 3, `the first frame shows the coarse maps, later ones the full grid: ${state.frames - before} frames`);
    const settled = await rig.picture();
    // A change of the sun is answered in the next frame and refined after it.
    const frames = rig.renderer.state.frames;
    rig.setDisplay({ verticalScale: 1, showSea: true, sunAzimuth: 100, sunElevation: 20 });
    const lit = await rig.picture();
    assert.ok(rig.renderer.state.frames - frames >= 2);
    assert.ok(difference(lit, settled) > 1);
    const done = rig.renderer.state.frames;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rig.renderer.state.frames, done);
    assert.ok(rig.renderer.state.reservedBytes < 400 * 2 ** 20, `the renderer holds ${Math.round(rig.renderer.state.reservedBytes / 2 ** 20)} MB for a field of 2017`);
  });
});

test('the share of a frame that refines the light maps follows the device: by its clock where it has one, by the wall clock where it has none; the maps are the same', async (t) => {
  const camera = { kind: 'orbit', target: [1008, 1008, 100], yaw: 300, pitch: 30, distance: 3200, fovY: 35 } as const;
  const drawn = async (timeBakes: boolean): Promise<{ picture: Awaited<ReturnType<ViewRig['picture']>>; loads: number }> => {
    const rig = await startView({ renderer: { timeBakes } });
    try {
      rig.setCamera(camera);
      await rig.show(rangeDoc(2017));
      // The sun moves a few times: the frames that refine are timed, and the share of the next follows.
      for (const sunAzimuth of [100, 140, 180, 195]) {
        rig.setDisplay({ verticalScale: 1, showSea: true, sunAzimuth, sunElevation: 38 });
        await rig.picture();
      }
      return { picture: await rig.picture(), loads: rig.renderer.state.bakeLoads };
    } finally {
      await rig.dispose();
    }
  };
  // Without the device's clock the share begins at BAKE_LOADS_PER_FRAME and is set by the time the frames took by
  // the wall clock (lighting.ts nextBakeLoads, held in tests/ui/viewport/unit/display.test.ts): wherever that
  // leaves it on this machine, it is within its bounds.
  const plain = await drawn(false);
  assert.ok(plain.loads >= BAKE_LOADS_MIN && plain.loads <= BAKE_LOADS_MAX, `${plain.loads} loads a frame without the clock`);
  const timed = await drawn(true);
  const gpu = await testGpu();
  t.diagnostic(`a frame may spend ${Math.round(plain.loads / 1e6)} M loads by the wall clock and ${Math.round(timed.loads / 1e6)} M ${gpu.caps.timestampQuery ? 'by the device\'s clock' : 'asked for the device\'s clock, which this device does not have (it runs under OROGEN_GPU_PROFILE=max)'}; it begins at ${Math.round(BAKE_LOADS_PER_FRAME / 1e6)} M`);
  assert.ok(timed.loads >= BAKE_LOADS_MIN && timed.loads <= BAKE_LOADS_MAX, `${timed.loads}`);
  assert.ok(difference(timed.picture, plain.picture) < 0.05, 'however the work is cut into frames, the maps are the same');
});

test('a draft during a gesture is shown as it comes and refined when the gesture ends; a node that fails leaves the last picture', async () => {
  await withView(async (rig) => {
    const doc = (height: number, view = HEIGHT) => makeDoc({
      range: { type: 'generate/mountain-range', params: { height } },
      missing: { type: 'io/import-field', params: { file: '/no/such/heights.png' } },
    }, { height: view }, { buildResolution: 2017, previewLevel: 1 });
    rig.setCamera({ kind: 'orbit', target: [2016, 2016, 250], yaw: 300, pitch: 30, distance: 6500, fovY: 35 });
    await rig.show(doc(1));
    const full = await rig.picture();
    assert.equal(rig.renderer.state.lightSize, 1024);

    // A gesture: the document changes, and a coarser level of the ladder is shown.
    rig.session.beginGesture();
    const from = rig.events.length;
    rig.session.setDocument(doc(0.5), 100);
    await rig.until(() => rig.events.slice(from).some((e) => e.type === 'view-updated' && e.revision === 100), 'the draft');
    const draft = rig.events.slice(from).find((e) => e.type === 'view-updated')!;
    assert.ok(draft.type === 'view-updated' && draft.draft && draft.resolution < 1009, `a draft at ${JSON.stringify(draft)}`);
    const coarse = await rig.picture();
    assert.ok(rig.renderer.state.lightSize < 1024, 'the light maps follow the size of what is shown');
    assert.ok(difference(coarse, full) > 0.3, 'half as high is another picture');
    rig.session.endGesture();
    await rig.until(() => rig.events.slice(from).some((e) => e.type === 'view-updated' && e.revision === 100 && !e.draft), 'the refinement');
    const refined = await rig.picture();
    assert.equal(rig.renderer.state.lightSize, 1024);
    assert.ok(difference(refined, coarse) < difference(refined, full) + 5);

    // The view names a node that fails: nothing new is shown, and what was on screen stays (7.3 rule 6).
    const frames = rig.renderer.state.frames;
    const failing = rig.events.length;
    rig.session.setDocument(doc(0.5, { node: 'missing', port: 'out' }), 101);
    await rig.until(() => rig.events.slice(failing).some((e) => e.type === 'eval-end'), 'the evaluation that fails');
    assert.ok(rig.events.slice(failing).some((e) => e.type === 'node-error' && e.error.nodeId === 'missing'));
    assert.equal(rig.events.slice(failing).some((e) => e.type === 'view-updated'), false);
    assert.ok(difference(await rig.picture(), refined) < 0.05, 'the last picture stays');
    assert.ok(rig.renderer.state.frames - frames <= 1);
  });
});

test('the GPU\'s end of a frame that never comes is nobody\'s unhandled rejection: a device whose process went answers so', async () => {
  // In Chromium `onSubmittedWorkDone` rejects when the GPU process has gone ("A valid external Instance reference
  // no longer exists"); Dawn in Node resolves it, so the rejection is put in the queue's place for one frame.
  const unhandled: unknown[] = [];
  const listen = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listen);
  const rig = await startView({ size: SQUARE });
  const queue = rig.gpu.device.queue as { onSubmittedWorkDone?: () => Promise<undefined> };
  try {
    await rig.show(rangeDoc());
    const frames = rig.renderer.state.frames;
    let rejected = 0;
    queue.onSubmittedWorkDone = () => {
      rejected++;
      return Promise.reject(new DOMException('A valid external Instance reference no longer exists.', 'OperationError'));
    };
    // One frame, and none after it that would look at the promise of this one.
    rig.setCamera({ kind: 'top', center: [0.4, 0.6], span: 0.8 });
    await rig.picture();
    assert.ok(rig.renderer.state.frames > frames, 'the new camera was drawn');
    // An unhandled rejection is told after the task it was left in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(rejected >= 1, 'the frame asked for the GPU\'s end of it');
    assert.deepEqual(unhandled.map(String), [], 'the renderer handles what it asked for');
  } finally {
    // The device is the process's own and serves the tests after this one.
    delete queue.onSubmittedWorkDone;
    process.off('unhandledRejection', listen);
    await rig.dispose();
  }
});
