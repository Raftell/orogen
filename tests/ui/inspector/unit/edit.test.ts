// The document changes the inspector makes (src/app/panels/inspector/edit.ts) and its commands (commands.ts), on
// stores of their own: every edit is one transaction of the commands of runtime.md 4.6, a drag is one history
// entry, a drag that was taken back is none, and each command acts on what is selected.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StoreApi } from 'zustand/vanilla';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { addNode, connect, createRegistry, previewResolution, type DocDraft, type EngineSession, type GraphDoc } from '../../../../src/core/runtime.ts';
import { commands, keys, menu } from '../../../../src/app/panels/inspector/commands.ts';
import {
  createGesture, paramKey, randomSeed, resetParamsOf, setFlagsOf, setParamOf, setSettingOf, settingKey, targetLabel, type EditTarget,
} from '../../../../src/app/panels/inspector/edit.ts';
import { targetOf } from '../../../../src/app/panels/inspector/model.ts';
import { activeParam, forgetParams, inspectorStore, sectionKey, setHoverParam, setSectionOpen, setTouchedParam } from '../../../../src/app/panels/inspector/state.ts';
import type { PlatformApi } from '../../../../src/app/platform.ts';
import { createDocStore, type DocState } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore } from '../../../../src/app/state/engine-store.ts';
import { createUiStore, setSelection } from '../../../../src/app/state/ui-store.ts';
import type { CommandContext } from '../../../../src/app/ui/types.ts';

const REGISTRY = createRegistry(nodes);

interface Rig {
  readonly ctx: CommandContext;
  readonly doc: StoreApi<DocState>;
  readonly ids: { readonly noise: string; readonly second: string; readonly blur: string; readonly imported: string; readonly landscape: string };
  /** What the engine was told beside the document. */
  readonly projects: (string | null)[];
  /** A clock the test moves: transactions of one merge key merge while less than 600 ms lie between them (8.5 rule 3). */
  readonly clock: { now: number };
  target(...ids: string[]): EditTarget;
  labels(): string[];
  param(node: string, name: string): unknown;
  run(id: string): void;
  enabled(id: string): boolean;
}

function rig(): Rig {
  const ui = createUiStore();
  const clock = { now: 1000 };
  const doc = createDocStore({ ui, now: () => clock.now });
  const ids = { noise: '', second: '', blur: '', imported: '', landscape: '' };
  // A project that was opened: the history begins empty.
  const draft = structuredClone(doc.getState().doc) as DocDraft;
  ids.noise = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 0 });
  ids.second = addNode(draft, REGISTRY, 'generate/fractal-noise', { x: 0, y: 100 });
  ids.blur = addNode(draft, REGISTRY, 'filter/blur', { x: 200, y: 0 });
  ids.imported = addNode(draft, REGISTRY, 'io/import-field', { x: 0, y: 200 });
  ids.landscape = addNode(draft, REGISTRY, 'io/export-landscape', { x: 400, y: 0 });
  connect(draft, REGISTRY, { node: ids.noise, port: 'out' }, { node: ids.blur, port: 'in' });
  doc.getState().load(draft as GraphDoc, '/projects/alps.orogen');

  const projects: (string | null)[] = [];
  const engine = { setProject: (project: { path: string | null }) => void projects.push(project.path) } as unknown as EngineSession;
  const ctx: CommandContext = {
    doc, ui, registry: REGISTRY, engineState: createEngineStore(), engine, platform: {} as PlatformApi,
    run(id) {
      const command = commands.find((candidate) => candidate.id === id);
      if (!command) throw new Error(`No command "${id}"`);
      if (command.enabled?.(ctx) !== false) void command.run(ctx);
    },
  };
  return {
    ctx, doc, ids, projects, clock,
    target(...selected) {
      const target = targetOf(doc.getState().doc.nodes, REGISTRY, selected);
      assert.ok(target.kind === 'nodes');
      return target;
    },
    labels: () => doc.getState().past.map((entry) => entry.label),
    param: (node, name) => doc.getState().doc.nodes[node]!.params[name],
    run: (id) => ctx.run(id),
    enabled: (id) => commands.find((command) => command.id === id)!.enabled?.(ctx) !== false,
  };
}

const paramOf = (r: Rig, type: string, name: string) => REGISTRY.get(type)!.params.find((param) => param.name === name)!;

