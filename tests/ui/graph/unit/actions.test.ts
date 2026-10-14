// What the graph does to the document and the selection (runtime.md 4.6, 7.4, 8.5): each action is one
// transaction, so one step of the history, and what is only a view is no step at all. Also the panel's commands,
// keys and menu entries, held against the table of 8.8 and registered with the shell's own registry.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  addNodeAt, addNodeNow, BESIDE_GAP, canToggleViewLock, CLEAR_MARGIN, clearSelection, clearSpot, deleteSelection, disconnectEdges, freeSpot, hasSelection, insertTarget, renameGroup, renameNode, renameTarget,
  saveViewport, selectAll, selectContents, toggleBypass, toggleCollapsed, toggleViewLock, useAsTerrain,
} from '../../../../src/app/panels/graph/actions.ts';
import { commands, keys, menu } from '../../../../src/app/panels/graph/commands.ts';
import { graphHost, graphStore } from '../../../../src/app/panels/graph/state.ts';
import { shellSource, type ShellCommandHost } from '../../../../src/app/shell/app-commands.ts';
import { createCommandRegistry } from '../../../../src/app/shell/commands.ts';
import { createKeymap } from '../../../../src/app/shell/keys.ts';
import { selectNodes, setSelection } from '../../../../src/app/state/ui-store.ts';
import type { CommandContext } from '../../../../src/app/ui/types.ts';
import { bench, edgeInto, wiring, type Bench } from './_graph.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

function chain(b: Bench): { range: string; blur: string; slope: string; exported: string } {
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const slope = b.add('select/slope', { x: 600, y: 0 }, { in: `${blur}.out` });
  const exported = b.add('io/export-landscape', { x: 600, y: 300 }, { in: `${blur}.out` });
  return { range, blur, slope, exported };
}

test('adding a node selects it, places it on whole pixels and never exactly on another', () => {
  const b = bench();
  const first = addNodeAt(b, 'generate/mountain-range', { x: 10.6, y: 20.2 })!;
  assert.deepEqual(b.now().nodes[first]!.position, { x: 11, y: 20 });
  assert.deepEqual(b.ui.getState().selection, [first]);
  const second = addNodeAt(b, 'generate/mountain-range', { x: 11, y: 20 })!;
  assert.deepEqual(b.now().nodes[second]!.position, { x: 35, y: 44 }, 'a second paste or drop at one point does not hide the first');
  assert.deepEqual(freeSpot(b.now(), { x: 11, y: 20 }), { x: 59, y: 68 });
  assert.deepEqual(freeSpot(b.now(), { x: 500, y: 0 }), { x: 500, y: 0 });
  assert.deepEqual(b.labels(), ['Add Mountain Range', 'Add Mountain Range']);
  // The parameters are stored at their defaults (4.6), so the node is the node the inspector shows.
  assert.equal(typeof b.now().nodes[first]!.params.seed, 'number');
});

/** Whether the boxes of two nodes of the document share a point. */
function overlap(b: Bench, one: string, other: string): boolean {
  const rect = (id: string) => {
    const view = b.views().get(id)!;
    const at = b.now().nodes[id]!.position;
    return { x: at.x, y: at.y, w: view.width, h: view.height };
  };
  const p = rect(one), q = rect(other);
  return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
}

