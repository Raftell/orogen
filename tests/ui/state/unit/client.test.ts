// EngineClient without an engine (runtime.md 7.2, 8.3, 8.5): the client on one port of a real MessageChannel and,
// on the other, the protocol's server over a session that only records. What the client sends, in which order,
// and where the events it receives go. The same client against the real engine is in ../client.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import type { StoreApi } from 'zustand/vanilla';

import type { FieldStats } from '../../../../src/core/api.ts';
import {
  DEFAULT_PREFERENCES, moveNodes, newDoc, serveSession, setGroup, setNodeFlags, setParam, setView,
  type BuildPlan, type BuildResult, type CameraState, type EngineEvent, type EngineSession, type GpuCaps, type GraphDoc, type PickResult,
  type SessionPort, type ViewportDisplay,
} from '../../../../src/core/runtime.ts';
import { createEngineClient, ENGINE_WATCH, EngineReplacedError, type EngineClient } from '../../../../src/app/engine/client.ts';
import type { DocState } from '../../../../src/app/state/doc-store.ts';
import { INITIAL_ENGINE_STATE } from '../../../../src/app/state/engine-store.ts';
import { createPage, difference, REGISTRY, until, type Page, same, different } from './_page.ts';

interface Call { readonly method: string; readonly args: readonly unknown[] }

/** The engine thread's end with a session that records every call and answers what the test tells it to. */
interface FarEnd {
  readonly port: SessionPort;
  readonly calls: Call[];
  /** What `inspect`, `build`, `viewport.pick` and `dispose` answer next, in order; an Error rejects. Without an answer, `inspect` and `build` stay open. */
  readonly answers: { inspect: unknown[]; build: unknown[]; pick: unknown[]; plan: unknown[] };
  emit(event: EngineEvent): void;
  methods(from?: number): string[];
  close(): void;
}

function farEnd(): FarEnd {
  const calls: Call[] = [];
  const listeners = new Set<(e: EngineEvent) => void>();
  const answers: FarEnd['answers'] = { inspect: [], build: [], pick: [], plan: [] };
  const tell = (method: string) => (...args: unknown[]): void => { calls.push({ method, args }); };
  const ask = (method: string, kind: keyof FarEnd['answers'] | null) => (...args: unknown[]): Promise<never> => {
    calls.push({ method, args });
    const queue = kind ? answers[kind] : [undefined];
    if (queue.length === 0) return kind === 'pick' ? Promise.resolve(null as never) : new Promise<never>(() => undefined);
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as never);
  };
  const session: EngineSession = {
    setProject: tell('setProject'), setDocument: tell('setDocument'), beginGesture: tell('beginGesture'), endGesture: tell('endGesture'),
    setPaused: tell('setPaused'), requestThumbnails: tell('requestThumbnails'), cancelBuild: tell('cancelBuild'),
    setPreferences: tell('setPreferences'), retryDevice: tell('retryDevice'),
    inspect: ask('inspect', 'inspect'), build: ask('build', 'build'), plan: ask('plan', 'plan'),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    viewport: {
      attach: tell('viewport.attach'), detach: tell('viewport.detach'), resize: tell('viewport.resize'),
      setCamera: tell('viewport.setCamera'), setDisplay: tell('viewport.setDisplay'), pick: ask('viewport.pick', 'pick'),
    },
    dispose: ask('dispose', null),
  };
  const { port1, port2 } = new MessageChannel();
  serveSession(session, port2);
  return {
    port: port1, calls, answers,
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    methods: (from = 0) => calls.slice(from).map((call) => call.method),
    close: () => { port1.close(); port2.close(); },
  };
}

interface Rig { readonly page: Page; readonly far: FarEnd; readonly client: EngineClient; readonly land: string; readonly soft: string }

/** A page with a small graph, and a client on a far end that has been told of it. */
async function rig(options: { readonly preferences?: typeof DEFAULT_PREFERENCES } = {}): Promise<Rig> {
  const page = createPage();
  const land = page.add('ref/fbm');
  const soft = page.add('ref/blur', {}, { in: `${land}.out` });
  const far = farEnd();
  const client = createEngineClient({ port: far.port, doc: page.doc, engineState: page.engineState, thumbnails: page.thumbnails, ...options });
  await until(() => far.calls.length >= 3, 'the client introduced itself');
  return { page, far, client, land, soft };
}

/**
 * Lets everything the client has sent arrive: messages are handled in the order sent (7.2), so when this
 * question is answered every earlier message has been handled. The question itself is taken out of the record.
 */
async function arrived(r: Pick<Rig, 'client' | 'far'>): Promise<void> {
  await r.client.viewport.pick(-1, -1);
  const at = r.far.calls.findLastIndex((call) => call.method === 'viewport.pick' && call.args[0] === -1);
  r.far.calls.splice(at, 1);
}

const CAPS = { software: false, vramBytes: 1 } as unknown as GpuCaps;
const stats: FieldStats = { min: 0, max: 1, mean: 0.5, nonFinite: 0 };

