// What the shell and the shared controls write for a person, and the two pure descriptions the frame is made
// from: colours between the document and the screen, sizes and names, the menu bar and the dock layout.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCommandRegistry, type CommandSource } from '../../../../src/app/shell/commands.ts';
import { adapterName, baseName, failedNodes, folderOf, formatBytes, formatDuration, isAbsolutePath, projectName, windowTitle } from '../../../../src/app/shell/format.ts';
import { createKeymap } from '../../../../src/app/shell/keys.ts';
import { initialSize, LAYOUT_VERSION, placementOrder, savedDock } from '../../../../src/app/shell/layout.ts';
import { buildMenus } from '../../../../src/app/shell/menu.ts';
import { fromDisplay, fromHex, linearToSrgb, srgbToLinear, toDisplay, toHex } from '../../../../src/app/ui/color.ts';
import { isFailure, nodeErrorText, portLabel } from '../../../../src/app/ui/node-text.ts';
import { nodes as productNodes } from '../../../../src/core/nodes/index.ts';
import { createRegistry } from '../../../../src/core/runtime.ts';
import { reduceEngineEvents } from '../../../../src/app/state/engine-store.ts';
import type { CommandDef, PanelDef } from '../../../../src/app/ui/types.ts';
import type { GraphDoc, NodeError } from '../../../../src/core/runtime.ts';

// ---- colour ----

test('a stored colour is linear RGB and is shown as sRGB', () => {
  assert.deepEqual(toDisplay([0, 0, 0]), { r: 0, g: 0, b: 0 });
  assert.deepEqual(toDisplay([1, 1, 1]), { r: 255, g: 255, b: 255 });
  assert.deepEqual(toDisplay([0.2140411, 0.2140411, 0.2140411]), { r: 127, g: 127, b: 127 }, 'linear 0.214 is the middle grey of a screen');
  assert.deepEqual(toDisplay([0.5, 0.5, 0.5], false), { r: 128, g: 128, b: 128 });
  assert.equal(toHex([1, 0, 0]), '#ff0000');
  assert.equal(toHex([0.2140411, 0, 1]), '#7f00ff');
  assert.deepEqual(toDisplay([2, -1, Number.NaN]), { r: 255, g: 0, b: 0 }, 'a channel outside 0..1 is shown at its end');
});

test('every 8-bit colour survives the way into the document and back', () => {
  for (let value = 0; value < 256; value++) {
    const stored = fromDisplay({ r: value, g: 255 - value, b: (value * 7) % 256 });
    const shown = toDisplay(stored);
    assert.ok(shown.r === value && shown.g === 255 - value && shown.b === (value * 7) % 256, `the colour ${value} came back as ${JSON.stringify(shown)}`);
    assert.ok(Math.abs(srgbToLinear(linearToSrgb(value / 255)) - value / 255) < 1e-12);
  }
});

test('a hex code is read with or without its sign, in three or six digits', () => {
  assert.deepEqual(fromHex('#ffffff'), [1, 1, 1]);
  assert.deepEqual(fromHex('000'), [0, 0, 0]);
  assert.deepEqual(fromHex(' #F00 '), [1, 0, 0]);
  assert.deepEqual(fromHex('#808080', false), [0.501961, 0.501961, 0.501961]);
  assert.equal(toHex(fromHex('#3a7bd5')!), '#3a7bd5');
  for (const bad of ['', '#12', '#12345', 'red', '#gggggg', '#1234567']) assert.equal(fromHex(bad), null, bad);
});

// ---- sizes, durations, names ----

test('sizes and durations read as a person writes them', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1000), '1 MB');
  assert.equal(formatBytes(22 * 2 ** 20), '22 MB');
  assert.equal(formatBytes(2 ** 30), '1.0 GB');
  assert.equal(formatBytes(3.6 * 2 ** 30), '3.6 GB');
  assert.equal(formatBytes(Number.NaN), '0 MB');
  assert.equal(formatDuration(400), '0.4 s');
  assert.equal(formatDuration(12_300), '12 s');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(3_900_000), '1 h 05 min');
  assert.equal(formatDuration(-1), '');
});