test('"add this node now" with a node selected: the new node is connected to it and stands to its right, covering nothing', () => {
  // The default project: one Mountain Range at the origin, selected as a click on it leaves it.
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  setSelection(b.ui, [range]);
  const steps = b.labels().length;
  const center = { x: 112, y: 72 };   // the middle of what the graph shows lies on the range, as it does at first start

  const erosion = addNodeNow(b, 'simulate/fluvial-erosion', center)!;
  assert.deepEqual(wiring(b.now()), [`${range}.out>${erosion}.in`], 'the selected node\'s output feeds the new node');
  const rangeView = b.views().get(range)!;
  const placed = b.now().nodes[erosion]!.position;
  assert.equal(placed.x, rangeView.width + BESIDE_GAP, 'to the right of the selected node, with room for the wire');
  assert.equal(placed.y, 0, 'the wire runs level: first output to first input');
  assert.equal(overlap(b, range, erosion), false);
  assert.deepEqual(b.ui.getState().selection, [erosion], 'the new node is selected: the next one continues the chain');
  assert.deepEqual(b.labels().slice(steps), ['Add Fluvial Erosion'], 'adding and connecting is one step of the history');

  // The next node continues the chain from the node just added.
  const exported = addNodeNow(b, 'io/export-landscape', center)!;
  assert.deepEqual(wiring(b.now()), [`${erosion}.out>${exported}.in`, `${range}.out>${erosion}.in`].sort());
  for (const other of [range, erosion]) assert.equal(overlap(b, exported, other), false);
  assert.ok(b.now().nodes[exported]!.position.x > placed.x);

  // A second consumer of one output goes beside it too, and below the first: no box covers another.
  setSelection(b.ui, [range]);
  const blur = addNodeNow(b, 'filter/blur', center)!;
  assert.ok(wiring(b.now()).includes(`${range}.out>${blur}.in`));
  for (const other of [range, erosion, exported]) assert.equal(overlap(b, blur, other), false, other);
  assert.equal(b.now().nodes[blur]!.position.x, placed.x, 'in the same column');
  assert.ok(b.now().nodes[blur]!.position.y > 0, 'below the node that stands there');

  // A mask output goes into the input that is for masks, not into the terrain's.
  const slope = b.add('select/slope', { x: 0, y: 900 }, { in: `${range}.out` });
  setSelection(b.ui, [slope]);
  const layer = addNodeNow(b, 'io/export-layer', center)!;
  assert.ok(wiring(b.now()).includes(`${slope}.out>${layer}.in`));
});

test('"add this node now" without a node to continue from: unconnected, at the nearest place that covers no node', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const center = { x: 112, y: 72 };
  // Nothing is selected: the node is not connected, and it does not lie on the node in the middle of the view.
  const second = addNodeNow(b, 'generate/mountain-range', center)!;
  assert.deepEqual(wiring(b.now()), []);
  assert.equal(overlap(b, range, second), false, 'the first finding of the review: a node added from the library covered the node that was there');
  // A generator has no input to connect: with a node selected it is placed the same way.
  setSelection(b.ui, [range]);
  const third = addNodeNow(b, 'generate/mountain', center)!;
  assert.deepEqual(wiring(b.now()), []);
  for (const other of [range, second]) assert.equal(overlap(b, third, other), false);
  // Several nodes selected, or a wire: nothing says which to continue from.
  setSelection(b.ui, [range, second]);
  const fourth = addNodeNow(b, 'filter/blur', center)!;
  assert.deepEqual(wiring(b.now()), []);
  for (const other of [range, second, third]) assert.equal(overlap(b, fourth, other), false);
  // An empty graph: the node's middle is the middle of the view.
  const empty = bench();
  const alone = addNodeNow(empty, 'generate/mountain-range', { x: 400, y: 300 })!;
  const view = empty.views().get(alone)!;
  assert.deepEqual(empty.now().nodes[alone]!.position, { x: Math.round(400 - view.width / 2), y: Math.round(300 - view.height / 2) });
  assert.equal(addNodeNow(empty, 'legacy/unknown', { x: 0, y: 0 }), null);
});

test('clearSpot: a free place is kept; a taken one gives the nearest that keeps the margin to every box', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const view = b.views().get(range)!;
  const size = { w: view.width, h: view.height };
  assert.deepEqual(clearSpot(b, { x: 1000.4, y: 2000.6 }, size), { x: 1000, y: 2001 }, 'whole pixels, where nothing is');
  const moved = clearSpot(b, { x: 10, y: 10 }, size);
  assert.notDeepEqual(moved, { x: 10, y: 10 });
  const clear = moved.x >= view.width + CLEAR_MARGIN || moved.x + size.w <= -CLEAR_MARGIN || moved.y >= view.height + CLEAR_MARGIN || moved.y + size.h <= -CLEAR_MARGIN;
  assert.ok(clear, JSON.stringify(moved));
  // No nearer place is free: the one found is within a step of the least distance that clears the box.
  const distance = Math.hypot(moved.x - 10, moved.y - 10);
  assert.ok(distance <= view.height + CLEAR_MARGIN + 34, `moved ${distance} px`);
});