test('an edit is one transaction that stores the normalised value, named for the node and the parameter', () => {
  const r = rig();
  const noise = r.target(r.ids.noise);
  setParamOf(r.ctx, noise, paramOf(r, 'generate/fractal-noise', 'octaves'), 11.6);
  assert.equal(r.param(r.ids.noise, 'octaves'), 12, 'rounded as normalizeParams rounds');
  setParamOf(r.ctx, noise, paramOf(r, 'generate/fractal-noise', 'gain'), 7);
  assert.equal(r.param(r.ids.noise, 'gain'), 1, 'held to the hard limits');
  setParamOf(r.ctx, noise, paramOf(r, 'generate/fractal-noise', 'size'), 12);
  assert.equal(r.param(r.ids.noise, 'size'), 12, 'a soft parameter takes what was typed');
  assert.deepEqual(r.labels(), ['Fractal Noise: Octaves', 'Fractal Noise: Roughness', 'Fractal Noise: Feature size']);
  assert.deepEqual(r.doc.getState().past.map((entry) => entry.mergeKey), ['octaves', 'gain', 'size'].map((name) => `param:${r.ids.noise}:${name}`));
  assert.equal(r.doc.getState().unsaved, true);

  // The node's own title names the entry.
  setFlagsOf(r.ctx, [r.ids.noise], 'Rename Node', { title: 'Base' });
  setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'mode'), 'ridged');
  assert.deepEqual(r.labels().slice(-2), ['Rename Node', 'Base: Mode']);

  // A value that changes nothing is no transaction; an enum value nobody declares is refused and changes nothing.
  const before = r.doc.getState().revision;
  setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'mode'), 'ridged');
  assert.throws(() => setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'mode'), 'spiky'), /unknown value "spiky"/);
  assert.deepEqual([r.doc.getState().revision, r.param(r.ids.noise, 'mode')], [before, 'ridged']);
});

test('typed edits of one parameter merge while they follow each other closely; another parameter is another entry', () => {
  const r = rig();
  const size = paramOf(r, 'generate/fractal-noise', 'size');
  for (const value of [0.3, 0.31, 0.32]) {
    r.clock.now += 200;
    setParamOf(r.ctx, r.target(r.ids.noise), size, value);
  }
  assert.deepEqual(r.labels(), ['Fractal Noise: Feature size']);
  r.clock.now += 700;
  setParamOf(r.ctx, r.target(r.ids.noise), size, 0.5);
  assert.equal(r.labels().length, 2, 'after a pause the next edit is a step of its own');
  r.doc.getState().undo();
  assert.equal(r.param(r.ids.noise, 'size'), 0.32);
  r.doc.getState().undo();
  assert.equal(r.param(r.ids.noise, 'size'), 0.25, 'the burst is undone as one');
});

test('a drag is one history entry however long it lasts, and a step of its own', () => {
  const r = rig();
  const size = paramOf(r, 'generate/fractal-noise', 'size');
  const key = paramKey([r.ids.noise], 'size');
  assert.equal(key, `param:${r.ids.noise}:size`, 'the merge key of runtime.md 8.5 rule 4');
  // A typed edit just before the drag is not swallowed by it.
  setParamOf(r.ctx, r.target(r.ids.noise), size, 0.3);
  r.clock.now += 5000;

  const gesture = createGesture(r.doc, key);
  gesture.begin();
  assert.equal(r.doc.getState().gesture, key);
  for (let step = 1; step <= 40; step++) {
    r.clock.now += 1000;   // slower than any merge by time
    setParamOf(r.ctx, r.target(r.ids.noise), size, 0.3 + step * 0.01);
  }
  gesture.end();
  assert.equal(r.doc.getState().gesture, null);
  assert.deepEqual(r.labels(), ['Fractal Noise: Feature size', 'Fractal Noise: Feature size']);
  assert.equal(r.param(r.ids.noise, 'size'), 0.7);
  r.doc.getState().undo();
  assert.equal(r.param(r.ids.noise, 'size'), 0.3, 'undo takes the whole drag back');
  r.doc.getState().redo();
  assert.equal(r.param(r.ids.noise, 'size'), 0.7);

  // The next drag is the next entry. (One that began within 600 ms of the last would merge with it by rule 3.)
  r.clock.now += 5000;
  gesture.begin();
  setParamOf(r.ctx, r.target(r.ids.noise), size, 0.9);
  gesture.end();
  assert.equal(r.labels().length, 3);
  // Ending twice, or without a beginning, does nothing.
  gesture.end();
  gesture.end(false);
  assert.equal(r.labels().length, 3);
});

