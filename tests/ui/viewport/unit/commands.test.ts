// The commands of the viewport panel (src/app/panels/viewport/commands.ts, runtime.md 8.8) without a window:
// what the PanelDef brings to the shell is consistent, and each command does to the panel's state, or to the
// view of the document, what its title says.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import type { FieldStats } from '../../../../src/core/api.ts';
import { addNode, createRegistry, type DocDraft, type EngineEvent, type EngineSession } from '../../../../src/core/runtime.ts';
import { commands, frameTerrain, keys, menu, paletteCommand, SHADING_COMMAND, terrainOf, TOP_STYLE_COMMAND } from '../../../../src/app/panels/viewport/commands.ts';
import { DEFAULT_DISPLAY, initialModel, PALETTES } from '../../../../src/app/panels/viewport/model.ts';
import { BOTH, untouched, viewportStore } from '../../../../src/app/panels/viewport/state.ts';
import { createDocStore } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore } from '../../../../src/app/state/engine-store.ts';
import { createUiStore } from '../../../../src/app/state/ui-store.ts';
import type { CommandContext } from '../../../../src/app/ui/types.ts';

const REGISTRY = createRegistry(nodes);

/**
 * `answer` settles what the engine was asked last: the statistics of a port come when the test says so. `emit`
 * is an event of the engine, to whoever subscribed; `listeners` is how many do.
 */
function context(): { readonly ctx: CommandContext; readonly asked: unknown[]; answer(stats: FieldStats | null): Promise<void>; emit(event: EngineEvent): void; listeners(): number } {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  const asked: unknown[] = [];
  let settle: (stats: FieldStats | null) => void = () => undefined;
  const subscribed = new Set<(event: EngineEvent) => void>();
  const engine = {
    inspect: (ref: unknown) => { asked.push(ref); return new Promise<FieldStats | null>((resolve) => { settle = resolve; }); },
    subscribe: (listener: (event: EngineEvent) => void) => { subscribed.add(listener); return () => { subscribed.delete(listener); }; },
  } as unknown as EngineSession;
  const ctx = { doc, ui, engineState: createEngineStore(), engine, registry: REGISTRY, platform: {} as CommandContext['platform'], run: () => undefined } as CommandContext;
  return {
    ctx, asked,
    answer: async (stats) => { settle(stats); await new Promise((resolve) => setImmediate(resolve)); },
    emit: (event) => { for (const listener of [...subscribed]) listener(event); },
    listeners: () => subscribed.size,
  };
}
const command = (id: string) => {
  const found = commands.find((c) => c.id === id);
  assert.ok(found, `the panel declares ${id}`);
  return found;
};
const reset = (): void => viewportStore.setState({ ...initialModel(), width: 1600, height: 1000 }, true);

test('the PanelDef: every command is the viewport\'s, no id is declared twice, and keys and menu entries name declared commands', () => {
  const ids = commands.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of commands) {
    assert.match(c.id, /^viewport\.[a-zA-Z]+$/);
    // testing.md 6.2: Title Case, no full stop.
    assert.ok(/^[A-Z]/.test(c.title) && !c.title.endsWith('.') && c.title.length <= 40, c.title);
  }
  for (const id of ['viewport.toggleTop', 'viewport.frame']) assert.ok(ids.includes(id), id);
  assert.deepEqual(keys, [{ key: 'F', command: 'viewport.frame', scope: 'viewport' }, { key: 'Home', command: 'viewport.resetView', scope: 'viewport' }], 'F6 is the shell\'s global binding to viewport.toggleTop (8.8)');
  for (const entry of menu) assert.ok(ids.includes(entry.command), `the menu entry ${entry.command}`);
  assert.deepEqual([...new Set(menu.map((entry) => entry.menu))], ['View', 'Viewport']);
  for (const id of [...Object.values(SHADING_COMMAND), ...Object.values(TOP_STYLE_COMMAND), ...PALETTES.map(paletteCommand)]) assert.ok(ids.includes(id), id);
});