test('delete takes the selected nodes with their wires, the selected wires and the selected groups, as one step', () => {
  const b = bench();
  const { range, blur, slope, exported } = chain(b);
  b.group({ id: 'g', title: 'Frame', rect: { x: -20, y: -40, w: 600, h: 300 } });
  const steps = b.labels().length;
  assert.equal(hasSelection(b), false);
  assert.equal(deleteSelection(b), false);

  // A wire alone.
  b.local.setState({ edgeSelection: [edgeInto(b.now(), slope, 'in')] });
  assert.equal(hasSelection(b), true);
  deleteSelection(b);
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${exported}.in`, `${range}.out>${blur}.in`].sort());
  assert.deepEqual([b.labels().at(-1), b.local.getState().edgeSelection], ['Delete Wire', []]);

  // A node, and the group: the group's contents stay.
  setSelection(b.ui, [blur]);
  b.local.setState({ groupSelection: ['g'] });
  deleteSelection(b);
  assert.deepEqual([Object.keys(b.now().nodes), wiring(b.now()), Object.keys(b.now().groups)], [[range, slope, exported], [], []]);
  assert.deepEqual([b.ui.getState().selection, b.local.getState().groupSelection], [[], []]);
  assert.deepEqual(b.labels().slice(steps), ['Delete Wire', 'Delete']);

  b.doc.getState().undo();
  assert.deepEqual([Object.keys(b.now().nodes).length, Object.keys(b.now().groups), b.ui.getState().selection], [4, ['g'], [blur]]);
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${exported}.in`, `${range}.out>${blur}.in`].sort());
  b.doc.getState().redo();
  assert.equal(Object.hasOwn(b.now().nodes, blur), false);

  assert.equal(disconnectEdges(b, ['no-such-edge']), false);
});

test('select all selects every node and group; clearing selects nothing', () => {
  const b = bench();
  const { range, blur, slope, exported } = chain(b);
  b.group({ id: 'g', title: '', rect: { x: 0, y: 0, w: 200, h: 200 } });
  selectAll(b);
  assert.deepEqual([b.ui.getState().selection, b.local.getState().groupSelection], [[range, blur, slope, exported], ['g']]);
  assert.equal(b.now().ui.view, undefined, 'several nodes selected: the view stays as it is (7.4)');
  clearSelection(b);
  assert.deepEqual([b.ui.getState().selection, b.local.getState().groupSelection], [[], []]);
});

test('bypass is toggled for the selected nodes that can be bypassed, and undone as one step', () => {
  const b = bench();
  const { range, blur, slope } = chain(b);
  const paint = b.add('color/gradient-map', { x: 900, y: 0 }, { in: `${slope}.out` });
  setSelection(b.ui, [range]);
  assert.equal(toggleBypass(b), false, 'a generator has no input to pass through (engine.md 4.14)');
  setSelection(b.ui, [paint]);
  assert.equal(toggleBypass(b), false, 'a gradient map turns a field into a colour: there is nothing of its type to pass through');
  setSelection(b.ui, [range, blur, paint]);
  const steps = b.labels().length;
  assert.equal(toggleBypass(b), true);
  assert.deepEqual([b.now().nodes[blur]!.bypass, b.now().nodes[range]!.bypass, b.now().nodes[paint]!.bypass], [true, undefined, undefined]);
  toggleBypass(b);
  assert.equal(Object.hasOwn(b.now().nodes[blur]!, 'bypass'), false);
  assert.deepEqual(b.labels().slice(steps), ['Bypass', 'Remove Bypass']);
  b.doc.getState().undo();
  assert.equal(b.now().nodes[blur]!.bypass, true);

  setSelection(b.ui, [range, blur, slope]);
  toggleCollapsed(b);
  assert.deepEqual([range, blur, slope].map((id) => b.now().nodes[id]!.collapsed), [true, true, true]);
  assert.equal(b.views().get(blur)!.thumbnail, false);
  toggleCollapsed(b);
  assert.equal(b.views().get(blur)!.thumbnail, true);
});

