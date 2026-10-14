// EngineClient (runtime.md 7.2, 8.5): the interface thread's end of the session. It is `createSessionClient`
// over the engine worker, with what the application adds: every event goes into engineStore and the thumbnail
// cache, and docStore drives the session's project, document and gestures.

import type { StoreApi } from 'zustand/vanilla';

import {
  createSessionClient, DEFAULT_PREFERENCES,
  type BuildPlan, type BuildRequest, type BuildResult, type CameraState, type EngineEvent, type EnginePreferences, type EngineSession, type GraphDoc,
  type PickResult, type PortRef, type SessionPort, type ViewportDisplay, type ViewportHost, type ViewportSize,
} from '../../core/runtime.ts';
import type { DocState } from '../state/doc-store.ts';
import { adoptThumbnails, applyEngineEvent, forgetProject, INITIAL_ENGINE_STATE, setEnginePaused, setEngineSilent, type EngineState } from '../state/engine-store.ts';
import { thumbnails as applicationThumbnails, type ThumbnailCache } from './thumbnails.ts';

export interface EngineClientOptions {
  /** The engine worker, or one end of a MessageChannel whose other end serves a session (7.2). */
  readonly port: SessionPort;
  readonly doc: StoreApi<DocState>;
  readonly engineState: StoreApi<EngineState>;
  /** Sent before the project and the first document (8.3); default DEFAULT_PREFERENCES. */
  readonly preferences?: EnginePreferences;
  /** Where thumbnail pixels go; default the application's cache. */
  readonly thumbnails?: ThumbnailCache;
  /**
   * Watches whether the engine still answers (8.5, "An engine that is silent"): when nothing was heard of it
   * for `intervalMs` it is asked, and when that question has stood for `limitMs`, `EngineState.silent` is set
   * until something is heard again. Default: not watched, as a window-free test wants it.
   */
  readonly watch?: { readonly intervalMs: number; readonly limitMs: number } | null;
}

/** What the application watches its engine with: asked after 5 s of silence, called silent after 15 s without an answer. */
export const ENGINE_WATCH = { intervalMs: 5000, limitMs: 15_000 } as const;

/** The events that say something of the nodes or the picture of a document: those of a request made for the project before are not this project's. */
const OF_A_DOCUMENT: ReadonlySet<EngineEvent['type']> = new Set<EngineEvent['type']>([
  'eval-start', 'node-start', 'node-progress', 'node-preview', 'node-done', 'node-error', 'node-skipped', 'view-updated', 'thumbnail', 'keys',
]);

export interface EngineClient extends EngineSession {
  readonly thumbnails: ThumbnailCache;
  /**
   * Moves the client to the session behind another port: a new engine worker in place of one that is gone. The
   * client holds everything a session is told that is not in docStore (the preferences, the pause, the thumbnail
   * list, the camera and the display), so the new session is told all of it again, in the order of 8.3, and
   * engineStore starts over, with a `device` object of its own whose state is 'starting'. Two members stay: the
   * pause, which is the client's own, and what the last build wrote and reported, which is on disk whatever
   * became of the worker; a build that was running ended with its worker. Calls that awaited the old session
   * reject. The canvas went with the old worker: the viewport attaches a new one when it sees that `device`
   * (7.5 rule 8).
   */
  connect(port: SessionPort): void;
}

/** One session client and what ends with it. */
interface Connection {
  readonly session: EngineSession;
  /** Rejects when the client leaves this connection: a call that awaits the old worker would await for ever. */
  readonly left: Promise<never>;
  leave(reason: Error): void;
}

const WORKER_REPLACED = 'The engine worker was replaced';

/**
 * What a call that awaited the session rejects with when the client moved to another session meanwhile
 * (`connect`): the answer will never come. It is no failure of what was asked for: a build that was running
 * ended with its worker, and whoever started it takes this for its end.
 */
export class EngineReplacedError extends Error {
  override name = 'EngineReplacedError';
  constructor() {
    super(WORKER_REPLACED);
  }
}

/** What a Worker tells the page beside its messages. A MessagePort has `messageerror` alone; the listeners cost it nothing. */
interface FailureSource {
  addEventListener?(type: 'error' | 'messageerror', listener: (e: { readonly message?: unknown }) => void): void;
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const { doc: docStore, engineState } = options;
  const thumbnails = options.thumbnails ?? applicationThumbnails;
  const listeners = new Set<(e: EngineEvent) => void>();

  // What a session is told that docStore does not hold.
  let preferences: EnginePreferences = options.preferences ?? DEFAULT_PREFERENCES;
  let paused = false;
  let wanted: readonly string[] = [];
  let camera: CameraState | null = null;
  let display: ViewportDisplay | null = null;

  let connection!: Connection;
  let disposal: Promise<void> | null = null;