test('at start the session is told the preferences, then the project, then the document under its engine revision', async () => {
  const r = await rig({ preferences: { vramBytes: 6 * 2 ** 30, budgetFraction: 0.5 } });
  try {
    await arrived(r);
    assert.deepEqual(r.far.methods(), ['setPreferences', 'setProject', 'setDocument'], '8.3: before its first setDocument');
    assert.deepEqual(r.far.calls[0]!.args, [{ vramBytes: 6 * 2 ** 30, budgetFraction: 0.5 }]);
    assert.deepEqual(r.far.calls[1]!.args, [{ path: null }]);
    const [sent, revision] = r.far.calls[2]!.args as [GraphDoc, number];
    const state = r.page.doc.getState();
    assert.equal(difference(sent, state.doc), null, 'the whole document, as a copy');
    different(sent, state.doc);
    assert.deepEqual([revision, state.engineRevision, state.revision], [2, 2, 2]);
  } finally {
    r.far.close();
  }
});

test('without preferences of its own the client sends the defaults; a document that moved on after its last engine revision is sent under that revision', async () => {
  const page = createPage();
  const land = page.add('ref/fbm');
  page.doc.getState().transact('Move', (d) => moveNodes(d, [land], { x: 5, y: 5 }));
  const far = farEnd();
  const client = createEngineClient({ port: far.port, doc: page.doc, engineState: page.engineState, thumbnails: page.thumbnails });
  try {
    await arrived({ client, far });
    assert.deepEqual(far.calls[0], { method: 'setPreferences', args: [DEFAULT_PREFERENCES] });
    assert.deepEqual([far.calls[2]!.args[1], page.doc.getState().revision], [1, 2], 'the revision of the last change the evaluator can see');
  } finally {
    far.close();
  }
});

test('a change the evaluator can see is sent as the document and its revision; moving, renaming, collapsing and grouping send nothing', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const sent = r.far.calls.length;
    const store = r.page.doc;

    store.getState().transact('Gain', (d) => setParam(d, REGISTRY, r.land, 'gain', 0.75));
    store.getState().transact('Bypass', (d) => setNodeFlags(d, r.soft, { bypass: true }));
    store.getState().transact('View', (d) => setView(d, { height: { node: r.soft, port: 'out' } }), { undoable: false });
    await arrived(r);
    assert.deepEqual(r.far.methods(sent), ['setDocument', 'setDocument', 'setDocument']);
    assert.deepEqual(r.far.calls.slice(sent).map((call) => call.args[1]), [3, 4, 5], 'each under the revision it made');
    const last = r.far.calls.at(-1)!.args[0] as GraphDoc;
    assert.equal(difference(last, store.getState().doc), null);
    assert.deepEqual([last.nodes[r.land]!.params.gain, last.nodes[r.soft]!.bypass, last.ui.view?.height?.node], [0.75, true, r.soft]);

    const quiet = r.far.calls.length;
    store.getState().transact('Move', (d) => moveNodes(d, [r.land, r.soft], { x: 30, y: 0 }));
    store.getState().transact('Rename', (d) => setNodeFlags(d, r.soft, { title: 'Soften' }));
    store.getState().transact('Collapse', (d) => setNodeFlags(d, r.land, { collapsed: true }));
    store.getState().transact('Group', (d) => setGroup(d, { id: 'g', title: 'Land', rect: { x: 0, y: 0, w: 10, h: 10 } }));
    r.page.ui.setState({ selection: [r.land] });
    await arrived(r);
    assert.deepEqual(r.far.methods(quiet), [], 'four revisions the engine never hears of');
    assert.deepEqual([store.getState().revision, store.getState().engineRevision], [9, 5]);

    // Undo and redo are ordinary changes with a new revision: the engine is not told what they were.
    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    await arrived(r);
    assert.deepEqual(r.far.methods(quiet), [], 'undoing those four sends nothing either');
    store.getState().undo();
    await arrived(r);
    assert.deepEqual(r.far.methods(quiet), ['setDocument']);
    assert.deepEqual([r.far.calls.at(-1)!.args[1], (r.far.calls.at(-1)!.args[0] as GraphDoc).nodes[r.soft]!.bypass], [14, undefined]);
  } finally {
    r.far.close();
  }
});

test('a gesture of the document is a gesture of the engine: begun before its first document, ended after its last', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const store = r.page.doc;
    const key = `param:${r.land}:gain`;
    let from = r.far.calls.length;

    store.getState().beginGesture(key);
    for (const gain of [0.6, 0.7, 0.8]) store.getState().transact('Fbm: Roughness', (d) => setParam(d, REGISTRY, r.land, 'gain', gain), { mergeKey: key });
    store.getState().endGesture();
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['beginGesture', 'setDocument', 'setDocument', 'setDocument', 'endGesture']);
    assert.equal(store.getState().past.length, 3, 'two entries made the graph; the scrub is one more');

    // A drag of nodes is a gesture as well; its moves are sent to nobody.
    from = r.far.calls.length;
    store.getState().beginGesture('move:1');
    store.getState().transact('Move', (d) => moveNodes(d, [r.land], { x: 4, y: 4 }), { mergeKey: 'move:1' });
    store.getState().endGesture();
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['beginGesture', 'endGesture']);

    // A second beginGesture of the store while one is in progress is the same gesture to the engine.
    from = r.far.calls.length;
    store.getState().beginGesture('move:2');
    store.getState().beginGesture(key);
    store.getState().endGesture();
    store.getState().endGesture();
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['beginGesture', 'endGesture']);
  } finally {
    r.far.close();
  }
});

