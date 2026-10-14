// What is left of a project when the application does not end as it should (runtime.md 8.2 rule 11, 8.6): the
// page's process is killed with unsaved work in it, as an engine that ran out of memory in a build would take it
// along, and the window is loaded again and offers the project as it was kept; and two applications on one
// project file do not save over each other without a word.
//
// The page's process is found among this process's own descendants, through /proc: only the application this
// test launched can be hit, and only on Linux.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { nodes } from '../../../src/core/nodes/index.ts';
import { createRegistry, parseDoc, serializeDoc } from '../../../src/core/runtime.ts';
import { launchApp, type AppDriver } from '../../helpers/index.ts';
import { rendererProcesses } from '../platform/rig.ts';
import { defaultDoc } from '../../../src/app/shell/project.ts';
import { appears, EVALUATION_BACKSTOP_MS, install, OUTPUT, PAGE_BACKSTOP_MS, press, quote, ready, run, settled, sleep, vanishes } from './rig.ts';

const REGISTRY = createRegistry(nodes);
const FOLDER = path.join(OUTPUT, 'crash');
fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

const SEED = `orogenTest.ctx.doc.getState().doc.settings.seed`;
const setSeed = (app: AppDriver, seed: number): Promise<void> => app.eval<void>(`void orogenTest.ctx.doc.getState().transact('Seed', (draft) => { draft.settings.seed = ${seed}; })`);
const dialogKind = (app: AppDriver): Promise<string | null> => app.eval<string | null>(`orogenTest.shell.state.getState().dialog?.kind ?? null`);