  // ---- another project (docStore.load) ----
  /** The newest request heard of, and the newest that was made for the project before this one. */
  let lastRequest = 0;
  let floor = 0;
  /** The revision the project before this one was last sent under: a `keys` or a picture of it is not this project's. */
  let revisionFloor = -1;
  /**
   * The requests the session still began for the project before, after this one was loaded: the session hears of
   * the new document a moment after the page has it, and an idle evaluation for thumbnails may begin in between.
   * A request says the revision it is made for (`request-start`).
   */
  const before = new Set<number>();
  /** The keys of the project that was loaded have not arrived yet: when they do, the thumbnails held are sorted by them. */
  let sorting = false;

  // ---- an engine that is silent ----
  const watch = options.watch ?? null;
  let lastHeard = performance.now();
  /** Since when a question to the engine has stood without an answer; null: none stands. */
  let askedAt: number | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  function heard(): void {
    lastHeard = performance.now();
    askedAt = null;
    setEngineSilent(engineState, false);
  }
  function look(): void {
    if (disposal || !watch) return;
    watchTimer = setTimeout(look, watch.intervalMs);
    // An engine that is starting answers when it has its device (8.3), and one that failed has said so.
    const { device, silent } = engineState.getState();
    if (device.state === 'starting' || device.state === 'failed') {
      askedAt = null;
      return;
    }
    const now = performance.now();
    if (askedAt === null) {
      if (now - lastHeard < watch.intervalMs) return;
      askedAt = now;
      const asked = connection;
      // Any answer is one, a refusal too. A port that names nothing costs the engine nothing to answer.
      const answered = (): void => { if (asked === connection) heard(); };
      asked.session.inspect({ node: '', port: '' }).then(answered, answered);
    } else if (!silent && now - askedAt >= watch.limitMs) {
      setEngineSilent(engineState, true);
    }
  }

  /** What a new session leaves of the build the old one made: its plan, problems and result, and nothing that runs. */
  function buildAfterRestart(build: EngineState['build']): EngineState['build'] {
    if (!build.running) return build;
    // No `build-end` will come: the build ended with its worker, without a result.
    return { ...INITIAL_ENGINE_STATE.build, requestId: build.requestId, plan: build.plan, problems: build.problems, lastStatus: 'aborted' };
  }

  function onEvent(from: Connection, event: EngineEvent): void {
    // The old worker may still be answering while the new one starts; a disposed client has no one to tell.
    if (from !== connection || disposal) return;
    heard();
    const request = 'requestId' in event && typeof event.requestId === 'number' ? event.requestId : null;
    if (request !== null && request > lastRequest) lastRequest = request;
    if (event.type === 'request-start' && event.revision <= revisionFloor) {
      // A few at the most: the session takes the new document with its next message.
      if (before.size >= 64) before.clear();
      before.add(event.requestId);
    }
    // What a request for the project before still says of nodes and pictures is not said of this project,
    // whose nodes may bear the same ids. The end of that request is the application's to hear all the same.
    const stale = OF_A_DOCUMENT.has(event.type) && (
      (request !== null && (request <= floor || before.has(request)))
      || ('revision' in event && typeof event.revision === 'number' && event.revision <= revisionFloor));
    // The pixels first: whoever hears of the new key through the store finds the image.
    if (event.type === 'thumbnail' && !stale) thumbnails.put(event);
    if (!stale) applyEngineEvent(engineState, event);
    if (event.type === 'keys' && !stale && sorting) {
      // The first keys of the project that was opened. A thumbnail held for one of its node ids is this node's
      // when it was made of the same content, and then the engine sends no other (5.12): it stays, and the
      // store is told that it is current. One of other content is the picture of another project's node.
      sorting = false;
      const current: Record<string, string> = {};
      for (const [id, key] of Object.entries(event.keys)) {
        const held = thumbnails.get(id);
        if (held === null) continue;
        if (held.contentKey === key) current[id] = key;
        else thumbnails.drop(id);
      }
      adoptThumbnails(engineState, current);
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (thrown) {
        console.error('[orogen] an engine event listener threw', thrown);
      }
    }
  }

  function open(port: SessionPort): Connection {
    const session = createSessionClient(port);
    let leave!: (reason: Error) => void;
    const left = new Promise<never>((_, reject) => { leave = reject; });
    // Nobody may be waiting when it rejects.
    left.catch(() => undefined);
    const made: Connection = { session, left, leave };
    session.subscribe((event) => onEvent(made, event));

    // A worker whose script does not load, or throws, sends no event: the page would wait at 'starting' for ever.
    // Until the device has been ready once the engine has not started, and that is fatal; afterwards the session
    // is still there, and the error is one for whoever shows errors.
    const failures = port as unknown as FailureSource;
    const failed = (what: string) => (e: { readonly message?: unknown }): void => {
      const message = typeof e?.message === 'string' && e.message !== '' ? e.message : what;
      onEvent(made, { type: 'engine-error', message, fatal: engineState.getState().device.state === 'starting' });
    };
    failures.addEventListener?.('error', failed('The engine worker failed'));
    failures.addEventListener?.('messageerror', failed('A message of the engine worker could not be read'));
    return made;
  }

