// The engine worker's entry (runtime.md 8.3): the device, the engine, the session and the viewport renderer in
// one thread. Built to dist/engine-worker.js, a classic script whose Node modules are `require` calls; the page
// creates it with `new Worker('engine-worker.js')`.

import path from 'node:path';

import { nodes } from '../../../core/nodes/index.ts';
import {
  budgetBytes, createEngine, createRegistry, createSession, DEFAULT_PREFERENCES, GpuUnavailableError, NO_WEBGPU, openFirstDevice, openGpu, serveSession,
  type ClientMessage, type GpuContext, type GpuProfile, type SessionPort, type WorkerMessage,
} from '../../../core/runtime.ts';
import { buildToFolder } from '../../../export/folder.ts';
import { planBuild } from '../../../export/plan.ts';
import { createViewportRenderer } from '../../../viewport/index.ts';
import { NodeFileSink, NodeFileSource } from '../../node/files.ts';
import { createWebCpuRunner } from './cpu.ts';

type Listener = (e: { data: unknown }) => void;

const isClientMessage = (data: unknown): data is ClientMessage =>
  typeof data === 'object' && data !== null && typeof (data as ClientMessage).id === 'number' && typeof (data as ClientMessage).method === 'string';

const post = (message: WorkerMessage, transfer: readonly unknown[] = []): void => self.postMessage(message, transfer as Transferable[]);

// ---- the port --------------------------------------------------------------------------------------------------------
// The page talks from the moment it has created the worker; the session exists only when the device and the
// engine do. What arrives in between is held here and handed, in order, to the session's server.
const held: { readonly data: unknown }[] = [];
const listeners = new Set<Listener>();
/** Set when the engine did not start: every call is then answered with this failure. */
let refusal: string | null = null;
/** The server has stopped (the session is disposed): nothing more is held. */
let closed = false;
/** The device in use. Recovery opens the next one; the session's end is the end of the last. */
let current: GpuContext | null = null;

function refuse(data: unknown, reason: string): void {
  if (!isClientMessage(data)) return;
  // A page that disposes of an engine that never started must not wait for ever.
  if (data.method === 'dispose') post({ id: data.id, ok: true, value: undefined });
  else post({ id: data.id, ok: false, error: { name: 'Error', message: reason } });
}

self.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (refusal !== null) {
    refuse(e.data, refusal);
    return;
  }
  if (listeners.size > 0) {
    for (const listener of [...listeners]) listener(e);
    return;
  }
  if (closed) return;
  // Of documents sent in a row the session would keep the latest only (7.3): so does the queue, which bounds it.
  const last = held[held.length - 1];
  if (isClientMessage(e.data) && e.data.method === 'setDocument' && last && isClientMessage(last.data) && last.data.method === 'setDocument') held.pop();
  held.push({ data: e.data });
});

const port: SessionPort = {
  postMessage: (message, transfer) => self.postMessage(message, transfer as Transferable[]),
  addEventListener(_type, listener) {
    listeners.add(listener);
    // In a microtask: the session announces its device in one, to the subscriber it got just before this call
    // (7.7), and what was held is answered after that announcement, as a message that arrives later would be.
    queueMicrotask(() => {
      for (const e of held.splice(0)) if (listeners.has(listener)) listener(e);
    });
  },
  removeEventListener(_type, listener) {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // The session is disposed, and its engine with it: the device goes last (1.5 rule 5).
    closed = true;
    current?.destroy();
    current = null;
  },
};

/** 8.3 step 1: without a device, or without an engine on it, the page is told and the worker does nothing more. */
function fail(message: string): void {
  refusal = `The engine did not start: ${message}`;
  post({ event: { type: 'engine-error', message, fatal: true } });
  for (const e of held.splice(0)) refuse(e.data, refusal);
}

// ---- start-up --------------------------------------------------------------------------------------------------------
// The variables of runtime.md 1.1 rule 5. The main process has checked them; this process inherited them.
const environment: Readonly<Record<string, string | undefined>> = typeof process === 'object' && process !== null ? process.env : {};
const profile: GpuProfile = environment.OROGEN_GPU_PROFILE === 'core' ? 'core' : 'max';
const log = environment.OROGEN_GPU_LOG === '1';

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** A device that is lost while the engine is made on it is tried once more: there is no session yet to recover it. */
const ENGINE_ROUNDS = 2;

async function start(): Promise<void> {
  if (!navigator.gpu) {
    fail(NO_WEBGPU);
    return;
  }
  for (let round = 1; ; round++) {
    let gpu: GpuContext;
    try {
      // 8.3 step 1: on the schedule of recovery (7.8 rule 2). One missing adapter is not final: a GPU process
      // that ended while the application started is back a moment later.
      gpu = await openFirstDevice(() => openGpu(navigator.gpu, { profile, log }));
    } catch (thrown) {
      if (!(thrown instanceof GpuUnavailableError)) console.error('[orogen] the GPU device could not be opened', thrown);
      fail(messageOf(thrown));
      return;
    }

    // Recovery opens the next device, and the lost one is destroyed first (7.8 rule 2).
    current = gpu;
    const reopenGpu = async (): Promise<GpuContext> => {
      current?.destroy();
      current = null;
      // One that arrives after the session's end is destroyed by the session, which alone has it then.
      const next = await openGpu(navigator.gpu, { profile, log });
      if (!closed) current = next;
      return next;
    };

    try {
      const engine = await createEngine({
        gpu,
        registry: createRegistry(nodes),
        files: NodeFileSource(null),
        cpu: createWebCpuRunner(),
        budgetBytes: budgetBytes(gpu.caps, DEFAULT_PREFERENCES),
      });
      const session = createSession({
        engine,
        reopenGpu,
        createFiles: (projectPath) => NodeFileSource(projectPath === null ? null : path.dirname(projectPath)),
        build: (host, o) => buildToFolder(host, { ...o, createSink: NodeFileSink }),
        plan: (host, doc) => planBuild(doc, host.registry),
        renderer: createViewportRenderer(),
      });
      // The same task as createSession (8.3 step 4): the first subscriber is the server, so no event is missed.
      serveSession(session, port);
      return;
    } catch (thrown) {
      const lost = gpu.lost;
      gpu.destroy();
      current = null;
      if (lost && round < ENGINE_ROUNDS) continue;
      console.error('[orogen] the engine could not be created', thrown);
      fail(messageOf(thrown));
      return;
    }
  }
}

void start();
