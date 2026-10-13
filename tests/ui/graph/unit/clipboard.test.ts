// Nodes on the clipboard are text (runtime.md 8.8 rule 3): what one application copies another pastes. The
// round trip goes through the text alone, between two benches that share nothing but the registry.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyNodes, setNodeFlags, setParam } from '../../../../src/core/runtime.ts';
import { copyText, cutText, duplicateSelection, pasteText } from '../../../../src/app/panels/graph/actions.ts';
import { CLIPBOARD_FORMAT, fragmentFromText, fragmentToText } from '../../../../src/app/panels/graph/clipboard.ts';
import { setSelection } from '../../../../src/app/state/ui-store.ts';
import { bench, REGISTRY, wiring, type Bench } from './_graph.ts';

function terrain(b: Bench): { range: string; blur: string; terraces: string } {
  const range = b.add('generate/mountain-range', { x: 100, y: 80 });
  const blur = b.add('filter/blur', { x: 400, y: 120 }, { in: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 700, y: 80 }, { in: `${blur}.out`, mask: `${range}.out` });
  b.doc.getState().transact('Edit', (draft) => {
    setParam(draft, REGISTRY, blur, 'radius', 0.03);
    setParam(draft, REGISTRY, terraces, 'levels', 5);
    setNodeFlags(draft, blur, { title: 'Soften', bypass: true });
  });
  return { range, blur, terraces };
}

test('a fragment is text that says what it is, and comes back as the fragment it was', () => {
  const b = bench();
  const { blur, terraces } = terrain(b);
  const fragment = copyNodes(b.now(), [blur, terraces]);
  const text = fragmentToText(fragment);
  assert.equal(typeof text, 'string');
  assert.equal(JSON.parse(text).format, CLIPBOARD_FORMAT);
  const back = fragmentFromText(text)!;
  assert.ok(JSON.stringify({ nodes: back.nodes, edges: back.edges }) === JSON.stringify(fragment), 'the same nodes and edges');
  assert.deepEqual(back.groups, []);
  assert.equal(Object.hasOwn(JSON.parse(text), 'groups'), false, 'without groups the text names none');
  assert.equal(back.nodes.length, 2);
  assert.equal(back.edges.length, 1, 'only the wire between the two copied nodes');
});

test('any other text is not nodes: nothing is pasted, and nothing thrown', () => {
  for (const text of ['', 'hello', '42', '[]', '{}', '{"format":"orogen","version":1,"nodes":{}}', '{"format":"orogen-nodes","version":99,"nodes":[{}]}',
    '{"format":"orogen-nodes","version":1,"nodes":[]}', '{"format":"orogen-nodes","version":1}', '{broken']) {
    assert.equal(fragmentFromText(text), null, text);
  }
  assert.equal(fragmentFromText(undefined as unknown as string), null);
  const b = bench();
  const before = b.now();
  assert.equal(pasteText(b, 'just some text', { x: 0, y: 0 }), null);
  // A fragment whose entries are no nodes pastes nothing and leaves no step behind (pasteNodes reads each as the loader does).
  assert.equal(pasteText(b, '{"format":"orogen-nodes","version":1,"nodes":[1,"x",{"id":5}],"edges":[7]}', { x: 0, y: 0 }), null);
  assert.equal(b.now(), before);
  assert.deepEqual(b.labels(), []);
});

test('copy in one application, paste in another: the same nodes with their parameters, names, flags and the wires between them', () => {
  const first = bench();
  const { range, blur, terraces } = terrain(first);
  setSelection(first.ui, [blur, terraces]);
  const text = copyText(first)!;
  assert.equal(first.now().nodes[blur]!.title, 'Soften', 'copying changes nothing');

  const second = bench();
  const made = pasteText(second, text, { x: 1000, y: 500 })!;
  const doc = second.now();
  assert.equal(made.length, 2);
  assert.deepEqual(second.ui.getState().selection, made, 'what was pasted is selected');
  assert.deepEqual(second.labels(), ['Paste']);
  const [pastedBlur, pastedTerraces] = made.map((id) => doc.nodes[id]!);
  assert.ok(!made.includes(blur) && !made.includes(terraces), 'the copies have ids of their own');
  assert.deepEqual([pastedBlur!.type, pastedBlur!.title, pastedBlur!.bypass, pastedBlur!.params.radius], ['filter/blur', 'Soften', true, 0.03]);
  assert.deepEqual([pastedTerraces!.type, pastedTerraces!.params.levels], ['surface/terraces', 5]);
  // The top-left corner of what was copied lies where it was pasted; the nodes keep their places to each other.
  assert.deepEqual([pastedBlur!.position, pastedTerraces!.position], [{ x: 1000, y: 540 }, { x: 1300, y: 500 }]);
  // The wire between the two came along; the wires from the node that was not copied did not.
  assert.deepEqual(wiring(doc), [`${made[0]}.out>${made[1]}.in`]);
  assert.equal(Object.hasOwn(doc.nodes, range), false);

  // One step back and the paste is gone; the selection is what it was before.
  second.doc.getState().undo();
  assert.deepEqual([Object.keys(second.now().nodes).length, second.ui.getState().selection], [0, []]);
});