test('a drag that Escape took back leaves the document and the history as they were', () => {
  const r = rig();
  const size = paramOf(r, 'generate/fractal-noise', 'size');
  setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'octaves'), 4);
  r.clock.now += 5000;
  const saved = r.doc.getState().doc;

  const gesture = createGesture(r.doc, paramKey([r.ids.noise], 'size'));
  gesture.begin();
  for (const value of [0.3, 0.4, 0.5]) setParamOf(r.ctx, r.target(r.ids.noise), size, value);
  // What the number field does on Escape: the value the drag began with, then the end, not kept.
  setParamOf(r.ctx, r.target(r.ids.noise), size, 0.25);
  gesture.end(false);

  assert.deepEqual(r.labels(), ['Fractal Noise: Octaves'], 'no entry of the drag is left to undo');
  assert.equal(r.param(r.ids.noise, 'size'), 0.25);
  assert.ok(JSON.stringify(r.doc.getState().doc) === JSON.stringify(saved), 'the document is what it was before the drag');
  assert.equal(r.doc.getState().gesture, null);
  assert.equal(r.doc.getState().future.length, 0, 'and none to redo: the drag left no entry that changes nothing');
  r.doc.getState().undo();
  assert.equal(r.param(r.ids.noise, 'octaves'), 8, 'the next undo is the step before the drag');

  // What could be redone before the drag still can: a drag that is taken back has cost no redo step.
  assert.equal(r.doc.getState().future.length, 1);
  gesture.begin();
  for (const value of [0.6, 0.7]) setParamOf(r.ctx, r.target(r.ids.noise), size, value);
  assert.equal(r.doc.getState().future.length, 0, 'while it lasts, the drag is a change like any other');
  setParamOf(r.ctx, r.target(r.ids.noise), size, 0.25);
  gesture.end(false);
  assert.deepEqual([r.doc.getState().future.length, r.doc.getState().past.length, r.param(r.ids.noise, 'octaves')], [1, 0, 8]);
  r.doc.getState().redo();
  assert.equal(r.param(r.ids.noise, 'octaves'), 4, 'the redo that was there before the drag');
  r.doc.getState().undo();

  // A drag that never changed anything, taken back, undoes nothing.
  r.doc.getState().redo();
  gesture.begin();
  gesture.end(false);
  assert.deepEqual([r.labels(), r.param(r.ids.noise, 'octaves')], [['Fractal Noise: Octaves'], 4]);
});

test('several nodes of one type are edited together in one entry, and each is undone with it', () => {
  const r = rig();
  const both = r.target(r.ids.noise, r.ids.second);
  assert.equal(targetLabel(both), '2 × Fractal Noise');
  setParamOf(r.ctx, both, paramOf(r, 'generate/fractal-noise', 'octaves'), 3);
  assert.deepEqual([r.param(r.ids.noise, 'octaves'), r.param(r.ids.second, 'octaves')], [3, 3]);
  assert.deepEqual(r.labels(), ['2 × Fractal Noise: Octaves']);
  assert.equal(r.doc.getState().past[0]!.mergeKey, `param:${r.ids.noise}+${r.ids.second}:octaves`);
  r.doc.getState().undo();
  assert.deepEqual([r.param(r.ids.noise, 'octaves'), r.param(r.ids.second, 'octaves')], [8, 8]);

  // A node that was deleted while the control still named it is left out; the others are edited.
  r.doc.getState().transact('Delete', (draft) => { delete draft.nodes[r.ids.second]; });
  setParamOf(r.ctx, both, paramOf(r, 'generate/fractal-noise', 'octaves'), 5);
  assert.equal(r.param(r.ids.noise, 'octaves'), 5);
});

test('a parameter is reset alone, and all of a node\'s at once in one entry', () => {
  const r = rig();
  const type = 'generate/fractal-noise';
  for (const [name, value] of [['size', 0.5], ['octaves', 3], ['mode', 'billow']] as const) {
    r.clock.now += 5000;
    setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, type, name), value);
  }
  resetParamsOf(r.ctx, r.target(r.ids.noise), [paramOf(r, type, 'octaves')]);
  assert.deepEqual([r.param(r.ids.noise, 'octaves'), r.param(r.ids.noise, 'size')], [8, 0.5]);
  assert.equal(r.labels().at(-1), 'Fractal Noise: Reset Octaves');

  resetParamsOf(r.ctx, r.target(r.ids.noise), REGISTRY.get(type)!.params);
  assert.deepEqual([r.param(r.ids.noise, 'size'), r.param(r.ids.noise, 'mode')], [0.25, 'fbm']);
  assert.equal(r.labels().at(-1), 'Fractal Noise: Reset Parameters');
  const entries = r.labels().length;
  r.doc.getState().undo();
  assert.deepEqual([r.param(r.ids.noise, 'size'), r.param(r.ids.noise, 'mode'), r.param(r.ids.noise, 'octaves')], [0.5, 'billow', 8], 'one undo brings all of them back');
  // Resetting what is at its default is no transaction.
  r.doc.getState().redo();
  resetParamsOf(r.ctx, r.target(r.ids.noise), REGISTRY.get(type)!.params);
  resetParamsOf(r.ctx, r.target(r.ids.noise), []);
  assert.equal(r.labels().length, entries);
});

