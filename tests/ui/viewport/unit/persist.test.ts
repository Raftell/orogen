// What the viewport keeps between runs (src/app/panels/viewport/persist.ts, runtime.md 7.5 "What is kept"),
// without a window: what goes with the project and what with the user, that a document comes back with it
// through the core's own reader and writer, and that a project which is only opened is not changed by it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { addNode, createRegistry, newDoc, parseDoc, serializeDoc, setSettings, type DocDraft, type EngineSession, type GraphDoc } from '../../../../src/core/runtime.ts';
import { commands } from '../../../../src/app/panels/viewport/commands.ts';
import { DEFAULT_DISPLAY, initialModel, orbit as turn, panTop } from '../../../../src/app/panels/viewport/model.ts';
import {
  DEFAULT_PROJECT_VIEW, keepViewport, keptIn, projectViewOf, readProjectView, readUserView, userViewOf, type ProjectView, type UserView,
} from '../../../../src/app/panels/viewport/persist.ts';
import { setDisplay, untouched, viewportStore } from '../../../../src/app/panels/viewport/state.ts';
import { createDocStore } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore } from '../../../../src/app/state/engine-store.ts';
import { createUiStore } from '../../../../src/app/state/ui-store.ts';
import type { Preferences } from '../../../../src/app/platform.ts';
import type { CommandContext } from '../../../../src/app/ui/types.ts';

const REGISTRY = createRegistry(nodes);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const reset = (): void => viewportStore.setState({ ...initialModel(), width: 1600, height: 1000, pictured: false, restored: false }, true);

/** A project with one mountain shown, and with `view` for what it keeps of the viewport when one is given. */
function project(view?: unknown, settings: object = {}): GraphDoc {
  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, { terrainSize: 4032, heightRange: 1008, ...settings });
  const id = addNode(draft, REGISTRY, 'generate/mountain', { x: 0, y: 0 });
  draft.ui.view = { height: { node: id, port: 'out' } };
  if (view !== undefined) (draft.ui as { viewport?: unknown }).viewport = view;
  return draft as GraphDoc;
}

/** The services the keeper uses: a document store of its own, an engine that answers nothing, and preferences that remember. */
function context(stored: unknown = null) {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  const written: Partial<Preferences>[] = [];
  const platform = {
    getPreferences: () => Promise.resolve({ gpu: { vramBytes: null, budgetFraction: 0.6 }, keymap: {}, layout: null, recent: [], viewport: stored, panels: {} } satisfies Preferences),
    setPreferences: (patch: Partial<Preferences>) => { written.push(patch); return Promise.resolve(); },
  } as unknown as CommandContext['platform'];
  const engine = { inspect: () => new Promise(() => undefined), subscribe: () => () => undefined } as unknown as EngineSession;
  const ctx = { doc, ui, engineState: createEngineStore(), engine, registry: REGISTRY, platform, run: () => undefined } as CommandContext;
  return { ctx, doc, written };
}

const KEPT: ProjectView = {
  version: 1, mode: 'top',
  orbit: { kind: 'orbit', target: [1200, 2500, 310], yaw: 41, pitch: 17, distance: 2600, fovY: 35 },
  top: { kind: 'top', center: [0.4, 0.62], span: 0.35 },
  sun: [300, 12], verticalScale: 2.5, showSea: false,
};

