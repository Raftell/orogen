// Copy, cut and paste in the graph are the DOM's clipboard events at the panel, and what is on the clipboard is
// text (runtime.md 8.8 rules 3 and 6): nodes copied in one application are pasted into a second one that runs
// beside it. The tests give each event a clipboard of its own, so the desktop's clipboard, which is the user's,
// is neither read nor written; how the shell's Edit commands reach these events is the shell's own test.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { launchApp, type AppDriver } from '../../helpers/index.ts';
import {
  added, appears, attr, capture, click, docked, docOf, focusGraph, graphSettled, history, install, key, near, nodeBox, nodeSelector, quote, ready,
  selection, settled, titleOf, undo, vanishes, wires,
} from './rig.ts';

interface Taken { readonly taken: boolean; readonly text: string }
const clipboard = (app: AppDriver, type: 'copy' | 'cut' | 'paste', text?: string): Promise<Taken> =>
  app.eval<Taken>(`graphTest.clipboard(${quote(type)}${text === undefined ? '' : `, ${quote(text)}`})`);

async function selectTwo(app: AppDriver): Promise<void> {
  await click(app, await titleOf(app, 'talus'));
  await app.eval(`void graphTest.keyDown('ShiftLeft', 'Shift', { shiftKey: true })`);
  await click(app, await titleOf(app, 'mixed'), { shiftKey: true });
  await app.eval(`void graphTest.keyUp('ShiftLeft', 'Shift')`);
  assert.deepEqual(await selection(app), ['talus', 'mixed']);
}

