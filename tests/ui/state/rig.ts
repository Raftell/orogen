// What the tests on the real engine share. Not a test file.
//
// The engine thread's end, in Node: a real session on the process's engine, served over one port of a real
// MessageChannel as the engine worker serves it (runtime.md 8.3), with a build function that calls buildProject
// with a memory sink (7.1). The page's end is the other port, which a test hands to createEngineClient.

import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import { nodes as ioNodes } from '../../../src/core/nodes/io/index.ts';
import { createSession, serveSession, type Engine, type EngineEvent, type EngineSession, type SessionPort } from '../../../src/core/runtime.ts';
import { buildProject } from '../../../src/export/build.ts';
import { planBuild } from '../../../src/export/plan.ts';
import { createEngineClient, type EngineClient } from '../../../src/app/engine/client.ts';
import type { EngineState } from '../../../src/app/state/engine-store.ts';
import { getEngine, memorySink, memorySource, useNodes, type MemorySink } from '../../helpers/index.ts';
import { BACKSTOP_MS, createPage, until, type Page } from './unit/_page.ts';

export { applySettings, BACKSTOP_MS, createPage, difference, DRAFT, PREVIEW, REGISTRY, same, SETTINGS, showHeight, until } from './unit/_page.ts';
export type { Page } from './unit/_page.ts';

// The engine of the process gets the definitions the page's registry holds: the harness has the reference nodes already.
useNodes(ioNodes);

// ---- the engine thread's side ---------------------------------------------------------------------------------------

export interface WorkerEnd {
  /** The page's end of the channel. */
  readonly port: SessionPort;
  readonly session: EngineSession;
  /** Every event the session emitted, in order. A thumbnail's pixels are gone from these: the server moved them (7.2). */
  readonly emitted: EngineEvent[];
  /** The sink of every build the session ran, in order. */
  readonly sinks: MemorySink[];
  /** Resolves when the session has asked nothing of the engine that is not answered, and a turn of the event loop passed without an event. */
  idle(): Promise<void>;
  /** Closes the channel and disposes the session, and with it the engine. */
  close(): Promise<void>;
}

export interface WorkerSetup {
  /**
   * The last timing of a node as the session is told it: what predicts a node too slow for an idle thumbnail
   * (7.3 rule 9). A test of that rule gives the duration itself (testing.md 8.3). Default: what the engine measured.
   */
  readonly lastTiming?: (nodeId: string) => { readonly resolution: number; readonly wallMs: number } | null;
}

let started = 0;
const open = new Set<WorkerEnd>();

/**
 * A session on an engine of its own. A session numbers its requests from 1 (7.1), so it needs an engine nothing
 * has evaluated on: the harness makes a new one when the slicing asked for changes, and no slicing changes what
 * these tests assert.
 */
