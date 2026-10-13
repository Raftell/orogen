// Pictures of every view of the renderer at 1600 by 1000, for a person to judge as pictures of terrain
// (testing.md 5.4): <OROGEN_TEST_OUTPUT>/viewport-engine/view-*.png. A test only holds that each is a picture:
// that something of the terrain is in it. Skipped on a software adapter (CI), where renderer.test.ts is what runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CameraState, ViewBinding } from '../../../src/core/runtime.ts';
import { DEFAULT_DISPLAY, type DisplayOptions } from '../../../src/viewport/index.ts';
import { makeDoc, region, startView, writePicture } from './rig.ts';

/** The display of a new session: its sun stands over the left shoulder of the cameras below. */
const SUN: DisplayOptions = { verticalScale: 1, showSea: true, sunAzimuth: DEFAULT_DISPLAY.sunAzimuth, sunElevation: DEFAULT_DISPLAY.sunElevation };
const SIZE = 4032;
const WHOLE: CameraState = { kind: 'orbit', target: [SIZE / 2, SIZE * 0.52, 170], yaw: 300, pitch: 27, distance: 1.42 * SIZE, fovY: 35 };
const TOP: CameraState = { kind: 'top', center: [0.5, 0.5], span: 1.7 };

const LAND = {
  range: { type: 'generate/mountain-range' },
  eroded: { type: 'simulate/hydraulic-erosion', inputs: { in: 'range.out' } },
  steep: { type: 'select/slope', inputs: { in: 'eroded.out' } },
  paint: { type: 'color/natural', inputs: { in: 'eroded.out' } },
  shelter: { type: 'select/occlusion', inputs: { in: 'eroded.out' } },
  island: { type: 'generate/island' },
  canyon: { type: 'generate/canyon' },
  dunes: { type: 'generate/dunes' },
  volcano: { type: 'generate/volcano' },
};
const view = (node: string, overlay?: ViewBinding['overlay'], settings: object = {}) =>
  makeDoc(LAND, { height: { node, port: 'out' }, ...(overlay ? { overlay } : {}) }, { buildResolution: 2017, previewLevel: 0, seaLevel: 0, ...settings });

test('pictures of every view, at 1600 by 1000', async (t) => {
  const rig = await startView();
  // The pictures are for a person, and are made where there is a GPU: an erosion of four million texels and
  // eighteen pictures of 1.6 million pixels are minutes of a CPU rasteriser, which shows nothing a GPU does not.
  if (rig.gpu.caps.software) {
    await rig.dispose();
    t.skip('pictures are made on a GPU');
    return;
  }
  const shots: [string, CameraState, DisplayOptions][] = [];
  const shoot = async (name: string, camera: CameraState, display: DisplayOptions): Promise<void> => {
    rig.setCamera(camera);
    rig.setDisplay(display);
    const picture = await rig.picture();
    assert.deepEqual([picture.width, picture.height], [1600, 1000]);
    assert.ok(region(picture, 0.25, 0.3, 0.75, 0.8).spread > 40, `${name} shows terrain`);
    t.diagnostic(await writePicture(`view-${name}`, picture));
    shots.push([name, camera, display]);
  };
  try {
    await rig.show(view('eroded'));
    await shoot('01-material', WHOLE, SUN);
    await shoot('02-clay', WHOLE, { ...SUN, shading: 'clay' });
    await shoot('03-low-sun', { ...WHOLE, yaw: 330, pitch: 14, target: [SIZE / 2, SIZE / 2, 200] }, { ...SUN, sunAzimuth: 200, sunElevation: 7 });
    await shoot('04-close', { kind: 'orbit', target: [SIZE * 0.5, SIZE * 0.5, 330], yaw: 20, pitch: 16, distance: 0.3 * SIZE, fovY: 35 }, SUN);
    await shoot('05-top-hillshade', TOP, SUN);
    await shoot('06-top-height', TOP, { ...SUN, topStyle: 'grey' });

    await rig.show(view('eroded', { ref: { node: 'paint', port: 'out' }, as: 'color', opacity: 1 }));
    await shoot('07-color-draped', WHOLE, SUN);
    await shoot('08-top-color', TOP, { ...SUN, topStyle: 'overlay' });
    await rig.show(view('eroded', { ref: { node: 'steep', port: 'out' }, as: 'mask', opacity: 0.85 }));
    await shoot('09-mask-red', WHOLE, SUN);
    await shoot('10-top-mask-blue', TOP, { ...SUN, palette: 'blue' });
    await rig.show(view('eroded', { ref: { node: 'shelter', port: 'out' }, as: 'heat', opacity: 1 }));
    await shoot('11-data-viridis', WHOLE, { ...SUN, palette: 'viridis', shading: 'clay' });
    await shoot('12-top-data-magma', TOP, { ...SUN, palette: 'magma', topStyle: 'overlay' });

    await rig.show(view('island', undefined, { seaLevel: 0.25 }));
    await shoot('13-island-sea', { ...WHOLE, target: [SIZE / 2, SIZE / 2, 300] }, SUN);
    await shoot('14-island-shore', { kind: 'orbit', target: [SIZE * 0.5, SIZE * 0.78, 250], yaw: 285, pitch: 14, distance: 0.42 * SIZE, fovY: 35 }, { ...SUN, sunAzimuth: 160, sunElevation: 24 });
    await shoot('15-top-island', TOP, SUN);
    await rig.show(view('canyon'));
    await shoot('16-canyon', { ...WHOLE, yaw: 240, pitch: 34 }, { ...SUN, sunAzimuth: 300, sunElevation: 28 });
    await rig.show(view('dunes'));
    await shoot('17-dunes-scaled', { ...WHOLE, pitch: 20, target: [SIZE / 2, SIZE / 2, 60] }, { ...SUN, sunElevation: 18, verticalScale: 2 });
    await rig.show(view('volcano'));
    await shoot('18-volcano', { ...WHOLE, yaw: 45 }, { ...SUN, sunAzimuth: 110 });
    assert.equal(shots.length, 18);
  } finally {
    await rig.dispose();
  }
});
