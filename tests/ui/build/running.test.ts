// A build that takes a while, watched and then cancelled midway (runtime.md 7.6, export-unreal.md 3.8, 3.9):
// while it runs the panel shows its stages and targets with their progress and time, offers Cancel in place of
// Build, and says that previews are paused; cancelled, it leaves nothing partial behind: the folder still holds
// the earlier build, byte for byte, and beside it lies the report of the cancelled build and nothing else.
//
// Captures, for a person: ui/build/running-01-progress, running-02-cancelled.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  appears, attr, build, buildState, built, capture, chooseFolder, dismissNotices, longRidge, press, scratch, text, texts, vanishes, withBuildPanel, writeProject,
  BUILD_BACKSTOP_MS, PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('running');
const OUT = path.join(FOLDER, 'out');
const STAGING = `${OUT}.partial`;

const { doc: DOC } = longRidge({ buildResolution: 241 });
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'ridge', DOC);

const hashes = (folder: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(folder).sort().map((name) => [name, createHash('sha1').update(fs.readFileSync(path.join(folder, name))).digest('hex')]));

interface Seen {
  readonly running: boolean;
  readonly line: string | null;
  readonly sub: string | null;
  readonly cancel: boolean;
  readonly start: boolean;
  readonly resolutionDisabled: boolean;
  readonly previews: string | null;
  readonly remaining: string | null;
  readonly stages: readonly (readonly [string, string, string, string])[];
  readonly targets: readonly (readonly [string, string])[];
  readonly planTitle: string | null;
  readonly planFiles: number;
  readonly sections: readonly string[];
}

/** What the panel shows, read in one go: the build goes on between two calls. */
const SEE = `(() => {
  const panel = document.querySelector('[data-panel="build"]');
  const q = (selector) => panel.querySelector(selector);
  const all = (selector) => [...panel.querySelectorAll(selector)];
  return {
    running: orogenTest.ctx.engineState.getState().build.running,
    line: q('[data-build="status-line"]')?.textContent ?? null,
    sub: q('[data-build="status-sub"]')?.textContent ?? null,
    cancel: q('[data-command="build.cancel"]') !== null && !q('[data-command="build.cancel"]').disabled,
    start: q('[data-command="build.start"]') !== null,
    resolutionDisabled: q('#build-resolution').hasAttribute('data-disabled') || q('#build-resolution').disabled === true,
    previews: q('[data-build-note="previews"]')?.textContent ?? null,
    remaining: q('[data-build="remaining"]')?.textContent ?? null,
    stages: all('[data-build-stage]').map((stage) => [stage.getAttribute('data-build-stage'), stage.getAttribute('data-state'),
      stage.querySelector('[data-build="stage-percent"]').textContent, stage.querySelector('[data-build="stage-time"]').textContent]),
    targets: all('[data-build-progress]').map((target) => [target.getAttribute('data-build-progress'), target.getAttribute('data-state')]),
    planTitle: q('[data-build-section="plan"] button')?.textContent ?? null,
    planFiles: all('[data-build-file]').length,
    sections: all('[data-build-section]').map((section) => section.getAttribute('data-build-section')),
  };
})()`;