test('an undo in mid-gesture ends the gesture first, so that what it restores is evaluated in full', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const store = r.page.doc;
    const key = `param:${r.land}:gain`;
    const from = r.far.calls.length;
    store.getState().beginGesture(key);
    store.getState().transact('Fbm: Roughness', (d) => setParam(d, REGISTRY, r.land, 'gain', 0.9), { mergeKey: key });
    store.getState().undo();
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['beginGesture', 'setDocument', 'endGesture', 'setDocument']);
    assert.equal((r.far.calls.at(-1)!.args[0] as GraphDoc).nodes[r.land]!.params.gain, 0.5);
  } finally {
    r.far.close();
  }
});

test('setProject follows the path of the document: a save under a new name, and a loaded project before its document', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const store = r.page.doc;
    let from = r.far.calls.length;

    store.getState().markSaved('/projects/hills.orogen');
    await arrived(r);
    assert.deepEqual(r.far.calls.slice(from), [{ method: 'setProject', args: [{ path: '/projects/hills.orogen' }] }]);

    from = r.far.calls.length;
    store.getState().markSaved('/projects/hills.orogen');
    await arrived(r);
    assert.deepEqual(r.far.methods(from), [], 'a save under the same name changes no path');

    store.getState().load(newDoc(), '/projects/other/dunes.orogen');
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['setProject', 'setDocument'], 'the files of the new project before the document that names them');
    assert.deepEqual(r.far.calls.at(-2)!.args, [{ path: '/projects/other/dunes.orogen' }]);
    assert.deepEqual([r.far.calls.at(-1)!.args[1], Object.keys((r.far.calls.at(-1)!.args[0] as GraphDoc).nodes).length], [store.getState().revision, 0]);

    from = r.far.calls.length;
    store.getState().load(newDoc(), '/projects/other/dunes.orogen');
    store.getState().load(newDoc(), null);
    await arrived(r);
    assert.deepEqual(r.far.methods(from), ['setDocument', 'setProject', 'setDocument'], 'the same file again: its document alone; a new project: no path');
    assert.deepEqual(r.far.calls.at(-2)!.args, [{ path: null }]);
  } finally {
    r.far.close();
  }
});

test('every event goes into the engine store, a thumbnail\'s pixels into the cache first, and then to the subscribers, in order', async () => {
  const r = await rig();
  try {
    const heard: string[] = [];
    const off = r.client.subscribe((event) => heard.push(event.type));
    const second: string[] = [];
    r.client.subscribe((event) => second.push(event.type));
    // When the store tells of a thumbnail's key, the image is there to draw.
    const imagesAtKey: (string | null)[] = [];
    r.page.engineState.subscribe((state, previous) => {
      if (state.thumbnailKeys !== previous.thumbnailKeys) imagesAtKey.push(r.page.thumbnails.get(r.land)?.contentKey ?? null);
    });

    const rgba = new Uint8ClampedArray(128 * 128 * 4).fill(77);
    r.far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 << 30 });
    r.far.emit({ type: 'keys', revision: 2, keys: { [r.land]: 'k-land', [r.soft]: 'k-soft' } });
    r.far.emit({ type: 'thumbnail', nodeId: r.land, contentKey: 'k-land', resolution: 129, rgba });
    r.far.emit({ type: 'engine-error', message: 'A slice took 900 ms', fatal: false });
    await until(() => heard.length === 4, 'four events arrived');

    const state = r.page.engineState.getState();
    assert.deepEqual([state.device.state, state.keys[r.soft], state.thumbnailKeys[r.land]], ['ready', 'k-soft', 'k-land']);
    assert.deepEqual(heard, ['device-ready', 'keys', 'thumbnail', 'engine-error'], 'an error that is no state still reaches whoever shows it');
    assert.deepEqual(second, heard);
    assert.deepEqual(imagesAtKey, ['k-land']);

    const entry = r.page.thumbnails.get(r.land)!;
    const image = entry.image as unknown as { data: Uint8ClampedArray; width: number };
    assert.deepEqual([entry.contentKey, entry.resolution, image.width, image.data.length, image.data[0], image.data[image.data.length - 1]], ['k-land', 129, 128, 65536, 77, 77]);
    assert.equal(rgba.byteLength, 0, 'the pixels were moved across, not copied (7.2)');

    off();
    r.far.emit({ type: 'memory', budgetBytes: 100, workingBytes: 1, cacheBytes: 2, pinnedBytes: 3, freeBytes: 4, reservedBytes: 5, drainingBytes: 6 });
    await until(() => second.length === 5, 'the fifth event arrived');
    assert.equal(heard.length, 4, 'an ended subscription hears nothing more');
    assert.deepEqual(r.page.engineState.getState().memory, { budgetBytes: 100, workingBytes: 1, cacheBytes: 2, pinnedBytes: 3, freeBytes: 4, reservedBytes: 5, drainingBytes: 6 });
  } finally {
    r.far.close();
  }
});

