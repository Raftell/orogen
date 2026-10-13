// EngineClient (runtime.md 7.2, 8.5): the interface thread's end of the session. It is `createSessionClient`
// over the engine worker, with what the application adds: every event goes into engineStore and the thumbnail
// cache, and docStore drives the session's project, document and gestures.

import type { StoreApi } from 'zustand/vanilla';

import {
  createSessionClient, DEFAULT_PREFERENCES,
  type BuildRequest, type BuildResult, type CameraState, type EngineEvent, type EnginePreferences, type EngineSession, type GraphDoc,
  type PickResult, type PortRef, type SessionPort, type ViewportDisplay, type ViewportHost, type ViewportSize,
} from '../../core/runtime.ts';
import type { DocState } from '../state/doc-store.ts';
import { applyEngineEvent, INITIAL_ENGINE_STATE, type EngineState } from '../state/engine-store.ts';
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
}

export interface EngineClient extends EngineSession {
  readonly thumbnails: ThumbnailCache;
  /**
   * Moves the client to the session behind another port: a new engine worker in place of one that is gone. The
   * client holds everything a session is told that is not in docStore (the preferences, the pause, the thumbnail
   * list, the camera and the display), so the new session is told all of it again, in the order of 8.3, and
   * engineStore starts over, with a `device` object of its own whose state is 'starting'. Calls that awaited the
   * old session reject. The canvas went with the old worker: the viewport attaches a new one when it sees that
   * `device` (7.5 rule 8).
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

  function onEvent(from: Connection, event: EngineEvent): void {
    // The old worker may still be answering while the new one starts; a disposed client has no one to tell.
    if (from !== connection || disposal) return;
    // The pixels first: whoever hears of the new key through the store finds the image.
    if (event.type === 'thumbnail') thumbnails.put(event);
    applyEngineEvent(engineState, event);
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

  const unsubscribe = docStore.subscribe((state, previous) => {
    const { session } = connection;
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
      old.leave(new Error(WORKER_REPLACED));
      // A worker that still listens ends its session; one that is gone never answers.
      old.session.dispose().catch(() => undefined);
      // A new object, and a new `device` in it: a store that was still at its first state tells its subscribers
      // as well, and whoever holds a canvas hears that the engine it was given to is gone.
      engineState.setState({ ...INITIAL_ENGINE_STATE, device: { ...INITIAL_ENGINE_STATE.device } }, true);
      introduce(connection.session);
    },

    // docStore is what the session is told of the project and the document; these two serve code that has no store.
    setProject: (project) => connection.session.setProject(project),
    setDocument: (doc: GraphDoc, revision: number) => connection.session.setDocument(doc, revision),
    beginGesture: () => connection.session.beginGesture(),
    endGesture: () => connection.session.endGesture(),
    setPaused(next) {
      paused = next;
      connection.session.setPaused(next);
    },
    requestThumbnails(nodeIds) {
      wanted = [...nodeIds];
      connection.session.requestThumbnails(wanted);
    },
    inspect: (ref: PortRef) => awaited((session) => session.inspect(ref)),
    build: (request: BuildRequest) => awaited<BuildResult>((session) => session.build(request)),
    cancelBuild: () => connection.session.cancelBuild(),
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
      unsubscribe();
      disposal = connection.session.dispose().finally(() => listeners.clear());
      return disposal;
    },
  };
}
