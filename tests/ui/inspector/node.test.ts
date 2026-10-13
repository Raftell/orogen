// The head of the inspector, several selected nodes, and the panel's commands, in the window: the title renames
// the node, the bypass toggles, the engine's report of the node is shown (state, time, memory, the range and the
// mean of its first output, an error with everything it holds), nodes of one type are edited together, and every
// command the panel registers runs (testing.md 5.6).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeError } from '../../../src/core/runtime.ts';
import { addNode, connect, setParam, setView } from '../../../src/core/runtime.ts';
import { formatStat, formatStatMetres } from '../../../src/app/panels/inspector/model.ts';
import type { AppDriver } from '../../helpers/index.ts';
import { closeMenu, openMenu } from '../shell/rig.ts';
import {
  apart, appears, attrOf, capture, choose, contentKey, count, docOf, enter, exists, field, inspect, key, nodeState, PAGE_BACKSTOP_MS, PANEL, paramOf, past,
  press, project, quote, REGISTRY, row, run, scrub, select, settled, textOf, undo, vanishes, withProject,
} from './rig.ts';

const ids = { noise: '', second: '', blur: '', failing: '', after: '', imported: '', landscape: '', erosion: '' };

const FILE = project('node', (draft, registry) => {
  ids.noise = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 0 });
  ids.second = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 200 });
  ids.imported = addNode(draft, registry, 'io/import-field', { x: 0, y: 400 });
  ids.blur = addNode(draft, registry, 'filter/blur', { x: 300, y: 0 });
  ids.failing = addNode(draft, registry, 'ref/fail', { x: 300, y: 200 });
  ids.after = addNode(draft, registry, 'filter/blur', { x: 600, y: 200 });
  ids.landscape = addNode(draft, registry, 'io/export-landscape', { x: 600, y: 0 });
  ids.erosion = addNode(draft, registry, 'simulate/hydraulic-erosion', { x: 300, y: 400 });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.erosion, port: 'in' });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.blur, port: 'in' });
  connect(draft, registry, { node: ids.noise, port: 'out' }, { node: ids.failing, port: 'in' });
  connect(draft, registry, { node: ids.failing, port: 'out' }, { node: ids.after, port: 'in' });
  connect(draft, registry, { node: ids.blur, port: 'out' }, { node: ids.landscape, port: 'in' });
  setParam(draft, registry, ids.failing, 'message', 'The ground gave way');
  setParam(draft, registry, ids.second, 'octaves', 5);
  setParam(draft, registry, ids.blur, 'radius', 0.02);
  setView(draft, { height: { node: ids.blur, port: 'out' } });
});

const head = (member: string): string => `${PANEL} [data-field="${member}"]`;
const TITLE = head('title');
const status = (app: AppDriver): Promise<string> => textOf(app, `${PANEL} [data-status-text]`);
const focused = (app: AppDriver, selector: string): Promise<boolean> => app.eval<boolean>(`document.activeElement === shellTest.el(${quote(selector)})`);
const node = async (app: AppDriver, id: string) => (await docOf(app)).nodes[id]!;
/**
 * Puts a report of the engine into its store, as an event would: for a state no real node of the product is in on
 * demand. It is filed under a request later than any the session makes, so that no event of the running engine
 * replaces it (runtime.md 7.7: an event of an older request is ignored).
 */
const report = (app: AppDriver, id: string, record: object): Promise<void> => app.eval<void>(`void (() => {
  const store = orogenTest.ctx.engineState;
  const known = store.getState().nodes[${quote(id)}];
  store.setState({ ...store.getState(), nodes: { ...store.getState().nodes, [${quote(id)}]: { ...known, ...${quote(record)}, requestId: 1e9 } } }, true);
})()`);

