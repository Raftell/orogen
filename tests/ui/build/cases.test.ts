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
  appears, attr, build, buildState, built, capture, chooseFolder, crowded, cut, dismissNotices, fit, LONG, press, quote, ridge, run, scratch, scrollTo, setParamIn, text, texts,
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
    // Said where it is always in sight, and under Exports as the problem a plan will report.
    assert.deepEqual(await head(app), ['Nothing to export', 'The project has no export node, so a build would write nothing.', 'warning']);
    assert.deepEqual(await sections(app), ['settings', 'plan']);
    assert.equal(
      await text(app, '[data-build="known-problems"] [data-build-problem="E_NOTHING_TO_EXPORT"]'),
      'Nothing to exportE_NOTHING_TO_EXPORTThe project has no export node, so a build would write nothing.A build writes only what export nodes declare. Add an export node from the I/O category, connect it and switch it on.',
    );
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="export-nodes"]') === null`), true);
    assert.match((await text(app, '[data-build="plan-pending"]'))!, /^A build writes what export nodes declare, and nothing else\./);
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

    // ---- every export node in one row, each by its own name; the two a build does not write for say why ----
    const rows = await app.eval<{ id: string; name: string | null; source: string | null; tags: string[]; text: string }[]>(`[...document.querySelectorAll('[data-build-export]')].map((row) => ({
      id: row.getAttribute('data-build-export'),
      name: row.querySelector('[data-build="export-name"]')?.textContent ?? null,
      source: row.querySelector('[data-build="export-source"]')?.textContent ?? null,
      tags: [...row.querySelectorAll('span')].filter((span) => span.hasAttribute('data-tone')).map((span) => span.textContent),
      text: row.textContent,
    }))`);
    assert.equal(rows.length, 19);
    assert.deepEqual(rows[0], { id: ids.landscape, name: LONG.landscape, source: 'from Invert', tags: [], text: `${LONG.title}${LONG.landscape}from InvertSelect` });
    // Fourteen layers, in the order a plan lists them, told apart by the names of their layers.
    const layers = rows.filter((row) => ids.layers.includes(row.id));
    assert.deepEqual(layers.map((row) => row.name), [LONG.layer, 'Cliff', 'Dirt', 'Forest', 'Grass', 'Gravel', 'Ice', 'Moss', 'Mud', 'Rock', 'Sand', 'Scree', 'Snow', 'Wet']);
    assert.ok(layers.every((row) => row.source === 'from Slope'));
    assert.deepEqual(rows.find((row) => row.id === ids.off)!.tags, ['Off']);
    assert.deepEqual(rows.find((row) => row.id === ids.loose)!.tags, ['No input']);
    assert.deepEqual(await head(app), ['An export node has no input', 'Color Texture: nothing is connected to its input.', 'warning']);
    assert.deepEqual((await fit(app)).spills, []);
    await scrollTo(app, '[data-build-section="plan"]');
    t.diagnostic(`capture: ${await capture(app, 'cases-02-crowded-exports')}`);

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
    assert.equal(await text(app, '[data-build-section="plan"] > button'), 'Exports', 'the plan was of the state before');
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
    assert.equal((await texts(app, '[data-build-export]')).length, 3);
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
    assert.equal(await text(app, '[data-build="layout"]'), 'A custom size: whether Unreal has a landscape of it is checked when a build is planned');
    assert.deepEqual(await head(app), ['Not built yet', 'Build asks for the output folder', null]);

    // The plan refuses the size, and the panel says so under the resolution, with the sizes the pipeline names.
    await chooseFolder(app, path.join(FOLDER, 'limits-out'));
    const refused = await build(app);
    assert.deepEqual([refused.status, refused.problems.map((problem) => [problem.code, problem.nodeId])], ['errors', [['E_SIZE_NOT_LANDSCAPE', ids.landscape]]]);
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
