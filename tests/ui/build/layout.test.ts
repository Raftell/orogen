// The panel in a column of any width (runtime.md 8.7 rule 7: the user arranges the panels): at the width it has
// in a window of 1600, dragged in to 250, at the 220 pixels a window of 960 by 600 leaves it, and dragged out to
// 760. At every width everything is inside the panel, what Unreal calls a field is read whole, a stage keeps
// its name, and the line at the head of the panel is said in full. The project has names as long as their
// parameters take.
//
// The width is set through the dock, not by making the window smaller. Measured in a window that was never
// shown: `window.resizeTo` loses the graphics device ("A valid external Instance reference no longer exists"),
// and in one run of three the session could open no other ("No WebGPU adapter is available"). The column of a
// window of 960 is 220 pixels wide; that is the width tested here.
//
// Captures, for a person: ui/build/layout-01-default, layout-02-narrow-unreal, layout-03-narrow-settings,
// layout-04-narrow-stopped, layout-05-wide.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { addNode, connect, setParam } from '../../../src/core/runtime.ts';
import type { AppDriver } from '../../helpers/index.ts';
import {
  build, capture, chooseFolder, crowded, cut, dismissNotices, fit, quote, REGISTRY, scratch, scrollTo, setParamIn, sideWidth, text, texts, withBuildPanel, writeProject,
} from './rig.ts';

const FOLDER = scratch('layout');
// The crowded project without the export that stops its plan, and with an import of a file that does not exist,
// whose export is switched off until a build is to fail among its nodes.
let failing = '';
const { doc: DOC } = crowded({}, (draft, ids) => {
  setParam(draft, REGISTRY, ids.loose, 'enabled', false);
  const imported = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 3400 });
  setParam(draft, REGISTRY, imported, 'file', path.join(FOLDER, 'no-such-heights.png'));
  failing = addNode(draft, REGISTRY, 'io/export-field', { x: 4200, y: 3400 });
  setParam(draft, REGISTRY, failing, 'name', 'Imported');
  setParam(draft, REGISTRY, failing, 'enabled', false);
  connect(draft, REGISTRY, { node: imported, port: 'out' }, { node: failing, port: 'in' });
});
const PROJECT = writeProject(path.join(FOLDER, 'project'), 'crowded', DOC);

/** The fields of Unreal's panel that the rows name: those of a fixed wording, which no width may cut. */
const FIELDS = '[data-build-section="unreal"] [data-build-row]:not([data-build-row^="layer-"]):not([data-build-row^="texture-"]) > span:first-child';

/** Everything fits, at whatever part of the panel is scrolled to. */
async function fits(app: AppDriver, where: string): Promise<void> {
  const { width, spills } = await fit(app);
  assert.deepEqual(spills, [], `${where}, at ${width} px`);
}

const widths = (app: AppDriver, selector: string): Promise<number[]> =>
  app.eval<number[]>(`[...document.querySelectorAll(${quote(selector)})].map((element) => Math.round(element.getBoundingClientRect().width))`);

test('the panel at every width: nothing runs out of it, and what must be read whole is', async (t) => {
  await withBuildPanel(PROJECT, async (app) => {
    await chooseFolder(app, path.join(FOLDER, 'a folder with spaces and a long name for the output of the build', 'out'));

    // ---- before a build, at the width of the default layout ----
    await fits(app, 'before a build');
    const first = await build(app);
    assert.equal(first.status, 'ok', JSON.stringify(first.problems));
    await dismissNotices(app);
    await fits(app, 'after a build');
    assert.deepEqual(await cut(app, FIELDS), [], 'no field of Unreal\'s panel is cut');
    assert.deepEqual(await cut(app, '[data-build="status-line"]'), []);
    await scrollTo(app, '[data-build-group="layers"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-01-default')}`);

    // ---- narrow: 250 pixels, then the 220 a window of 960 leaves the column ----
    for (const width of [250, 220]) {
      await sideWidth(app, width);
      await fits(app, 'a narrow panel');
      // A field's name stands on a line of its own, whole, with its value under it.
      assert.deepEqual(await cut(app, FIELDS), [], `${width}: no field of Unreal's panel is cut`);
      assert.ok((await texts(app, FIELDS)).includes('Sections Per Component'));
      // The head of the panel says its line in full, under the button.
      assert.deepEqual(await cut(app, '[data-build="status-line"]'), [], `${width}: the status`);
      assert.equal(await text(app, '[data-build="status-line"]'), 'Build finished with 1 warning');
      // The memory a build needs is read whole, with its budget.
      assert.deepEqual(await cut(app, '[data-build="memory"] span'), [], `${width}: the memory`);
    }
    await scrollTo(app, '[data-build-group="scale"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-02-narrow-unreal')}`);
    await scrollTo(app, '[data-build-section="settings"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-03-narrow-settings')}`);

    // ---- a build that stops among its nodes, in the narrow panel: every stage and target keeps its name ----
    await setParamIn(app, failing, 'enabled', true);
    const failed = await build(app);
    assert.equal(failed.status, 'errors');
    assert.deepEqual(failed.problems.filter((problem) => problem.severity === 'error').map((problem) => problem.code), ['E_NODE_FAILED']);
    await dismissNotices(app);
    await fits(app, 'a failed build in a narrow panel');
    const stages = await texts(app, '[data-build="stages"] li > span:nth-child(2)');
    assert.deepEqual(stages.slice(0, 3), ['Plan', 'Compute the nodes', 'Convert and encode']);
    assert.deepEqual(await cut(app, '[data-build="stages"] li > span:nth-child(2)'), [], 'the name of every stage is read whole');
    // A target is named by its file, and a file's name can be longer than any column: it keeps the room the bar gave up.
    for (const width of await widths(app, '[data-build="targets"] li > span:nth-child(2)')) assert.ok(width >= 90, `a target has ${width} px for its name`);
    assert.deepEqual(await cut(app, '[data-build="status-line"]'), []);
    await scrollTo(app, '[data-build-section="run"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-04-narrow-stopped')}`);

    // ---- wide: 760 pixels. A row keeps the width at which its label and its value are read together ----
    await setParamIn(app, failing, 'enabled', false);
    const again = await build(app);
    assert.equal(again.status, 'ok', JSON.stringify(again.problems));
    await dismissNotices(app);
    await sideWidth(app, 760);
    await fits(app, 'a wide panel');
    for (const width of await widths(app, '[data-build-section]')) assert.ok(width <= 600, `a section is ${width} px wide`);
    assert.deepEqual(await cut(app, FIELDS), []);
    await scrollTo(app, '[data-build-section="run"]');
    t.diagnostic(`capture: ${await capture(app, 'layout-05-wide')}`);

  });
});