test('node: the head renames and bypasses the node and shows what the engine says of it', async (t) => {
  await withProject(FILE, async (app) => {
    const out = { node: ids.blur, port: 'out' };
    await select(app, [ids.blur], { height: out });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    const blur = REGISTRY.get('filter/blur')!;

    // ---- the title, the type and what it does ----
    assert.equal(await app.eval<string>(`shellTest.el(${quote(TITLE)}).value`), 'Blur');
    assert.equal(await textOf(app, `${PANEL} [data-inspector-header]`), 'BypassBlurfilter/blur');
    assert.equal(await textOf(app, head('description')), blur.description);

    // ---- its state, the time and the memory of its last run ----
    assert.equal(await attrOf(app, `${PANEL} [data-node-status]`, 'data-node-status'), 'done');
    const said = await status(app);
    assert.match(said, /^Computed · (<1|\d+) ms · \d+ (KB|MB)$|^Computed · \d+\.\d+ s · \d+ (KB|MB)$/, said);
    const record = await app.eval<{ wallMs: number; peakBytes: number }>(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.blur)}]`);
    assert.ok(record.wallMs > 0 && record.peakBytes > 0, 'the engine measured the run the line reports');

    // ---- the range and the mean of its first output, from the session's inspect ----
    const stats = (await inspect(app, out))!;
    assert.equal(await textOf(app, `${PANEL} [data-node-stats] dd > div:first-child`), `${formatStat(stats.min)} to ${formatStat(stats.max)}, mean ${formatStat(stats.mean)}`);
    // The blur's output has the kind of its input, which is the noise's heights: metres as well.
    assert.equal(await textOf(app, `${PANEL} [data-node-stats] dd > div:last-child`), `${formatStatMetres(stats.min, 1008)} to ${formatStatMetres(stats.max, 1008)}`);
    // Another radius is another field: the numbers follow.
    await enter(app, field('radius'), '0.08');
    await settled(app);
    const wider = (await inspect(app, out))!;
    assert.ok(wider.max < stats.max, 'a wider blur lowers the peaks');
    await app.waitFor(`shellTest.text(${quote(`${PANEL} [data-node-stats] dd > div:first-child`)}) === ${quote(`${formatStat(wider.min)} to ${formatStat(wider.max)}, mean ${formatStat(wider.mean)}`)}`, PAGE_BACKSTOP_MS);
    t.diagnostic(`capture: ${await capture(app, 'node-head')}`);

    // ---- while a drag makes drafts the head neither blinks nor goes blank ----
    // A draft is computed many times a second. Its time and memory are those of a coarse grid, and between two of
    // them the node waits and runs: none of that is the line of the head, and the numbers of the output stay.
    await apart();
    await settled(app);
    await app.waitFor(`!shellTest.el(${quote(`${PANEL} [data-node-stats]`)}).hasAttribute('data-stale')`, PAGE_BACKSTOP_MS);
    const steady = await status(app);
    const during = await app.eval<{ status: string[]; stats: string[]; stale: boolean; drafts: number }>(`(async () => {
      const about = shellTest.el(${quote(`${PANEL} [data-inspector-about]`)});
      const status = new Set();
      const stats = new Set();
      let stale = false;
      let drafts = 0;
      const read = () => {
        status.add(about.querySelector('[data-status-text]').textContent);
        const row = about.querySelector('[data-node-stats]');
        stats.add(row.getAttribute('data-node-stats'));
        stale = stale || row.hasAttribute('data-stale');
      };
      const observer = new MutationObserver(read);
      observer.observe(about, { subtree: true, childList: true, characterData: true, attributes: true });
      const stop = orogenTest.ctx.engineState.subscribe((state, before) => { if (state.view !== before.view && state.view?.draft) drafts++; });
      read();
      const field = shellTest.el(${quote(field('radius'))});
      const box = field.getBoundingClientRect();
      const send = (type, x) => field.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: box.top + box.height / 2, movementX: 2,
      }));
      send('pointerdown', box.left + 40);
      for (let step = 1; step <= 30; step++) {
        send('pointermove', box.left + 40 + step * 2);
        await new Promise((done) => setTimeout(done, 25));
      }
      // The button stays down: the last draft arrives, and nothing refines it yet.
      for (let wait = 0; wait < 100 && (drafts === 0 || orogenTest.ctx.engineState.getState().evaluation !== null); wait++) await new Promise((done) => setTimeout(done, 25));
      read();
      observer.disconnect();
      stop();
      return { status: [...status], stats: [...stats], stale, drafts };
    })()`);
    assert.ok(during.drafts >= 2, `the drag was drafted: ${during.drafts} drafts were shown`);
    for (const text of during.status) assert.ok(text === steady || /^(Computing|Waiting)/.test(text), `during the drag the line was "${text}"; before it, "${steady}"`);
    assert.deepEqual(during.stats, ['known'], 'the numbers of the output stay while drafts are computed');
    assert.equal(during.stale, true, 'and are marked as those of the result before the drag');
    await app.eval(`void shellTest.release(${quote(field('radius'))})`);
    await settled(app);
    await app.waitFor(`!shellTest.el(${quote(`${PANEL} [data-node-stats]`)}).hasAttribute('data-stale')`, PAGE_BACKSTOP_MS);
    const dragged = (await inspect(app, out))!;
    await app.waitFor(`shellTest.text(${quote(`${PANEL} [data-node-stats] dd > div:first-child`)}) === ${quote(`${formatStat(dragged.min)} to ${formatStat(dragged.max)}, mean ${formatStat(dragged.mean)}`)}`, PAGE_BACKSTOP_MS);
    assert.match(await status(app), /^Computed · /);

    // ---- the numbers are asked for whenever a result is shown, also one of the revision that was shown before ----
    // While a build runs the session answers nothing (runtime.md 7.1), and when it has ended it shows the same
    // revision again. The session is made to answer so, and then shows what it showed.
    await app.eval(`void (() => {
      const engine = orogenTest.ctx.engine;
      window.inspectorAnswer = engine.inspect;
      engine.inspect = () => Promise.resolve(null);
    })()`);
    await select(app, [ids.noise]);
    // Whatever the selection made the engine do is over: from here on nothing changes but what the test changes.
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="unknown"]`);
    const shown = await app.eval<object>(`orogenTest.ctx.engineState.getState().view`);
    await app.eval(`void (() => {
      orogenTest.ctx.engine.inspect = window.inspectorAnswer;
      const store = orogenTest.ctx.engineState;
      store.setState({ ...store.getState(), view: { ...store.getState().view } }, true);
    })()`);
    await appears(app, `${PANEL} [data-node-stats="known"]`);
    assert.deepEqual(await app.eval<object>(`orogenTest.ctx.engineState.getState().view`), shown, 'the same revision at the same resolution, shown again');
    await select(app, [ids.blur], { height: out });
    await settled(app);
    await appears(app, `${PANEL} [data-node-stats="known"]`);

    // ---- renaming: the title field, and F2 ----
    const sent = await app.eval<number>(`orogenTest.ctx.doc.getState().engineRevision`);
    await app.eval(`void (shellTest.focus(${quote(TITLE)}), shellTest.type(${quote(TITLE)}, '  Soften  '))`);
    await key(app, 'Enter', {}, TITLE);
    assert.equal((await node(app, ids.blur)).title, 'Soften');
    assert.deepEqual((await past(app)).at(-1), { label: 'Rename Node', mergeKey: null });
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().engineRevision`), sent, 'a name is nothing the engine computes');
    await enter(app, field('radius'), '0.05');
    assert.equal((await past(app)).at(-1)!.label, 'Soften: Radius', 'the history names the node as the user does');
    // A title is at most 64 characters, however it gets into the field.
    await app.eval(`void (shellTest.focus(${quote(TITLE)}), shellTest.type(${quote(TITLE)}, ${quote('Long '.repeat(20))}))`);
    await key(app, 'Enter', {}, TITLE);
    assert.equal((await node(app, ids.blur)).title, 'Long '.repeat(13).slice(0, 64).trim());
    await undo(app);
    assert.equal((await node(app, ids.blur)).title, 'Soften');
    // The type's own title, or none, is no title of the node's.
    await app.eval(`void (shellTest.focus(${quote(TITLE)}), shellTest.type(${quote(TITLE)}, 'Blur'))`);
    await key(app, 'Enter', {}, TITLE);
    assert.equal((await node(app, ids.blur)).title, undefined);
    await undo(app);
    assert.equal((await node(app, ids.blur)).title, 'Soften');
    assert.equal(await app.eval<string>(`shellTest.el(${quote(TITLE)}).value`), 'Soften');
    // F2 with the inspector in front of the keyboard: the title takes the focus, all of it selected.
    await press(app, head('description'));
    assert.equal(await app.eval<string>(`orogenTest.ctx.ui.getState().focusedPanel`), 'inspector');
    await key(app, 'F2');
    await app.waitFor(`document.activeElement === shellTest.el(${quote(TITLE)})`, PAGE_BACKSTOP_MS);
    assert.deepEqual(await app.eval<number[]>(`[shellTest.el(${quote(TITLE)}).selectionStart, shellTest.el(${quote(TITLE)}).selectionEnd]`), [0, 6]);
    await key(app, 'Escape', {}, TITLE);

    // ---- bypass: the box, and B ----
    const box = `${PANEL} [data-action="bypass"] [data-ui="checkbox"]`;
    await settled(app);
    const computed = await contentKey(app, ids.blur);
    assert.equal(await attrOf(app, box, 'data-checked'), null);
    await press(app, box);
    assert.equal((await node(app, ids.blur)).bypass, true);
    assert.equal((await past(app)).at(-1)!.label, 'Bypass Node');
    assert.equal(await attrOf(app, box, 'data-checked'), '');
    await settled(app);
    assert.notEqual(await contentKey(app, ids.blur), computed, 'a bypassed node passes its input on: another content');
    const passed = (await inspect(app, out))!;
    const source = (await inspect(app, { node: ids.noise, port: 'out' }))!;
    assert.ok(Math.abs(passed.max - source.max) < 1e-6 && Math.abs(passed.mean - source.mean) < 1e-6, 'the output is the noise itself');
    await app.eval(`void shellTest.focus(${quote(box)})`);
    await key(app, 'KeyB');
    assert.equal((await node(app, ids.blur)).bypass, undefined);
    assert.equal((await past(app)).at(-1)!.label, 'Enable Node');
    // A generator has no input to pass on: its box cannot be set.
    await select(app, [ids.noise]);
    assert.equal(await app.eval<boolean>(`shellTest.el(${quote(box)}).hasAttribute('data-disabled')`), true);
    await app.eval(`void shellTest.hover(${quote(`${PANEL} [data-action="bypass"]`)})`);
    await appears(app, '[data-ui="tooltip"]');
    assert.match(await textOf(app, '[data-ui="tooltip"]'), /cannot be bypassed$/);

    // ---- a node that failed says why, and the node behind it says whom it waits for ----
    await select(app, [ids.failing], { height: { node: ids.after, port: 'out' } });
    await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null && orogenTest.ctx.engineState.getState().nodes[${quote(ids.after)}]?.state === 'skipped'`);
    assert.equal(await nodeState(app, ids.failing), 'error');
    await appears(app, `${PANEL} [data-node-error]`);
    assert.equal(await status(app), 'Failed');
    assert.equal(await attrOf(app, `${PANEL} [data-node-error]`, 'data-node-error'), 'node-exception');
    assert.equal(await textOf(app, `${PANEL} [data-node-error] span`), 'The ground gave way');
    assert.equal(await textOf(app, `${PANEL} [data-error-fact="Kind"] dd`), 'Node error');
    const real = await app.eval<NodeError>(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.failing)}].error`);
    if (real.detail) assert.equal(await textOf(app, `${PANEL} [data-error-detail]`), real.detail, 'the full message is there to be opened');
    t.diagnostic(`capture: ${await capture(app, 'node-failed')}`);
    await select(app, [ids.after]);
    assert.equal(await status(app), 'Skipped: Fail (Reference) failed');
    assert.equal(await exists(app, `${PANEL} [data-node-error]`), false);

    // ---- a shader error: the kernel, the line, and the excerpt with the failing line marked ----
    // No node of the product fails to compile, so the report is put into the engine's store as its event would put it.
    const shader: NodeError = {
      nodeId: ids.blur, nodeType: 'filter/blur', kind: 'shader-compile', kernel: 'filter/blur.pass',
      message: 'kernel "filter/blur.pass": unresolved value \'radiu\'',
      detail: 'error: unresolved value \'radiu\'\n    let r = params.radiu;\n                   ^^^^^\n - While validating [ShaderModuleDescriptor "filter/blur.pass"]',
      wgsl: {
        origin: 'code', line: 12, column: 20, length: 5, message: 'unresolved value \'radiu\'',
        excerpt: ['  let c = x_at(px);', '  var sum = 0.0;', '  let r = params.radiu;', '  for (var i = -4; i <= 4; i++) {', '    sum += x_at(px + vec2i(i, 0));'],
      },
    };
    await select(app, [ids.blur]);
    await report(app, ids.blur, { state: 'error', error: shader });
    await appears(app, `${PANEL} [data-node-error="shader-compile"]`);
    assert.equal(await textOf(app, `${PANEL} [data-node-error] span`), shader.message);
    assert.deepEqual(
      await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PANEL} [data-error-fact]`)})].map((fact) => fact.getAttribute('data-error-fact') + ': ' + fact.querySelector('dd').textContent)`),
      ['Kind: Shader error', 'Kernel: filter/blur.pass', 'Line: 12, column 20, in kernel code'],
    );
    assert.equal(await count(app, `${PANEL} [data-error-excerpt] > div`), 5);
    assert.equal(await textOf(app, `${PANEL} [data-error-excerpt] > [data-failing]`), '12  let r = params.radiu;', 'the failing line, with its number');
    assert.equal(await textOf(app, `${PANEL} [data-error-excerpt] > div:first-child`), '10  let c = x_at(px);');
    assert.equal(await textOf(app, `${PANEL} [data-error-detail]`), shader.detail);
    await app.eval(`void (shellTest.el(${quote(`${PANEL} [data-node-error] details`)}).open = true)`);
    t.diagnostic(`capture: ${await capture(app, 'node-shader-error')}`);

    // ---- a node that is running says how far it is ----
    await report(app, ids.blur, { state: 'running', error: null, fraction: 0.416, label: 'Pass 5 of 12', etaMs: 4200 });
    await app.waitFor(`shellTest.text(${quote(`${PANEL} [data-status-text]`)}) === 'Computing 42 % · Pass 5 of 12 · 4.20 s left'`, PAGE_BACKSTOP_MS);
    assert.equal(await attrOf(app, `${PANEL} [role="progressbar"]`, 'aria-valuenow'), '42');
    t.diagnostic(`capture: ${await capture(app, 'node-running')}`);
    await report(app, ids.blur, { state: 'done', fraction: 1, label: null, etaMs: null });

    // ---- and a node that really runs for seconds: an erosion at the full build resolution ----
    await select(app, [ids.erosion], { height: { node: ids.erosion, port: 'out' } });
    await settled(app);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Preview', (draft) => { draft.settings.previewLevel = 0; }, { undoable: false })`);
    await enter(app, field('duration'), '8');
    await app.waitFor(`(() => {
      const record = orogenTest.ctx.engineState.getState().nodes[${quote(ids.erosion)}];
      return record?.state === 'running' && record.fraction > 0.02 && /^Computing [0-9]+ % · /.test(shellTest.text(${quote(`${PANEL} [data-status-text]`)}));
    })()`);
    const running = await app.eval<{ text: string; bar: string | null; tone: string | null; record: { fraction: number; label: string | null } }>(`({
      text: shellTest.text(${quote(`${PANEL} [data-status-text]`)}),
      bar: document.querySelector(${quote(`${PANEL} [role="progressbar"]`)})?.getAttribute('aria-valuenow') ?? null,
      tone: shellTest.attr(${quote(`${PANEL} [data-status-text]`)}, 'data-tone'),
      record: orogenTest.ctx.engineState.getState().nodes[${quote(ids.erosion)}],
    })`);
    assert.match(running.text, /^Computing \d+ % · Hydraulic erosion( · .+ left)?$/, running.text);
    assert.ok(running.bar !== null && Number(running.bar) > 0 && Number(running.bar) < 100, `the bar shows the progress: ${running.bar}`);
    assert.equal(running.tone, 'running');
    assert.equal(await attrOf(app, `${PANEL} [data-node-stats]`, 'data-stale'), '', 'the numbers are those of the terrain still on screen');
    t.diagnostic(`capture: ${await capture(app, 'node-running-erosion')}`);
    // Undone in the middle of the run: the node is computed as it was, and says so.
    await undo(app);
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Preview', (draft) => { draft.settings.previewLevel = 1; }, { undoable: false })`);
    await settled(app);
    await app.waitFor(`/^Computed · /.test(shellTest.text(${quote(`${PANEL} [data-status-text]`)}))`, PAGE_BACKSTOP_MS);
    assert.equal(await exists(app, `${PANEL} [role="progressbar"]`), false);
  });
});

