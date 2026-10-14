import type { FieldStats } from '../eval/context.ts';
import type { BuildPlan, BuildResult } from '../export-decl.ts';
import type { GraphDoc, PortRef } from '../graph/doc.ts';
import type { EngineEvent } from './events.ts';
import type { BuildRequest, EnginePreferences, EngineSession } from './session.ts';
import type { CameraState, PickResult, ViewportDisplay, ViewportHost, ViewportSize } from './viewport.ts';

// runtime.md 7.2. `method` is the member's name of EngineSession, with the prefix `viewport.` for ViewportHost.

export type ClientMessage = { readonly id: number; readonly method: string; readonly args: readonly unknown[] };
export type WorkerMessage =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { readonly name: string; readonly message: string } }
  | { readonly event: EngineEvent };

/**
 * One end of the thread boundary. Satisfied by a Worker as the page sees it, by a worker's global scope, and by
 * a MessagePort of a browser or of node:worker_threads. The transfer list holds ArrayBuffers and the canvas.
 */
export interface SessionPort {
  postMessage(message: unknown, transfer: readonly unknown[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  /** A Web MessagePort delivers nothing until start() is called; a Worker and a worker's scope have no such method. */
  start?(): void;
}

const DISPOSED = 'The engine session is disposed';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function errorOf(error: unknown): Error {
  const e = isRecord(error) ? error : {};
  const made = new Error(typeof e.message === 'string' ? e.message : 'The engine session call failed');
  if (typeof e.name === 'string') made.name = e.name;
  return made;
}

function describe(thrown: unknown): { name: string; message: string } {
  if (thrown instanceof Error) return { name: thrown.name, message: thrown.message };
  return { name: 'Error', message: typeof thrown === 'string' ? thrown : String(thrown) };
}

// ---- the client ------------------------------------------------------------------------------------------------------

/**
 * EngineSession over a port: every call becomes one ClientMessage, every WorkerMessage a settled promise or an
 * event for the subscribers. `subscribe` is local; the server posts every event. Nothing here touches a device.
 */
export function createSessionClient(port: SessionPort): EngineSession {
  const waiting = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  const listeners = new Set<(e: EngineEvent) => void>();
  let lastId = 0;
  /** dispose() was called: nothing more is sent. */
  let closing: Promise<void> | null = null;

  function send(method: string, args: readonly unknown[], transfer: readonly unknown[]): number {
    const message: ClientMessage = { id: ++lastId, method, args };
    port.postMessage(message, transfer);
    return message.id;
  }
  /** A method without a result. */
  function tell(method: string, args: readonly unknown[], transfer: readonly unknown[] = []): void {
    if (closing) return;
    send(method, args, transfer);
  }
  /** A method that returns a promise: its one reply settles it. */
  function ask<T>(method: string, args: readonly unknown[]): Promise<T> {
    if (closing) return Promise.reject(new Error(DISPOSED));
    return new Promise<T>((resolve, reject) => {
      const id = send(method, args, []);
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  const onMessage = (e: { data: unknown }): void => {
    const data = e.data;
    if (!isRecord(data)) return;
    if ('event' in data) {
      const event = data.event as EngineEvent;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (thrown) {
          console.error('[orogen] an engine event listener threw', thrown);
        }
      }
      return;
    }
    if (typeof data.id !== 'number') return;
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.ok === true) call?.resolve(data.value);
    else if (call) call.reject(errorOf(data.error));
    // A method without a result is answered only when it threw on the other side: nobody awaits it.
    else console.error(`[orogen] an engine session call failed: ${errorOf(data.error).message}`);
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  const viewport: ViewportHost = {
    // The canvas is moved, not copied: it is in the transfer list (7.2).
    attach: (canvas: OffscreenCanvas, size: ViewportSize) => tell('viewport.attach', [canvas, size], [canvas]),
    detach: () => tell('viewport.detach', []),
    resize: (size: ViewportSize) => tell('viewport.resize', [size]),
    setCamera: (camera: CameraState) => tell('viewport.setCamera', [camera]),
    setDisplay: (display: ViewportDisplay) => tell('viewport.setDisplay', [display]),
    pick: (x: number, y: number) => ask<PickResult | null>('viewport.pick', [x, y]),
  };

  return {
    setProject: (project) => tell('setProject', [{ path: project.path }]),
    setDocument: (doc: GraphDoc, revision: number) => tell('setDocument', [doc, revision]),
    beginGesture: () => tell('beginGesture', []),
    endGesture: () => tell('endGesture', []),
    setPaused: (paused: boolean) => tell('setPaused', [paused]),
    requestThumbnails: (nodeIds: readonly string[]) => tell('requestThumbnails', [[...nodeIds]]),
    inspect: (ref: PortRef) => ask<FieldStats | null>('inspect', [{ node: ref.node, port: ref.port }]),
    build: (request: BuildRequest) => ask<BuildResult>('build', [{ doc: request.doc, outDir: request.outDir }]),
    cancelBuild: () => tell('cancelBuild', []),
    plan: (doc: GraphDoc) => ask<BuildPlan>('plan', [doc]),
    setPreferences: (prefs: EnginePreferences) => tell('setPreferences', [{ vramBytes: prefs.vramBytes, budgetFraction: prefs.budgetFraction }]),
    retryDevice: () => tell('retryDevice', []),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    viewport,
    dispose() {
      if (closing) return closing;
      const done = ask<void>('dispose', []);
      closing = done.finally(() => {
        port.removeEventListener('message', onMessage);
        listeners.clear();
        for (const call of waiting.values()) call.reject(new Error(DISPOSED));
        waiting.clear();
      });
      return closing;
    },
  };
}

// ---- the server ------------------------------------------------------------------------------------------------------

type Args = readonly unknown[];

/** The methods without a result. A name that is not a key of one of these two tables is no method: nothing else of the session can be reached by a message. */
const TELL: Readonly<Record<string, (session: EngineSession, args: Args) => void>> = {
  setProject: (s, a) => s.setProject(a[0] as { path: string | null }),
  setDocument: (s, a) => s.setDocument(a[0] as GraphDoc, a[1] as number),
  beginGesture: (s) => s.beginGesture(),
  endGesture: (s) => s.endGesture(),
  setPaused: (s, a) => s.setPaused(a[0] === true),
  requestThumbnails: (s, a) => s.requestThumbnails(a[0] as readonly string[]),
  cancelBuild: (s) => s.cancelBuild(),
  setPreferences: (s, a) => s.setPreferences(a[0] as EnginePreferences),
  retryDevice: (s) => s.retryDevice(),
  'viewport.attach': (s, a) => s.viewport.attach(a[0] as OffscreenCanvas, a[1] as ViewportSize),
  'viewport.detach': (s) => s.viewport.detach(),
  'viewport.resize': (s, a) => s.viewport.resize(a[0] as ViewportSize),
  'viewport.setCamera': (s, a) => s.viewport.setCamera(a[0] as CameraState),
  'viewport.setDisplay': (s, a) => s.viewport.setDisplay(a[0] as ViewportDisplay),
};

/** The methods that return a promise. Each gets one reply. */
const ASK: Readonly<Record<string, (session: EngineSession, args: Args) => Promise<unknown>>> = {
  inspect: (s, a) => s.inspect(a[0] as PortRef),
  build: (s, a) => s.build(a[0] as BuildRequest),
  plan: (s, a) => s.plan(a[0] as GraphDoc),
  'viewport.pick': (s, a) => s.viewport.pick(a[0] as number, a[1] as number),
  dispose: (s) => s.dispose(),
};

function isClientMessage(data: unknown): data is ClientMessage {
  return isRecord(data) && typeof data.id === 'number' && typeof data.method === 'string' && Array.isArray(data.args);
}

/**
 * The engine thread's end: calls the session for every ClientMessage, in the order they arrive, and posts every
 * EngineEvent. The pixels of a thumbnail are moved, so the session's other subscribers must not keep them.
 * Returns a function that stops serving; `dispose` stops it as well, after its reply.
 */
export function serveSession(session: EngineSession, port: SessionPort): () => void {
  let serving = true;

  function post(message: WorkerMessage, transfer: readonly unknown[] = []): void {
    try {
      port.postMessage(message, transfer);
    } catch (thrown) {
      // The port is closed, or the value cannot be cloned: the other side learns of a failed call, never of nothing.
      if ('id' in message && message.ok) post({ id: message.id, ok: false, error: describe(thrown) });
      else console.error('[orogen] an engine session message could not be posted', thrown);
    }
  }

  const unsubscribe = session.subscribe((event) => {
    post({ event }, event.type === 'thumbnail' ? [event.rgba.buffer] : []);
  });

  const onMessage = (e: { data: unknown }): void => {
    const message = e.data;
    if (!serving || !isClientMessage(message)) return;
    const { id, method, args } = message;
    const tell = Object.hasOwn(TELL, method) ? TELL[method] : undefined;
    const ask = Object.hasOwn(ASK, method) ? ASK[method] : undefined;
    if (tell) {
      try {
        tell(session, args);
      } catch (thrown) {
        post({ id, ok: false, error: describe(thrown) });
      }
      return;
    }
    if (!ask) {
      post({ id, ok: false, error: { name: 'TypeError', message: `The engine session has no method "${method}"` } });
      return;
    }
    let result: Promise<unknown>;
    try {
      result = ask(session, args);
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    result.then(
      (value) => post({ id, ok: true, value }),
      (thrown: unknown) => post({ id, ok: false, error: describe(thrown) }),
    ).finally(() => {
      if (method === 'dispose') stop();
    });
  };

  function stop(): void {
    if (!serving) return;
    serving = false;
    unsubscribe();
    port.removeEventListener('message', onMessage);
  }

  port.addEventListener('message', onMessage);
  port.start?.();
  return stop;
}