test('the commands of the display change the panel\'s state, each as its title says', async () => {
  reset();
  const { ctx } = context();
  const display = () => viewportStore.getState().display;
  await command('viewport.toggleTop').run(ctx);
  assert.equal(viewportStore.getState().mode, 'top');
  await command('viewport.toggleTop').run(ctx);
  assert.equal(viewportStore.getState().mode, 'orbit');

  await command('viewport.shadingClay').run(ctx);
  assert.equal(display().shading, 'clay');
  await command('viewport.shadingMaterial').run(ctx);
  assert.equal(display().shading, 'material');
  for (const [style, id] of Object.entries(TOP_STYLE_COMMAND)) {
    await command(id).run(ctx);
    assert.equal(display().topStyle, style);
  }
  await command('viewport.toggleSea').run(ctx);
  assert.equal(display().showSea, !DEFAULT_DISPLAY.showSea);
  for (const palette of PALETTES) {
    await command(paletteCommand(palette)).run(ctx);
    assert.equal(display().palette, palette);
  }
  await command('viewport.nextPalette').run(ctx);
  assert.equal(display().palette, PALETTES[0], 'after the last palette comes the first');

  viewportStore.setState({ display: { ...display(), sunAzimuth: 10, sunElevation: 80, verticalScale: 3 } });
  await command('viewport.resetSun').run(ctx);
  assert.deepEqual([display().sunAzimuth, display().sunElevation, display().verticalScale], [DEFAULT_DISPLAY.sunAzimuth, DEFAULT_DISPLAY.sunElevation, 3]);
  await command('viewport.resetVerticalScale').run(ctx);
  assert.equal(display().verticalScale, 1);
  // A command that changes nothing tells nobody.
  const same = viewportStore.getState();
  await command('viewport.resetSun').run(ctx);
  assert.equal(viewportStore.getState(), same);
});

test('Frame Terrain frames both cameras for the project\'s terrain, and again around the heights the engine reports', async () => {
  reset();
  const { ctx, asked, answer } = context();
  ctx.doc.getState().transact('Size', (draft) => { draft.settings.terrainSize = 10_000; draft.settings.heightRange = 2000; });
  let range = '';
  ctx.doc.getState().transact('Add', (draft) => { range = addNode(draft as DocDraft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 }); });
  ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height: { node: range, port: 'out' } }; }, { undoable: false });
  assert.deepEqual(terrainOf(ctx), { terrainSize: 10_000, heightRange: 2000 });

  const before = viewportStore.getState().orbit;
  viewportStore.setState({ orbit: { ...before, yaw: 20, pitch: 55 } });
  await command('viewport.frame').run(ctx);
  const framed = viewportStore.getState();
  assert.deepEqual(framed.framed, { terrainSize: 10_000, heightRange: 2000 });
  assert.deepEqual([framed.orbit.yaw, framed.orbit.pitch], [20, 55], 'the direction is kept');
  assert.ok(Math.hypot(framed.orbit.target[0] - 5000, framed.orbit.target[1] - 5000) < 2000, `the camera looks at the middle of the terrain: ${framed.orbit.target.join(' ')}`);
  assert.deepEqual(framed.top, { kind: 'top', center: [0.5, 0.5], span: 1.08 * 1.6 });
  assert.deepEqual(asked, [{ node: range, port: 'out' }]);
  await answer({ min: 0.5, max: 0.9, mean: 0.7, nonFinite: 0 });
  const refined = viewportStore.getState().orbit;
  assert.ok(refined !== framed.orbit && refined.target[2] > framed.orbit.target[2] + 100, `the camera looks higher, where the terrain is: ${refined.target[2]} after ${framed.orbit.target[2]}`);
});

