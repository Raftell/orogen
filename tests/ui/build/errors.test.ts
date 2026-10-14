// What goes wrong, and what the panel says of it. Every refusal of the output folder (export-unreal.md 3.8):
// a folder with files of the user's, a build folder with a foreign file in it, a path that is a file, a foreign
// folder under the name the build stages in, and the project's own folder, which the panel warns of before a
// build is started. Then a build with a node that fails. Each time: what the panel says, with the problem's
// code in plain words, and that the disk holds what it held before.
//
// Captures, for a person: ui/build/error-01-folder-refused, error-02-project-folder, error-03-node-failed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { addNode, connect, setParam, type BuildResult } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  attr, build, buildState, built, capture, chooseFolder, dismissNotices, press, quote, REGISTRY, ridge, scratch, scrollTo, text, texts, withBuildPanel, writeProject,
  PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('errors');
const PROJECT_FOLDER = path.join(FOLDER, 'project');
const ABSENT = path.join(FOLDER, 'no-such-heights.png');

// The ridge, and beside it an import of a file that does not exist, with an export of its own that is switched off.
let imported = '';
let exported = '';
const { doc: DOC } = ridge({ buildResolution: 241 }, (draft) => {
  imported = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 420 });
  setParam(draft, REGISTRY, imported, 'file', ABSENT);
  exported = addNode(draft, REGISTRY, 'io/export-field', { x: 520, y: 420 });
  setParam(draft, REGISTRY, exported, 'name', 'Imported');
  setParam(draft, REGISTRY, exported, 'enabled', false);
  connect(draft, REGISTRY, { node: imported, port: 'out' }, { node: exported, port: 'in' });
});
const PROJECT = writeProject(PROJECT_FOLDER, 'ridge', DOC);

/** Every file under a folder with a digest of its content: what "the disk holds what it held" is checked by. */
function contents(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(folder, file)] = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

interface Said {
  readonly line: string | null;
  readonly sub: string | null;
  /** What follows the outcome and its buttons in the Build section: the problems, before anything about the build's course. */
  readonly afterOutcome: string | null;
  readonly outcome: string | null;
  readonly written: string | null;
  readonly kept: string | null;
  readonly places: readonly string[];
  readonly problems: readonly { readonly code: string | null; readonly severity: string | null; readonly text: string; readonly select: string | null }[];
  readonly stages: readonly string[];
  readonly reveal: boolean;
  readonly sections: readonly string[];
}
const said = (app: AppDriver): Promise<Said> => app.eval<Said>(`(() => {
  const panel = document.querySelector('[data-panel="build"]');
  const q = (selector) => panel.querySelector(selector);
  const all = (selector) => [...panel.querySelectorAll(selector)];
  return {
    line: q('[data-build="status-line"]')?.textContent ?? null,
    sub: q('[data-build="status-sub"]')?.textContent ?? null,
    afterOutcome: all('[data-build-section="run"] [data-build-note="outcome"] ~ [data-build]')[0]?.getAttribute('data-build') ?? null,
    outcome: q('[data-build="outcome"]')?.textContent ?? null,
    written: q('[data-build="written"]')?.textContent ?? null,
    kept: q('[data-build="kept"]')?.textContent ?? null,
    places: all('[data-build-place]').map((place) => place.textContent),
    problems: all('[data-build-problem]').map((problem) => ({
      code: problem.getAttribute('data-build-problem'), severity: problem.getAttribute('data-severity'), text: problem.textContent,
      select: problem.querySelector('[data-build-select]')?.getAttribute('data-build-select') ?? null,
    })),
    stages: all('[data-build-stage]').map((stage) => stage.getAttribute('data-build-stage') + ' ' + stage.getAttribute('data-state')),
    reveal: !q('[data-build-section="run"] [data-command="build.revealFolder"]').disabled,
    sections: all('[data-build-section]').map((section) => section.getAttribute('data-build-section')),
  };
})()`);