test('a subscriber that throws keeps neither the store nor the other subscribers from the event', async () => {
  const r = await rig();
  const original = console.error;
  const said: unknown[] = [];
  console.error = (...args: unknown[]) => { said.push(args[0]); };
  try {
    let heard = 0;
    r.client.subscribe(() => { throw new Error('a toast that failed'); });
    r.client.subscribe(() => { heard++; });
    r.far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
    await until(() => heard === 1, 'the event arrived');
    assert.equal(r.page.engineState.getState().device.state, 'ready');
    assert.deepEqual(said, ['[orogen] an engine event listener threw']);
  } finally {
    console.error = original;
    r.far.close();
  }
});

test('the facade: every method of EngineSession reaches the session with its arguments, and every answer comes back', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const from = r.far.calls.length;
    const camera: CameraState = { kind: 'top', center: [0.5, 0.5], span: 1 };
    const display: ViewportDisplay = { verticalScale: 2, showSea: true, sunAzimuth: 315, sunElevation: 40 };
    const picked: PickResult = { uv: [0.25, 0.5], height: 0.75, position: [500, 1000, 450] };
    const built = { requestId: 9, status: 'ok', problems: [], files: [{ path: 'Land.orogen.json', bytes: 120 }], manifest: 'Land.orogen.json', report: 'Land.report.json', outDir: '/out', peakPoolBytes: 4096 } as BuildResult;
    const doc = r.page.doc.getState().doc;

    r.client.setPaused(true);
    r.client.requestThumbnails([r.land, r.soft]);
    r.client.setPreferences({ vramBytes: null, budgetFraction: 0.4 });
    r.client.viewport.attach(new ArrayBuffer(8) as unknown as OffscreenCanvas, { width: 640, height: 480, dpr: 2 });
    r.client.viewport.resize({ width: 800, height: 600, dpr: 2 });
    r.client.viewport.setCamera(camera);
    r.client.viewport.setDisplay(display);
    r.far.answers.pick.push(picked);
    assert.deepEqual(await r.client.viewport.pick(10, 20), picked);
    r.far.answers.inspect.push(stats, null);
    assert.deepEqual(await r.client.inspect({ node: r.soft, port: 'out' }), stats);
    assert.equal(await r.client.inspect({ node: r.land, port: 'out' }), null);
    r.far.answers.build.push(built, new Error('A build is already running'));
    assert.deepEqual(await r.client.build({ doc, outDir: '/out' }), built);
    await assert.rejects(r.client.build({ doc, outDir: '/out' }), /A build is already running/);
    r.client.cancelBuild();
    // A plan without a build (7.6): the document goes over, the plan comes back as plain values, and no event is its.
    const planned = { ok: false, resolution: 1009, name: 'Land', items: [], files: [], problems: [{ severity: 'error', code: 'E_NOTHING_TO_EXPORT', message: 'Nothing to export' }] };
    r.far.answers.plan.push(planned, new Error('This session was given no planner'));
    assert.deepEqual(await r.client.plan(doc), planned);
    await assert.rejects(r.client.plan(doc), /no planner/);
    r.client.retryDevice();
    r.client.viewport.detach();
    // What docStore usually drives is there for code that has no store.
    r.client.setProject({ path: '/elsewhere/a.orogen' });
    r.client.beginGesture();
    r.client.setDocument(doc, 40);
    r.client.endGesture();
    await arrived(r);

    const calls = r.far.calls.slice(from);
    assert.deepEqual(calls.map((call) => call.method), [
      'setPaused', 'requestThumbnails', 'setPreferences', 'viewport.attach', 'viewport.resize', 'viewport.setCamera', 'viewport.setDisplay',
      'viewport.pick', 'inspect', 'inspect', 'build', 'build', 'cancelBuild', 'plan', 'plan', 'retryDevice', 'viewport.detach',
      'setProject', 'beginGesture', 'setDocument', 'endGesture',
    ]);
    const args = (method: string): readonly unknown[] => calls.find((call) => call.method === method)!.args;
    assert.deepEqual(args('setPaused'), [true]);
    assert.deepEqual(args('requestThumbnails'), [[r.land, r.soft]]);
    assert.deepEqual(args('setPreferences'), [{ vramBytes: null, budgetFraction: 0.4 }]);
    assert.ok(args('viewport.attach')[0] instanceof ArrayBuffer, 'the canvas is moved to the other side');
    assert.deepEqual(args('viewport.attach')[1], { width: 640, height: 480, dpr: 2 });
    assert.deepEqual(args('viewport.resize'), [{ width: 800, height: 600, dpr: 2 }]);
    assert.deepEqual(args('viewport.setCamera'), [camera]);
    assert.deepEqual(args('viewport.setDisplay'), [display]);
    assert.deepEqual(args('viewport.pick'), [10, 20]);
    assert.deepEqual(args('inspect'), [{ node: r.soft, port: 'out' }]);
    assert.deepEqual((args('build')[0] as { outDir: string }).outDir, '/out');
    assert.equal(difference((args('build')[0] as { doc: GraphDoc }).doc, doc), null);
    assert.equal(difference(args('plan')[0] as GraphDoc, doc), null, 'the plan is of the document it was asked for');
    assert.deepEqual(args('setProject'), [{ path: '/elsewhere/a.orogen' }]);
    assert.equal(args('setDocument')[1], 40);
  } finally {
    r.far.close();
  }
});