test('crash: the page process is killed with unsaved work in it; the window is loaded again and offers the project as it was kept', { skip: process.platform === 'linux' ? false : 'the page process is found through /proc', timeout: 240_000 }, async (t) => {
  const file = path.join(FOLDER, 'kept.orogen');
  fs.writeFileSync(file, serializeDoc(defaultDoc(REGISTRY)));
  const app = await launchApp({ open: file });
  try {
    await install(app);
    await ready(app);
    await settled(app);
    await setSeed(app, 4711);
    assert.deepEqual(await app.eval<[boolean, string]>(`[orogenTest.ctx.doc.getState().unsaved, document.title]`), [true, 'kept* - Orogen']);
    // Kept a few seconds after the change, without anybody asking for it.
    await app.waitFor(`orogenTest.ctx.platform.readRecovery().then((record) => record !== null && JSON.parse(record.text).settings.seed === 4711 && record.path === ${quote(file)})`, 20_000);

    const pages = rendererProcesses();
    assert.equal(pages.length, 1, `the application has one page process: ${pages.join(', ')}`);
    process.kill(pages[0]!, 'SIGKILL');
    // The main process hears of it and loads the window again; test mode asks nothing (8.2 rule 11).
    await sleep(2000);
    const reloaded = rendererProcesses();
    assert.equal(reloaded.length, 1, 'the window has a page again');
    assert.notEqual(reloaded[0], pages[0], 'in a new process');
    await app.waitFor(`typeof orogenTest === 'object' && orogenTest.shell.state.getState().dialog?.kind === 'recover'`, 60_000);
    await install(app);

    // The file is opened as it is on disk, and the question stands over it.
    assert.equal(await app.eval<number>(SEED), 0);
    const question = await app.eval<string>(`document.querySelector('[data-dialog="recover"]').textContent`);
    assert.match(question, /^Restore the unsaved changes to kept\?/);
    assert.match(question, /kept it as it was a few seconds earlier/);
    t.diagnostic(`capture: ${await app.capture('shell/crash-01-recover-question')}`);
    await press(app, '[data-dialog="recover"] [data-action="restore"]');
    await vanishes(app, '[data-dialog="recover"]');
    assert.deepEqual(
      await app.eval<[number, string | null, boolean, string]>(`[${SEED}, orogenTest.ctx.doc.getState().path, orogenTest.ctx.doc.getState().unsaved, document.title]`),
      [4711, file, true, 'kept* - Orogen'],
      'the project is the one that was lost, under its file, unsaved',
    );
    assert.equal(parseDoc(fs.readFileSync(file, 'utf8'), REGISTRY).doc.settings.seed, 0, 'the file is not touched until the project is saved');

    // The engine came back with the page: the restored project is computed and shown.
    await ready(app);
    await app.waitFor(`(() => { const e = orogenTest.ctx.engineState.getState(); return e.view !== null && e.evaluation === null && e.view.revision >= orogenTest.ctx.doc.getState().engineRevision; })()`, EVALUATION_BACKSTOP_MS);

    // Saved, it is in its file, and nothing is kept for the next start to offer.
    await run(app, 'file.save');
    await app.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(parseDoc(fs.readFileSync(file, 'utf8'), REGISTRY).doc.settings.seed, 4711);
    await app.waitFor(`orogenTest.ctx.platform.readRecovery().then((record) => record === null)`, PAGE_BACKSTOP_MS);

    // What the application recorded is the end of that process, and nothing else.
    const errors = await app.errors();
    assert.ok(errors.some((line) => line.includes('the renderer process is gone')), errors.join('\n'));
    assert.deepEqual(errors.filter((line) => !line.includes('the renderer process is gone')), []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('crash: two applications on one project file: the second to save is asked before it replaces what the first wrote', { timeout: 240_000 }, async (t) => {
  const file = path.join(FOLDER, 'shared.orogen');
  fs.writeFileSync(file, serializeDoc(defaultDoc(REGISTRY)));
  // Test mode takes no lock (8.2 rule 8), so two applications run here as they could where the lock failed.
  const first = await launchApp({ open: file });
  let second: AppDriver | null = null;
  try {
    second = await launchApp({ open: file });
    for (const app of [first, second]) {
      await install(app);
      await app.waitFor(`orogenTest.ctx.doc.getState().path === ${quote(file)}`, PAGE_BACKSTOP_MS);
    }
    // The first adds a node and saves.
    await first.eval(`void orogenTest.ctx.doc.getState().transact('Add', (draft) => {
      draft.nodes.soften = { id: 'soften', type: 'filter/blur', version: 1, position: { x: 400, y: 0 }, params: {} };
    })`);
    await run(first, 'file.save');
    await first.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    const theirs = fs.readFileSync(file, 'utf8');
    assert.ok(Object.hasOwn(parseDoc(theirs, REGISTRY).doc.nodes, 'soften'));

    // The second, which opened the file before that, changes the seed and saves: it is asked.
    await setSeed(second, 999);
    await run(second, 'file.save');
    await appears(second, '[data-dialog="changed"]');
    assert.equal(await dialogKind(second), 'changed');
    assert.match(await second.eval<string>(`document.querySelector('[data-dialog="changed"]').textContent`), /^shared\.orogen was changed outside this window/);
    assert.equal(fs.readFileSync(file, 'utf8'), theirs, 'nothing is written while the question stands');
    t.diagnostic(`capture: ${await second.capture('shell/crash-02-changed-question')}`);
    await press(second, '[data-dialog="changed"] [data-action="cancel"]');
    await vanishes(second, '[data-dialog="changed"]');
    assert.equal(fs.readFileSync(file, 'utf8'), theirs, 'cancelled: the first application\'s node is still in the file');
    assert.equal(await second.eval<boolean>(`orogenTest.ctx.doc.getState().unsaved`), true);

    // Overwrite is the user's own decision, and after it the file is the second application's without another question.
    await run(second, 'file.save');
    await appears(second, '[data-dialog="changed"]');
    await press(second, '[data-dialog="changed"] [data-action="overwrite"]');
    await second.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.deepEqual([parseDoc(fs.readFileSync(file, 'utf8'), REGISTRY).doc.settings.seed, Object.hasOwn(parseDoc(fs.readFileSync(file, 'utf8'), REGISTRY).doc.nodes, 'soften')], [999, false]);
    await setSeed(second, 1000);
    await run(second, 'file.save');
    await second.waitFor(`orogenTest.ctx.doc.getState().unsaved === false`, PAGE_BACKSTOP_MS);
    assert.equal(await dialogKind(second), null);
    assert.deepEqual(await second.errors(), []);
    assert.deepEqual(await first.errors(), []);
  } finally {
    await first.close().catch(() => {});
    await second?.close().catch(() => {});
  }
});