test('a project is named by its file, on either kind of path, and the title says what is unsaved', () => {
  assert.equal(projectName(null), 'Untitled');
  assert.equal(projectName('/home/a/alps.orogen'), 'alps');
  assert.equal(projectName('C:\\Terrains\\Alps.OROGEN'), 'Alps');
  assert.equal(projectName('/home/a/notes.json'), 'notes.json');
  assert.equal(projectName('/home/a/.orogen'), '.orogen');
  assert.equal(windowTitle(null, false), 'Untitled - Orogen');
  assert.equal(windowTitle('/home/a/alps.orogen', true), 'alps* - Orogen');
  assert.equal(baseName('C:\\Terrains\\Alps.orogen'), 'Alps.orogen');
  assert.equal(folderOf('C:\\Terrains\\Alps.orogen'), 'C:\\Terrains');
  assert.equal(folderOf('alps.orogen'), '');
  for (const path of ['/a/b', 'C:\\a', 'c:/a', '\\\\server\\share']) assert.equal(isAbsolutePath(path), true, path);
  for (const path of ['a/b', 'maps/height.png', '..\\a', '']) assert.equal(isAbsolutePath(path), false, path);
});

test('an adapter is named by its vendor and its device, wherever the platform put the name', () => {
  const adapter = (vendor: string, architecture: string, device: string, description: string) =>
    ({ vendor, architecture, device, description, isFallbackAdapter: false, backend: null });
  assert.equal(adapterName(adapter('nvidia', 'turing', '0x2191', 'NVIDIA GeForce GTX 1660 Ti')), 'NVIDIA GeForce GTX 1660 Ti');
  assert.equal(adapterName(adapter('microsoft', 'warp', 'microsoft-basic-render-driver', 'D3D12 driver version 10.0.26100.33438')), 'microsoft basic render driver');
  assert.equal(adapterName(adapter('mesa', 'software', 'llvmpipe-llvm-20-1-2-256-bits-', '')), 'Mesa llvmpipe llvm 20 1 2 256 bits');
  assert.equal(adapterName(adapter('google', 'swiftshader', '0xc0de', 'SwiftShader Device (Subzero)')), 'Google SwiftShader Device (Subzero)');
  assert.equal(adapterName(adapter('intel', '', '', '')), 'Intel');
  assert.equal(adapterName(adapter('', '', '', '')), 'Unknown adapter');
});

// ---- errors ----

test('the errors to show are those of the nodes the document holds, in its order', () => {
  const error = (nodeId: string): NodeError => ({ nodeId, nodeType: 'io/import-field', kind: 'io', message: `File not found: ${nodeId}.png` });
  const engine = reduceEngineEvents([
    { type: 'node-error', requestId: 1, error: error('gone') },
    { type: 'node-error', requestId: 1, error: error('second') },
    { type: 'node-done', requestId: 1, nodeId: 'fine', cached: false, wallMs: 1, gpuMs: null, peakBytes: 0 },
    { type: 'node-error', requestId: 1, error: error('first') },
  ]);
  const node = (id: string): GraphDoc['nodes'][string] => ({ id, type: 'io/import-field', version: 1, position: { x: 0, y: 0 }, params: {} });
  // `gone` was deleted: the store still has the engine's last word on it, and the user is told nothing of it.
  const held = { first: node('first'), fine: node('fine'), second: node('second'), never: node('never') };
  assert.deepEqual(failedNodes(engine.nodes, held).map((failed) => failed.nodeId), ['first', 'second']);
  assert.deepEqual(failedNodes(engine.nodes, {}), []);
  // The undo that brings the node back finds its error where it was.
  assert.deepEqual(failedNodes(engine.nodes, { ...held, gone: node('gone') }).map((failed) => failed.nodeId), ['first', 'second', 'gone']);
});

