// A build at 4033 × 4033 from the application, of the alpine example, with the interface used while it runs.
// Not a test of a suite (its name ends in no .test.ts, as testing.md 8.1 asks of what no layer runs): it holds
// the GPU for about a minute and needs more memory than the guard's default allows. Run it by itself:
//
//   npm run build
//   tools/guard --lock --mem=6G --timeout=3600 node --test --test-concurrency=1 --test-timeout=3000000 tests/ui/shell/heavy/build-4033.ts
//
// What is measured (how long the build took, how long the page took to answer) is reported, not asserted: the
// assertions are that every input made during the build did what it does at any other time, and that the build
// is whole. Captures: test-output/ui/gate-build-4033/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { BuildResult } from '../../../../src/core/runtime.ts';
import type { AppDriver } from '../../../helpers/index.ts';
import {
  appears, boxOf, camera, capture as captureIn, closeMenu, docOf, graphDrag, graphHover, graphSettled, graphWheel, nodeBox, openMenu, OUTPUT, PAGE_BACKSTOP_MS, press, quote, selectNode,
  settled, showTab, start, text,
} from '../gate-rig.ts';

const SHOTS = 'gate-build-4033';
const FOLDER = path.join(OUTPUT, 'gate-build-4033');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });
fs.rmSync(path.join(OUTPUT, 'ui', SHOTS), { recursive: true, force: true });
const capture = (app: AppDriver, name: string): Promise<string> => captureIn(app, SHOTS, name);

/** The build of the alpine example at 4033 took 64 s with the command-line program on the GTX 1660 Ti. */
const BUILD_BACKSTOP_MS = 30 * 60_000;

const running = (app: AppDriver): Promise<boolean> => app.eval<boolean>(`orogenTest.ctx.engineState.getState().build.running`);
/** How long the page takes to come back to a task that waits for nothing. */
const lag = (app: AppDriver): Promise<number> => app.eval<number>(`new Promise((resolve) => { const from = performance.now(); setTimeout(() => resolve(performance.now() - from), 0); })`);