test('connect: a new worker is told everything again, the store starts over, and what awaited the old worker rejects', async () => {
  const r = await rig({ preferences: { vramBytes: null, budgetFraction: 0.7 } });
  const second = farEnd();
  try {
    const camera: CameraState = { kind: 'orbit', target: [0, 0, 0], yaw: 30, pitch: 40, distance: 3000, fovY: 45 };
    const display: ViewportDisplay = { verticalScale: 1, showSea: false, sunAzimuth: 100, sunElevation: 30 };
    r.client.setPaused(true);
    r.client.requestThumbnails([r.land]);
    r.client.viewport.setCamera(camera);
    r.client.viewport.setDisplay(display);
    r.page.doc.getState().markSaved('/projects/hills.orogen');
    r.page.doc.getState().transact('Gain', (d) => setParam(d, REGISTRY, r.land, 'gain', 0.75));
    r.far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
    r.far.emit({ type: 'view-updated', requestId: 1, revision: 3, resolution: 257, draft: false, height: true, overlay: false });
    await until(() => r.page.engineState.getState().view !== null, 'the events of the first worker arrived');
    await arrived(r);

    // The old worker never answers these: it is gone.
    const inspecting = r.client.inspect({ node: r.land, port: 'out' });
    const building = r.client.build({ doc: r.page.doc.getState().doc, outDir: '/out' });
    const planning = r.client.plan(r.page.doc.getState().doc);
    const heard: string[] = [];
    r.client.subscribe((event) => heard.push(event.type));

    // An event the old worker sent before it went is still under way when the client moves on.
    let lateArrived = false;
    r.far.port.addEventListener('message', (e) => {
      if (((e.data as { event?: EngineEvent }).event)?.type === 'device-lost') lateArrived = true;
    });
    r.far.emit({ type: 'device-lost', reason: 'unknown', message: 'the last word of the old worker' });

    r.client.connect(second.port);
    await assert.rejects(inspecting, /The engine worker was replaced/);
    await assert.rejects(building, /The engine worker was replaced/);
    await assert.rejects(planning, /The engine worker was replaced/);
    const startedOver = r.page.engineState.getState();
    // The pause is the client's own, and the new session is told of it: it is the one member that stays.
    assert.deepEqual(startedOver, { ...INITIAL_ENGINE_STATE, paused: true }, 'the report of a session that is gone says nothing of the new one');
    different(startedOver.device, INITIAL_ENGINE_STATE.device, 'its device is an object of its own: whoever holds a canvas sees that the engine is another');
    // The client's listener on that port ran before this one: the late event has been through the client.
    await until(() => lateArrived, 'the late event of the old worker arrived');
    assert.deepEqual(heard, [], 'and it reached no subscriber');
    same(r.page.engineState.getState(), startedOver, 'nor the store');

    const next = { client: r.client, far: second };
    await arrived(next);
    assert.deepEqual(second.methods(), ['setPreferences', 'setProject', 'setPaused', 'requestThumbnails', 'viewport.setDisplay', 'viewport.setCamera', 'setDocument']);
    const args = (method: string): readonly unknown[] => second.calls.find((call) => call.method === method)!.args;
    assert.deepEqual(args('setPreferences'), [{ vramBytes: null, budgetFraction: 0.7 }]);
    assert.deepEqual(args('setProject'), [{ path: '/projects/hills.orogen' }]);
    assert.deepEqual(args('setPaused'), [true]);
    assert.deepEqual(args('requestThumbnails'), [[r.land]]);
    assert.deepEqual(args('viewport.setCamera'), [camera]);
    assert.deepEqual(args('viewport.setDisplay'), [display]);
    assert.deepEqual([(args('setDocument')[0] as GraphDoc).nodes[r.land]!.params.gain, args('setDocument')[1]], [0.75, r.page.doc.getState().engineRevision]);
    await until(() => r.far.methods().includes('dispose'), 'the old session was told to end');

    // From here on the client is the new worker's.
    second.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
    await until(() => heard.length > 0, 'an event of the new worker arrived');
    assert.deepEqual(heard, ['device-ready']);
    assert.equal(r.page.engineState.getState().device.state, 'ready');

    const from = second.calls.length;
    r.page.doc.getState().transact('Gain', (d) => setParam(d, REGISTRY, r.land, 'gain', 0.8));
    second.answers.inspect.push(stats);
    assert.deepEqual(await r.client.inspect({ node: r.land, port: 'out' }), stats);
    assert.deepEqual(second.methods(from), ['setDocument', 'inspect']);
    assert.equal(r.far.methods().filter((method) => method === 'setDocument').length, 2, 'the old worker got the two documents of its time and no more');
  } finally {
    r.far.close();
    second.close();
  }
});