test('the settings are edited like parameters, except the two that are no undo steps', () => {
  const r = rig();
  setSettingOf(r.ctx, 'terrainSize', 8000);
  r.clock.now += 100;
  setSettingOf(r.ctx, 'terrainSize', 8128);
  r.clock.now += 5000;
  setSettingOf(r.ctx, 'heightRange', 2000);
  setSettingOf(r.ctx, 'seaLevel', 0.2);
  setSettingOf(r.ctx, 'seed', 77);
  assert.deepEqual(r.labels(), ['Project: Terrain size', 'Project: Height range', 'Project: Sea level', 'Project: Seed']);
  assert.equal(r.doc.getState().past[0]!.mergeKey, settingKey('terrainSize'));
  const { settings } = r.doc.getState().doc;
  assert.deepEqual([settings.terrainSize, settings.heightRange, settings.seaLevel, settings.seed], [8128, 2000, 0.2, 77]);

  // Values outside the limits of runtime.md 4.2 are taken into them by setSettings.
  setSettingOf(r.ctx, 'terrainSize', 0);
  setSettingOf(r.ctx, 'seed', 2 ** 40);
  assert.deepEqual([r.doc.getState().doc.settings.terrainSize, r.doc.getState().doc.settings.seed], [1, 2 ** 32 - 1]);

  // The build resolution and the preview level: no entry, and the history stays as it is (8.5 rule 5). A new build
  // resolution takes the preview level with it that keeps the previews at the resolution they had, or the nearest
  // its ladder has (4.2): 4033 at level 2 is 1009, and stays 1009.
  const entries = r.labels().length;
  const held = (): number[] => {
    const now = r.doc.getState().doc.settings;
    return [now.buildResolution, now.previewLevel, previewResolution(now)];
  };
  assert.deepEqual(held(), [4033, 2, 1009]);
  setSettingOf(r.ctx, 'buildResolution', 1009);
  assert.deepEqual(held(), [1009, 0, 1009], 'a smaller build does not blur the previews');
  setSettingOf(r.ctx, 'buildResolution', 8129);
  assert.deepEqual(held(), [8129, 3, 1017], 'and a larger one does not make them four times as heavy');
  setSettingOf(r.ctx, 'buildResolution', 4033);
  assert.deepEqual(held(), [4033, 2, 1009], 'and back');
  setSettingOf(r.ctx, 'previewLevel', 6);
  setSettingOf(r.ctx, 'buildResolution', 2017);
  assert.deepEqual(held(), [2017, 5, 64], 'the coarsest previews stay the coarsest');
  setSettingOf(r.ctx, 'previewLevel', 9);
  assert.equal(r.doc.getState().doc.settings.previewLevel, 5, 'a level the resolution lacks is lowered to its last');
  assert.equal(r.labels().length, entries);
  r.doc.getState().undo();
  assert.deepEqual([r.doc.getState().doc.settings.seed, r.doc.getState().doc.settings.buildResolution], [77, 2017], 'undo steps over them');
});

test('a seed drawn by the dice is an unsigned 32-bit integer, and not always the same', () => {
  const drawn = new Set<number>();
  for (let i = 0; i < 16; i++) {
    const seed = randomSeed();
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 2 ** 32 - 1, String(seed));
    drawn.add(seed);
  }
  assert.ok(drawn.size > 8);
});

// ---- the commands ----