test('a node is given a name of its own, and its type\'s name back by an empty one; a group is renamed', () => {
  const b = bench();
  const { blur } = chain(b);
  b.group({ id: 'g', title: 'Frame', rect: { x: 0, y: 0, w: 200, h: 200 } });
  const steps = b.labels().length;
  renameNode(b, blur, '  Soften   a bit ');
  assert.equal(b.now().nodes[blur]!.title, 'Soften a bit');
  renameNode(b, blur, 'Soften a bit');
  assert.deepEqual(b.labels().slice(steps), ['Rename'], 'the same name again is no step');
  renameNode(b, blur, 'Blur');
  assert.equal(Object.hasOwn(b.now().nodes[blur]!, 'title'), false, 'the name of the type is no name of its own');
  renameNode(b, blur, 'x'.repeat(200));
  assert.equal(b.now().nodes[blur]!.title!.length, 64);
  renameNode(b, blur, '');
  assert.equal(Object.hasOwn(b.now().nodes[blur]!, 'title'), false);
  renameGroup(b, 'g', 'Base terrain');
  assert.equal(b.now().groups.g!.title, 'Base terrain');
  assert.deepEqual(b.labels().slice(steps), ['Rename', 'Rename', 'Rename', 'Rename', 'Rename Group']);

  // What F2 renames: the one selected node, else the one selected group.
  assert.equal(renameTarget(b), null);
  setSelection(b.ui, [blur]);
  b.local.setState({ groupSelection: ['g'] });
  assert.deepEqual(renameTarget(b), { kind: 'node', id: blur });
  setSelection(b.ui, []);
  assert.deepEqual(renameTarget(b), { kind: 'group', id: 'g' });
});

test('G makes the selected node the terrain shown; the view is no step of the history and no unsaved change', () => {
  const b = bench();
  const { range, blur, slope, exported } = chain(b);
  const steps = b.labels().length;
  b.doc.getState().markSaved('/tmp/project.orogen');
  selectNodes(b, [range]);
  assert.deepEqual(b.now().ui.view, { height: { node: range, port: 'out' } });
  // A mask selected lies over the terrain (7.4); G makes it the terrain itself, and the overlay of itself goes.
  selectNodes(b, [slope]);
  assert.deepEqual(b.now().ui.view, { height: { node: range, port: 'out' }, overlay: { ref: { node: slope, port: 'out' }, as: 'mask', opacity: 1 } });
  assert.equal(useAsTerrain(b), true);
  assert.deepEqual(b.now().ui.view, { height: { node: slope, port: 'out' } });
  // Another node as the terrain keeps an overlay that is not of it.
  selectNodes(b, [blur]);
  selectNodes(b, [slope]);
  selectNodes(b, [range]);
  setSelection(b.ui, [range]);
  useAsTerrain(b);
  assert.deepEqual(b.now().ui.view!.height, { node: range, port: 'out' });
  setSelection(b.ui, [exported]);
  assert.equal(useAsTerrain(b), false, 'a node without an output shows nothing');
  setSelection(b.ui, [range, blur]);
  assert.equal(useAsTerrain(b), false);
  assert.equal(b.labels().length, steps);
  assert.equal(b.doc.getState().unsaved, false);
});

test('F locks the view to the selected node and unlocks it again; unlocked, the view follows the selection at once', () => {
  const b = bench();
  const { range, blur } = chain(b);
  assert.equal(canToggleViewLock(b), false, 'nothing shown and nothing selected: nothing to lock');
  assert.equal(toggleViewLock(b), false);

  setSelection(b.ui, [blur]);
  assert.equal(toggleViewLock(b), true);
  assert.deepEqual(b.now().ui.view, { height: { node: blur, port: 'out' }, locked: true }, 'what is locked is the node the user points at');
  selectNodes(b, [range]);
  assert.deepEqual(b.now().ui.view!.height, { node: blur, port: 'out' }, 'locked: the selection does not move the view');
  assert.equal(b.views().get(blur)!.locked, true);
  toggleViewLock(b);
  assert.deepEqual(b.now().ui.view, { height: { node: range, port: 'out' } }, 'unlocked, the view shows what is selected');
  assert.equal(b.labels().includes('Lock view'), false);
});

test('the graph\'s viewport is kept in the document, rounded, outside the history and outside "unsaved"', () => {
  const b = bench();
  chain(b);
  b.doc.getState().markSaved('/tmp/project.orogen');
  const steps = b.labels().length;
  saveViewport(b, { x: 12.3456, y: -7.891, zoom: 0.73456789 });
  assert.deepEqual(b.now().ui.graphViewport, { x: 12.35, y: -7.89, zoom: 0.7346 });
  const held = b.now();
  saveViewport(b, { x: 12.3456, y: -7.891, zoom: 0.73456789 });
  assert.equal(b.now(), held, 'the same viewport again changes nothing');
  saveViewport(b, { x: Number.NaN, y: 0, zoom: 1 });
  saveViewport(b, { x: 0, y: 0, zoom: 0 });
  assert.equal(b.now(), held);
  assert.deepEqual([b.labels().length, b.doc.getState().unsaved], [steps, false]);
});