test('gate: the alpine example is built at 4033 from the application, and the interface answers while the build runs', async (t) => {
  const app = await start();
  try {
    await showTab(app, 'Library');
    await press(app, '[data-panel="library"] [data-tab="examples"]');
    await appears(app, '[data-library="examples"] [data-example="alpine-range"]');
    await press(app, '[data-library="examples"] [data-example="alpine-range"] [data-action="open"]');
    await app.waitFor(`Object.hasOwn(orogenTest.ctx.doc.getState().doc.nodes, 'hydraulic')`, PAGE_BACKSTOP_MS);
    await settled(app, 120_000);
    await graphSettled(app);
    assert.equal((await docOf(app)).settings.buildResolution, 4033);

    // Near enough to read, before the build: what is selected during it is found by its title.
    const block = await nodeBox(app, 'hydraulic');
    const over = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
    await graphHover(app, over);
    for (let tick = 0; tick < 12 && (await app.eval<string>(`graphTest.lod()`)) !== 'near'; tick++) await graphWheel(app, over, -120);
    await graphSettled(app);

    await showTab(app, 'Build');
    await appears(app, '[data-panel="build"] [data-build="panel"]');
    const out = path.join(FOLDER, 'alpine-4033');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)})`);
    await press(app, '[data-panel="build"] [data-command="build.chooseFolder"]');
    await app.waitFor(`document.querySelector('[data-build="folder"]')?.textContent === ${quote(out)}`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '[data-build="memory-field"]'), 'One field at this size is 62 MB');
    await capture(app, '01-before-the-build');

    // ---- the build begins ----
    const began = performance.now();
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    await app.waitFor(`orogenTest.ctx.engineState.getState().build.running`, PAGE_BACKSTOP_MS);

    // ---- and the interface is used while it runs: each round is one of the things a person does meanwhile ----
    const lags: number[] = [];
    const done: Record<string, number> = { tabs: 0, pan: 0, orbit: 0, menu: 0, select: 0, progress: 0 };
    const pane = await boxOf(app, '[data-graph="root"]');
    const size = await app.eval<{ width: number; height: number }>(`viewportTest.size()`);
    let shot = false;
    const rounds: (() => Promise<void>)[] = [
      // The tabs of the side column, each of which shows its panel.
      async () => {
        await showTab(app, 'Inspector');
        await appears(app, '[data-panel="inspector"] [data-inspector]');
        await showTab(app, 'Library');
        await appears(app, '[data-panel="library"] [data-library="root"]');
        await showTab(app, 'Build');
        // The build may end during a round: what is waited for is the panel, not that the build still runs.
        await appears(app, '[data-panel="build"] [data-build="status"]');
        done.tabs!++;
      },
      // The graph is panned, and the document has the new place a quarter of a second later.
      async () => {
        const held = (await docOf(app)).ui.graphViewport!;
        const from = { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.85 };
        await graphDrag(app, from, { x: from.x + 40, y: from.y }, { button: 1 }, 8);
        await app.waitFor(`Math.abs((orogenTest.ctx.doc.getState().doc.ui.graphViewport?.x ?? 0) - ${held.x + 40}) < 4`, PAGE_BACKSTOP_MS);
        await graphDrag(app, { x: from.x + 40, y: from.y }, from, { button: 1 }, 8);
        await app.waitFor(`Math.abs((orogenTest.ctx.doc.getState().doc.ui.graphViewport?.x ?? 0) - ${held.x}) < 4`, PAGE_BACKSTOP_MS);
        done.pan!++;
      },
      // The camera of the viewport turns: the picture is the last one, and it is still a picture to look at.
      async () => {
        const before = await camera(app);
        await app.eval(`void viewportTest.drag([${size.width / 2}, ${size.height / 2}], [${size.width / 2 + 60}, ${size.height / 2 + 10}], 0, {}, 6)`);
        const after = await camera(app);
        assert.ok(before.kind === 'orbit' && after.kind === 'orbit' && Math.abs(after.yaw - before.yaw) > 3, 'the camera turned during the build');
        await app.eval(`orogenTest.ctx.engine.viewport.pick(${Math.round(size.width / 2)}, ${Math.round(size.height / 2)})`);
        done.orbit!++;
      },
      // A menu opens with its items, of which Cancel Build can be chosen and Build cannot.
      async () => {
        const items = await openMenu(app, 'Engine');
        await closeMenu(app);
        const offered = items.filter((item) => item.id === 'build.start' || item.id === 'build.cancel').map((item) => `${item.id}:${item.enabled}`);
        // While it runs a build can be cancelled and not started; the round in which it ends may see either.
        if (await running(app)) assert.deepEqual(offered, ['build.start:false', 'build.cancel:true']);
        else assert.equal(offered.length, 2);
        done.menu!++;
      },
      // A node is selected, and the inspector shows it. (The view of a locked build stays: previews are paused.)
      async () => {
        const which = done.select! % 2 === 0 ? 'fluvial' : 'hydraulic';
        await selectNode(app, which);
        await showTab(app, 'Inspector');
        await app.waitFor(`document.querySelector('[data-panel="inspector"] [aria-label="Node title"]')?.value === ${quote(which === 'fluvial' ? 'Valleys' : 'Gullies and Fans')}`, PAGE_BACKSTOP_MS);
        // The view is behind the document while the build runs: the viewport and the status bar say it in one word.
        if (await running(app)) {
          await app.waitFor(`document.querySelector('[data-viewport="state"]')?.textContent === 'Out of date'`, PAGE_BACKSTOP_MS);
          assert.equal(await app.eval<string>(`document.querySelector('[data-status="view"]').textContent`), '1009 × 1009Out of date');
        }
        await showTab(app, 'Build');
        done.select!++;
      },
      // The build panel says where the build is: a stage that runs, and a line about what is left.
      async () => {
        const stages = await app.eval<string[]>(`[...document.querySelectorAll('[data-build="stages"] li')].map((stage) => stage.getAttribute('data-state') ?? stage.textContent)`);
        assert.ok(stages.length > 0, 'the panel lists the stages of the build');
        if (!shot && await running(app)) {
          shot = true;
          await capture(app, '02-during-the-build');
        }
        done.progress!++;
      },
    ];
    let round = 0;
    let inBuild = 0;
    while (await running(app)) {
      const duringBefore = await running(app);
      await rounds[round % rounds.length]!();
      lags.push(await lag(app));
      // Counted only when the build ran before and after the round: the input was made during the build.
      if (duringBefore && await running(app)) inBuild++;
      round++;
      assert.ok(performance.now() - began < BUILD_BACKSTOP_MS, 'the build ends');
    }
    const result = await app.eval<BuildResult>(`orogenTest.ctx.engineState.getState().build.result`);
    const took = performance.now() - began;

    // ---- the build is whole ----
    assert.equal(result.status, 'ok', JSON.stringify(result.problems));
    assert.equal(result.outDir, out);
    const held = fs.readdirSync(out).sort();
    assert.deepEqual(held, [...result.files.map((file) => file.path), result.report!].sort(), 'the folder holds the build and nothing else');
    for (const file of result.files) assert.equal(fs.statSync(path.join(out, file.path)).size, file.bytes, file.path);
    assert.equal(fs.statSync(path.join(out, 'AlpineHeight.r16')).size, 2 * 4033 * 4033);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, result.manifest!), 'utf8')) as { resolution: { x: number; y: number }; landscape: { layers: unknown[] } };
    assert.deepEqual([manifest.resolution.x, manifest.resolution.y, manifest.landscape.layers.length], [4033, 4033, 5]);

    // ---- every kind of input was made while the build ran, and each did what it does ----
    assert.ok(inBuild >= rounds.length, `at least one round of each kind was made during the build: ${inBuild} rounds`);
    const sorted = [...lags].sort((a, b) => a - b);
    t.diagnostic(`the build took ${(took / 1000).toFixed(1)} s for ${result.files.length} files, ${(result.files.reduce((sum, file) => sum + file.bytes, 0) / 2 ** 20).toFixed(0)} MB`);
    t.diagnostic(`${round} rounds of input, ${inBuild} of them wholly during the build: ${JSON.stringify(done)}`);
    t.diagnostic(`the page's lag after each round: median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, worst ${sorted[sorted.length - 1]!.toFixed(1)} ms`);

    // ---- and afterwards the previews are back ----
    await app.eval(`void [...document.querySelectorAll('[data-ui="notice"] [aria-label="Dismiss"]')].forEach((button) => shellTest.press(button))`);
    await settled(app, 300_000);
    assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished');
    assert.equal(await text(app, '[data-status="view"]'), '1009 × 1009');
    await capture(app, '03-after-the-build');
    await app.close();
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
});