/** A build into a folder the pipeline refuses: the result, and what the panel says of it. */
async function refused(app: AppDriver, folder: string, message: RegExp): Promise<Said> {
  await chooseFolder(app, folder);
  const result = await build(app);
  const where = path.basename(folder);
  assert.equal(result.status, 'errors', where);
  assert.deepEqual([result.files, result.manifest, result.report, result.outDir], [[], null, null, null], where);
  assert.deepEqual(result.problems.map((problem) => [problem.severity, problem.code]), [['error', 'E_OUT_DIR']], where);
  assert.match(result.problems[0]!.message, message, where);
  const shown = await said(app);
  assert.equal(shown.line, 'The output folder was refused', where);
  assert.equal(shown.outcome, 'The output folder was refused', where);
  assert.equal(shown.written, 'Nothing was planned, computed or written.', where);
  assert.equal(shown.kept, 'The folder was not touched. Orogen replaces a folder only when it holds an earlier Orogen build and nothing else.', where);
  assert.deepEqual(shown.places, [`Output folder${folder}`], where);
  // The problem: its code, what it means in plain words, the pipeline's own sentence, and what to do.
  assert.equal(shown.problems.length, 1, where);
  const [problem] = shown.problems;
  assert.deepEqual([problem!.code, problem!.severity, problem!.select], ['E_OUT_DIR', 'error', null], where);
  assert.ok(problem!.text.startsWith('The output folder cannot be usedE_OUT_DIRCannot '), problem!.text);
  assert.ok(problem!.text.includes(result.problems[0]!.message), where);
  assert.ok(problem!.text.endsWith('Choose a new or empty folder, or one that holds an earlier Orogen build and nothing else. Nothing in the folder was touched.'), problem!.text);
  // Nothing was planned: the build began no stage, so none is listed, and the problem stands right under how it ended.
  assert.deepEqual(shown.stages, [], where);
  assert.equal(shown.sub, null, 'a build that was refused took no time worth saying');
  assert.equal(shown.afterOutcome, 'problem-count', where);
  assert.equal(shown.reveal, false, where);
  assert.deepEqual(shown.sections.filter((section) => ['files', 'unreal', 'report'].includes(section)), [], where);
  return shown;
}