test('a node that lacks a wire is unfinished, not failed, and its input is named by its label', () => {
  const registry = createRegistry(productNodes);
  const error = (kind: NodeError['kind'], message: string, nodeType = 'surface/terraces'): NodeError => ({ nodeId: 'n', nodeType, kind, message });
  // The engine names the port (runtime.md 5.3); a person reads its label, in the words the graph uses.
  assert.equal(nodeErrorText(error('missing-input', 'missing input "in"'), registry), 'Missing input: In');
  assert.equal(nodeErrorText(error('missing-input', 'missing input "a"', 'adjust/combine'), registry), 'Missing input: A');
  assert.equal(nodeErrorText(error('missing-input', 'missing input "gone"'), registry), 'Missing input: gone', 'a port the type does not have is named as the engine names it');
  assert.equal(nodeErrorText(error('missing-input', 'missing input "in"', 'no/such-type'), registry), 'Missing input: in');
  assert.equal(nodeErrorText(error('io', 'File not found: a.png'), registry), 'File not found: a.png', 'every other error is said as the engine says it');
  assert.equal(isFailure(error('missing-input', 'missing input "in"')), false);
  for (const kind of ['io', 'param', 'cycle', 'unknown-type', 'version'] as const) assert.equal(isFailure(error(kind, 'x')), true, kind);
  assert.deepEqual([portLabel({ name: 'in' }), portLabel({ name: 'flow', label: 'Flow map' })], ['In', 'Flow map']);
});

// ---- the menu bar ----

const command = (id: string, title: string): CommandDef => ({ id, title, run: () => undefined });
const SOURCES: readonly CommandSource[] = [
  {
    owner: 'shell',
    commands: [command('file.new', 'New Project'), command('file.save', 'Save'), command('edit.undo', 'Undo'), command('view.help', 'Help'), command('engine.pause', 'Pause')],
    keys: [{ key: 'Mod+S', command: 'file.save', scope: 'global' }, { key: 'Mod+Z', command: 'edit.undo', scope: 'global' }],
    menu: [
      { menu: 'File', command: 'file.new', group: 'open' },
      { menu: 'File', command: 'file.save', group: 'save' },
      { menu: 'Edit', command: 'edit.undo', group: 'history' },
      { menu: 'Help', command: 'view.help' },
    ],
  },
  {
    owner: 'graph',
    commands: [command('graph.delete', 'Delete Nodes'), command('graph.fit', 'Fit Graph'), command('graph.group', 'Group')],
    keys: [{ key: 'Delete', command: 'graph.delete', scope: 'graph' }, { key: 'Backspace', command: 'graph.delete', scope: 'graph' }],
    menu: [
      { menu: 'Graph', command: 'graph.fit' },
      { menu: 'Edit', command: 'graph.delete', group: 'history' },
      { menu: 'Graph', command: 'graph.group' },
      { menu: 'Edit', command: 'graph.group' },
    ],
  },
];

test('the menu bar is built from the menu entries of the shell and the panels', () => {
  const registry = createCommandRegistry(SOURCES);
  const menus = buildMenus(registry, createKeymap(registry.bindings, registry.keymapCommands));
  const shape = menus.map((menu) => [menu.title, menu.items.map((item) => (item.kind === 'separator' ? '-' : `${item.title}${item.key ? ` [${item.key}]` : ''}`))]);
  assert.deepEqual(shape, [
    ['File', ['New Project', '-', 'Save [Mod+S]']],
    // A panel's entry joins the group it names; without a group it follows in a group of its owner's.
    ['Edit', ['Undo [Mod+Z]', 'Delete Nodes [Delete]', '-', 'Group']],
    // A panel's own menu follows the shell's, and Help is last. The Engine menu has no entry and is left out.
    ['Graph', ['Fit Graph', 'Group']],
    ['Help', ['Help']],
  ]);
});

test('a menu shows the key the user gave a command', () => {
  const registry = createCommandRegistry(SOURCES);
  const keymap = createKeymap(registry.bindings, registry.keymapCommands, { 'file.save': 'Mod+Alt+S', 'graph.delete': '' });
  const items = buildMenus(registry, keymap).flatMap((menu) => menu.items).flatMap((item) => (item.kind === 'command' ? [[item.command, item.key]] : []));
  assert.deepEqual(items.find(([id]) => id === 'file.save'), ['file.save', 'Mod+Alt+S']);
  assert.deepEqual(items.find(([id]) => id === 'graph.delete'), ['graph.delete', null]);
});