// ---- the panel's commands (8.8) ----

/** The default bindings 8.8 prints for the graph scope. */
const CONTRACT_KEYS: readonly (readonly [string, string])[] = [
  ['Tab', 'graph.addNode'], ['Delete', 'graph.delete'], ['Backspace', 'graph.delete'], ['Mod+D', 'graph.duplicate'], ['B', 'graph.toggleBypass'],
  ['F', 'graph.toggleViewLock'], ['G', 'graph.useAsTerrain'], ['Mod+G', 'graph.group'], ['F2', 'graph.rename'], ['Mod+0', 'graph.fit'], ['Home', 'graph.fit'],
];

test('the panel declares the commands and the default keys of runtime.md 8.8, and every one has a menu entry or is reached through Edit', () => {
  const ids = commands.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [key, command] of CONTRACT_KEYS) {
    assert.ok(keys.some((binding) => binding.key === key && binding.command === command && binding.scope === 'graph'), `${key} runs ${command} in the graph`);
  }
  // The table of the contract itself names them: a row that changes there changes here.
  const contract = fs.readFileSync(path.join(ROOT, 'docs/contract/runtime.md'), 'utf8');
  for (const [, command] of CONTRACT_KEYS) assert.ok(contract.includes(`\`${command}\``), `runtime.md names ${command}`);
  assert.ok(keys.every((binding) => binding.scope === 'graph' && ids.includes(binding.command)));
  // Copy, cut and paste are DOM clipboard events, never commands of the panel (8.8 rules 3 and 6).
  for (const id of ['graph.copy', 'graph.cut', 'graph.paste']) assert.equal(ids.includes(id), false);
  // Delete and Select All are reached through the shell's Edit menu, which sends them to the focused panel.
  const inMenu = new Set(menu.map((entry) => entry.command));
  for (const id of ids) assert.ok(inMenu.has(id) || id === 'graph.delete' || id === 'graph.selectAll', `${id} is in a menu`);
  assert.ok(menu.every((entry) => entry.menu === 'Graph'));
  for (const command of commands) assert.match(command.title, /^[A-Z][^.]*$/, `${command.id}: a title, no full stop`);
});