test('the pause is in the store: the client writes what it tells the session, and panels read it there', async () => {
  const r = await rig();
  try {
    assert.equal(r.page.engineState.getState().paused, false);
    const told: boolean[] = [];
    const stop = r.page.engineState.subscribe((next, previous) => { if (next.paused !== previous.paused) told.push(next.paused); });
    r.client.setPaused(true);
    r.client.setPaused(true);
    assert.equal(r.page.engineState.getState().paused, true);
    // No event sets it and none clears it: the session says nothing of a pause.
    r.far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
    r.far.emit({ type: 'device-lost', reason: 'unknown', message: 'gone' });
    await until(() => r.page.engineState.getState().device.state === 'lost', 'the events arrived');
    assert.equal(r.page.engineState.getState().paused, true);
    r.client.setPaused(false);
    stop();
    assert.deepEqual(told, [true, false], 'subscribers are told when it changes, and only then');
    await arrived(r);
    assert.deepEqual(r.far.calls.filter((call) => call.method === 'setPaused').map((call) => call.args[0]), [true, true, false]);
  } finally {
    r.far.close();
  }
});

test('connect keeps what the last build wrote and reported: the folder still holds it, whatever became of the worker', async () => {
  const r = await rig();
  const second = farEnd();
  const third = farEnd();
  try {
    const result = { requestId: 4, status: 'ok', problems: [], files: [{ path: 'Land.orogen.json', bytes: 120 }], manifest: 'Land.orogen.json', report: 'Land.report.json', outDir: '/out', peakPoolBytes: 1 } as BuildResult;
    const plan = { ok: true, resolution: 1009, name: 'Land' } as unknown as BuildPlan;
    r.far.emit({ type: 'build-start', requestId: 4, resolution: 1009, outDir: '/out' });
    r.far.emit({ type: 'build-plan', requestId: 4, plan });
    r.far.emit({ type: 'build-result', requestId: 4, result });
    r.far.emit({ type: 'build-end', requestId: 4, status: 'ok' });
    await until(() => r.page.engineState.getState().build.lastStatus === 'ok', 'the build of the first worker ended');
    const built = r.page.engineState.getState().build;

    r.client.connect(second.port);
    const after = r.page.engineState.getState();
    same(after.build, built, 'the finished build is the store\'s as it was');
    assert.deepEqual([after.device.state, after.view, after.evaluation, after.nodes], ['starting', null, null, {}], 'everything else starts over');

    // A build that was running when its worker went never ends by an event: it ended with the worker, without a result.
    second.emit({ type: 'build-start', requestId: 2, resolution: 1009, outDir: '/out' });
    second.emit({ type: 'build-plan', requestId: 2, plan });
    await until(() => r.page.engineState.getState().build.requestId === 2 && r.page.engineState.getState().build.plan !== null, 'the second worker began a build');
    const running = r.page.engineState.getState().build;
    assert.equal(running.running, true);
    r.client.connect(third.port);
    const stopped = r.page.engineState.getState().build;
    assert.deepEqual([stopped.running, stopped.requestId, stopped.lastStatus, stopped.result, stopped.target, stopped.phase], [false, 2, 'aborted', null, null, null]);
    same(stopped.plan, running.plan, 'what it had planned is still what it planned');
    assert.equal(r.page.engineState.getState().evaluation, null, 'nothing is said to be running');
  } finally {
    r.far.close();
    second.close();
    third.close();
  }
});

test('connect during a gesture: the new session is in the gesture before it gets the document', async () => {
  const r = await rig();
  const second = farEnd();
  try {
    r.page.doc.getState().beginGesture(`param:${r.land}:gain`);
    // No device was ever ready: the store is at its first state, and its subscribers hear of the new engine all
    // the same. The viewport holds a canvas the old worker took with it (8.5).
    same(r.page.engineState.getState(), INITIAL_ENGINE_STATE);
    const told: string[] = [];
    const stop = r.page.engineState.subscribe((next, previous) => { if (next.device !== previous.device) told.push(next.device.state); });
    r.client.connect(second.port);
    stop();
    assert.deepEqual(told, ['starting'], 'a device that is starting again is another object, whatever the state was');
    await arrived({ client: r.client, far: second });
    assert.deepEqual(second.methods(), ['setPreferences', 'setProject', 'beginGesture', 'setDocument']);
    r.page.doc.getState().endGesture();
    await arrived({ client: r.client, far: second });
    assert.equal(second.methods().at(-1), 'endGesture');
  } finally {
    r.far.close();
    second.close();
  }
});