test('node: several nodes of one type are edited together, and nodes of several types are a summary', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);
    await select(app, [ids.noise, ids.second]);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'nodes');
    assert.equal(await textOf(app, head('count')), '2 × Fractal Noise');
    assert.equal(await exists(app, TITLE), false, 'two nodes have no one title to edit');
    assert.equal(await count(app, `${PANEL} [data-param]`), 8);
    // The second noise is no part of what is shown; whether it has been computed for its thumbnail is the graph's business.
    assert.match(await status(app), /^(1 computed, 1 not computed|2 computed)$/);

    // The second node has 5 octaves, the first 8: the row shows the first value and says that they differ.
    assert.equal(await attrOf(app, row('octaves'), 'data-mixed'), '');
    assert.equal(await textOf(app, `${row('octaves')} [data-mixed]`), 'mixed');
    assert.equal(await attrOf(app, field('octaves'), 'data-value'), '8');
    assert.equal(await attrOf(app, row('gain'), 'data-mixed'), null);

    // A typed value goes to both, in one entry; one undo takes it from both.
    await enter(app, field('octaves'), '3');
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'octaves'), await paramOf<number>(app, ids.second, 'octaves')], [3, 3]);
    assert.deepEqual(await past(app), [{ label: '2 × Fractal Noise: Octaves', mergeKey: `param:${ids.noise}+${ids.second}:octaves` }]);
    assert.equal(await attrOf(app, row('octaves'), 'data-mixed'), null);
    await undo(app);
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'octaves'), await paramOf<number>(app, ids.second, 'octaves')], [8, 5]);
    assert.equal(await attrOf(app, row('octaves'), 'data-mixed'), '');

    // A drag moves both, as one gesture and one entry.
    await scrub(app, field('gain'), 45);
    const gains = [await paramOf<number>(app, ids.noise, 'gain'), await paramOf<number>(app, ids.second, 'gain')];
    assert.ok(gains[0]! > 0.5 && gains[0] === gains[1], `both nodes: ${gains.join(', ')}`);
    assert.deepEqual((await past(app)).map((entry) => entry.label), ['2 × Fractal Noise: Roughness']);
    await apart();
    await choose(app, row('mode'), 'ridged');
    assert.deepEqual([await paramOf<string>(app, ids.noise, 'mode'), await paramOf<string>(app, ids.second, 'mode')], ['ridged', 'ridged']);
    // The dice gives both the same seed.
    await press(app, `${row('seed')} [data-command="inspector.randomizeSeed"]`);
    const seeds = [await paramOf<number>(app, ids.noise, 'seed'), await paramOf<number>(app, ids.second, 'seed')];
    assert.ok(seeds[0]! > 0 && seeds[0] === seeds[1], `both nodes: ${seeds.join(', ')}`);
    t.diagnostic(`capture: ${await capture(app, 'nodes-edited-together')}`);

    // The reset of the head sets every parameter of both back, in one entry.
    const steps = (await past(app)).length;
    await press(app, `${PANEL} [data-command="inspector.resetAll"]`);
    assert.equal((await past(app)).length, steps + 1);
    assert.equal((await past(app)).at(-1)!.label, '2 × Fractal Noise: Reset Parameters');
    for (const id of [ids.noise, ids.second]) {
      assert.deepEqual([await paramOf<number>(app, id, 'octaves'), await paramOf<number>(app, id, 'gain'), await paramOf<string>(app, id, 'mode'), await paramOf<number>(app, id, 'seed')], [8, 0.5, 'fbm', 0]);
    }
    assert.equal(await count(app, `${PANEL} [data-param][data-changed]`), 0);

    // ---- nodes of several types: what is selected, their state, and the bypass of those that have one ----
    await select(app, [ids.noise, ids.blur, ids.second]);
    assert.equal(await attrOf(app, `${PANEL} [data-inspector]`, 'data-inspector'), 'summary');
    assert.equal(await textOf(app, head('count')), '3 nodes selected');
    assert.deepEqual(await app.eval<string[]>(`[...document.querySelectorAll(${quote(`${PANEL} [data-inspector-types] > li`)})].map((item) => item.textContent)`), [
      '2 × Fractal Noisegenerate/fractal-noise', '1 × Blurfilter/blur',
    ]);
    assert.equal(await count(app, `${PANEL} [data-param]`), 0, 'no parameters are offered');
    assert.match(await textOf(app, `${PANEL} [data-inspector-hint]`), /^Select nodes of one type/);
    await press(app, `${PANEL} [data-action="bypass"] [data-ui="checkbox"]`);
    const held = await docOf(app);
    assert.deepEqual([held.nodes[ids.blur]!.bypass, held.nodes[ids.noise]!.bypass, held.nodes[ids.second]!.bypass], [true, undefined, undefined]);
    t.diagnostic(`capture: ${await capture(app, 'nodes-summary')}`);

    // ---- two nodes of which one is bypassed: the box says that they differ, and a press bypasses both ----
    await select(app, [ids.blur, ids.after]);
    const bypass = `${PANEL} [data-action="bypass"]`;
    assert.deepEqual([await attrOf(app, bypass, 'data-mixed'), await textOf(app, bypass), await attrOf(app, `${bypass} [data-ui="checkbox"]`, 'data-checked')], ['', 'Bypassmixed', null]);
    await app.eval(`void shellTest.hover(${quote(bypass)})`);
    await appears(app, '[data-ui="tooltip"]');
    assert.match(await textOf(app, '[data-ui="tooltip"]'), /1 of the 2 selected nodes are bypassed/);
    await press(app, `${bypass} [data-ui="checkbox"]`);
    assert.deepEqual([(await docOf(app)).nodes[ids.blur]!.bypass, (await docOf(app)).nodes[ids.after]!.bypass], [true, true]);
    assert.deepEqual([await attrOf(app, bypass, 'data-mixed'), await textOf(app, bypass), await attrOf(app, `${bypass} [data-ui="checkbox"]`, 'data-checked')], [null, 'Bypass', '']);
    await undo(app);
    await undo(app);
    assert.deepEqual([(await docOf(app)).nodes[ids.blur]!.bypass, (await docOf(app)).nodes[ids.after]!.bypass], [undefined, undefined]);

    // ---- a selected node that is deleted leaves the project settings, and comes back with the undo ----
    await select(app, [ids.second]);
    assert.equal(await app.eval<string>(`shellTest.el(${quote(TITLE)}).value`), 'Fractal Noise');
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Delete', (draft) => { delete draft.nodes[${quote(ids.second)}]; })`);
    await app.waitFor(`shellTest.attr(${quote(`${PANEL} [data-inspector]`)}, 'data-inspector') === 'settings'`, PAGE_BACKSTOP_MS);
    await undo(app);
    await app.waitFor(`shellTest.attr(${quote(`${PANEL} [data-inspector]`)}, 'data-inspector') === 'nodes'`, PAGE_BACKSTOP_MS);
    assert.equal(await count(app, `${PANEL} [data-param]`), 8);

    // ---- a node saved by another version of its type is shown, said to be so, and not edited (runtime.md 4.5) ----
    await app.eval(`void orogenTest.ctx.doc.getState().transact('Other version', (draft) => { draft.nodes[${quote(ids.second)}].version = 7; })`);
    await appears(app, `${PANEL} [data-inspector-locked]`);
    assert.match(await textOf(app, `${PANEL} [data-inspector-locked]`), /^Saved with version 7 of this node; this build has version 1\./);
    // The engine refuses the node with the same sentence: it is said once, by the notice.
    await app.waitFor(`orogenTest.ctx.engineState.getState().nodes[${quote(ids.second)}]?.error?.kind === 'version'`, PAGE_BACKSTOP_MS);
    assert.equal(await status(app), 'Failed');
    assert.equal(await count(app, `${PANEL} [data-node-error]`), 0);
    assert.equal((await textOf(app, `${PANEL} [data-inspector-body]`)).split('Saved with version 7').length - 1, 1);
    assert.equal(await count(app, `${PANEL} [data-param] [data-ui="number-field"]:not([data-disabled])`), 0, 'every number field is disabled');
    const revision = await app.eval<number>(`orogenTest.ctx.doc.getState().revision`);
    await scrub(app, field('gain'), 40);
    await press(app, field('octaves'));
    assert.equal(await exists(app, `${field('octaves')} input`), false, 'a disabled field opens no entry');
    await press(app, `${row('seed')} [data-command="inspector.randomizeSeed"]`);
    assert.equal(await app.eval<number>(`orogenTest.ctx.doc.getState().revision`), revision, 'nothing was changed');
    t.diagnostic(`capture: ${await capture(app, 'node-other-version')}`);
    await undo(app);
    assert.equal(await exists(app, `${PANEL} [data-inspector-locked]`), false);
  });
});

