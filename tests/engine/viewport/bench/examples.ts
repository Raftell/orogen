// Pictures of the six example projects as the renderer draws them, in Node, at 1600 by 1000: each with its colour
// output draped and with the default material alone, from the direction the panel frames a new project from, and
// one from near the ground. Not a test: a person looks at what it writes, beside what a terrain tool shows.
//
//   OROGEN_TEST_OUTPUT=test-output/<folder> tools/guard --mem=4G --timeout=1800 node tests/engine/viewport/bench/examples.ts [name ...] [--close] [--low] [--shore] [--top]
//
// The pictures are <OROGEN_TEST_OUTPUT>/viewport-engine/example-<name>-<what>.png.

import fs from 'node:fs';
import path from 'node:path';

import { parseDoc, type CameraState, type GraphDoc } from '../../../../src/core/runtime.ts';
import { frameOrbit } from '../../../../src/app/panels/viewport/model.ts';
import { DEFAULT_DISPLAY } from '../../../../src/viewport/index.ts';
import { REGISTRY, ROOT, startView } from '../rig.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const wanted = args.filter((arg) => !arg.startsWith('--'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/index.json'), 'utf8')) as { examples: { file: string }[] };
const names = index.examples.map((example) => example.file.replace(/\.orogen$/, '')).filter((name) => wanted.length === 0 || wanted.includes(name));

const rig = await startView({ budgetBytes: 3 * 2 ** 30 });
try {
  for (const name of names) {
    const { doc } = parseDoc(fs.readFileSync(path.join(ROOT, 'examples', `${name}.orogen`), 'utf8'), REGISTRY);
    const { terrainSize, heightRange, seaLevel } = doc.settings;
    const started = performance.now();
    await rig.show(doc);
    const range = rig.renderer.state.heightRange ?? [0, 0.5];
    const middle = (range[0] + range[1]) / 2;
    const whole: CameraState = frameOrbit({ terrainSize, heightRange }, 1, 1.6, { yaw: 300, pitch: 30 }, middle, seaLevel > range[0] ? seaLevel : null);
    rig.setDisplay(DEFAULT_DISPLAY);
    rig.setCamera(whole);
    console.log(`${name}: shown after ${Math.round(performance.now() - started)} ms, heights ${range[0].toFixed(3)} .. ${range[1].toFixed(3)}`);
    const draped = doc.ui.view?.overlay !== undefined;
    console.log(await rig.capture(`example-${name}-${draped ? 'color' : 'material'}`));
    // What a person sees who brings the camera down: the ground under the middle, from a few metres above it, and the horizon behind.
    rig.setCamera({ kind: 'top', center: [0.5, 0.5], span: 1.7 });
    const under = async (u: number, v: number): Promise<number> => {
      const hit = await rig.session.viewport.pick((0.5 + (u - 0.5) / 1.7) * 1600, (0.5 + ((v - 0.5) / 1.7) * 1.6) * 1000);
      return hit ? hit.position[2] : heightRange * middle;
    };
    const ground = await under(0.52, 0.5);
    const close: CameraState = { kind: 'orbit', target: [terrainSize * 0.52, terrainSize * 0.5, ground + 0.01 * terrainSize], yaw: 25, pitch: 16, distance: 0.09 * terrainSize, fovY: 35 };
    const low: CameraState = { kind: 'orbit', target: [terrainSize * 0.5, terrainSize * 0.5, heightRange * middle], yaw: 300, pitch: 7, distance: 1.25 * terrainSize, fovY: 35 };
    rig.setCamera(whole);
    const extra = async (kind: string): Promise<void> => {
      if (flags.has('--close')) {
        rig.setCamera(close);
        console.log(await rig.capture(`example-${name}-${kind}-close`));
      }
      if (flags.has('--low')) {
        rig.setCamera(low);
        console.log(await rig.capture(`example-${name}-${kind}-low`));
      }
      if (flags.has('--shore') && seaLevel > range[0]) {
        // Along the water's edge: where the sea is judged.
        rig.setCamera({ kind: 'orbit', target: [terrainSize * 0.52, terrainSize * 0.8, heightRange * seaLevel], yaw: 285, pitch: 12, distance: 0.22 * terrainSize, fovY: 35 });
        console.log(await rig.capture(`example-${name}-${kind}-shore`));
      }
    };
    await extra(draped ? 'color' : 'material');
    if (flags.has('--top')) {
      rig.setCamera({ kind: 'top', center: [0.5, 0.5], span: 1.7 });
      console.log(await rig.capture(`example-${name}-top`));
    }
    if (!draped) continue;
    const { overlay: _overlay, ...view } = doc.ui.view!;
    const plain: GraphDoc = { ...doc, ui: { ...doc.ui, view } };
    await rig.show(plain);
    rig.setCamera(whole);
    console.log(await rig.capture(`example-${name}-material`));
    await extra('material');
  }
} finally {
  await rig.dispose();
  rig.gpu.destroy();
}
process.exit(0);
