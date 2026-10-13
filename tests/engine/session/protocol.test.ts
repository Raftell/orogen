// The thread boundary (runtime.md 7.2): a client on one port of a real MessageChannel and the server on the
// other. First against a session that only records, so that every request and every event crosses with known
// content; then against the real session on the real engine, where the stream the client receives is the stream
// the session emitted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import type {
  BuildPlan, BuildRequest, BuildResult, ClientMessage, EngineEvent, EnginePreferences, EngineSession, GraphDoc, PortRef, WorkerMessage,
} from '../../../src/core/runtime.ts';
import { createSessionClient, serveSession } from '../../../src/core/session/protocol.ts';
import { testGpu } from '../gpu/rig.ts';
import { BACKSTOP_MS, doc, PREVIEW, resetSlow, startSession, THUMBNAIL } from './rig.ts';

const gpu = await testGpu();

/**
 * Lets the messages that are under way arrive: a message is delivered in a later turn of the event loop. Some
 * are the answer to GPU work, which takes as many turns as the adapter is slow: the wait has a backstop, not a count.
 */
async function delivered(until: () => boolean, what: string): Promise<void> {
  const backstop = performance.now() + BACKSTOP_MS;
  while (!until()) {
    if (performance.now() > backstop) assert.fail(`the messages did not arrive: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): string | null {
  if (a.length !== b.length) return `lengths ${a.length} and ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i} is ${a[i]}, expected ${b[i]}`;
  return null;
}

const GRAPH = (value = 0.25, view: object = { height: { node: 'out', port: 'out' } }) => doc({
  level: { type: 'ref/constant', params: { value } },
  walk: { type: 'ref/slow', params: { iterations: 12, lend: true }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
  paint: { type: 'ref/tint', params: { tint: [0.25, 0.5, 0.75] } },
  broken: { type: 'ref/gain', params: { gain: 2 } },
  below: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'broken.out' } },
}, view);

// ---- a session that records -----------------------------------------------------------------------------------------

interface Recorded { readonly method: string; readonly args: readonly unknown[] }

function recordingSession() {
  const calls: Recorded[] = [];
  const listeners = new Set<(e: EngineEvent) => void>();
  /** What the methods that return a promise answer with next; a function is called, an Error is thrown. */
  const answers: Record<string, unknown[]> = { inspect: [], build: [], pick: [], dispose: [] };
  const answer = (method: string): Promise<unknown> => {
    const next = answers[method]!.shift();
    if (next instanceof Error) return Promise.reject(next);
    return typeof next === 'function' ? (next as () => Promise<unknown>)() : Promise.resolve(next ?? null);
  };
  const tell = (method: string) => (...args: unknown[]): void => {
    calls.push({ method, args });
    if (method === 'setDocument' && args[1] === -1) throw new RangeError('revision -1 is not greater than 7');
  };
  const session: EngineSession = {
    setProject: tell('setProject'), setDocument: tell('setDocument'), beginGesture: tell('beginGesture'), endGesture: tell('endGesture'),
    setPaused: tell('setPaused'), requestThumbnails: tell('requestThumbnails'), cancelBuild: tell('cancelBuild'),
    setPreferences: tell('setPreferences'), retryDevice: tell('retryDevice'),
    inspect: (ref) => { calls.push({ method: 'inspect', args: [ref] }); return answer('inspect') as ReturnType<EngineSession['inspect']>; },
    build: (request) => { calls.push({ method: 'build', args: [request] }); return answer('build') as Promise<BuildResult>; },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    viewport: {
      attach: tell('viewport.attach'), detach: tell('viewport.detach'), resize: tell('viewport.resize'),
      setCamera: tell('viewport.setCamera'), setDisplay: tell('viewport.setDisplay'),
      pick: (x, y) => { calls.push({ method: 'viewport.pick', args: [x, y] }); return answer('pick') as ReturnType<EngineSession['viewport']['pick']>; },
    },
    dispose: () => { calls.push({ method: 'dispose', args: [] }); return answer('dispose') as Promise<void>; },
  };
  return { session, calls, answers, emit: (e: EngineEvent) => { for (const listener of [...listeners]) listener(e); }, subscribers: () => listeners.size };
}

function channel(session: EngineSession) {
  const { port1, port2 } = new MessageChannel();
  const stop = serveSession(session, port2);
  const raw: WorkerMessage[] = [];
  port1.addEventListener('message', (e) => raw.push((e as unknown as { data: WorkerMessage }).data));
  const client = createSessionClient(port1);
  return { client, port1, port2, stop, raw, close: () => { port1.close(); port2.close(); } };
}

test('every request crosses the channel: in order, with its arguments, and with its one reply where it has a result', async () => {
  const far = recordingSession();
  const { client, port1, raw, close } = channel(far.session);
  try {
    const graph = GRAPH();
    const prefs: EnginePreferences = { vramBytes: null, budgetFraction: 0.5 };
    const size = { width: 640, height: 480, dpr: 1.5 };
    const camera = { kind: 'orbit', target: [0, 0, 100], yaw: 30, pitch: 45, distance: 3000, fovY: 40 } as const;
    const display = { verticalScale: 2, showSea: false, sunAzimuth: 135, sunElevation: 30 };
    // A canvas cannot be had in Node; a buffer is the transferable that stands in for it.
    const canvas = new ArrayBuffer(64);

    client.setPreferences(prefs);
    client.setProject({ path: '/projects/alps.orogen' });
    client.setProject({ path: null });
    client.requestThumbnails(['level', 'out']);
    client.setDocument(graph, 7);
    client.beginGesture();
    client.endGesture();
    client.setPaused(true);
    client.cancelBuild();
    client.retryDevice();
    client.viewport.attach(canvas as unknown as OffscreenCanvas, size);
    client.viewport.resize(size);
    client.viewport.setCamera(camera);
    client.viewport.setDisplay(display);
    client.viewport.detach();

    const stats = { min: -1, max: 2.5, mean: 0.25, nonFinite: 3 };
    const built: BuildResult = { requestId: 9, status: 'ok', problems: [], files: [{ path: 'Alps.r16', bytes: 132_161_282 }], manifest: 'Alps.json', report: 'Alps.report.json', outDir: '/out/alps' };
    const picked = { uv: [0.25, 0.75], height: 0.5, position: [1024, 3072, 512] } as const;
    const request: BuildRequest = { doc: graph, outDir: '/out/alps' };
    far.answers.inspect!.push(stats, null);
    far.answers.build!.push(built);
    far.answers.pick!.push(picked, null);
    const answers = await Promise.all([
      client.inspect({ node: 'out', port: 'out' }), client.inspect({ node: 'gone', port: 'out' }),
      client.build(request), client.viewport.pick(320, 240), client.viewport.pick(-5, 0),
    ]);
    assert.deepEqual(answers, [stats, null, built, picked, null]);

    const received = (far.calls[10]!.args as [ArrayBuffer, unknown])[0];
    assert.deepEqual(far.calls.map((c) => c.method), [
      'setPreferences', 'setProject', 'setProject', 'requestThumbnails', 'setDocument', 'beginGesture', 'endGesture', 'setPaused',
      'cancelBuild', 'retryDevice', 'viewport.attach', 'viewport.resize', 'viewport.setCamera', 'viewport.setDisplay', 'viewport.detach',
      'inspect', 'inspect', 'build', 'viewport.pick', 'viewport.pick',
    ], 'messages are handled in the order sent');
    assert.deepEqual(far.calls.map((c) => c.args).filter((_, i) => i !== 10), [
      [prefs], [{ path: '/projects/alps.orogen' }], [{ path: null }], [['level', 'out']], [graph, 7], [], [], [true], [], [],
      [size], [camera], [display], [],
      [{ node: 'out', port: 'out' }], [{ node: 'gone', port: 'out' }], [request], [320, 240], [-5, 0],
    ]);
    // The document is a structured clone, not the object; the canvas was moved, not copied.
    assert.notEqual((far.calls[4]!.args as [GraphDoc])[0], graph);
    assert.ok(received instanceof ArrayBuffer && received.byteLength === 64, 'the canvas arrived');
    assert.equal(canvas.byteLength, 0, 'and was transferred: it is in the transfer list');
    assert.deepEqual(far.calls[10]!.args[1], size);

    // One reply per method with a result, none for the others; ids increase with the calls.
    const replies = raw.filter((m): m is Extract<WorkerMessage, { id: number }> => 'id' in m);
    assert.deepEqual(replies.map((m) => [m.id, m.ok]), [[16, true], [17, true], [18, true], [19, true], [20, true]]);

    // Replies find their call by id, whatever order they come in.
    let late!: (value: unknown) => void;
    far.answers.inspect!.push(() => new Promise((resolve) => { late = resolve; }), { ...stats, mean: 7 });
    const slow = client.inspect({ node: 'a', port: 'out' });
    const fast = client.inspect({ node: 'b', port: 'out' });
    assert.equal((await fast)?.mean, 7);
    late({ ...stats, mean: 3 });
    assert.equal((await slow)?.mean, 3);

    // A rejection crosses as name and message.
    far.answers.build!.push(new Error('A build is already running'));
    await assert.rejects(client.build(request), (e: Error) => e instanceof Error && e.name === 'Error' && e.message === 'A build is already running');
    far.answers.inspect!.push(new TypeError('not a port'));
    await assert.rejects(client.inspect({} as PortRef), (e: Error) => e.name === 'TypeError' && e.message === 'not a port');

    // A method without a result is answered only when it threw; a name that is no method is refused; other messages are ignored.
    const before = raw.length;
    const errors: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      client.setDocument(graph, -1);
      const stray = (message: unknown): void => port1.postMessage(message);
      stray({ id: 900, method: 'constructor', args: [] } satisfies ClientMessage);
      stray({ id: 901, method: 'subscribe', args: [] } satisfies ClientMessage);
      stray({ id: 902, method: 'viewport', args: [] } satisfies ClientMessage);
      stray({ id: 'x', method: 'setPaused', args: [true] });
      stray({ id: 903, method: 'setPaused' });
      stray('setPaused');
      stray(null);
      client.setPaused(false);
      await delivered(() => far.calls.at(-1)?.method === 'setPaused' && raw.length >= before + 4, 'the stray messages');
    } finally {
      console.error = error;
    }
    const refused = raw.slice(before).filter((m): m is Extract<WorkerMessage, { ok: false }> => 'id' in m && !m.ok);
    assert.deepEqual(refused.map((m) => [m.id, m.error.name, m.error.message]), [
      [replies.length + 20, 'RangeError', 'revision -1 is not greater than 7'],
      [900, 'TypeError', 'The engine session has no method "constructor"'],
      [901, 'TypeError', 'The engine session has no method "subscribe"'],
      [902, 'TypeError', 'The engine session has no method "viewport"'],
    ]);
    assert.deepEqual(far.calls.slice(-2).map((c) => [c.method, c.args]), [['setDocument', [graph, -1]], ['setPaused', [false]]], 'nothing else reached the session');
    assert.equal(errors.length, 4, 'the client logs a failed call that nobody awaits');

    // dispose: its reply, then both ends are closed for business.
    await client.dispose();
    assert.equal(far.calls.at(-1)!.method, 'dispose');
    assert.equal(far.subscribers(), 0, 'the server unsubscribed');
    const count = far.calls.length;
    client.setPaused(true);
    port1.postMessage({ id: 990, method: 'setPaused', args: [true] } satisfies ClientMessage);
    await assert.rejects(client.inspect({ node: 'out', port: 'out' }), /disposed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(far.calls.length, count, 'nothing is served after dispose');
    assert.equal(client.dispose(), client.dispose(), 'a second dispose is the first');
  } finally {
    close();
  }
});

test('every event crosses the channel as it was emitted, in order; thumbnail pixels are moved', async () => {
  const far = recordingSession();
  const { client, close } = channel(far.session);
  try {
    const got: EngineEvent[] = [];
    const off = client.subscribe((e) => got.push(e));
    client.subscribe(() => { throw new Error('a listener that throws does not stop the others'); });
    const also: string[] = [];
    client.subscribe((e) => also.push(e.type));

    const plan: BuildPlan = {
      ok: true, resolution: 513, name: 'Alps', layout: null, layers: [], problems: [],
      items: [{ nodeId: 'export', item: { kind: 'image', source: { node: 'export', input: 'in' }, name: 'Alps', format: 'r32', map: 'unit' } }],
      targets: [{ node: 'export', input: 'in' }],
      files: [{ path: 'Alps.r32', encoding: 'raw-f32', width: 513, height: 513, bytes: 1_052_676, nodeId: 'export' }],
      estimate: { planeBytes: 0, knownFileBytes: 1_052_676 },
    };
    const result: BuildResult = { requestId: 4, status: 'errors', problems: [{ severity: 'error', code: 'E_NODE_FAILED', message: 'Erosion failed.', nodeId: 'n1' }], files: [], manifest: null, report: 'Alps.report.json', outDir: null };
    const rgba = new Uint8ClampedArray(128 * 128 * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) % 256;
    const pixels = rgba.slice();
    const memory = { budgetBytes: 2 ** 31, workingBytes: 1, cacheBytes: 2, pinnedBytes: 3, freeBytes: 4, reservedBytes: 5, drainingBytes: 6 };
    // One of every type of runtime.md 7.7, 5.10 and export-unreal.md 3.9.
    const events: EngineEvent[] = [
      { type: 'device-ready', epoch: 1, caps: gpu.caps, budgetBytes: 2 ** 31 },
      { type: 'keys', revision: 3, keys: { n1: '["k",1]', n2: '["k",2]' } },
      { type: 'request-start', requestId: 4, revision: 3, purpose: 'view' },
      { type: 'eval-start', requestId: 4, resolution: 1009, mode: 'preview', plan: [{ nodeId: 'n1', state: 'run' }, { nodeId: 'n2', state: 'cached' }], outputPeakBytes: null },
      { type: 'node-start', requestId: 4, nodeId: 'n1' },
      { type: 'node-progress', requestId: 4, nodeId: 'n1', fraction: 0.5, label: 'Eroding', etaMs: 1200 },
      { type: 'node-progress', requestId: 4, nodeId: 'n1', fraction: 0.75, etaMs: null },
      { type: 'node-preview', requestId: 4, nodeId: 'n1', ports: ['out'] },
      { type: 'eval-progress', requestId: 4, fraction: 0.25, etaMs: null },
      { type: 'node-done', requestId: 4, nodeId: 'n1', cached: false, wallMs: 12.5, gpuMs: null, peakBytes: 4096 },
      {
        type: 'node-error', requestId: 4,
        error: {
          nodeId: 'n2', nodeType: 'filter/blur', kind: 'shader-compile', message: 'kernel "blur": unknown identifier', detail: 'full text', kernel: 'blur',
          wgsl: { origin: 'code', line: 3, column: 7, length: 4, message: 'unknown identifier', excerpt: ['a', 'b', 'c'] },
        },
      },
      { type: 'node-skipped', requestId: 4, nodeId: 'n3', reason: 'upstream', upstream: 'n2' },
      { type: 'node-skipped', requestId: 4, nodeId: 'n4', reason: 'aborted' },
      { type: 'eval-end', requestId: 4, status: 'errors', wallMs: 20 },
      { type: 'view-updated', requestId: 4, revision: 3, resolution: 1009, draft: false, height: true, overlay: false },
      { type: 'thumbnail', nodeId: 'n1', contentKey: '["k",1]', resolution: 1009, rgba },
      { type: 'memory', ...memory },
      { type: 'build-start', requestId: 5, resolution: 4033, outDir: '/out/alps' },
      { type: 'build-plan', requestId: 5, plan },
      { type: 'build-target', requestId: 5, index: 0, count: 1, nodeId: 'export', label: 'Alps.r32' },
      { type: 'build-progress', requestId: 5, phase: 'targets', fraction: 0.5 },
      { type: 'build-problem', requestId: 5, problem: { severity: 'warning', code: 'W_FLAT', message: 'The landscape is flat.' } },
      { type: 'build-result', requestId: 5, result },
      { type: 'build-end', requestId: 5, status: 'errors' },
      { type: 'device-lost', reason: 'unknown', message: 'DXGI_ERROR_DEVICE_RESET', nodeId: 'n1' },
      { type: 'device-lost', reason: 'destroyed', message: '' },
      { type: 'engine-error', message: 'A slice took 812 ms', fatal: false },
      { type: 'engine-error', message: 'No GPU device could be opened', fatal: true },
    ];
    const log = console.error;
    console.error = () => undefined;
    try {
      for (const event of events) far.emit(event);
      await delivered(() => got.length === events.length, 'the events');
      off();
      far.emit({ type: 'engine-error', message: 'later', fatal: false });
      await delivered(() => also.length === events.length + 1, 'one more event');
    } finally {
      console.error = log;
    }
    assert.equal(got.length, events.length, 'an unsubscribed listener gets nothing more');

    assert.deepEqual(got.map((e) => e.type), events.map((e) => e.type));
    assert.deepEqual(also, [...events.map((e) => e.type), 'engine-error']);
    for (let i = 0; i < events.length; i++) {
      const sent = events[i]!, received = got[i]!;
      if (sent.type === 'thumbnail' && received.type === 'thumbnail') {
        assert.deepEqual({ ...received, rgba: null }, { ...sent, rgba: null });
        assert.ok(received.rgba instanceof Uint8ClampedArray);
        assert.equal(sameBytes(received.rgba, pixels), null, 'the pixels arrive as they were');
        assert.equal(sent.rgba.byteLength, 0, 'and were moved, not copied: the sender\'s array is detached');
      } else {
        assert.deepEqual(received, sent, `event ${i} (${sent.type})`);
        assert.notEqual(received, sent);
      }
    }
  } finally {
    close();
  }
});

test('the real session behind the channel: the client drives it and receives the stream the session emitted', async () => {
  resetSlow();
  // The canvas the renderer is handed, and what a build delivers, are observed on the engine's side.
  const { port1, port2 } = new MessageChannel();
  // The server subscribes in the task that creates the session, as the engine worker's does.
  const t = await startSession({ first: (session) => void serveSession(session, port2) });
  const client = createSessionClient(port1);
  const got: EngineEvent[] = [];
  client.subscribe((e) => got.push(e));
  const next = async <T extends EngineEvent['type']>(type: T, match: (e: Extract<EngineEvent, { type: T }>) => boolean = () => true) => {
    let found: Extract<EngineEvent, { type: T }> | undefined;
    await delivered(() => (found = got.find((e): e is Extract<EngineEvent, { type: T }> => e.type === type && match(e as Extract<EngineEvent, { type: T }>))) !== undefined, type);
    return found!;
  };
  try {
    assert.equal((await next('device-ready')).epoch, 1);

    client.setPreferences({ vramBytes: 512 * 2 ** 20, budgetFraction: 0.5 });
    client.setProject({ path: null });
    client.requestThumbnails(['level', 'walk', 'out', 'paint']);
    client.viewport.attach(new ArrayBuffer(8) as unknown as OffscreenCanvas, { width: 320, height: 200, dpr: 1 });
    client.viewport.setCamera({ kind: 'top', center: [0.5, 0.5], span: 1 });
    client.setDocument(GRAPH(), 1);
    const shown = await next('view-updated');
    assert.deepEqual([shown.revision, shown.resolution, shown.height], [1, PREVIEW, true]);
    assert.deepEqual(await client.inspect({ node: 'out', port: 'out' }), { min: 24.5, max: 24.5, mean: 24.5, nonFinite: 0 });
    assert.equal(await client.inspect({ node: 'paint', port: 'out' }), null);
    assert.deepEqual(await client.viewport.pick(50, 25), { uv: [0.5, 0.25], height: 0.5, position: [50, 25, 512] });
    assert.equal((await next('memory')).budgetBytes, 256 * 2 ** 20, 'the preferences reached the engine');
    const attach = t.renderer.calls.find((c) => c.call === 'attach') as { canvas: unknown; size: unknown };
    assert.ok(attach.canvas instanceof ArrayBuffer);
    assert.deepEqual(attach.size, { width: 320, height: 200, dpr: 1 });

    // Thumbnails: the view chain as a by-product, `paint` from the idle evaluation; the pixels arrive on this side.
    const painted = await next('thumbnail', (e) => e.nodeId === 'paint');
    assert.deepEqual([painted.resolution, painted.rgba.length, painted.rgba[3]], [THUMBNAIL, 128 * 128 * 4, 255]);
    await next('thumbnail', (e) => e.nodeId === 'out');

    // A gesture, then a node that fails and one that is skipped for it.
    client.beginGesture();
    client.setDocument(GRAPH(0.5), 2);
    assert.equal((await next('view-updated', (e) => e.revision === 2)).draft, true);
    client.endGesture();
    assert.equal((await next('view-updated', (e) => e.revision === 2 && !e.draft)).resolution, PREVIEW);
    client.setDocument(GRAPH(0.5, { height: { node: 'below', port: 'out' } }), 3);
    assert.equal((await next('node-error')).error.kind, 'missing-input');
    assert.deepEqual([(await next('node-skipped')).nodeId, (await next('node-skipped')).reason], ['below', 'upstream']);

    // A build, and a second one that is refused while it runs; then one that is cancelled.
    const first = client.build({ doc: GRAPH(0.75), outDir: '/out/terrain' });
    await assert.rejects(client.build({ doc: GRAPH(0.75), outDir: '/out/other' }), /A build is already running/);
    const built = await first;
    assert.deepEqual([built.status, built.outDir], ['ok', '/out/terrain']);
    assert.deepEqual(t.builds.calls.map((c) => c.means), [[2 * (0.75 + 12)]]);
    const second = client.build({ doc: GRAPH(0.875), outDir: '/out/terrain' });
    client.cancelBuild();
    assert.equal((await second).status, 'aborted');
    client.setPaused(true);
    client.retryDevice();

    // The stream on this side is the stream the session emitted: the same events in the same order.
    await t.idle();
    await delivered(() => got.length === t.events.length, `${t.events.length} events were emitted, ${got.length} arrived`);
    assert.equal(got[0]!.type, 'device-ready');
    for (let i = 0; i < t.events.length; i++) {
      const sent = t.events[i]!, received = got[i]!;
      if (sent.type === 'thumbnail' && received.type === 'thumbnail') {
        assert.deepEqual([received.nodeId, received.contentKey, received.resolution], [sent.nodeId, sent.contentKey, sent.resolution]);
        assert.equal(sent.rgba.byteLength, 0, 'the server moved the pixels');
      } else {
        assert.deepEqual(received, sent, `event ${i} (${sent.type})`);
      }
    }
    const types = new Set(got.map((e) => e.type));
    for (const type of [
      'device-ready', 'keys', 'request-start', 'eval-start', 'node-start', 'node-progress', 'node-preview', 'node-done', 'node-error', 'node-skipped',
      'eval-end', 'view-updated', 'thumbnail', 'memory', 'build-start', 'build-progress', 'build-result', 'build-end',
    ]) assert.ok(types.has(type as EngineEvent['type']), `a "${type}" event crossed`);
    assert.deepEqual(t.of('request-start').map((e) => e.purpose).filter((p) => p === 'build').length, 2);

    // dispose through the channel disposes the session and its engine.
    await client.dispose();
    assert.deepEqual(t.renderer.calls.at(-1), { call: 'dispose' });
    const left = t.atDispose!;
    assert.deepEqual([left.workingBytes, left.pinnedBytes, left.cacheBytes, left.freeBytes], [0, 0, 0, 0]);
  } finally {
    port1.close();
    port2.close();
    await t.dispose();
  }
});