export async function startWorkerEnd(setup: WorkerSetup = {}): Promise<WorkerEnd> {
  assert.equal(open.size, 0, 'one engine is alive at a time (testing.md 2.1): close the earlier worker end first');
  const real = (await getEngine(started++ % 2 === 0 ? 'auto' : 'one')).engine;

  // What the session has asked of the engine and not yet got back, for idle().
  let inFlight = 0;
  let wakers: (() => void)[] = [];
  const counted = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    inFlight++;
    return call(...args).finally(() => {
      inFlight--;
      for (const wake of wakers.splice(0)) wake();
    });
  };
  const engine: Engine = Object.create(real, {
    evaluate: { value: counted(real.evaluate.bind(real)) },
    keys: { value: counted(real.keys.bind(real)) },
    stats: { value: counted(real.stats.bind(real)) },
    trim: { value: counted(real.trim.bind(real)) },
    ...(setup.lastTiming ? { lastTiming: { value: setup.lastTiming } } : {}),
  }) as Engine;

  const sinks: MemorySink[] = [];
  const session = createSession({
    engine,
    reopenGpu: () => Promise.reject(new Error('These tests have one device')),
    createFiles: () => memorySource(),
    build: counted((host, o) => {
      const sink = memorySink();
      sinks.push(sink);
      return buildProject(host, { doc: o.doc, sink, requestId: o.requestId, signal: o.signal, onEvent: o.onEvent });
    }),
    plan: (host, doc) => planBuild(doc, host.registry),
    renderer: null,
  });
  const { port1, port2 } = new MessageChannel();
  const emitted: EngineEvent[] = [];
  // In the task that creates the session, as the engine worker does (8.3 step 4).
  serveSession(session, port2);
  session.subscribe((event) => emitted.push(event));

  let closed: Promise<void> | null = null;
  const end: WorkerEnd = {
    port: port1, session, emitted, sinks,
    async idle() {
      const backstop = performance.now() + BACKSTOP_MS;
      for (;;) {
        if (performance.now() > backstop) assert.fail('the session did not come to rest');
        if (inFlight > 0) {
          await new Promise<void>((resolve) => wakers.push(resolve));
          continue;
        }
        // What a settled call leads to is started in its continuation, which has run when the event loop comes round.
        const before = emitted.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (inFlight === 0 && emitted.length === before) return;
      }
    },
    close() {
      closed ??= (async () => {
        try {
          await session.dispose();
        } finally {
          port1.close();
          port2.close();
          open.delete(end);
        }
      })();
      return closed;
    },
  };
  open.add(end);
  return end;
}

export interface Application {
  readonly page: Page;
  readonly client: EngineClient;
  readonly worker: WorkerEnd;
  /** Every event the client delivered, in order. */
  readonly received: EngineEvent[];
  /**
   * Resolves when the session has handled everything the page sent, has no evaluation or build left to make, and
   * the page has every event of it so far. Thumbnails may still follow: the engine reads them back after the
   * evaluation that made them has ended (5.12 rule 4). `thumbnailsOf` waits for those.
   */
  settled(): Promise<void>;
  /** Resolves when the cache holds, for each of these nodes, a thumbnail of the node's current key made from a field of this resolution. */
  thumbnailsOf(nodeIds: readonly string[], resolution: number): Promise<void>;
  /** Ends the client and the worker end, whatever the test left running. */
  close(): Promise<void>;
}

/** A page with a client on a new worker end. */
export async function startApplication(setup: WorkerSetup = {}): Promise<Application> {
  const worker = await startWorkerEnd(setup);
  const page = createPage();
  const client = createEngineClient({ port: worker.port, doc: page.doc, engineState: page.engineState, thumbnails: page.thumbnails });
  const received: EngineEvent[] = [];
  client.subscribe((event) => received.push(event));
  return {
    page, client, worker, received,
    async settled() {
      // Messages are handled in the order sent (7.2): when this one is answered, every earlier one has been handled.
      // Without a renderer the session answers it at once, whatever the engine is doing.
      await client.viewport.pick(0, 0);
      await worker.idle();
      await until(() => received.length === worker.emitted.length, `${worker.emitted.length} events were emitted, ${received.length} arrived`);
    },
    async thumbnailsOf(nodeIds, resolution) {
      const missing = (): string[] => nodeIds.filter((id) => {
        const entry = page.thumbnails.get(id);
        const key = page.engineState.getState().keys[id];
        return !entry || key === undefined || entry.contentKey !== key || entry.resolution !== resolution;
      });
      await until(() => missing().length === 0, `thumbnails at ${resolution} of the nodes ${nodeIds.join(', ')}`);
    },
    async close() {
      // The client's own dispose is answered only by a worker that is still there, and a test may end without one.
      client.dispose().catch(() => undefined);
      await worker.close();
    },
  };
}

/** The state of each node in the engine store, by the names a test gave the ids. */
export function nodeStates(state: EngineState, ids: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(ids)) out[name] = Object.hasOwn(state.nodes, id) ? state.nodes[id]!.state : 'none';
  return out;
}