test('clipboard: nodes copied in one application are pasted into another; cut, and what is not nodes', async (t) => {
  const running: AppDriver[] = [];
  const launch = async (open?: string): Promise<AppDriver> => {
    const app = await launchApp({ profile: 'core', ...(open === undefined ? {} : { open }) });
    running.push(app);
    await install(app);
    await ready(app);
    await docked(app);
    await graphSettled(app);
    await focusGraph(app);
    return app;
  };
  const end = async (app: AppDriver): Promise<void> => {
    running.splice(running.indexOf(app), 1);
    await app.close();
  };

  try {
    // ---- the first application: two connected nodes are copied ----
    const first = await launch('tests/graphs/03-simulate.orogen');
    assert.deepEqual(await clipboard(first, 'copy'), { taken: false, text: '' }, 'nothing selected: the event is left alone');
    await selectTwo(first);
    const copied = await clipboard(first, 'copy');
    assert.equal(copied.taken, true, 'the graph took the event and put text on its clipboard');
    const held = JSON.parse(copied.text) as { format: string; nodes: { id: string; type: string }[]; edges: unknown[] };
    assert.deepEqual([held.format, held.nodes.map((node) => node.type).sort(), held.edges.length], ['orogen-nodes', ['ref/combine', 'ref/talus'], 2]);
    assert.deepEqual(await history(first), [], 'copying changes nothing');
    t.diagnostic(`the clipboard text is ${copied.text.length} characters`);

    // ---- a second application, beside the first: the text is pasted where the pointer is ----
    const second = await launch();
    const start = await docOf(second);
    const range = Object.keys(start.nodes)[0]!;
    const box = await nodeBox(second, range);
    const at = { x: box.x - 420, y: box.y - 90 };
    await second.eval(`void graphTest.hover(${at.x}, ${at.y})`);
    assert.equal((await clipboard(second, 'paste', copied.text)).taken, true);
    const pasted = await added(second, start);
    assert.equal(pasted.length, 2);
    let doc = await docOf(second);
    assert.deepEqual(pasted.map((id) => doc.nodes[id]!.type).sort(), ['ref/combine', 'ref/talus']);
    const talus = pasted.find((id) => doc.nodes[id]!.type === 'ref/talus')!;
    const combine = pasted.find((id) => doc.nodes[id]!.type === 'ref/combine')!;
    assert.deepEqual(await wires(second), [`${talus}.moved>${combine}.mask`, `${talus}.out>${combine}.a`].sort(), 'the wires between the two came along, and no other');
    assert.deepEqual((await selection(second)).sort(), [...pasted].sort(), 'what was pasted is selected');
    assert.deepEqual(await history(second), ['Paste']);
    // The top-left corner of what was copied lies under the pointer, and the two keep their places to each other.
    const pastedBox = await nodeBox(second, talus);
    near(pastedBox.x, at.x, 2, 'pasted at the pointer, x');
    near(pastedBox.y, at.y, 2, 'pasted at the pointer, y');
    assert.equal(doc.nodes[combine]!.position.x - doc.nodes[talus]!.position.x, 280);
    await appears(second, nodeSelector(talus));
    await appears(second, nodeSelector(combine));
    // The pasted nodes are nodes like any other: the one that lacks an input says so.
    assert.equal(await attr(second, nodeSelector(talus), 'data-status'), 'missing');
    t.diagnostic(`capture: ${await capture(second, 'clipboard-01-pasted-into-a-second-application')}`);

    await undo(second);
    assert.deepEqual(Object.keys((await docOf(second)).nodes), [range]);
    assert.deepEqual(await selection(second), []);

    // ---- text that is not nodes is not the graph's: nothing changes, and the event is left to whoever wants it ----
    assert.deepEqual(await clipboard(second, 'paste', 'just a line of text'), { taken: false, text: 'just a line of text' });
    assert.deepEqual(await clipboard(second, 'paste', '{"format":"orogen","version":1}'), { taken: false, text: '{"format":"orogen","version":1}' });
    assert.deepEqual(Object.keys((await docOf(second)).nodes), [range]);
    assert.deepEqual(await history(second), []);
    await end(second);

    // ---- back in the first: cut takes the nodes away as one step, and a paste brings copies back ----
    const before = await docOf(first);
    const cut = await clipboard(first, 'cut');
    assert.equal(cut.taken, true);
    assert.ok(cut.text === copied.text, 'the same text as the copy');
    doc = await docOf(first);
    assert.deepEqual(Object.keys(doc.nodes).sort(), ['dist', 'fbm', 'steep']);
    assert.deepEqual(await wires(first), ['steep.out>dist.in']);
    assert.deepEqual(await history(first), ['Cut']);
    await vanishes(first, nodeSelector('talus'));
    await undo(first);
    assert.equal(Object.keys((await docOf(first)).nodes).length, 5);
    assert.deepEqual(await selection(first), ['talus', 'mixed']);

    // While a name is typed the clipboard is the field's: the graph does not paste nodes into the document.
    await click(first, await titleOf(first, 'fbm'));
    await key(first, 'F2');
    const field = `${nodeSelector('fbm')} [data-graph="rename"]`;
    await appears(first, field);
    const inField = await first.eval<boolean>(`(() => {
      const data = new DataTransfer();
      data.setData('text/plain', ${quote(copied.text)});
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      document.querySelector(${quote(field)}).dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(inField, false);
    assert.equal(Object.keys((await docOf(first)).nodes).length, 5);
    await key(first, 'Escape', {}, field);
    await vanishes(first, field);

    // Pasted twice at one place, the second copy does not hide the first.
    const spot = await nodeBox(first, 'fbm');
    await first.eval(`void graphTest.hover(${spot.x + 40}, ${spot.y + spot.height + 30})`);
    await clipboard(first, 'paste', copied.text);
    await clipboard(first, 'paste', copied.text);
    doc = await docOf(first);
    const copies = Object.keys(doc.nodes).filter((id) => !Object.hasOwn(before.nodes, id) && doc.nodes[id]!.type === 'ref/talus');
    assert.equal(copies.length, 2);
    assert.notDeepEqual(doc.nodes[copies[0]!]!.position, doc.nodes[copies[1]!]!.position);
    assert.equal(Object.keys(doc.nodes).length, 9);
    assert.deepEqual((await history(first)).slice(-2), ['Paste', 'Paste']);
    await settled(first);
    await end(first);
  } finally {
    for (const app of running.splice(0)) await app.close().catch(() => {});
  }
});