test('cut takes the nodes away as one step and leaves them on the clipboard; a paste at the same place does not hide what is there', () => {
  const b = bench();
  const { range, blur, terraces } = terrain(b);
  setSelection(b.ui, [blur]);
  const steps = b.labels().length;
  const text = cutText(b)!;
  assert.deepEqual([Object.hasOwn(b.now().nodes, blur), wiring(b.now())], [false, [`${range}.out>${terraces}.mask`]]);
  assert.deepEqual(b.labels().slice(steps), ['Cut']);
  assert.deepEqual(b.ui.getState().selection, []);

  const once = pasteText(b, text, { x: 50, y: 50 })!;
  const twice = pasteText(b, text, { x: 50, y: 50 })!;
  const [a, c] = [b.now().nodes[once[0]!]!.position, b.now().nodes[twice[0]!]!.position];
  assert.deepEqual(a, { x: 50, y: 50 });
  assert.ok(c.x > a.x && c.y > a.y, 'the second copy lies a little down and right of the first');
  assert.equal(copyText(bench()), null, 'nothing selected: nothing to copy');
  assert.equal(cutText(bench()), null);
});

test('duplicate copies the selection beside itself with the wires between the copies, as one step', () => {
  const b = bench();
  const { range, blur, terraces } = terrain(b);
  setSelection(b.ui, [blur, terraces]);
  const steps = b.labels().length;
  const made = duplicateSelection(b);
  const doc = b.now();
  assert.equal(made.length, 2);
  assert.deepEqual(b.labels().slice(steps), ['Duplicate']);
  assert.deepEqual(b.ui.getState().selection, made);
  assert.deepEqual(doc.nodes[made[0]!]!.position, { x: 424, y: 144 });
  assert.equal(doc.nodes[made[0]!]!.title, 'Soften');
  assert.deepEqual(wiring(doc), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`, `${range}.out>${terraces}.mask`, `${made[0]}.out>${made[1]}.in`].sort());
  b.doc.getState().undo();
  assert.deepEqual([Object.keys(b.now().nodes).length, b.ui.getState().selection], [3, [blur, terraces]]);
  setSelection(b.ui, []);
  assert.deepEqual(duplicateSelection(b), []);
});

test('the groups that frame what is copied go along: selected, or with every node of theirs copied; and they keep their place to the nodes', () => {
  const first = bench();
  const { range, blur, terraces } = terrain(first);
  first.group({ id: 'tail', title: 'Tail', color: '#246283', rect: { x: 380, y: 30, w: 580, h: 260 } });   // blur and terraces
  first.group({ id: 'all', title: 'All', rect: { x: 60, y: 0, w: 940, h: 320 } });                          // the three, and the group above
  first.group({ id: 'far', title: 'Far', rect: { x: 2000, y: 0, w: 300, h: 200 } });                        // nothing

  // The two nodes of 'Tail' copied: its frame goes along; 'All' holds a node that is not copied, and 'Far' none at all.
  setSelection(first.ui, [blur, terraces]);
  const text = copyText(first)!;
  assert.deepEqual(fragmentFromText(text)!.groups.map((group) => group.title), ['Tail']);
  // A selected group goes along whatever it holds.
  first.local.setState({ groupSelection: ['far'] });
  assert.deepEqual(fragmentFromText(copyText(first)!)!.groups.map((group) => group.title).sort(), ['Far', 'Tail']);
  first.local.setState({ groupSelection: [] });

  const second = bench();
  const made = pasteText(second, text, { x: 1000, y: 500 })!;
  const doc = second.now();
  const [frame] = Object.values(doc.groups);
  assert.equal(Object.keys(doc.groups).length, 1);
  assert.notEqual(frame!.id, 'tail', 'the copy has an id of its own');
  assert.deepEqual([frame!.title, frame!.color], ['Tail', '#246283']);
  // The nodes' top-left corner went from (400, 80) to (1000, 500): the frame moved by as much, and holds them still.
  assert.deepEqual(frame!.rect, { x: 380 + 600, y: 30 + 420, w: 580, h: 260 });
  assert.deepEqual(doc.nodes[made[0]!]!.position, { x: 1000, y: 540 });
  assert.deepEqual(second.labels(), ['Paste'], 'nodes and frame are one step');
  second.doc.getState().undo();
  assert.deepEqual([Object.keys(second.now().nodes).length, Object.keys(second.now().groups).length], [0, 0]);

  // Cut takes the frame away with its nodes, as one step.
  const steps = first.labels().length;
  cutText(first);
  assert.deepEqual([Object.keys(first.now().nodes), Object.keys(first.now().groups).sort()], [[range], ['all', 'far']]);
  assert.deepEqual(first.labels().slice(steps), ['Cut']);
  first.doc.getState().undo();
  assert.deepEqual(Object.keys(first.now().groups).sort(), ['all', 'far', 'tail']);

  // A text from anywhere: what is no group is left out, and what is one is read member by member.
  const held = JSON.parse(text) as { groups: unknown[] };
  held.groups = [
    null, 5, { title: 'No frame' }, { title: 'Bad frame', rect: { x: 0, y: 0, w: 'wide', h: 10 } }, { title: 'Empty', rect: { x: 0, y: 0, w: 0, h: 10 } },
    { id: 7, title: 'T'.repeat(200), color: 'red; background: url(x)', rect: { x: 1, y: 2, w: 300, h: 200, more: true }, extra: 'dropped' },
  ];
  const read = fragmentFromText(JSON.stringify(held))!.groups;
  assert.equal(read.length, 1);
  assert.deepEqual([read[0]!.title.length, Object.hasOwn(read[0]!, 'color'), read[0]!.rect, Object.keys(read[0]!).sort()], [64, false, { x: 1, y: 2, w: 300, h: 200 }, ['id', 'rect', 'title']]);
  held.groups = Array.from({ length: 1000 }, () => ({ title: 'G', rect: { x: 0, y: 0, w: 10, h: 10 } }));
  assert.equal(fragmentFromText(JSON.stringify(held))!.groups.length, 256, 'a text is not trusted to be short');
});