test('the commands are the inspector\'s own, each with a title, and their keys and menu name commands that exist', () => {
  const ids = commands.map((command) => command.id);
  assert.deepEqual(ids, [
    'inspector.rename', 'inspector.toggleBypass', 'inspector.resetParameter', 'inspector.resetAll', 'inspector.randomizeSeed', 'inspector.reloadFiles',
    'inspector.expandAll', 'inspector.collapseAll',
  ]);
  for (const command of commands) assert.match(command.title, /^[A-Z][a-z]+( [A-Z][a-z]+)*$/, `"${command.title}" is title case`);
  assert.deepEqual(keys, [{ key: 'F2', command: 'inspector.rename', scope: 'inspector' }, { key: 'B', command: 'inspector.toggleBypass', scope: 'inspector' }]);
  assert.deepEqual(menu.map((entry) => entry.command), ids, 'every command is in the menu');
  assert.ok(menu.every((entry) => entry.menu === 'Inspector'));
});

test('each command is enabled for what it can act on, and acts on the selection', () => {
  const r = rig();
  const select = (...ids: string[]): void => setSelection(r.ctx.ui, ids);
  const all = commands.map((command) => command.id);
  const enabled = (): string[] => all.filter((id) => r.enabled(id)).map((id) => id.slice('inspector.'.length));

  // Nothing selected: the project settings, whose seed the dice draws.
  assert.deepEqual(enabled(), ['randomizeSeed']);
  r.run('inspector.randomizeSeed');
  assert.deepEqual(r.labels(), ['Project: Seed']);
  r.run('inspector.toggleBypass');
  r.run('inspector.resetAll');
  assert.equal(r.labels().length, 1, 'a command that is not enabled does nothing');

  // A generator: it has a seed and a group, and no input to bypass.
  select(r.ids.noise);
  assert.deepEqual(enabled(), ['rename', 'randomizeSeed', 'expandAll', 'collapseAll']);
  const requests = inspectorStore.getState().renameRequests;
  r.run('inspector.rename');
  assert.equal(inspectorStore.getState().renameRequests, requests + 1, 'the title field is asked to take the focus');
  r.clock.now += 5000;
  r.run('inspector.randomizeSeed');
  assert.equal(r.labels().at(-1), 'Fractal Noise: Seed');
  assert.notEqual(r.param(r.ids.noise, 'seed'), 0);

  // Reset Parameter acts on the parameter under the pointer, and with the pointer on no row on the one last pressed or focused.
  r.clock.now += 5000;
  setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'octaves'), 3);
  assert.deepEqual(enabled(), ['rename', 'resetAll', 'randomizeSeed', 'expandAll', 'collapseAll'], 'no parameter is active yet');
  setHoverParam('gain', true);
  assert.equal(r.enabled('inspector.resetParameter'), false, 'the parameter under the pointer is at its default');
  setHoverParam('octaves', true);
  assert.equal(r.enabled('inspector.resetParameter'), true);
  // The pointer leaves for the menu bar across the rows above: none of them is what the user chose.
  setTouchedParam('octaves');
  setHoverParam('gain', true);
  setHoverParam('gain', false);
  setHoverParam('mode', true);
  setHoverParam('gain', false);
  assert.equal(activeParam(), 'mode', 'leaving a row the pointer is no longer on changes nothing');
  setHoverParam('mode', false);
  assert.equal(activeParam(), 'octaves', 'with the pointer on no row, the parameter that was pressed');
  r.run('inspector.resetParameter');
  assert.deepEqual([r.param(r.ids.noise, 'octaves'), r.labels().at(-1)], [8, 'Fractal Noise: Reset Octaves']);
  assert.notEqual(r.param(r.ids.noise, 'seed'), 0, 'the other parameters keep their values');
  r.clock.now += 5000;
  setParamOf(r.ctx, r.target(r.ids.noise), paramOf(r, 'generate/fractal-noise', 'gain'), 0.9);
  r.run('inspector.resetAll');
  assert.deepEqual([r.param(r.ids.noise, 'seed'), r.param(r.ids.noise, 'gain'), r.labels().at(-1)], [0, 0.5, 'Fractal Noise: Reset Parameters']);
  assert.equal(r.enabled('inspector.resetAll'), false);
  forgetParams();
  assert.equal(activeParam(), null);

  // The sections of the node's type.
  const warp = sectionKey('generate/fractal-noise', 'Warp');
  r.run('inspector.collapseAll');
  assert.deepEqual(inspectorStore.getState().collapsed, { [warp]: true });
  r.run('inspector.expandAll');
  assert.deepEqual(inspectorStore.getState().collapsed, {});
  setSectionOpen(warp, false);
  setSectionOpen(warp, false);
  assert.deepEqual(Object.keys(inspectorStore.getState().collapsed), [warp]);
  setSectionOpen(warp, true);

  // A filter can be bypassed; the command toggles.
  select(r.ids.blur);
  assert.deepEqual(enabled(), ['rename', 'toggleBypass']);
  r.run('inspector.toggleBypass');
  assert.deepEqual([r.doc.getState().doc.nodes[r.ids.blur]!.bypass, r.labels().at(-1)], [true, 'Bypass Node']);
  r.run('inspector.toggleBypass');
  assert.deepEqual([r.doc.getState().doc.nodes[r.ids.blur]!.bypass, r.labels().at(-1)], [undefined, 'Enable Node']);

  // Nodes of several types: only what can be bypassed is, and nothing is renamed.
  select(r.ids.blur, r.ids.noise);
  assert.deepEqual(enabled(), ['toggleBypass']);
  r.run('inspector.toggleBypass');
  assert.deepEqual([r.doc.getState().doc.nodes[r.ids.blur]!.bypass, r.doc.getState().doc.nodes[r.ids.noise]!.bypass], [true, undefined]);

  // A node that reads a file: the engine is told its project again, which makes it look at the file anew.
  select(r.ids.imported);
  assert.deepEqual(enabled(), ['rename', 'reloadFiles']);
  r.run('inspector.reloadFiles');
  assert.deepEqual(r.projects, ['/projects/alps.orogen']);

  // An export node has groups and no seed.
  select(r.ids.landscape);
  assert.deepEqual(enabled(), ['rename', 'expandAll', 'collapseAll']);
  // A parameter whose row is hidden is none the user points at: "Reset Parameter" leaves it, "Reset All" takes it.
  r.clock.now += 5000;
  setParamOf(r.ctx, r.target(r.ids.landscape), paramOf(r, 'io/export-landscape', 'heightMin'), 0.2);
  setTouchedParam('heightMin');
  assert.deepEqual(enabled(), ['rename', 'resetAll', 'expandAll', 'collapseAll'], 'the lowest height is shown for a fixed range only');
  r.run('inspector.resetParameter');
  assert.equal(r.param(r.ids.landscape, 'heightMin'), 0.2);
  r.clock.now += 5000;
  setParamOf(r.ctx, r.target(r.ids.landscape), paramOf(r, 'io/export-landscape', 'rangeMode'), 'fixed');
  assert.equal(r.enabled('inspector.resetParameter'), true);
  r.run('inspector.resetParameter');
  assert.deepEqual([r.param(r.ids.landscape, 'heightMin'), r.param(r.ids.landscape, 'rangeMode'), r.labels().at(-1)], [0, 'fixed', 'Unreal Landscape: Reset Lowest height']);
  r.run('inspector.resetAll');
  assert.equal(r.param(r.ids.landscape, 'rangeMode'), 'measured');
  forgetParams();
  r.run('inspector.collapseAll');
  assert.deepEqual(Object.keys(inspectorStore.getState().collapsed).sort(), [sectionKey('io/export-landscape', 'Layers'), sectionKey('io/export-landscape', 'World Partition')]);
  r.run('inspector.expandAll');
});