test('what a document holds is read as it is: every member in its range, a camera that is none left out, and nothing for a value this version does not know', () => {
  assert.deepEqual(readProjectView(KEPT), KEPT);
  assert.equal(readProjectView(undefined), null);
  assert.equal(readProjectView({ ...KEPT, version: 2 }), null);
  assert.equal(readProjectView('top'), null);
  const odd = readProjectView({
    version: 1, mode: 'sideways', orbit: { kind: 'orbit', target: [0, 0, Number.NaN], yaw: 0, pitch: 0, distance: 10 },
    top: { center: [7, -7], span: 400 }, sun: [725, 120], verticalScale: 0, showSea: 'yes',
  });
  assert.deepEqual(odd, { version: 1, mode: 'orbit', top: { kind: 'top', center: [2, -1], span: 16 }, sun: [5, 90], verticalScale: 0.01, showSea: true });
  const steep = readProjectView({ ...KEPT, orbit: { ...KEPT.orbit, yaw: -30, pitch: 200, distance: 1e12, fovY: 900 } });
  assert.deepEqual(steep!.orbit, { kind: 'orbit', target: [1200, 2500, 310], yaw: 330, pitch: 89.9, distance: 1e9, fovY: 35 });
  assert.deepEqual(readProjectView({ version: 1 }), DEFAULT_PROJECT_VIEW);

  assert.deepEqual(readUserView({ version: 1, shading: 'clay', topStyle: 'grey', palette: 'magma' }), { version: 1, shading: 'clay', topStyle: 'grey', palette: 'magma' });
  assert.deepEqual(readUserView({ version: 1, shading: 'chrome', palette: 7 }), { version: 1, shading: 'material', topStyle: 'hillshade', palette: 'red' });
  assert.equal(readUserView(null), null);
  assert.equal(readUserView({ shading: 'clay' }), null);
});

test('which is which: the cameras, the sun, the scale and the sea are the project\'s; the shading, the top style and the palette the user\'s', () => {
  const state = { ...initialModel(), display: { ...DEFAULT_DISPLAY, sunAzimuth: 300, verticalScale: 2, showSea: false, shading: 'clay' as const, palette: 'turbo' as const } };
  const view = projectViewOf(state);
  assert.deepEqual(Object.keys(view).sort(), ['mode', 'showSea', 'sun', 'version', 'verticalScale']);
  assert.deepEqual([view.sun, view.verticalScale, view.showSea], [[300, DEFAULT_DISPLAY.sunElevation], 2, false]);
  assert.deepEqual(userViewOf(state.display), { version: 1, shading: 'clay', topStyle: 'hillshade', palette: 'turbo' });
  // Between them they hold every display option, and each holds what the other does not.
  const project = { sunAzimuth: 0, sunElevation: 0, verticalScale: 0, showSea: 0 }, user = { shading: 0, topStyle: 0, palette: 0 };
  assert.deepEqual(Object.keys({ ...project, ...user }).sort(), Object.keys(DEFAULT_DISPLAY).sort());

  // A camera is the project's once a hand has moved it: one that is still the framed one is framed again.
  const framed = { ...state, framed: { terrainSize: 4032, heightRange: 1008 }, framedOrbit: state.orbit, framedTop: state.top };
  assert.equal(projectViewOf(framed).orbit, undefined);
  const moved = { ...framed, orbit: turn(framed.orbit, 30, 0) };
  assert.deepEqual([projectViewOf(moved).orbit, projectViewOf(moved).top], [moved.orbit, undefined]);
});

