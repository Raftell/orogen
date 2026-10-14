// The panel in the cases a build panel meets and a demonstration does not: a project with nothing in it, a project
// of three hundred nodes with names as long as their parameters take, input that comes faster than a build
// starts, an edit and its undo in the middle of a build, another project opened over the results of the last,
// and settings at their limits.
//
// Captures, for a person: ui/build/cases-01-empty, cases-02-crowded-exports, cases-03-crowded-refused,
// cases-04-crowded-built, cases-05-out-of-date, cases-06-custom-size.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { newDoc, serializeDoc } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  appears, attr, build, buildState, built, capture, chooseFolder, crowded, cut, dismissNotices, expectPlan, fit, LONG, PLAN_TITLE, planned, planOf, press, quote, ridge, run, scratch,
  scrollTo, setParamIn, shownPlan, text, texts,
  vanishes, withBuildPanel, writeProject, PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('cases');

const head = async (app: AppDriver): Promise<[string | null, string | null, string | null]> => [
  await text(app, '[data-build="status-line"]'),
  await app.eval<string | null>(`document.querySelector('[data-build="status-sub"]')?.textContent ?? null`),
  await attr(app, '[data-build="status-line"]', 'data-tone'),
];
const sections = (app: AppDriver): Promise<string[]> => app.eval<string[]>(`[...document.querySelectorAll('[data-build-section]')].map((section) => section.getAttribute('data-build-section'))`);
const enabled = (app: AppDriver, command: string): Promise<boolean> =>
  app.eval<boolean>(`!document.querySelector('[data-build="panel"] [data-command="${command}"]').disabled`);

test('a project with nothing in it: the panel says before a build that there is nothing to export, and a build of it writes nothing', async (t) => {
  const project = writeProject(path.join(FOLDER, 'empty-project'), 'empty', newDoc());
  const out = path.join(FOLDER, 'empty-out');
  await withBuildPanel(project, async (app) => {
    // Said where it is always in sight, and under the plan of the project as the problem the pipeline reports, in its words.
    await planned(app);
    const sentence = planOf(newDoc()).problems.find((problem) => problem.code === 'E_NOTHING_TO_EXPORT')!.message;
    assert.deepEqual(await head(app), ['Nothing to export', sentence, 'warning']);
    assert.deepEqual(await sections(app), ['settings', 'plan']);
    const nothing = await expectPlan(app, newDoc(), 'a project with nothing in it');
    assert.equal(
      nothing.problems[0]!.text,
      `Nothing to exportE_NOTHING_TO_EXPORT${sentence}A build writes only what export nodes declare. Add an export node from the Import and Export category of the library, connect it and switch it on: Unreal Landscape exports the terrain.`,
    );
    assert.equal(nothing.failed, 'This plan has an error, so a build would stop here, before it computes or writes anything.');
    // A plan of nothing lists no file: a build never writes a manifest alone.
    assert.deepEqual([nothing.targets, nothing.total, nothing.left], [[], null, []]);
    assert.equal(await text(app, '[data-build="memory-node"]'), 'No node is measured yet: the next preview measures them');
    t.diagnostic(`capture: ${await capture(app, 'cases-01-empty')}`);

    // Build is not held back: the pipeline is the judge of a plan, and says the same.
    await chooseFolder(app, out);
    const result = await build(app);
    assert.deepEqual([result.status, result.problems.map((problem) => problem.code), result.files, result.outDir], ['errors', ['E_NOTHING_TO_EXPORT'], [], null]);
    assert.deepEqual(await head(app), ['The build did not start', null, 'error']);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(`${out}.partial`), false);
    // The plan of a build of nothing lists no file: a build never writes a manifest alone.
    assert.equal(await text(app, '[data-build-section="plan"] > button'), 'Planof the last build');
    assert.equal(await text(app, '[data-build-note="plan-failed"]'), 'This plan has an error, so the build stopped here, before it computed or wrote anything.');
    assert.deepEqual([await texts(app, '[data-build-file]'), await texts(app, '[data-build-target]'), await texts(app, '[data-build="plan-total"]')], [[], [], []]);
    assert.deepEqual(await texts(app, '[data-build="stages"] li'), []);
    assert.equal(await enabled(app, 'build.revealFolder'), false, 'there is no folder of it to show');
  });
});