test('every refusal of the output folder, and a build with a node that fails: what is said, and that the disk is as it was', async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    const projectBefore = contents(PROJECT_FOLDER);
    assert.deepEqual(Object.keys(projectBefore), ['ridge.orogen']);

    // ---- 1. a folder that holds files of the user's ----
    const foreign = path.join(FOLDER, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'my own notes\n');
    const foreignBefore = contents(foreign);
    await refused(app, foreign, /foreign holds files and no Orogen build manifest \(\*\.orogen\.json\); the output folder belongs to Orogen/);
    assert.deepEqual(contents(foreign), foreignBefore);
    assert.equal(fs.existsSync(`${foreign}.partial`), false);
    // The rules it broke stood under the folder before the build was started.
    assert.ok((await texts(app, '[data-build="folder-rules"] li')).join(' ').includes('It must be new, empty, or hold an earlier Orogen build and nothing else. Any other folder is refused and not touched.'));
    await dismissNotices(app);
    t.diagnostic(`capture: ${await capture(app, 'error-01-folder-refused')}`);

    // ---- 2. a path that is a file ----
    const file = path.join(FOLDER, 'a-file.txt');
    fs.writeFileSync(file, 'not a folder\n');
    await refused(app, file, /a-file\.txt is a file, not a folder\.$/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a folder\n');

    // ---- 3. a build folder into which somebody has put a file of their own ----
    const mixed = path.join(FOLDER, 'mixed');
    await chooseFolder(app, mixed);
    const first = await build(app);
    assert.equal(first.status, 'ok', JSON.stringify(first.problems));
    fs.writeFileSync(path.join(mixed, 'mine.txt'), 'kept beside the build\n');
    const mixedBefore = contents(mixed);
    await refused(app, mixed, /mixed holds an Orogen build and also mine\.txt, which is no file of that build/);
    assert.deepEqual(contents(mixed), mixedBefore, 'the build and the file beside it are as they were');

    // ---- 4. a foreign folder under the name the build stages in ----
    const beside = path.join(FOLDER, 'beside');
    fs.mkdirSync(`${beside}.partial`);
    fs.writeFileSync(path.join(`${beside}.partial`, 'keep.txt'), 'not a build\n');
    await refused(app, beside, /a build needs the name .*beside\.partial beside it, and what bears that name holds files and no Orogen build manifest/);
    assert.deepEqual(Object.keys(contents(`${beside}.partial`)), ['keep.txt']);
    assert.equal(fs.existsSync(beside), false, 'the folder itself was not made');

    // ---- 4a. a folder that cannot be read, and a place where the folder the build stages in cannot be made ----
    if (process.platform !== 'win32') {
      const closed = path.join(FOLDER, 'closed');
      const locked = path.join(FOLDER, 'locked');
      fs.mkdirSync(closed);
      fs.mkdirSync(locked);
      fs.chmodSync(closed, 0o000);
      fs.chmodSync(locked, 0o555);
      try {
        await refused(app, closed, /closed cannot be read: /);
        await refused(app, path.join(locked, 'new'), /^Cannot prepare the folder .*new\.partial for the build: /);
        assert.deepEqual(fs.readdirSync(locked), [], 'nothing was made in it');
      } finally {
        fs.chmodSync(closed, 0o755);
        fs.chmodSync(locked, 0o755);
      }
    }

    // ---- 5. the project's own folder: said before a build is started, and Build asks for another ----
    await chooseFolder(app, PROJECT_FOLDER);
    assert.equal(await text(app, '[data-build-note="folder-warning"]'), 'This folder holds the project file. A build replaces everything in its folder, so it is refused here: choose a folder of its own. Build asks for another folder.');
    await dismissNotices(app);
    await scrollTo(app, '[data-build-section="settings"]');
    t.diagnostic(`capture: ${await capture(app, 'error-02-project-folder')}`);
    const good = path.join(FOLDER, 'good');
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(good)})`);
    const second = await build(app);
    assert.deepEqual([second.status, second.outDir], ['ok', good]);
    assert.equal(await text(app, '[data-build="folder"]'), good, 'the folder that was chosen instead is the project\'s folder now');
    assert.equal(await attr(app, '[data-build-note="folder-warning"]', 'data-tone'), null);
    assert.deepEqual(contents(PROJECT_FOLDER), projectBefore);
    // Whoever chooses it again when asked gets the pipeline's own refusal, and the project is untouched.
    await chooseFolder(app, PROJECT_FOLDER);
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(PROJECT_FOLDER)})`);
    const before = (await buildState(app)).requestId;
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    const insisted = await built(app, before);
    assert.deepEqual([insisted.status, insisted.problems.map((problem) => problem.code)], ['errors', ['E_OUT_DIR']]);
    assert.match(insisted.problems[0]!.message, /project holds files and no Orogen build manifest/);
    assert.deepEqual(contents(PROJECT_FOLDER), projectBefore);
    assert.equal((await said(app)).outcome, 'The output folder was refused');

    // ---- 6. a folder around the project: warned of, and refused by the pipeline for whoever chooses it again when asked ----
    await chooseFolder(app, FOLDER);
    assert.match((await text(app, '[data-build-note="folder-warning"]'))!, /^The project lies inside this folder\. A build replaces everything in its folder, so it is refused here/);
    const around = contents(FOLDER);
    await app.eval(`void orogenTest.shell.answers.chooseFolder.push(${quote(FOLDER)})`);
    const beforeAround = (await buildState(app)).requestId;
    await press(app, '[data-panel="build"] [data-command="build.start"]');
    const aroundResult = await built(app, beforeAround);
    assert.deepEqual([aroundResult.status, aroundResult.problems.map((problem) => problem.code), aroundResult.outDir], ['errors', ['E_OUT_DIR'], null]);
    assert.match(aroundResult.problems[0]!.message, /errors holds files and no Orogen build manifest/);
    assert.deepEqual(contents(FOLDER), around, 'the project, and everything beside it, is as it was');
    assert.equal(fs.existsSync(`${FOLDER}.partial`), false);

    // ---- 7. what is accepted: an empty folder that exists ----
    const empty = path.join(FOLDER, 'empty');
    fs.mkdirSync(empty);
    await chooseFolder(app, empty);
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build-note="folder-warning"]') === null`), true);
    const third = await build(app);
    assert.deepEqual([third.status, third.outDir], ['ok', empty]);
    assert.deepEqual(fs.readdirSync(empty).sort(), [...third.files.map((written) => written.path), third.report!].sort());

    // ---- 8. a node that fails: the import of a file that does not exist, exported ----
    await chooseFolder(app, good);
    const goodBefore = contents(good);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Enable', (draft) => { draft.nodes[${quote(exported)}].params.enabled = true; })`);
    // The plan of the project as it is now lists the export that was switched on.
    await app.waitFor(`document.querySelector('[data-build="plan-targets"] [data-build-target="${exported}"]') !== null`, PAGE_BACKSTOP_MS);
    const failed: BuildResult = await build(app);
    assert.equal(failed.status, 'errors');
    assert.deepEqual([failed.files, failed.manifest, failed.report, failed.outDir], [[], null, 'Ridge.report.json', `${good}.partial`]);
    const errors = failed.problems.filter((problem) => problem.severity === 'error');
    assert.deepEqual(errors.map((problem) => [problem.code, problem.nodeId]), [['E_NODE_FAILED', imported]]);
    // What was and was not written: the folder holds the earlier build, byte for byte; beside it the report alone.
    assert.deepEqual(contents(good), goodBefore);
    assert.deepEqual(fs.readdirSync(`${good}.partial`), ['Ridge.report.json']);

    const shown = await said(app);
    assert.deepEqual([shown.line, shown.outcome], ['Build failed', 'Build failed']);
    assert.equal(shown.written, 'Nothing was written to the output folder.');
    assert.equal(shown.kept, 'None of the 9 planned files was put in place: the folder holds what it held before. The report of this build lies in a folder beside it, which the next build removes.');
    assert.deepEqual(shown.places, [`Output folder${good}`, `Report${path.join(`${good}.partial`, 'Ridge.report.json')}`]);
    const problem = shown.problems.find((candidate) => candidate.code === 'E_NODE_FAILED')!;
    assert.deepEqual([problem.severity, problem.select], ['error', imported]);
    assert.ok(problem.text.startsWith('A node failed while computingE_NODE_FAILED'), problem.text);
    assert.ok(problem.text.includes(errors[0]!.message), 'the pipeline\'s sentence, which names the node and says what it said');
    assert.ok(problem.text.includes('The build stopped there and put no file in place.'));
    // The problem stands right under how the build ended; where it stopped comes after.
    assert.equal(shown.afterOutcome, 'problem-count');
    assert.match(shown.sub!, /^after \d+(\.\d)? s$/);
    // The plan was good and stands; the build stopped among the nodes, and the stages behind them were not reached.
    assert.equal(shown.stages[0], 'plan done');
    assert.ok(shown.stages.includes('compute stopped'), shown.stages.join(', '));
    assert.equal(shown.stages.at(-1), 'commit skipped');
    assert.equal(shown.reveal, true, 'the report can be shown in its folder');
    assert.deepEqual(shown.sections.filter((section) => ['files', 'unreal'].includes(section)), [], 'no files and no numbers of a build that wrote none');
    assert.ok(shown.sections.includes('report'), 'its report is read');
    // The node the problem concerns is selected from the problem.
    await press(app, `[data-build-problem="E_NODE_FAILED"] [data-build-select="${imported}"]`);
    assert.deepEqual(await app.eval<string[]>(`orogenTest.ctx.ui.getState().selection`), [imported]);
    // Selecting shows the node in the viewport, which changes the view and nothing a build reads: the build is still the project's.
    assert.deepEqual(await app.eval<unknown>(`orogenTest.ctx.doc.getState().doc.ui.view.height`), { node: imported, port: 'out' });
    assert.equal(await app.eval<boolean>(`document.querySelector('[data-build="stale"]') === null`), true);
    await dismissNotices(app);
    t.diagnostic(`the node said: ${errors[0]!.message}`);
    await scrollTo(app, '[data-build-section="run"]');
    t.diagnostic(`capture: ${await capture(app, 'error-03-node-failed')}`);

    // The export switched off again, the project builds as before: the next build removes what the failed one left.
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Disable', (draft) => { draft.nodes[${quote(exported)}].params.enabled = false; })`);
    const fourth = await build(app);
    assert.deepEqual([fourth.status, fourth.outDir], ['ok', good]);
    assert.equal(fs.existsSync(`${good}.partial`), false);
  });
});