test('a project comes back as it was left: the state is restored from the document, and a document that is only opened is not changed', async () => {
  reset();
  const { ctx, doc } = context();
  doc.getState().load(project(KEPT), '/projects/kept.orogen');
  const keeper = keepViewport(ctx, viewportStore, { delayMs: 5 });
  try {
    const state = viewportStore.getState();
    assert.deepEqual([state.mode, state.orbit, state.top], [KEPT.mode, KEPT.orbit, KEPT.top]);
    assert.deepEqual([state.display.sunAzimuth, state.display.sunElevation, state.display.verticalScale, state.display.showSea], [300, 12, 2.5, false]);
    assert.deepEqual(untouched(state), { orbit: false, top: false }, 'cameras of the project are the user\'s: a panel of another shape does not frame them anew');
    const before = doc.getState();
    keeper.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(doc.getState().doc === before.doc && doc.getState().revision === before.revision && !doc.getState().unsaved, 'opening a project writes nothing into it');

    // Another project, which holds nothing: the defaults, and cameras framed on its terrain from the first direction.
    doc.getState().load(project(undefined, { terrainSize: 8000 }), null);
    const fresh = viewportStore.getState();
    assert.deepEqual([fresh.mode, fresh.display.sunAzimuth, fresh.display.sunElevation, fresh.display.verticalScale, fresh.display.showSea],
      ['orbit', DEFAULT_DISPLAY.sunAzimuth, DEFAULT_DISPLAY.sunElevation, 1, true]);
    assert.deepEqual(untouched(fresh), { orbit: true, top: true });
    assert.deepEqual([fresh.orbit.yaw, fresh.orbit.pitch, fresh.framed], [initialModel().orbit.yaw, initialModel().orbit.pitch, { terrainSize: 8000, heightRange: 1008 }]);
    assert.ok(Math.hypot(fresh.orbit.target[0] - 4000, fresh.orbit.target[1] - 4000) < 1600, `framed on the terrain of 8000 m: ${fresh.orbit.target.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(keptIn(doc.getState().doc), undefined, 'and nothing is written into a project that is shown by the defaults');

    // And back: the first project's again.
    doc.getState().load(project(KEPT), '/projects/kept.orogen');
    assert.deepEqual([viewportStore.getState().mode, viewportStore.getState().orbit, viewportStore.getState().top], [KEPT.mode, KEPT.orbit, KEPT.top]);
  } finally {
    keeper.stop();
  }

  // The dock makes the panel anew when a layout is restored: the state outlives it and is not restored a second
  // time, so a view that was framed from another direction, which the project does not hold, stays as it is.
  const frame = commands.find((command) => command.id === 'viewport.frame')!;
  viewportStore.setState({ mode: 'orbit', orbit: turn(viewportStore.getState().orbit, 60, 0) });
  await frame.run(ctx);
  const framedFromThere = viewportStore.getState();
  assert.deepEqual(untouched(framedFromThere), { orbit: true, top: true });
  assert.ok(framedFromThere.orbit.yaw !== initialModel().orbit.yaw, 'framed from the direction it was turned to');
  const again = keepViewport(ctx, viewportStore, { delayMs: 5 });
  try {
    assert.equal(viewportStore.getState().orbit, framedFromThere.orbit, 'the camera is where it was when the panel was made anew');
    assert.equal(viewportStore.getState().top, framedFromThere.top);
    // A project that is opened afterwards is restored as any.
    doc.getState().load(project(KEPT), '/projects/kept.orogen');
    assert.deepEqual(viewportStore.getState().orbit, KEPT.orbit);
  } finally {
    again.stop();
  }
});

test('what a hand changes goes into the document when it has rested: not undoable, not a change the evaluator sees, and the project is not unsaved by it', async () => {
  reset();
  const { ctx, doc } = context();
  doc.getState().load(project(), '/projects/new.orogen');
  const keeper = keepViewport(ctx, viewportStore, { delayMs: 5 });
  try {
    const before = doc.getState();
    // A drag of sixty moves is one write.
    for (let move = 0; move < 60; move++) viewportStore.setState({ orbit: turn(viewportStore.getState().orbit, 2, 1) });
    assert.equal(doc.getState().revision, before.revision, 'nothing is written while the camera moves');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const after = doc.getState();
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(keptIn(after.doc), { ...DEFAULT_PROJECT_VIEW, orbit: viewportStore.getState().orbit });
    assert.deepEqual([after.engineRevision, after.unsaved, after.past.length], [before.engineRevision, false, 0], 'the evaluator is not asked again, the history has no entry, and the project is as saved as it was');
    assert.ok(after.doc.nodes === before.doc.nodes && after.doc.settings === before.doc.settings && after.doc.ui.view === before.doc.ui.view);

    // The sun, the scale and the sea, the other camera and the view go the same way; flush writes at once.
    setDisplay(viewportStore, { sunAzimuth: 80, sunElevation: 25, verticalScale: 1.5, showSea: false });
    viewportStore.setState({ mode: 'top', top: panTop(viewportStore.getState().top, 40, 0, 1600) });
    keeper.flush();
    const held = readProjectView(keptIn(doc.getState().doc))!;
    assert.deepEqual([held.mode, held.sun, held.verticalScale, held.showSea, held.top], ['top', [80, 25], 1.5, false, viewportStore.getState().top]);

    // Frame Terrain gives the camera back to the framing: the project then holds none, and opens framed.
    const frame = commands.find((command) => command.id === 'viewport.frame')!;
    viewportStore.setState({ mode: 'orbit' });
    await frame.run(ctx);
    keeper.flush();
    assert.deepEqual([readProjectView(keptIn(doc.getState().doc))!.orbit, readProjectView(keptIn(doc.getState().doc))!.top], [undefined, undefined]);

    // The document comes back through the core's writer and reader with what was kept in it.
    viewportStore.setState({ orbit: turn(viewportStore.getState().orbit, 25, -10) });
    keeper.flush();
    const text = serializeDoc(doc.getState().doc);
    const read = parseDoc(text, REGISTRY);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(keptIn(read.doc), keptIn(doc.getState().doc));
    assert.deepEqual(readProjectView(keptIn(read.doc))!.orbit, viewportStore.getState().orbit);
  } finally {
    keeper.stop();
  }
});

test('the user\'s choices come from the preferences and go back there, and a change of the camera writes none', async () => {
  reset();
  const stored: UserView = { version: 1, shading: 'clay', topStyle: 'grey', palette: 'viridis' };
  const { ctx, doc, written } = context(stored);
  doc.getState().load(project(), null);
  const keeper = keepViewport(ctx, viewportStore, { delayMs: 5 });
  try {
    await tick();
    const { display } = viewportStore.getState();
    assert.deepEqual([display.shading, display.topStyle, display.palette], ['clay', 'grey', 'viridis']);
    assert.deepEqual([display.sunAzimuth, display.verticalScale], [DEFAULT_DISPLAY.sunAzimuth, 1], 'and nothing of the project\'s');
    viewportStore.setState({ orbit: turn(viewportStore.getState().orbit, 9, 0) });
    keeper.flush();
    assert.deepEqual(written, [], 'the preferences are written when a choice of the user changes, and for nothing else');
    const revision = doc.getState().revision;
    setDisplay(viewportStore, { palette: 'turbo' });
    keeper.flush();
    assert.deepEqual(written, [{ viewport: { version: 1, shading: 'clay', topStyle: 'grey', palette: 'turbo' } }]);
    assert.equal(doc.getState().revision, revision, 'and a choice of the user is not written into the project');
    setDisplay(viewportStore, { palette: 'turbo' });
    keeper.flush();
    assert.equal(written.length, 1);
  } finally {
    keeper.stop();
  }

  // Preferences that hold nothing: the defaults, and nothing is written for having read them.
  reset();
  const empty = context(null);
  empty.doc.getState().load(project(), null);
  const second = keepViewport(empty.ctx, viewportStore, { delayMs: 5 });
  try {
    await tick();
    assert.equal(viewportStore.getState().display.shading, 'material');
    viewportStore.setState({ orbit: turn(viewportStore.getState().orbit, 9, 0) });
    second.flush();
    assert.deepEqual(empty.written, []);
  } finally {
    second.stop();
  }

  // Where there is no bridge (the page outside the application) the keeper keeps what the document keeps.
  reset();
  const bare = context();
  (bare.ctx as { platform: unknown }).platform = {};
  bare.doc.getState().load(project(KEPT), null);
  const third = keepViewport(bare.ctx, viewportStore, { delayMs: 5 });
  assert.equal(viewportStore.getState().mode, 'top');
  third.stop();
});