test('a build at 4033 watched while it runs, and cancelled midway: nothing partial is left', async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    await chooseFolder(app, OUT);

    // ---- an earlier build, small, which the cancelled one must leave as it is ----
    const earlier = await build(app);
    assert.equal(earlier.status, 'ok', JSON.stringify(earlier.problems));
    const kept = hashes(OUT);
    assert.equal(Object.keys(kept).length, earlier.files.length + 1);

    // ---- the resolution of the long build, from the list ----
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="4033"]');
    await press(app, '[data-ui="select-list"] [data-value="4033"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 4033`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '[data-build="spacing"]'), '49.6 cm per vertex');
    assert.equal(await text(app, '[data-build="layout"]'), '32 × 32 components of 2 × 2 sections, 63 × 63 quads each');
    assert.equal(await text(app, '[data-build="memory-field"]'), 'One field at this size is 62 MB');

    // ---- the build starts, and is looked at when a target after the first is being written ----
    const before = (await buildState(app)).requestId;
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    await app.waitFor(`(() => {
      const build = orogenTest.ctx.engineState.getState().build;
      return build.requestId !== ${before} && (!build.running && build.result !== null || build.target !== null && build.target.index >= 1);
    })()`, BUILD_BACKSTOP_MS);
    const during = await app.eval<Seen>(SEE);
    assert.equal(during.running, true, 'the build is still running when its second target begins');
    assert.deepEqual([during.cancel, during.start], [true, false], 'Cancel stands where Build stood');
    assert.equal(during.resolutionDisabled, true, 'the settings of a build that runs are not changed under it');
    assert.equal(during.previews, 'Previews are paused while the build runs, and the viewport keeps its last picture. They resume when the build ends.');
    assert.ok(during.remaining !== null && during.remaining !== '', 'what is left is said, or that it is not known yet');
    assert.match(during.sub!, /^\d+(\.\d)? s so far/);
    // The plan of the running build stands right under its progress.
    assert.deepEqual(during.sections.slice(0, 2), ['run', 'plan']);
    assert.equal(during.planTitle, 'Planof the running build');
    assert.equal(during.planFiles, 15, 'two files for the landscape and each of four layers, two textures, two images, the manifest');
    // Stages: the plan is done, the files are under way, the weights and the commit wait.
    const stage = Object.fromEntries(during.stages.map(([id, state, percent, time]) => [id, { state, percent, time }]));
    assert.deepEqual(Object.keys(stage), ['plan', 'compute', 'export', 'weights', 'commit']);
    assert.equal(stage.plan!.state, 'done');
    assert.ok(['running', 'done'].includes(stage.compute!.state), stage.compute!.state);
    assert.equal(stage.export!.state, 'running');
    assert.deepEqual([stage.weights!.state, stage.commit!.state], ['waiting', 'waiting']);
    assert.match(stage.export!.percent, /^\d+ %$/);
    assert.match(stage.export!.time, /^\d+(\.\d)? s$/);
    // Targets: eight; those begun are done but the one being written, the others wait. The line counts those begun.
    assert.equal(during.targets.length, 8);
    const states = during.targets.map(([, state]) => state);
    const count = (state: string): number => states.filter((found) => found === state).length;
    assert.ok(count('done') >= 1 && count('running') <= 1 && count('waiting') >= 1, states.join(' '));
    assert.equal(count('done') + count('running') + count('waiting'), 8, states.join(' '));
    assert.deepEqual(states, [...states].sort((a, b) => ['done', 'running', 'waiting'].indexOf(a) - ['done', 'running', 'waiting'].indexOf(b)), 'in the order they are written');
    const begun = /^Building: target (\d) of 8$/.exec(during.line!);
    assert.ok(begun && Number(begun[1]) >= 2 && Number(begun[1]) >= count('done') + count('running'), during.line!);
    // Mod+B does nothing while a build runs.
    await app.eval(`void shellTest.key('KeyB', { ctrl: true })`);
    assert.equal(fs.existsSync(STAGING), true, 'the build writes beside the output folder');
    assert.deepEqual(hashes(OUT), kept, 'and the output folder is as it was while it does');

    // The picture is taken a few seconds later: of a build that still runs, on a machine that builds no faster than this.
    t.diagnostic(`capture: ${await capture(app, 'running-01-progress')}`);
    const later = await app.eval<Seen>(SEE);
    t.diagnostic(`after the capture, ${later.running ? 'still running' : 'no longer running'}: ${later.line}; ${later.sub}; ${later.remaining}; stages ${later.stages.map((entry) => entry.join(' ')).join(' | ')}`);
    // It is ended here whichever way: the next build is the one that is cancelled at a moment the events name.
    await app.eval(`void orogenTest.ctx.run('build.cancel')`);
    await built(app, before);

    // ---- a build cancelled midway: when its second target begins, one is written and six are not begun ----
    const untouched = hashes(OUT);
    const second = (await buildState(app)).requestId;
    await app.eval(`void (window.begun = 0, window.stopCancel = orogenTest.ctx.engine.subscribe((event) => {
      if (event.type !== 'build-target' || ++window.begun < 2) return;
      window.stopCancel();
      document.querySelector('[data-panel="build"] [data-command="build.cancel"]').click();
    }))`);
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    const cancelled = await built(app, second);
    assert.equal(await app.eval<number>(`window.begun`), 2);
    assert.equal(cancelled.status, 'aborted');
    assert.deepEqual([cancelled.files, cancelled.manifest, cancelled.outDir, cancelled.report], [[], null, STAGING, 'Ridge.report.json']);

    // Nothing partial: the folder holds what it held, byte for byte; beside it the report and nothing else.
    assert.deepEqual(hashes(OUT), untouched);
    assert.deepEqual(fs.readdirSync(STAGING), ['Ridge.report.json']);
    assert.equal(fs.existsSync(`${OUT}.previous`), false);
    assert.deepEqual(fs.readdirSync(FOLDER).sort(), ['out', 'out.partial', 'project']);
    const report = JSON.parse(fs.readFileSync(path.join(STAGING, 'Ridge.report.json'), 'utf8')) as { status: string; files: unknown[]; targets: { exportMs: number | null }[] };
    assert.deepEqual([report.status, report.files], ['aborted', []]);
    // The cancellation reaches the pipeline while a target is converted: at least the two that the events named were begun.
    const begunTargets = report.targets.filter((target) => target.exportMs !== null).length;
    assert.ok(begunTargets >= 2 && begunTargets < 8, `${begunTargets} targets were begun`);

    // And the panel says so.
    assert.equal(await text(app, '[data-build="status-line"]'), 'Build cancelled');
    assert.equal(await text(app, '[data-build="outcome"]'), 'Build cancelled');
    assert.equal(await text(app, '[data-build="written"]'), 'Nothing was written to the output folder.');
    assert.equal(await text(app, '[data-build="kept"]'), 'None of the 15 planned files was put in place: the folder holds what it held before. The report of this build lies in a folder beside it, which the next build removes.');
    assert.deepEqual(await texts(app, '[data-build-place]'), [`Output folder${OUT}`, `Report${path.join(STAGING, 'Ridge.report.json')}`]);
    const after = await app.eval<Seen>(SEE);
    assert.deepEqual([after.cancel, after.start, after.resolutionDisabled], [false, true, false]);
    assert.match(after.previews!, /^While a build runs, previews pause/);
    // Where it stopped: the plan was done, the files were under way, the weights and the commit were never reached.
    // Of the targets, those written are done, the one under way is stopped where it was, and the rest were not begun:
    // as many were begun as the report says.
    const stopped = Object.fromEntries(after.stages.map(([id, state]) => [id, state]));
    assert.deepEqual([stopped.plan, stopped.export, stopped.weights, stopped.commit], ['done', 'stopped', 'skipped', 'skipped']);
    // The targets that were never begun are a number, not a row each: what did not happen does not bury what did.
    const ended = after.targets.map(([, state]) => state);
    const of = (state: string): number => ended.filter((found) => found === state).length;
    assert.deepEqual(ended, [...Array<string>(of('done')).fill('done'), ...Array<string>(of('stopped')).fill('stopped')]);
    assert.deepEqual([ended.length, of('stopped')], [begunTargets, 1], ended.join(' '));
    assert.equal(await text(app, '[data-build="targets-unreached"]'), `${8 - begunTargets} targets were not reached`);
    assert.match((await text(app, '[data-build="status-sub"]'))!, /^after \d+(\.\d)? s$/, 'a build that was cancelled took the time until then');
    // The files that were written, the numbers for Unreal: none are shown for a build that wrote nothing.
    assert.deepEqual(after.sections.filter((section) => ['files', 'unreal'].includes(section)), []);
    assert.equal(await attr(app, '[data-build-section="run"] [data-command="build.revealFolder"]', 'disabled'), null, 'the report can be shown in its folder');
    assert.deepEqual(await texts(app, '[data-build="problems"] li'), [], 'a cancelled build has no problem to report');
    await dismissNotices(app);
    t.diagnostic(`capture: ${await capture(app, 'running-02-cancelled')}`);

    // Previews resume after a build, as the session does it: the view of the project is computed again.
    await app.waitFor(`(() => {
      const engine = orogenTest.ctx.engineState.getState();
      return engine.evaluation === null && engine.view !== null && engine.view.revision >= orogenTest.ctx.doc.getState().engineRevision;
    })()`, BUILD_BACKSTOP_MS);

    // ---- the next build removes what the cancelled one left ----
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="241"]');
    await press(app, '[data-ui="select-list"] [data-value="241"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 241`, PAGE_BACKSTOP_MS);
    const next = await build(app);
    assert.equal(next.status, 'ok', JSON.stringify(next.problems));
    assert.equal(fs.existsSync(STAGING), false);
    // The same project at the same resolution builds to the same bytes; the report holds times, and differs.
    const data = (files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith('.report.json')));
    assert.deepEqual(data(hashes(OUT)), data(kept), 'and it is the build that was there first');
  });
});