test('the commands register with the shell\'s own list without a fault, and their keys resolve only while the graph has the focus', () => {
  const host = { edit: { textField: () => false }, hasCommand: () => false, recent: () => [], paused: () => false, testMode: false } as unknown as ShellCommandHost;
  // A stand-in for the two commands the shell's global keys name (8.10 rule 1); the real ones are their panels'.
  const others = [
    { owner: 'build', commands: [{ id: 'build.start', title: 'Build…', run: () => undefined }], keys: [] },
    { owner: 'viewport', commands: [{ id: 'viewport.toggleTop', title: 'Toggle Top View', run: () => undefined }], keys: [{ key: 'F', command: 'viewport.toggleTop', scope: 'viewport' as const }] },
  ];
  const registry = createCommandRegistry([shellSource(host), ...others, { owner: 'graph', commands, keys, menu }]);
  const keymap = createKeymap(registry.bindings, registry.keymapCommands);
  for (const binding of keys) {
    assert.equal(keymap.resolve(binding.key, { focusedPanel: 'graph', textField: false }), binding.command);
    if (!['F'].includes(binding.key)) assert.notEqual(keymap.resolve(binding.key, { focusedPanel: 'viewport', textField: false }), binding.command);
  }
  // While a name is typed, letters are letters: only F2 and the keys with Mod reach the commands (8.8 rule 3).
  assert.equal(keymap.resolve('B', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('Delete', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(keymap.resolve('F2', { focusedPanel: 'graph', textField: true }), 'graph.rename');
  assert.equal(keymap.resolve('Mod+A', { focusedPanel: 'graph', textField: true }), null, 'Mod+A is the field\'s own');
  assert.equal(keymap.problems.length, 0);
});

test('every command says when it can run, and runs on the stores alone when no graph is mounted', () => {
  const b = bench();
  const { range, blur } = chain(b);
  const ctx = { doc: b.doc, ui: b.ui, registry: b.registry, engineState: b.engineState } as unknown as CommandContext;
  const command = (id: string) => commands.find((candidate) => candidate.id === id)!;
  const enabled = (id: string): boolean => command(id).enabled?.(ctx) ?? true;
  assert.equal(graphHost(), null, 'no window here');
  graphStore.setState({ edgeSelection: [], groupSelection: [], renaming: null, minimap: true });

  // Nothing selected: what needs a selection is disabled, and so is what needs the mounted graph.
  assert.deepEqual(
    ['graph.delete', 'graph.duplicate', 'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', 'graph.useAsTerrain', 'graph.group', 'graph.addNode', 'graph.fit'].map(enabled),
    [false, false, false, false, false, false, false, false, false],
  );
  assert.deepEqual(['graph.selectAll', 'graph.toggleMinimap'].map(enabled), [true, true]);

  setSelection(b.ui, [blur]);
  assert.deepEqual(['graph.delete', 'graph.duplicate', 'graph.rename', 'graph.toggleBypass', 'graph.toggleCollapse', 'graph.useAsTerrain', 'graph.toggleViewLock', 'graph.group'].map(enabled), [true, true, true, true, true, true, true, true]);
  setSelection(b.ui, [range]);
  assert.equal(enabled('graph.toggleBypass'), false);

  setSelection(b.ui, [blur]);
  void command('graph.toggleBypass').run(ctx);
  assert.equal(b.now().nodes[blur]!.bypass, true);
  void command('graph.useAsTerrain').run(ctx);
  assert.deepEqual(b.now().ui.view!.height, { node: blur, port: 'out' });
  void command('graph.toggleViewLock').run(ctx);
  assert.equal(b.now().ui.view!.locked, true);
  void command('graph.duplicate').run(ctx);
  assert.equal(Object.keys(b.now().nodes).length, 5);
  void command('graph.selectAll').run(ctx);
  assert.equal(b.ui.getState().selection.length, 5);
  void command('graph.delete').run(ctx);
  assert.equal(Object.keys(b.now().nodes).length, 0);
  void command('graph.toggleMinimap').run(ctx);
  assert.equal(graphStore.getState().minimap, false);
  graphStore.setState({ minimap: true });
  // Without a mounted graph these do nothing and throw nothing.
  void command('graph.addNode').run(ctx);
  void command('graph.fit').run(ctx);
});

test('what the menus of a wire and of a group offer are commands: a node into the one selected wire, and the contents of a group', () => {
  const b = bench();
  const { range, blur, slope } = chain(b);
  const ctx = { doc: b.doc, ui: b.ui, registry: b.registry, engineState: b.engineState } as unknown as CommandContext;
  const command = (id: string) => commands.find((candidate) => candidate.id === id)!;
  graphStore.setState({ edgeSelection: [], groupSelection: [], renaming: null });

  // A wire to put a node into: exactly one selected, and nothing else.
  const wire = edgeInto(b.now(), blur, 'in');
  assert.equal(insertTarget(b), null);
  b.local.setState({ edgeSelection: [wire] });
  assert.equal(insertTarget(b), wire);
  setSelection(b.ui, [range]);
  assert.equal(insertTarget(b), null, 'a node is selected as well: the wire is not what is meant');
  setSelection(b.ui, []);
  b.local.setState({ edgeSelection: [wire, edgeInto(b.now(), slope, 'in')] });
  assert.equal(insertTarget(b), null);
  b.local.setState({ edgeSelection: ['gone'] });
  assert.equal(insertTarget(b), null, 'a wire an undo took away');
  // The command needs the mounted graph for its palette; without one it is disabled and does nothing.
  graphStore.setState({ edgeSelection: [wire] });
  assert.equal(command('graph.insertNode').enabled?.(ctx), false);
  void command('graph.insertNode').run(ctx);
  graphStore.setState({ edgeSelection: [] });

  // The contents of the selected groups: the nodes that lie wholly inside, selected in place of the groups.
  b.group({ id: 'g', title: 'Front', rect: { x: -20, y: -50, w: 560, h: 260 } });
  assert.equal(command('graph.selectContents').enabled?.(ctx), false);
  assert.equal(selectContents(b), false);
  b.local.setState({ groupSelection: ['g'] });
  graphStore.setState({ groupSelection: ['g'] });
  assert.equal(command('graph.selectContents').enabled?.(ctx), true);
  assert.equal(selectContents(b), true);
  assert.deepEqual([...b.ui.getState().selection].sort(), [range, blur].sort());
  assert.deepEqual(b.local.getState().groupSelection, []);
  graphStore.setState({ groupSelection: [] });
});
