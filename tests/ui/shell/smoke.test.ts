// The application starts (testing.md 8.5): the frame is there with its five panels, the device becomes ready,
// the default project is computed and shown, acceptance graph 01 opens and is shown, a capture is not empty, and
// the application closes without an error.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import type { GraphDoc } from '../../../src/core/runtime.ts';
import { launchApp } from '../../helpers/index.ts';
import { capture, docked, install, ready, settled, withApp } from './rig.ts';

test('smoke: the application starts with the default project in its frame', async (t) => {
  await withApp({}, async (app) => {
    const caps = await ready(app);
    await docked(app);
    await settled(app);

    const page = await app.eval<{ title: string; panels: string[]; tabs: string[]; menus: string[]; status: string | null; adapter: string | null; memory: string | null; view: string | null; fatal: boolean }>(`({
      title: document.title,
      panels: Object.keys(orogenTest.shell.layout().dock.panels).sort(),
      tabs: shellTest.texts('.dv-default-tab-content'),
      menus: shellTest.texts('.og-menubar-item'),
      status: document.querySelector('[data-status="device"]')?.getAttribute('data-state') ?? null,
      adapter: document.querySelector('[data-status="adapter"]')?.textContent ?? null,
      memory: document.querySelector('[data-status="memory"]')?.textContent ?? null,
      view: document.querySelector('[data-status="view"]')?.textContent ?? null,
      fatal: shellTest.exists('[data-ui="fatal"]'),
    })`);
    assert.equal(page.fatal, false);
    assert.equal(page.title, 'Untitled - Orogen');
    assert.deepEqual(page.panels, ['build', 'graph', 'inspector', 'library', 'viewport']);
    assert.deepEqual([...page.tabs].sort(), ['Build', 'Graph', 'Inspector', 'Library', 'Viewport']);
    // 8.8 rule 7: the shell's four menus, then those the panels name.
    assert.deepEqual(page.menus, ['File', 'Edit', 'View', 'Engine', 'Viewport', 'Graph', 'Inspector', 'Library', 'Help']);
    assert.equal(page.status, 'ready');
    assert.ok(page.adapter !== null && page.adapter.trim() !== '', 'the status bar names the adapter');
    assert.equal(/software/i.test(page.adapter), caps.software, 'a software adapter is said, and only one');
    assert.match(page.memory ?? '', /^GPU memory\d+ MB of \d+(\.\d)? (MB|GB)$/, 'memory in use against the budget');
    assert.equal(page.view, '1009 × 1009', 'the default project is shown at its preview resolution, neither as a draft nor behind');

    // The default project: one terrain, bound to the view, computed.
    const project = await app.eval<{ doc: GraphDoc; path: string | null; unsaved: boolean; states: string[] }>(`(() => {
      const state = orogenTest.ctx.doc.getState();
      const nodes = orogenTest.ctx.engineState.getState().nodes;
      return { doc: state.doc, path: state.path, unsaved: state.unsaved, states: Object.keys(state.doc.nodes).map((id) => nodes[id]?.state ?? 'none') };
    })()`);
    const nodes = Object.values(project.doc.nodes);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.type, 'generate/mountain-range');
    assert.deepEqual(project.doc.ui.view, { height: { node: nodes[0]!.id, port: 'out' } });
    assert.deepEqual([project.path, project.unsaved, project.states], [null, false, ['done']]);

    const file = await capture(app, 'smoke-start');
    assert.ok(fs.statSync(file).size > 10_000, 'the capture holds a picture');
    t.diagnostic(`capture: ${file} (${caps.adapter.vendor} ${caps.adapter.description})`);
  });
});

test('smoke: acceptance graph 01 opens from the command line and is shown', async (t) => {
  await withApp({ open: 'tests/graphs/01-generate.orogen' }, async (app) => {
    await ready(app);
    await docked(app);
    await settled(app);
    const state = await app.eval<{ path: string; nodes: string[]; title: string; shown: number; sent: number; node: string; dialog: unknown }>(`(() => {
      const doc = orogenTest.ctx.doc.getState();
      const engine = orogenTest.ctx.engineState.getState();
      return { path: doc.path, nodes: Object.keys(doc.doc.nodes), title: document.title, shown: engine.view.revision, sent: doc.engineRevision,
        node: engine.nodes.fbm?.state ?? 'none', dialog: orogenTest.shell.state.getState().dialog };
    })()`);
    assert.ok(state.path.endsWith('/tests/graphs/01-generate.orogen'));
    assert.deepEqual(state.nodes, ['fbm']);
    assert.equal(state.title, '01-generate - Orogen');
    assert.equal(state.shown, state.sent, 'engineState.view reports the revision of the opened project');
    assert.equal(state.dialog, null, 'a project without problems opens without a word');
    const file = await capture(app, 'smoke-graph-01');
    assert.ok(fs.statSync(file).size > 10_000, 'the capture holds a picture');
    t.diagnostic(`capture: ${file}`);
  });
});

test('smoke: a software adapter is said in the status bar for as long as it is one', async (t) => {
  // runtime.md 1.3. On the software adapter the first evaluation takes its time; this test does not wait for it.
  const app = await launchApp({ profile: 'core', gpu: 'software' });
  try {
    await install(app);
    const caps = await ready(app);
    assert.equal(caps.software, true, `the adapter is ${caps.adapter.vendor} ${caps.adapter.description}`);
    await app.waitFor(`shellTest.exists('[data-status="software"]')`, 15_000);
    assert.equal(await app.eval<string>(`shellTest.text('[data-status="software"]')`), 'Software adapter: everything is slow');
    assert.equal(await app.eval<string>(`shellTest.attr('[data-status="device"]', 'data-state')`), 'ready');
    t.diagnostic(`capture: ${await capture(app, 'smoke-software')}`);
  } catch (thrown) {
    await app.close().catch(() => {});
    throw thrown;
  }
  await app.close();
});