test('a camera follows the shape of the panel until a hand has moved it, each camera for itself, and again once it is framed', async () => {
  reset();
  const { ctx } = context();
  assert.deepEqual(untouched(viewportStore.getState()), BOTH, 'before the first framing both cameras are the panel\'s to place');
  // What the panel does when its canvas gets another shape: the cameras nobody has moved are framed for it.
  const reshape = (width: number, height: number): void => {
    viewportStore.setState({ width, height });
    frameTerrain(ctx, untouched(viewportStore.getState()));
  };
  reshape(1200, 400);
  const wide = viewportStore.getState();
  assert.deepEqual([untouched(wide), wide.top.span], [BOTH, 1.08 * 3]);
  reshape(600, 900);
  const tall = viewportStore.getState();
  assert.ok(tall.orbit.distance > wide.orbit.distance && tall.top.span === 1.08, 'a tall panel: the camera backs away, the top view shows the terrain across its width');

  // The user turns the 3D camera; the top view is as it was framed.
  const turned = { ...tall.orbit, yaw: 10 };
  viewportStore.setState({ orbit: turned });
  assert.deepEqual(untouched(viewportStore.getState()), { orbit: false, top: true });
  reshape(1200, 400);
  assert.equal(viewportStore.getState().orbit, turned, 'the camera the user turned stays');
  assert.equal(viewportStore.getState().top.span, 1.08 * 3, 'the top view follows');
  // Nothing to frame: nothing is asked of the engine and nothing changes.
  viewportStore.setState({ top: { ...viewportStore.getState().top, span: 0.3 } });
  const both = viewportStore.getState();
  reshape(900, 900);
  assert.deepEqual([viewportStore.getState().orbit, viewportStore.getState().top], [both.orbit, both.top]);
  assert.deepEqual(untouched(viewportStore.getState()), { orbit: false, top: false });

  // A panel that is resized asks the engine nothing, however many shapes it passes through, and keeps what it knows of the heights.
  reset();
  const asking = context();
  let range = '';
  asking.ctx.doc.getState().transact('Add', (draft) => { range = addNode(draft as DocDraft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 }); });
  asking.ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height: { node: range, port: 'out' } }; }, { undoable: false });
  await command('viewport.frame').run(asking.ctx);
  await asking.answer({ min: 0.6, max: 1, mean: 0.8, nonFinite: 0 });
  const high = viewportStore.getState().orbit;
  for (const width of [1500, 1400, 1300, 1200]) {
    viewportStore.setState({ width, height: 1000 });
    frameTerrain(asking.ctx, untouched(viewportStore.getState()), false);
  }
  assert.equal(asking.asked.length, 1, 'the heights were asked for once, by the command');
  assert.deepEqual([viewportStore.getState().framedMiddle, untouched(viewportStore.getState())], [0.8, BOTH]);
  assert.ok(Math.abs(viewportStore.getState().orbit.target[2] - high.target[2]) < 0.2 * 1008, 'the camera still looks at where the terrain lies');
  // Another terrain: what was known of the last one's heights is not known of this one.
  asking.ctx.doc.getState().transact('Size', (draft) => { draft.settings.heightRange = 3000; });
  frameTerrain(asking.ctx, BOTH, false);
  assert.equal(viewportStore.getState().framedMiddle, null);

  // Frame Terrain makes both the panel's again. A change of the sun or of the view is no move of a camera.
  reset();
  viewportStore.setState({ orbit: { ...viewportStore.getState().orbit, yaw: 10 }, framed: { terrainSize: 4032, heightRange: 1008 } });
  assert.deepEqual(untouched(viewportStore.getState()), { orbit: false, top: false });
  await command('viewport.frame').run(ctx);
  await command('viewport.toggleTop').run(ctx);
  viewportStore.setState({ display: { ...viewportStore.getState().display, sunAzimuth: 12 } });
  assert.deepEqual(untouched(viewportStore.getState()), BOTH);
  assert.equal(viewportStore.getState().orbit.yaw, 10, 'from the direction the camera had');
});

test('Reset View looks from where a new session looks, at the whole terrain, wherever the camera had got to', async () => {
  reset();
  const { ctx } = context();
  const first = viewportStore.getState().orbit;
  viewportStore.setState({ orbit: { ...first, yaw: 77, pitch: 89.9, distance: 3, target: [9e5, -4e5, 12] } });
  await command('viewport.resetView').run(ctx);
  const back = viewportStore.getState().orbit;
  assert.deepEqual([back.yaw, back.pitch], [first.yaw, first.pitch]);
  const { terrainSize } = terrainOf(ctx);
  assert.ok(Math.hypot(back.target[0] - terrainSize / 2, back.target[1] - terrainSize / 2) < terrainSize / 4 && back.distance > terrainSize, JSON.stringify(back));
});