test('a worker that fails before the device was ever ready is a fatal engine error; one that fails later is an error to show', async () => {
  // A Worker as the page sees it, reduced to what the client uses of it: it never answers, and it can fail.
  const heardBy = new Map<string, ((e: { data?: unknown; message?: unknown }) => void)[]>();
  const worker = {
    postMessage: () => undefined,
    addEventListener: (type: string, listener: (e: { data?: unknown; message?: unknown }) => void) => { heardBy.set(type, [...(heardBy.get(type) ?? []), listener]); },
    removeEventListener: () => undefined,
  };
  const fire = (type: string, event: { data?: unknown; message?: unknown }): void => { for (const listener of heardBy.get(type) ?? []) listener(event); };

  const page = createPage();
  const client = createEngineClient({ port: worker as SessionPort, doc: page.doc, engineState: page.engineState, thumbnails: page.thumbnails });
  const heard: EngineEvent[] = [];
  client.subscribe((event) => heard.push(event));

  fire('error', { message: 'Uncaught SyntaxError: the worker script did not load' });
  assert.deepEqual(page.engineState.getState().device, { state: 'failed', caps: null, message: 'Uncaught SyntaxError: the worker script did not load' });
  assert.deepEqual(heard, [{ type: 'engine-error', message: 'Uncaught SyntaxError: the worker script did not load', fatal: true }]);

  // Once the engine has started, an error of the worker leaves the device as it is: the session is still there.
  fire('message', { data: { event: { type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 } } });
  assert.equal(page.engineState.getState().device.state, 'ready');
  const ready = page.engineState.getState();
  fire('error', {});
  fire('messageerror', {});
  same(page.engineState.getState(), ready);
  assert.deepEqual(heard.slice(2), [
    { type: 'engine-error', message: 'The engine worker failed', fatal: false },
    { type: 'engine-error', message: 'A message of the engine worker could not be read', fatal: false },
  ]);
});

test('dispose ends the session and the client\'s hold on the document store', async () => {
  const page = createPage();
  const land = page.add('ref/fbm');
  let subscriptions = 0;
  const doc: StoreApi<DocState> = {
    ...page.doc,
    subscribe(listener) {
      subscriptions++;
      const off = page.doc.subscribe(listener);
      return () => {
        subscriptions--;
        off();
      };
    },
  };
  const far = farEnd();
  const other = farEnd();
  const client = createEngineClient({ port: far.port, doc, engineState: page.engineState, thumbnails: page.thumbnails });
  try {
    assert.equal(subscriptions, 1);
    let heard = 0;
    client.subscribe(() => { heard++; });
    const disposing = client.dispose();
    assert.equal(client.dispose(), disposing, 'a second dispose is the first');
    await disposing;
    assert.equal(far.methods().at(-1), 'dispose');
    assert.equal(subscriptions, 0);

    const calls = far.calls.length;
    page.doc.getState().transact('Gain', (d) => setParam(d, REGISTRY, land, 'gain', 0.9));
    client.setPaused(true);
    far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
    await assert.rejects(client.inspect({ node: land, port: 'out' }), /disposed/);
    client.connect(other.port);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([far.calls.length, other.calls.length, heard, page.engineState.getState().device.state], [calls, 0, 0, 'starting'], 'nothing is sent, heard or stored after it');
  } finally {
    far.close();
    other.close();
  }
});