test('three hundred nodes with long names: what is listed, input faster than a build, an edit and its undo around a build, and another project over it', async (t) => {
  const { doc, ids } = crowded();
  assert.equal(Object.keys(doc.nodes).length, 294);
  const project = writeProject(path.join(FOLDER, 'crowded-project'), 'crowded', doc);
  const out = path.join(FOLDER, 'crowded-out');
  await withBuildPanel(project, async (app) => {
    await app.eval(`void (window.starts = 0, orogenTest.ctx.engine.subscribe((event) => { if (event.type === 'build-start') window.starts++; }))`);

    // ---- before a build: the plan of all of it, every target with its files; the two a build does not write for say why ----
    await planned(app);
    const standing = await expectPlan(app, doc, 'the crowded project');
    const targets = standing.targets.filter((target) => target.kind !== 'base' && target.kind !== 'manifest');
    assert.equal(targets.length, 17);
    assert.deepEqual([targets[0]!.id, targets[0]!.title, targets[0]!.source], [ids.landscape, LONG.title, 'from Invert']);
    // Fourteen layers, each a target of its own with the file of its name, and each fed by its slope mask.
    const layers = targets.filter((target) => ids.layers.includes(target.id));
    assert.equal(layers.length, 14);
    assert.ok(layers.every((target) => target.kind === 'layer' && target.source === 'from Slope' && target.files.length >= 1));
    assert.equal(new Set(layers.flatMap((target) => target.files.map((file) => file.path))).size, layers.reduce((sum, target) => sum + target.files.length, 0), 'no two layers share a file');
    // What only a plan finds is said before Build is pressed: the export without an input, which stops a build, and the warning of many layers.
    assert.deepEqual(standing.problems.map((problem) => problem.code), ['E_INPUT_MISSING', 'W_MANY_LAYERS']);
    assert.match(standing.failed!, /a build would stop here, before it computes or writes anything\. Below is what the rest of the plan would write\.$/);
    // And the two export nodes the plan has no target for stand under it, each with its reason.
    assert.deepEqual(standing.left, [{ id: ids.loose, tags: ['No input'] }, { id: ids.off, tags: ['Off'] }]);
    const missing = planOf(doc).problems.find((problem) => problem.code === 'E_INPUT_MISSING')!.message;
    assert.deepEqual(await head(app), ['An export node has no input', missing, 'warning']);
    assert.deepEqual((await fit(app)).spills, []);
    await scrollTo(app, '[data-build-section="plan"]');
    t.diagnostic(`capture: ${await capture(app, 'cases-02-crowded-plan')}`);

    // ---- five presses of Mod+B before the folder dialog has answered: one dialog, one build ----
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(out)}, ${quote(path.join(FOLDER, 'never'))})`);
    const before = (await buildState(app)).requestId;
    await app.eval(`void [1, 2, 3, 4, 5].forEach(() => shellTest.key('KeyB', { ctrl: true }))`);
    const refused = await built(app, before);
    assert.equal(await app.eval<number>(`window.starts`), 1);
    assert.equal(await app.eval<number>(`orogenTest.shell.answers.chooseFolder.length`), 1, 'the folder was asked for once');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.splice(0)`);
    assert.equal(await text(app, '[data-build="folder"]'), out);
    // The plan stops at the export without an input, and says so first; the warning of the plan stands behind it.
    assert.equal(refused.status, 'errors');
    assert.deepEqual(await app.eval<string[]>(`[...document.querySelectorAll('[data-build="problems"] [data-build-problem]')].map((problem) => problem.getAttribute('data-build-problem'))`), ['E_INPUT_MISSING', 'W_MANY_LAYERS']);
    assert.deepEqual(await texts(app, '[data-build="stages"] li'), [], 'no row for each of seventeen targets that were never begun');
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="targets"]') === null`), true);
    await dismissNotices(app);
    await scrollTo(app, '[data-build-section="run"]');
    t.diagnostic(`capture: ${await capture(app, 'cases-03-crowded-refused')}`);

    // ---- the export is switched off: the build runs, and the long names are inside the panel everywhere ----
    await setParamIn(app, ids.loose, 'enabled', false);
    assert.deepEqual((await head(app)).slice(0, 1), ['Changed since the last build'], 'the failure of the state before says nothing of this one');
    const first = await build(app);
    assert.equal(first.status, 'ok', JSON.stringify(first.problems));
    assert.equal(first.files.length, 35);
    assert.deepEqual(await head(app).then(([line, , tone]) => [line, tone]), ['Build finished with 1 warning', 'warning']);
    assert.deepEqual((await fit(app)).spills, []);
    // Fifteen layers, each on two rows, the base first and then by name; the last is no weight-blended layer.
    const blends = await texts(app, '[data-build-group="layers"] [data-build-row^="layer-"]:not([data-build-row$="-file"]) > span:nth-child(2)');
    assert.deepEqual(blends, [...Array<string>(14).fill('Weight-Blended, Advanced'), 'Non Weight-Blended']);
    assert.deepEqual(await cut(app, '[data-build-group="layers"] [data-build-row] > span:nth-child(2)'), [], 'what to choose for a layer is read whole');
    assert.match((await text(app, '[data-build-group="layers"] > p'))!, /Non Weight-Blended: a Non Weight-Blended Layer info with the method No Weight Blending\.$/);
    await dismissNotices(app);
    await scrollTo(app, '[data-build-group="layers"]');
    t.diagnostic(`capture: ${await capture(app, 'cases-04-crowded-built')}`);

    // ---- Build and Cancel pressed one after the other, five times: every build ends, none is left running ----
    for (let round = 0; round < 5; round++) {
      const last = (await buildState(app)).requestId;
      await app.eval(`void (shellTest.press('[data-panel="build"] [data-command="build.start"]'), setTimeout(() => orogenTest.ctx.run('build.cancel'), ${round * 30}))`);
      const ended = await built(app, last);
      assert.ok(ended.status === 'aborted' || ended.status === 'ok', ended.status);
      assert.equal(await text(app, '[data-build="status-line"]'), ended.status === 'ok' ? 'Build finished with 1 warning' : 'Build cancelled');
    }
    assert.equal(await app.eval<number>(`window.starts`), 7);
    assert.equal((await buildState(app)).running, false);
    assert.deepEqual(fs.readdirSync(out).sort(), [...first.files.map((file) => file.path), first.report!].sort(), 'the folder holds a whole build, whichever was the last to succeed');

    // ---- an edit while a build runs, and its undo afterwards ----
    await app.eval(`void (window.stopEdit = orogenTest.ctx.engine.subscribe((event) => {
      if (event.type !== 'build-plan') return;
      window.stopEdit();
      orogenTest.ctx.doc.getState().transact('Slope', (draft) => { draft.nodes[${quote(ids.slopes[0])}].params.slopeMin = 2; });
    }))`);
    const second = await build(app);
    assert.equal(second.status, 'ok', JSON.stringify(second.problems));
    // The build is of the project as it was when it started: the project has moved on, and the panel says so everywhere.
    assert.deepEqual(await head(app), ['Build out of date', 'The project has changed since', 'warning']);
    assert.equal(await text(app, '[data-build="stale"]'), 'The project has changed since this build.');
    assert.match((await text(app, '[data-build-note="unreal-stale"]'))!, /^These are the numbers of the last build, and the project has changed since\./);
    // The plan of the build was of the state before: what stands there now is the plan of the project as it is.
    await planned(app);
    await dismissNotices(app);
    await scrollTo(app, '[data-build-section="run"]');
    t.diagnostic(`capture: ${await capture(app, 'cases-05-out-of-date')}`);
    // Undone, the project is the one that was built: the build is its build again. Redone, it is not.
    await run(app, 'edit.undo');
    await app.waitFor(`document.querySelector('[data-build="status-line"]').textContent === 'Build finished with 1 warning'`, PAGE_BACKSTOP_MS);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="stale"]') === null && document.querySelector('[data-build-note="unreal-stale"]') === null`), true);
    assert.equal(await text(app, '[data-build-section="plan"] > button'), 'Planof the last build');
    await run(app, 'edit.redo');
    await app.waitFor(`document.querySelector('[data-build="status-line"]').textContent === 'Build out of date'`, PAGE_BACKSTOP_MS);
    await run(app, 'edit.undo');
    await app.waitFor(`document.querySelector('[data-build="status-line"]').textContent === 'Build finished with 1 warning'`, PAGE_BACKSTOP_MS);
    assert.equal(await enabled(app, 'build.revealFolder'), true);

    // ---- another project is opened: nothing of the last build is shown as its, and nothing of it can be opened from here ----
    await app.eval(`void orogenTest.ctx.doc.getState().load(${serializeDoc(ridge({ buildResolution: 241 }).doc)}, null)`);
    await vanishes(app, '[data-build-section="run"]');
    assert.deepEqual(await sections(app), ['settings', 'plan']);
    assert.deepEqual(await head(app), ['Not built yet', 'Build asks for the output folder', null]);
    assert.equal(await enabled(app, 'build.revealFolder'), false);
    assert.equal(await text(app, '[data-build="folder-name"]'), 'Not chosen', 'a project without a file has no folder of another');
    await planned(app);
    assert.equal((await shownPlan(app)).targets.length, 5, 'the plan is of the project that is open now: three exports, the base layer and the manifest');
    await run(app, 'build.revealFolder');
    await run(app, 'build.copyImportValues');
    await run(app, 'build.selectProblemNode');
    assert.deepEqual(await app.eval<string[]>(`orogenTest.ctx.ui.getState().selection`), []);

    // Given the folder the first project builds into, the panel says whose build a build here would replace:
    // the pipeline would not refuse it, since the folder holds an Orogen build and nothing else.
    await chooseFolder(app, out);
    assert.equal(
      await text(app, '[data-build-note="folder-shared"]'),
      'Another project builds into this folder: crowded.orogen. A build here replaces what it built: give every project a folder of its own.',
    );
    await chooseFolder(app, path.join(FOLDER, 'ridge-out'));
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build-note="folder-shared"]') === null`), true);
  });
});

