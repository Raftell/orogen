// engineStore, told to each node by its id (runtime.md 8.5: components subscribe to engineStore per node id).
// The store changes with every event of the engine, many times a second while it computes. Were every node of
// the graph to listen to the store itself, each event would ask every node whether it is meant: measured with
// 300 nodes, 0.2 ms an event. The feed listens once and tells only the nodes an event concerns. It keeps no
// state of its own: what a node shows it still reads from the store. No DOM and no React.

import type { StoreApi } from 'zustand/vanilla';

import type { EngineState, NodeRuntime } from '../../state/engine-store.ts';
import { own } from './model.ts';

/** The engine's record of a node; undefined before any event named it. */
export const runtimeOf = (state: EngineState, id: string): NodeRuntime | undefined => own(state.nodes, id);

/** Whether the node's record is of the evaluation that runs now: it waits for its turn in it, or is in it. */
export function isCurrent(state: EngineState, id: string): boolean {
  return state.evaluation !== null && own(state.nodes, id)?.requestId === state.evaluation.requestId;
}

/** Whether previews are paused (8.5): the same for every node, and told to each through the feed, which listens once. */
export const isPaused = (state: EngineState): boolean => state.paused;

/** 8.5: a thumbnail is stale while its key is not the key of the node as the engine was last sent it. */
export function isStale(state: EngineState, id: string): boolean {
  const key = own(state.keys, id);
  return key !== undefined && own(state.thumbnailKeys, id) !== key;
}

export interface NodeFeed {
  /** `listener` is called when the record of the node, whether it is current, whether its thumbnail is stale, or the pause may have changed. */
  subscribe(id: string, listener: () => void): () => void;
}

export function createNodeFeed(store: StoreApi<EngineState>): NodeFeed {
  const listeners = new Map<string, Set<() => void>>();
  let stop: (() => void) | null = null;

  function changed(state: EngineState, previous: EngineState): void {
    const records = state.nodes !== previous.nodes;
    const evaluation = state.evaluation?.requestId !== previous.evaluation?.requestId;
    const keys = state.keys !== previous.keys || state.thumbnailKeys !== previous.thumbnailKeys;
    const paused = state.paused !== previous.paused;
    if (!records && !evaluation && !keys && !paused) return;
    for (const [id, told] of [...listeners]) {
      const concerned = paused || (records && own(state.nodes, id) !== own(previous.nodes, id))
        || (evaluation && isCurrent(state, id) !== isCurrent(previous, id))
        || (keys && isStale(state, id) !== isStale(previous, id));
      if (!concerned) continue;
      for (const listener of [...told]) listener();
    }
  }

  return {
    subscribe(id, listener) {
      let told = listeners.get(id);
      if (!told) listeners.set(id, told = new Set());
      told.add(listener);
      stop ??= store.subscribe(changed);
      return () => {
        told.delete(listener);
        if (told.size === 0 && listeners.get(id) === told) listeners.delete(id);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}

const feeds = new WeakMap<StoreApi<EngineState>, NodeFeed>();

/** The one feed of a store. */
export function nodeFeed(store: StoreApi<EngineState>): NodeFeed {
  let feed = feeds.get(store);
  if (!feed) feeds.set(store, feed = createNodeFeed(store));
  return feed;
}