// ---- the dock layout ----

const placed = (id: PanelDef['id'], placement: PanelDef['placement'] = {}): Pick<PanelDef, 'id' | 'placement'> => ({ id, placement });

test('the default layout adds each panel after the one it stands beside', () => {
  const steps = placementOrder([
    placed('library', { relativeTo: 'inspector', direction: 'within' }),
    placed('graph', { relativeTo: 'viewport', direction: 'below' }),
    placed('viewport'),
    placed('inspector', { direction: 'right' }),
    placed('build', { relativeTo: 'library', direction: 'within' }),
  ]);
  assert.deepEqual(steps, [
    { id: 'viewport', relativeTo: null, direction: null },
    { id: 'inspector', relativeTo: null, direction: 'right' },
    { id: 'library', relativeTo: 'inspector', direction: 'within' },
    { id: 'graph', relativeTo: 'viewport', direction: 'below' },
    { id: 'build', relativeTo: 'library', direction: 'within' },
  ]);
});

test('placements that give no order are refused with the panels named', () => {
  assert.throws(() => placementOrder([placed('graph', { relativeTo: 'viewport' }), placed('viewport', { relativeTo: 'graph' })]), /"graph", "viewport" are placed relative to each other/);
  assert.throws(() => placementOrder([placed('graph', { relativeTo: 'viewport' })]), /"graph" is placed relative to "viewport", which is no other panel/);
  assert.throws(() => placementOrder([placed('graph', { relativeTo: 'graph' })]), /which is no other panel/);
  assert.throws(() => placementOrder([placed('graph', { direction: 'within' })]), /"graph" is placed within no panel/);
});

test('a saved layout is restored only when it is of this schema version and holds exactly the panels there are', () => {
  const ids = ['graph', 'viewport'];
  const dock = { grid: { root: {}, width: 800, height: 600, orientation: 'HORIZONTAL' }, panels: { graph: {}, viewport: {} } };
  assert.equal(savedDock({ version: LAYOUT_VERSION, dock }, ids), dock);
  assert.equal(savedDock({ version: LAYOUT_VERSION + 1, dock }, ids), null, 'another schema version');
  assert.equal(savedDock({ dock }, ids), null);
  assert.equal(savedDock({ version: LAYOUT_VERSION, dock }, [...ids, 'build']), null, 'a panel the layout does not hold');
  assert.equal(savedDock({ version: LAYOUT_VERSION, dock: { ...dock, panels: { ...dock.panels, log: {} } } }, ids), null, 'a panel this build does not have');
  assert.equal(savedDock({ version: LAYOUT_VERSION, dock: { panels: dock.panels } }, ids), null, 'no grid');
  for (const value of [null, undefined, 'layout', 7, [], { version: LAYOUT_VERSION }, { version: LAYOUT_VERSION, dock: [] }, { version: LAYOUT_VERSION, dock: { grid: {}, panels: [] } }]) {
    assert.equal(savedDock(value, ids), null, JSON.stringify(value));
  }
});

test('the side column of the default layout is a share of the window within its limits', () => {
  assert.deepEqual(initialSize('inspector', { width: 1600, height: 900 }), { initialWidth: 368 });
  assert.deepEqual(initialSize('inspector', { width: 900, height: 900 }), { initialWidth: 300 });
  assert.deepEqual(initialSize('inspector', { width: 4000, height: 900 }), { initialWidth: 440 });
  assert.deepEqual(initialSize('graph', { width: 1600, height: 900 }), { initialHeight: 450 });
  assert.deepEqual(initialSize('viewport', { width: 1600, height: 900 }), {});
  assert.deepEqual(initialSize('graph', { width: 0, height: 0 }), {}, 'a dock that has no size yet says nothing');
});