  /** 8.3: the preferences and the project come before the first document. */
  function introduce(session: EngineSession): void {
    const state = docStore.getState();
    session.setPreferences(preferences);
    session.setProject({ path: state.path });
    if (paused) session.setPaused(true);
    if (wanted.length > 0) session.requestThumbnails(wanted);
    if (display) session.viewport.setDisplay(display);
    if (camera) session.viewport.setCamera(camera);
    if (state.gesture !== null) session.beginGesture();
    session.setDocument(state.doc, state.engineRevision);
  }

  connection = open(options.port);
  introduce(connection.session);
  if (watch) watchTimer = setTimeout(look, watch.intervalMs);

  const unsubscribe = docStore.subscribe((state, previous) => {
    const { session } = connection;
    // `load` makes every member anew and empties the history, and nothing else does both (8.5).
    const loaded = state.doc !== previous.doc && state.doc.nodes !== previous.doc.nodes && state.doc.edges !== previous.doc.edges
      && state.doc.settings !== previous.doc.settings && state.doc.ui !== previous.doc.ui && state.past.length === 0 && state.future.length === 0 && !state.unsaved;
    if (loaded) {
      floor = lastRequest;
      revisionFloor = previous.engineRevision;
      sorting = true;
      forgetProject(engineState);
    }
    if (state.path !== previous.path) session.setProject({ path: state.path });
    // A gesture that ends with a change (an undo in mid-drag) ends first: the change is then evaluated in full.
    if (previous.gesture !== null && state.gesture === null) session.endGesture();
    if (previous.gesture === null && state.gesture !== null) session.beginGesture();
    if (state.engineRevision !== previous.engineRevision) session.setDocument(state.doc, state.engineRevision);
  });

  /** A call that returns a promise, on the connection of the moment it is made. */
  const awaited = <T>(call: (session: EngineSession) => Promise<T>): Promise<T> => {
    const { session, left } = connection;
    return Promise.race([call(session), left]);
  };

  const viewport: ViewportHost = {
    attach: (canvas: OffscreenCanvas, size: ViewportSize) => connection.session.viewport.attach(canvas, size),
    detach: () => connection.session.viewport.detach(),
    resize: (size: ViewportSize) => connection.session.viewport.resize(size),
    setCamera(next: CameraState) {
      camera = next;
      connection.session.viewport.setCamera(next);
    },
    setDisplay(next: ViewportDisplay) {
      display = next;
      connection.session.viewport.setDisplay(next);
    },
    pick: (x: number, y: number) => awaited<PickResult | null>((session) => session.viewport.pick(x, y)),
  };

  return {
    thumbnails,

    connect(port) {
      if (disposal) return;
      const old = connection;
      connection = open(port);
      old.leave(new EngineReplacedError());
      // A worker that still listens ends its session; one that is gone never answers.
      old.session.dispose().catch(() => undefined);
      // A new object, and a new `device` in it: a store that was still at its first state tells its subscribers
      // as well, and whoever holds a canvas hears that the engine it was given to is gone.
      engineState.setState({
        ...INITIAL_ENGINE_STATE, device: { ...INITIAL_ENGINE_STATE.device }, paused, build: buildAfterRestart(engineState.getState().build),
      }, true);
      // Another engine: its requests count from one again, and nothing was asked of it yet.
      lastRequest = 0;
      floor = 0;
      before.clear();
      lastHeard = performance.now();
      askedAt = null;
      introduce(connection.session);
    },

    // docStore is what the session is told of the project and the document; these two serve code that has no store.
    setProject: (project) => connection.session.setProject(project),
    setDocument: (doc: GraphDoc, revision: number) => connection.session.setDocument(doc, revision),
    beginGesture: () => connection.session.beginGesture(),
    endGesture: () => connection.session.endGesture(),
    setPaused(next) {
      paused = next === true;
      connection.session.setPaused(paused);
      // The session says nothing back: the store holds what it was told, for every panel that says "Paused".
      setEnginePaused(engineState, paused);
    },
    requestThumbnails(nodeIds) {
      wanted = [...nodeIds];
      connection.session.requestThumbnails(wanted);
    },
    inspect: (ref: PortRef) => awaited((session) => session.inspect(ref)),
    build: (request: BuildRequest) => awaited<BuildResult>((session) => session.build(request)),
    cancelBuild: () => connection.session.cancelBuild(),
    plan: (doc: GraphDoc) => awaited<BuildPlan>((session) => session.plan(doc)),
    setPreferences(next) {
      preferences = next;
      connection.session.setPreferences(next);
    },
    retryDevice: () => connection.session.retryDevice(),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    viewport,

    dispose() {
      if (disposal) return disposal;
      if (watchTimer !== null) clearTimeout(watchTimer);
      unsubscribe();
      disposal = connection.session.dispose().finally(() => listeners.clear());
      return disposal;
    },
  };
}