test('settings at their limits: a terrain of one meter, a custom size no landscape has, and the largest size', async (t) => {
  const { doc, ids } = ridge({ buildResolution: 2049, previewLevel: 4, terrainSize: 1, heightRange: 100_000, seaLevel: 0.5 });
  const project = writeProject(path.join(FOLDER, 'limits-project'), 'limits', doc);
  await withBuildPanel(project, async (app) => {
    // One meter over 2048 quads is half a millimeter, and is written as one.
    assert.equal(await text(app, '#build-resolution .og-select-value'), '2049 × 2049 (custom)');
    assert.equal(await text(app, '[data-build="spacing"]'), '0.488 mm per vertex');

    // The plan of the project refuses the size, and the panel says so before a build is asked for: at its head,
    // under the resolution with the sizes the pipeline names, and as a problem of the plan with its node.
    await planned(app);
    const size = planOf(doc).problems.find((problem) => problem.code === 'E_SIZE_NOT_LANDSCAPE')!;
    assert.deepEqual(await head(app), ['Unreal has no landscape of this size', size.message, 'warning']);
    assert.deepEqual([await text(app, '[data-build="layout"]'), await attr(app, '[data-build="layout"]', 'data-tone')], [size.message, 'error']);
    const standing = await expectPlan(app, doc, 'a size no landscape has');
    assert.deepEqual(standing.problems.map((problem) => problem.code), ['E_SIZE_NOT_LANDSCAPE']);
    assert.equal(await text(app, '[data-build="plan-problems"] [data-build-problem="E_SIZE_NOT_LANDSCAPE"] [data-build-select]'), 'Select node');
    t.diagnostic(`capture: ${await capture(app, 'cases-06a-custom-size-before-a-build')}`);

    // A build of it is not held back, and is refused for the same reason in the same words.
    await chooseFolder(app, path.join(FOLDER, 'limits-out'));
    const refused = await build(app);
    assert.deepEqual([refused.status, refused.problems.map((problem) => [problem.code, problem.nodeId])], ['errors', [['E_SIZE_NOT_LANDSCAPE', ids.landscape]]]);
    assert.equal(refused.problems[0]!.message, size.message);
    assert.deepEqual([await text(app, '[data-build="layout"]'), await attr(app, '[data-build="layout"]', 'data-tone')], [refused.problems[0]!.message, 'error']);
    assert.match(refused.problems[0]!.message, /2049 x 2049 is not a size an Unreal landscape can have; the nearest valid build resolutions are 2033 and 3025\.$/);
    assert.equal(await text(app, '[data-build="problems"] [data-build-problem="E_SIZE_NOT_LANDSCAPE"] [data-build-select]'), 'Select node');
    await dismissNotices(app);
    t.diagnostic(`capture: ${await capture(app, 'cases-06-custom-size')}`);

    // The largest size: the list, not the document, is where it is chosen. A failure of the size before is not this size's.
    await press(app, '#build-resolution');
    await appears(app, '[data-ui="select-list"] [data-value="8129"]');
    await press(app, '[data-ui="select-list"] [data-value="8129"]');
    await vanishes(app, '[data-ui="select-list"]');
    await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 8129`, PAGE_BACKSTOP_MS);
    assert.equal(await text(app, '[data-build="spacing"]'), '0.123 mm per vertex');
    assert.equal(await text(app, '[data-build="layout"]'), '32 × 32 components of 2 × 2 sections, 127 × 127 quads each');
    assert.equal(await text(app, '[data-build="memory-field"]'), 'One field at this size is 252 MB');
    assert.match((await text(app, '[data-build="memory"]'))!, /^at least \d+(\.\d)? (MB|GB) of \d+(\.\d)? GB$/);
    assert.deepEqual((await head(app)).slice(0, 1), ['Changed since the last build']);
    assert.equal(await app.eval<string | null>(`document.querySelector('[data-build="status-line"]').getAttribute('data-tone')`), null);
    assert.equal(await text(app, '[data-build="stale"]'), 'The project has changed since this build.');
  });
});
