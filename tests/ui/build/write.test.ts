// A file that cannot be written (export-unreal.md 3.9, E_WRITE_FAILED): what a full disk does to a build. A disk
// cannot be filled for a test; the folder the build writes into is made read-only instead, once the build has
// planned and before its first file, so that the sink's next call is refused by the system as a full disk
// refuses it. The pipeline reports the failure with its cause and the path, puts nothing in place, cannot write
// its report either and says so; the panel says what was and was not written, and the next build succeeds.
//
// Capture, for a person: ui/build/write-01-failed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  appears, attr, build, buildState, built, capture, chooseFolder, dismissNotices, longRidge, press, scratch, text, texts, vanishes, withBuildPanel, writeProject,
  BUILD_BACKSTOP_MS, PAGE_BACKSTOP_MS,
} from './rig.ts';

const FOLDER = scratch('write');
const OUT = path.join(FOLDER, 'out');
const STAGING = `${OUT}.partial`;
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'ridge', longRidge({ buildResolution: 241 }).doc);

const hashes = (folder: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(folder).sort().map((name) => [name, createHash('sha1').update(fs.readFileSync(path.join(folder, name))).digest('hex')]));

test('a file that cannot be written: the build fails with E_WRITE_FAILED, nothing is put in place, and the panel says so', { skip: process.platform === 'win32' && 'a folder is made read-only by its mode' }, async (t) => {
  try {
    await withBuildPanel(PROJECT, async (app) => {
      await chooseFolder(app, OUT);
      // An earlier build, which the failed one must leave as it is.
      const earlier = await build(app);
      assert.equal(earlier.status, 'ok', JSON.stringify(earlier.problems));
      const kept = hashes(OUT);

      // At 4033 the first field takes a moment to compute: the folder is closed between the plan and the first file.
      await press(app, '#build-resolution');
      await appears(app, '[data-ui="select-list"] [data-value="4033"]');
      await press(app, '[data-ui="select-list"] [data-value="4033"]');
      await vanishes(app, '[data-ui="select-list"]');
      await app.waitFor(`orogenTest.ctx.doc.getState().doc.settings.buildResolution === 4033`, PAGE_BACKSTOP_MS);
      const before = (await buildState(app)).requestId;
      await press(app, '[data-panel="build"] [data-command="build.start"]');
      await app.waitFor(`(() => {
        const state = orogenTest.ctx.engineState.getState().build;
        return state.requestId !== ${before} && (state.plan !== null || !state.running && state.result !== null);
      })()`, BUILD_BACKSTOP_MS);
      assert.equal((await buildState(app)).running, true, 'the build has planned and still runs');
      fs.chmodSync(STAGING, 0o555);

      const failed = await built(app, before);
      assert.equal(failed.status, 'errors', JSON.stringify(failed.problems));
      const errors = failed.problems.filter((problem) => problem.severity === 'error');
      assert.deepEqual(errors.map((problem) => problem.code), ['E_WRITE_FAILED']);
      assert.match(errors[0]!.message, /^Cannot write \S+: /, 'the cause and the file');
      // The report could not be written either: the pipeline says so as a warning of the same code (3.10).
      assert.deepEqual([failed.files, failed.manifest, failed.report, failed.outDir], [[], null, null, STAGING]);
      assert.deepEqual(failed.problems.filter((problem) => problem.severity === 'warning').map((problem) => problem.code), ['E_WRITE_FAILED']);
      // What was and was not written: the output folder holds the earlier build, byte for byte.
      assert.deepEqual(hashes(OUT), kept);

      assert.deepEqual([await text(app, '[data-build="status-line"]'), await attr(app, '[data-build="status-line"]', 'data-tone')], ['Build failed', 'error']);
      assert.equal(await text(app, '[data-build="outcome"]'), 'Build failed');
      assert.equal(await text(app, '[data-build="written"]'), 'Nothing was written to the output folder.');
      assert.equal(await text(app, '[data-build="kept"]'), 'None of the 15 planned files was put in place: the folder holds what it held before.');
      assert.deepEqual(await texts(app, '[data-build-place]'), [`Output folder${OUT}`], 'no report is named: none was written');
      const shown = await app.eval<[string | null, string][]>(`[...document.querySelectorAll('[data-build="problems"] [data-build-problem]')].map((problem) => [problem.getAttribute('data-severity'), problem.textContent])`);
      assert.deepEqual(shown.map(([severity]) => severity), ['error', 'warning']);
      for (const [index, [, said]] of shown.entries()) {
        assert.ok(said.startsWith('A file could not be writtenE_WRITE_FAILEDCannot write '), said);
        assert.ok(said.includes(failed.problems[index]!.message), 'the pipeline\'s own sentence, with the cause and the path');
        assert.ok(said.includes('Check the free space and the permissions of the disk that holds the output folder, then build again.'), said);
      }
      assert.deepEqual(await app.eval<string[]>(`[...document.querySelectorAll('[data-build-section]')].map((section) => section.getAttribute('data-build-section')).filter((id) => id === 'files' || id === 'unreal')`), []);
      await dismissNotices(app);
      t.diagnostic(`the sink said: ${errors[0]!.message}`);
      t.diagnostic(`capture: ${await capture(app, 'write-01-failed')}`);

      // The folder can be written again: the next build removes what the failed one left and replaces the earlier build.
      fs.chmodSync(STAGING, 0o755);
      const again = await build(app);
      assert.deepEqual([again.status, again.outDir], ['ok', OUT]);
      assert.equal(fs.existsSync(STAGING), false);
      assert.equal(fs.statSync(path.join(OUT, 'RidgeHeight.r16')).size, 2 * 4033 * 4033);
      assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished');
    });
  } finally {
    if (fs.existsSync(STAGING)) fs.chmodSync(STAGING, 0o755);
    // A build at 4033 is some 190 MB: it has served, and is not left on the disk.
    scratch('write');
  }
});