test('node: every command of the panel runs, from the context, the menu and its key', async (t) => {
  await withProject(FILE, async (app) => {
    await settled(app);
    const enabled = (id: string): Promise<boolean> => app.eval<boolean>(`(() => {
      const item = document.querySelector('[data-ui="menu"][data-menu="Inspector"] [data-item="${id}"]');
      return item !== null && !item.hasAttribute('data-disabled');
    })()`);

    // The menu of the panel lists its commands, each with its key, enabled for what is selected.
    await select(app, [ids.noise]);
    const items = await openMenu(app, 'Inspector');
    assert.deepEqual(items.map((item) => item.id), [
      'inspector.rename', 'inspector.toggleBypass', 'inspector.resetParameter', 'inspector.resetAll', 'inspector.randomizeSeed', 'inspector.reloadFiles',
      'inspector.expandAll', 'inspector.collapseAll',
    ]);
    assert.deepEqual(items.map((item) => item.label), [
      'Rename Node', 'Bypass Node', 'Reset Parameter', 'Reset All Parameters', 'Randomize Seed', 'Reload Files', 'Expand All Sections', 'Collapse All Sections',
    ]);
    assert.deepEqual(items.filter((item) => item.key !== null).map((item) => [item.id, item.key]), [['inspector.rename', 'F2'], ['inspector.toggleBypass', 'B']]);
    assert.deepEqual(items.filter((item) => item.enabled).map((item) => item.id), ['inspector.rename', 'inspector.randomizeSeed', 'inspector.expandAll', 'inspector.collapseAll']);
    t.diagnostic(`capture: ${await capture(app, 'menu')}`);

    // ---- from the menu: the sections ----
    await press(app, '[data-ui="menu"][data-menu="Inspector"] [data-item="inspector.collapseAll"]');
    await vanishes(app, '[data-ui="menu"][data-menu="Inspector"]');
    assert.equal(await attrOf(app, `${PANEL} [data-section="Warp"]`, 'data-open'), null);
    assert.equal(await exists(app, row('warpSize')), false);
    await run(app, 'inspector.expandAll');
    assert.equal(await attrOf(app, `${PANEL} [data-section="Warp"]`, 'data-open'), '');

    // ---- the seed, the reset of the parameter under the pointer, the reset of all ----
    await run(app, 'inspector.randomizeSeed');
    const seed = await paramOf<number>(app, ids.noise, 'seed');
    assert.ok(seed > 0);
    await enter(app, field('octaves'), '4');
    // The pointer comes onto the row of the seed: that is the parameter "Reset Parameter" means.
    await app.eval(`void inspectorTest.enter(${quote(row('seed'))})`);
    await run(app, 'inspector.resetParameter');
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'seed'), await paramOf<number>(app, ids.noise, 'octaves')], [0, 4]);
    assert.equal((await past(app)).at(-1)!.label, 'Fractal Noise: Reset Seed');
    await openMenu(app, 'Inspector');
    assert.equal(await enabled('inspector.resetParameter'), false, 'the seed is at its default again');
    assert.equal(await enabled('inspector.resetAll'), true);
    await closeMenu(app);
    // From the menu the command means the parameter that was last pressed: on its way to the menu bar the pointer
    // crosses the rows above and leaves each again, and none of them is what the user chose.
    const leave = (name: string): Promise<void> => app.eval<void>(`void shellTest.el(${quote(row(name))}).dispatchEvent(new PointerEvent('pointerout', { bubbles: true, cancelable: true, composed: true, relatedTarget: document.body }))`);
    await leave('seed');
    await enter(app, field('gain'), '0.8');
    await scrub(app, field('octaves'), -20);
    assert.notEqual(await paramOf<number>(app, ids.noise, 'octaves'), 4);
    for (const crossed of ['gain', 'size', 'mode']) {
      await app.eval(`void inspectorTest.enter(${quote(row(crossed))})`);
      await leave(crossed);
    }
    await openMenu(app, 'Inspector');
    assert.equal(await enabled('inspector.resetParameter'), true);
    await press(app, '[data-ui="menu"][data-menu="Inspector"] [data-item="inspector.resetParameter"]');
    await vanishes(app, '[data-ui="menu"][data-menu="Inspector"]');
    assert.deepEqual([await paramOf<number>(app, ids.noise, 'octaves'), await paramOf<number>(app, ids.noise, 'gain')], [8, 0.8], 'the octaves, which were dragged last; not the roughness the pointer crossed');
    assert.equal((await past(app)).at(-1)!.label, 'Fractal Noise: Reset Octaves');
    await run(app, 'inspector.resetAll');
    assert.equal(await paramOf<number>(app, ids.noise, 'gain'), 0.5);

    // ---- rename: the command gives the title the focus ----
    await run(app, 'inspector.rename');
    await app.waitFor(`document.activeElement === shellTest.el(${quote(TITLE)})`, PAGE_BACKSTOP_MS);
    await app.eval(`void shellTest.type(${quote(TITLE)}, 'Base')`);
    await key(app, 'Enter', {}, TITLE);
    assert.equal((await node(app, ids.noise)).title, 'Base');

    // ---- bypass ----
    await select(app, [ids.blur]);
    await run(app, 'inspector.toggleBypass');
    assert.equal((await node(app, ids.blur)).bypass, true);
    await run(app, 'inspector.toggleBypass');
    assert.equal((await node(app, ids.blur)).bypass, undefined);

    // ---- reload: the engine is told its project again and evaluates anew ----
    await select(app, [ids.imported], { height: { node: ids.blur, port: 'out' } });
    await settled(app);
    const request = await app.eval<number>(`orogenTest.ctx.engineState.getState().viewRequestId`);
    await run(app, 'inspector.reloadFiles');
    await app.waitFor(`orogenTest.ctx.engineState.getState().viewRequestId > ${request}`, PAGE_BACKSTOP_MS);
    await settled(app);

    // ---- an export node runs in a build and in no preview: that is what its head says, not that something is missing ----
    await select(app, [ids.landscape]);
    assert.equal(await textOf(app, `${PANEL} [data-status-text]`), 'Runs when the project is built');
    assert.equal(await exists(app, `${PANEL} [data-node-stats]`), false, 'it has no output to measure');

    // ---- with nothing selected the dice is the project's ----
    await select(app, []);
    await run(app, 'inspector.randomizeSeed');
    assert.ok((await docOf(app)).settings.seed > 0);
    assert.equal((await past(app)).at(-1)!.label, 'Project: Seed');
    await settled(app);
  });
});