test('the second framing is the first one made finer: it waits for a terrain that is not shown yet, and never moves a camera the user has moved since', async () => {
  reset();
  const { ctx, asked, answer, emit, listeners } = context();
  let range = '';
  ctx.doc.getState().transact('Add', (draft) => { range = addNode(draft as DocDraft, REGISTRY, 'generate/mountain-range', { x: 0, y: 0 }); });
  ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height: { node: range, port: 'out' } }; }, { undoable: false });
  const shown: EngineEvent = { type: 'view-updated', requestId: 1, revision: 1, resolution: 1009, draft: false, height: true, overlay: false };
  const high = { min: 0.5, max: 0.9, mean: 0.7, nonFinite: 0 };

  // Nothing is shown when the application starts: the engine has no statistics, and is asked again when the terrain is there.
  await command('viewport.frame').run(ctx);
  const first = viewportStore.getState().orbit;
  await answer(null);
  assert.deepEqual([viewportStore.getState().orbit === first, listeners(), asked.length], [true, 1, 1]);
  emit({ ...shown, draft: true });
  assert.equal(asked.length, 1, 'a draft is not what the camera is framed for');
  emit(shown);
  assert.deepEqual([asked.length, listeners()], [2, 0], 'asked once more, and no longer listening');
  await answer(high);
  const refined = viewportStore.getState().orbit;
  assert.ok(refined.target[2] > first.target[2] + 50, 'framed around the heights of the terrain that came');
  emit(shown);
  assert.equal(asked.length, 2, 'later results do not frame again: the camera does not move as the terrain is edited');

  // The answer comes after the user has turned the camera: the camera stays the user's.
  await command('viewport.frame').run(ctx);
  const turned = { ...viewportStore.getState().orbit, yaw: 12 };
  viewportStore.setState({ orbit: turned });
  await answer(high);
  assert.equal(viewportStore.getState().orbit, turned);

  // Waiting for a terrain, and the camera is moved before it comes.
  await command('viewport.frame').run(ctx);
  await answer(null);
  assert.equal(listeners(), 1);
  const moved = { ...viewportStore.getState().orbit, distance: 123 };
  viewportStore.setState({ orbit: moved });
  emit(shown);
  await answer(high);
  assert.deepEqual([viewportStore.getState().orbit === moved, listeners()], [true, 0]);

  // A second framing ends the wait of the first: one listener at the most, however often F is pressed.
  await command('viewport.frame').run(ctx);
  await answer(null);
  await command('viewport.frame').run(ctx);
  await answer(null);
  assert.equal(listeners(), 1);

  // A sea that is shown above the terrain is in the picture.
  ctx.doc.getState().transact('Sea', (draft) => { draft.settings.seaLevel = 2; });
  await command('viewport.frame').run(ctx);
  const flooded = viewportStore.getState().orbit;
  await command('viewport.toggleSea').run(ctx);
  await command('viewport.frame').run(ctx);
  assert.ok(viewportStore.getState().orbit.distance < flooded.distance * 0.9, 'and not when it is hidden');
});

test('Remove Overlay takes the overlay out of the document\'s view, as a change that is not undone', async () => {
  reset();
  const { ctx } = context();
  const remove = command('viewport.removeOverlay');
  assert.equal(remove.enabled!(ctx), false);
  const height = { node: 'a', port: 'out' };
  ctx.doc.getState().transact('View', (draft) => { draft.ui.view = { height, overlay: { ref: { node: 'b', port: 'out' }, as: 'mask', opacity: 0.5 }, locked: true }; }, { undoable: false });
  assert.equal(remove.enabled!(ctx), true);
  await remove.run(ctx);
  assert.deepEqual(ctx.doc.getState().doc.ui.view, { height, locked: true });
  assert.deepEqual([ctx.doc.getState().past.length, remove.enabled!(ctx)], [0, false]);
});