test('a node of a type this build lacks is a summary: it has no title field to rename it in', () => {
  const r = rig();
  r.doc.getState().load({ ...r.doc.getState().doc, nodes: { ...r.doc.getState().doc.nodes, ghost: { id: 'ghost', type: 'gone/away', version: 1, position: { x: 0, y: 0 }, params: {} } } }, null);
  setSelection(r.ctx.ui, ['ghost']);
  assert.equal(r.enabled('inspector.rename'), false);
  const requests = inspectorStore.getState().renameRequests;
  r.run('inspector.rename');
  assert.equal(inspectorStore.getState().renameRequests, requests);
  for (const command of commands) assert.equal(r.enabled(command.id), false, command.id);
});

test('a node saved by another version of its type is not edited by any command', () => {
  const r = rig();
  r.doc.getState().transact('Old', (draft) => { draft.nodes[r.ids.noise]!.version = 9; draft.nodes[r.ids.noise]!.params.octaves = 3; });
  setSelection(r.ctx.ui, [r.ids.noise]);
  setTouchedParam('octaves');
  for (const id of ['inspector.resetParameter', 'inspector.resetAll', 'inspector.randomizeSeed']) assert.equal(r.enabled(id), false, id);
  const before = r.doc.getState().revision;
  for (const command of commands) r.run(command.id);
  assert.equal(r.doc.getState().revision, before);
  forgetParams();
  for (const command of commands) if (command.id === 'inspector.expandAll') r.run(command.id);
});