test('another project: what the engine reported of the one before is forgotten, and what its requests still say is not this project\'s', async () => {
  const r = await rig();
  try {
    await arrived(r);
    const engine = (): ReturnType<typeof r.page.engineState.getState> => r.page.engineState.getState();
    const thumb = (nodeId: string, contentKey: string): EngineEvent => ({ type: 'thumbnail', requestId: 5, nodeId, contentKey, resolution: 253, rgba: new Uint8ClampedArray(128 * 128 * 4) } as EngineEvent);
    // The first project is computed and shown, with a node that failed.
    r.far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 2 ** 30 });
    r.far.emit({ type: 'request-start', requestId: 5, revision: 2, purpose: 'view' });
    r.far.emit({ type: 'keys', revision: 2, keys: { [r.land]: 'k-land', [r.soft]: 'k-soft' } });
    r.far.emit({ type: 'node-done', requestId: 5, nodeId: r.land, cached: false, wallMs: 10, gpuMs: null, peakBytes: 64, resolution: 1009 });
    r.far.emit({ type: 'node-error', requestId: 5, error: { nodeId: r.soft, nodeType: 'ref/blur', kind: 'node-exception', message: 'No file selected' } });
    r.far.emit({ type: 'view-updated', requestId: 5, revision: 2, resolution: 1009, draft: false, height: true, overlay: false });
    r.far.emit(thumb(r.land, 'k-land'));
    r.far.emit(thumb(r.soft, 'k-soft'));
    r.far.emit({ type: 'eval-end', requestId: 5, status: 'errors' } as EngineEvent);
    await arrived(r);
    assert.deepEqual([Object.keys(engine().nodes).sort(), engine().view?.revision, Object.keys(engine().keys).length], [[r.land, r.soft].sort(), 2, 2]);
    assert.deepEqual([r.page.thumbnails.size, engine().thumbnailKeys], [2, { [r.land]: 'k-land', [r.soft]: 'k-soft' }]);
    let softDrawn = 0;
    r.page.thumbnails.subscribe(r.soft, () => { softDrawn++; });

    // Another project whose nodes bear the same ids, as two examples do.
    const before = r.page.doc.getState();
    r.page.doc.getState().load(structuredClone(before.doc), null);
    assert.deepEqual([engine().nodes, engine().keys, engine().thumbnailKeys, engine().view], [{}, {}, {}, null], 'nothing of the project before is said of this one');
    assert.equal(engine().device.state, 'ready', 'the device is the application\'s');
    // A request that was made for the project before still reports: none of it is this project's.
    r.far.emit({ type: 'node-done', requestId: 5, nodeId: r.land, cached: true, wallMs: 0, gpuMs: null, peakBytes: 0, resolution: 1009 });
    r.far.emit({ type: 'node-skipped', requestId: 5, nodeId: r.soft, reason: 'aborted' } as EngineEvent);
    r.far.emit({ type: 'keys', revision: 2, keys: { [r.land]: 'k-land' } });
    r.far.emit({ type: 'view-updated', requestId: 5, revision: 2, resolution: 1009, draft: false, height: true, overlay: false });
    await arrived(r);
    assert.deepEqual([engine().nodes, engine().keys, engine().view], [{}, {}, null]);
    // The session hears of the new document a moment after the page has it: an idle evaluation it began for the
    // old one in between has a newer request id, and says the revision it is made for.
    r.far.emit({ type: 'request-start', requestId: 9, revision: 2, purpose: 'thumbnails' });
    r.far.emit({ type: 'node-done', requestId: 9, nodeId: r.land, cached: true, wallMs: 0, gpuMs: null, peakBytes: 0, resolution: 253 });
    r.far.emit({ type: 'eval-end', requestId: 9, status: 'aborted' } as EngineEvent);
    await arrived(r);
    assert.deepEqual([engine().nodes, engine().evaluation], [{}, null], 'its nodes are not this project\'s, and its end is heard');
    // The requests of this project are heard as ever.
    const sent = r.page.doc.getState().engineRevision;
    // The keys of this project: the node that has the content it had keeps its thumbnail, which the engine sends
    // no second time, and is known as current; the node of other content under the same id loses the picture of
    // the project before, and whoever draws it is told.
    r.far.emit({ type: 'keys', revision: sent, keys: { [r.land]: 'k-land', [r.soft]: 'other-content' } });
    await arrived(r);
    assert.deepEqual([r.page.thumbnails.get(r.land)?.contentKey, r.page.thumbnails.get(r.soft), engine().thumbnailKeys, softDrawn], ['k-land', null, { [r.land]: 'k-land' }, 1]);
    r.far.emit({ type: 'request-start', requestId: 10, revision: sent, purpose: 'view' });
    r.far.emit({ type: 'keys', revision: sent, keys: { [r.land]: 'k2' } });
    r.far.emit({ type: 'node-done', requestId: 10, nodeId: r.land, cached: false, wallMs: 12, gpuMs: null, peakBytes: 64, resolution: 1009 });
    r.far.emit({ type: 'view-updated', requestId: 10, revision: sent, resolution: 1009, draft: false, height: true, overlay: false });
    await arrived(r);
    assert.deepEqual([engine().nodes[r.land]?.state, engine().nodes[r.land]?.wallMs, engine().keys, engine().view?.revision], ['done', 12, { [r.land]: 'k2' }, sent]);
    // An edit, an undo and a save are no other project.
    r.page.doc.getState().transact('Octaves', (draft) => setParam(draft, REGISTRY, r.land, 'octaves', 3));
    r.page.doc.getState().undo();
    assert.equal(engine().nodes[r.land]?.state, 'done');
  } finally {
    await r.client.dispose().catch(() => undefined);
    r.far.close();
  }
});

test('an engine that is silent is said: asked after a while without a word, and called silent when that question stands too long', async () => {
  const page = createPage();
  page.add('ref/fbm');
  const far = farEnd();
  const client = createEngineClient({ port: far.port, doc: page.doc, engineState: page.engineState, thumbnails: page.thumbnails, watch: { intervalMs: 20, limitMs: 60 } });
  const silent = (): boolean => page.engineState.getState().silent;
  const next = farEnd();
  try {
    await until(() => far.calls.length >= 3, 'the client introduced itself');
    // An engine that is starting is not asked: it answers when it has its device.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual([far.methods().includes('inspect'), silent()], [false, false]);

    // Ready, and quiet: it is asked something that costs nothing, and its answer is all that was wanted.
    far.emit({ type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 2 ** 30 });
    far.answers.inspect.push(null, null, null, null);
    await until(() => far.methods().includes('inspect'), 'the engine was asked');
    assert.deepEqual(far.calls.find((call) => call.method === 'inspect')!.args, [{ node: '', port: '' }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(silent(), false, 'an engine that answers is not silent');

    // No answer any more, as from a worker whose thread ended: said after the limit, not before.
    far.answers.inspect.length = 0;
    await until(() => silent(), 'the engine is called silent');
    assert.equal(page.engineState.getState().device.state, 'ready', 'the device is what it last said: only `silent` says that it says nothing');
    // Anything heard of it ends that.
    far.emit({ type: 'memory', budgetBytes: 1, workingBytes: 0, cacheBytes: 0, pinnedBytes: 0, freeBytes: 0, reservedBytes: 0 } as EngineEvent);
    await until(() => !silent(), 'an event was heard');

    // Another worker in its place is not silent, and is watched in its turn.
    far.answers.inspect.length = 0;
    await until(() => silent(), 'silent again');
    client.connect(next.port);
    assert.equal(silent(), false);
    assert.deepEqual(ENGINE_WATCH, { intervalMs: 5000, limitMs: 15_000 });
    assert.equal(new EngineReplacedError().message, 'The engine worker was replaced');
  } finally {
    // Disposed while its far end still answers: a closed port would leave the answer out for ever.
    await client.dispose().catch(() => undefined);
    far.close();
    next.close();
  }
});
