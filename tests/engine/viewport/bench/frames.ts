// Frame time and memory of the renderer in Node, on the process's device, for fields of 1009, 4033 and 8129:
// not a test. Each frame is drawn, submitted and waited for, so the time is what a frame costs the GPU and this
// thread together, without a display's refresh in between.
//
//   tools/guard --lock --mem=6G --timeout=1800 node tests/engine/viewport/bench/frames.ts [resolution ...] [--light=4096]

import type { CameraState } from '../../../../src/core/runtime.ts';
import { rangeDoc, startView } from '../rig.ts';

const resolutions = process.argv.slice(2).map(Number).filter((n) => n > 0);
// --light=4096: the light maps of a large card (lightCapFor), on whatever card this is.
const light = Number(process.argv.slice(2).find((arg) => arg.startsWith('--light='))?.slice(8) ?? 2048);
const FRAMES = 90;
const MIB = 2 ** 20;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const high = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;

for (const resolution of resolutions.length > 0 ? resolutions : [1009, 4033, 8129]) {
  const size = resolution - 1;
  const rig = await startView({ budgetBytes: 4.5 * 2 ** 30, renderer: { lightSize: light } });
  try {
    const started = performance.now();
    rig.setCamera({ kind: 'orbit', target: [size / 2, size / 2, size * 0.06], yaw: 300, pitch: 30, distance: 2 * size, fovY: 35 });
    await rig.show(rangeDoc(resolution));
    const shownMs = performance.now() - started;
    const views: Readonly<Record<string, (i: number) => CameraState>> = {
      'whole terrain': (i) => ({ kind: 'orbit', target: [size / 2, size / 2, size * 0.06], yaw: 300 + i * 2, pitch: 30, distance: 2 * size, fovY: 35 }),
      'half the terrain': (i) => ({ kind: 'orbit', target: [size / 2, size / 2, size * 0.08], yaw: 300 + i * 2, pitch: 25, distance: 0.7 * size, fovY: 35 }),
      'near the ground': (i) => ({ kind: 'orbit', target: [size / 2, size / 2, size * 0.1], yaw: 300 + i * 2, pitch: 12, distance: 0.12 * size, fovY: 35 }),
      'top view': (i) => ({ kind: 'top', center: [0.5 + 0.001 * i, 0.5], span: 1.7 }),
    };
    const memory = rig.engine.memory();
    console.log(`\n${resolution} × ${resolution}: shown after ${Math.round(shownMs)} ms; renderer ${Math.round(rig.renderer.state.reservedBytes / MIB)} MB, light maps ${rig.renderer.state.lightSize}; `
      + `engine: ${Math.round(memory.pinnedBytes / MIB)} MB pinned, ${Math.round(memory.cacheBytes / MIB)} MB cached, ${Math.round(memory.reservedBytes / MIB)} MB reserved of a budget of ${Math.round(memory.budgetBytes / MIB)} MB`);
    for (const [name, at] of Object.entries(views)) {
      const times: number[] = [];
      let triangles = 0;
      for (let i = 0; i < FRAMES; i++) {
        const t0 = performance.now();
        rig.setCamera(at(i));
        await rig.renderer.whenIdle();
        await rig.gpu.device.queue.onSubmittedWorkDone();
        times.push(performance.now() - t0);
        triangles = Math.max(triangles, rig.renderer.state.triangles);
      }
      console.log(`  ${name.padEnd(18)} median ${median(times).toFixed(2)} ms, 95th ${high(times).toFixed(2)} ms, up to ${Math.round(triangles / 1000)} k triangles`);
    }
    // The light maps: what the frame of a change costs (a pick is answered when that frame is drawn and the GPU has
    // done it), and how long the refinement over the following frames takes.
    rig.setCamera(views['whole terrain']!(0));
    await rig.renderer.whenIdle();
    const display = { verticalScale: 1, showSea: true, sunAzimuth: 195, sunElevation: 38 };
    const changes: Readonly<Record<string, (i: number) => typeof display>> = {
      'the sun moves': (i) => ({ ...display, sunAzimuth: 100 + 7 * i }),
      'the heights scale': (i) => ({ ...display, verticalScale: 1 + 0.05 * (i + 1) }),
      'the terrain changes': (i) => ({ ...display, showSea: i % 2 === 0 }),
    };
    for (const [name, change] of Object.entries(changes)) {
      const first: number[] = [], whole: number[] = [], frames: number[] = [];
      for (let i = 0; i < 8; i++) {
        const before = rig.renderer.state.frames;
        const t0 = performance.now();
        rig.setDisplay(change(i));
        await rig.session.viewport.pick(1, 1);
        first.push(performance.now() - t0);
        await rig.renderer.whenIdle();
        await rig.gpu.device.queue.onSubmittedWorkDone();
        whole.push(performance.now() - t0);
        frames.push(rig.renderer.state.frames - before);
      }
      console.log(`  ${name.padEnd(18)} first frame ${median(first).toFixed(1)} ms (worst ${Math.max(...first).toFixed(1)}), refined after ${median(whole).toFixed(0)} ms in ${median(frames)} frames; `
        + `${Math.round(rig.renderer.state.bakeLoads / 1e6)} M loads a frame`);
      if (process.env.OROGEN_BENCH_VERBOSE) console.log(`    first frames ${first.map((ms) => ms.toFixed(1)).join(' ')}; whole ${whole.map((ms) => ms.toFixed(0)).join(' ')}; frames ${frames.join(' ')}`);
    }
  } finally {
    await rig.dispose();
  }
}
