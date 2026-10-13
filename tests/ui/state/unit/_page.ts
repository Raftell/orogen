// The page's side of the application without a window: the three stores, a thumbnail cache and the registry,
// as src/app/main.tsx assembles them. Shared by the window-free tests and by the tests on the real engine
// (../rig.ts). Not a test file. It loads no GPU code.

import assert from 'node:assert/strict';
import type { StoreApi } from 'zustand/vanilla';

import { nodes as ioNodes } from '../../../../src/core/nodes/io/index.ts';
import { nodes as refNodes } from '../../../../src/core/nodes/ref/index.ts';
import {
  addNode, connect, createRegistry, setParam, setSettings, setView,
  type NodeRegistry, type ProjectSettings,
} from '../../../../src/core/runtime.ts';
import { createThumbnailCache, type ThumbnailCache } from '../../../../src/app/engine/thumbnails.ts';
import { createDocStore, type DocState } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore, type EngineState } from '../../../../src/app/state/engine-store.ts';
import { createUiStore, type UiState } from '../../../../src/app/state/ui-store.ts';

/** The registry of the page: metadata of the reference nodes and the import and export nodes. */
export const REGISTRY: NodeRegistry = createRegistry([...refNodes, ...ioNodes]);

/** Builds and thumbnails at 241, the preview at 121, drafts at 61: a size the landscape export accepts, and small. */
export const SETTINGS: ProjectSettings = { terrainSize: 2000, heightRange: 600, seed: 7, buildResolution: 241, previewLevel: 1, seaLevel: 0.3 };
export const PREVIEW = 121;
export const DRAFT = 61;

/** A wait that nothing ends is a failure to describe. It bounds no duration a test relies on. */
export const BACKSTOP_MS = 120_000;

/** Resolves when `done()` holds. Looked at after every turn of the event loop: a message arrives in a later turn. */
export async function until(done: () => boolean, what: string): Promise<void> {
  const backstop = performance.now() + BACKSTOP_MS;
  while (!done()) {
    if (performance.now() > backstop) throw new Error(`Not within ${BACKSTOP_MS / 1000} s: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A clock a test moves by hand: HistoryEntry.time and the 600 ms of merging follow it. */
export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

export function testClock(start = 1000): TestClock {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

export interface Page {
  readonly doc: StoreApi<DocState>;
  readonly engineState: StoreApi<EngineState>;
  readonly ui: StoreApi<UiState>;
  readonly thumbnails: ThumbnailCache;
  /** One transaction that adds a node, sets the parameters given and connects the inputs given ('<node id>.<port>'). Returns the node's id. */
  add(type: string, params?: Readonly<Record<string, unknown>>, inputs?: Readonly<Record<string, string>>): string;
}

/** Stores of their own, with thumbnails as plain objects: Node has no ImageData. */
export function createPage(options: { readonly clock?: TestClock; readonly limits?: { readonly entries?: number; readonly bytes?: number } } = {}): Page {
  const ui = createUiStore();
  const doc = createDocStore({ ui, ...(options.clock ? { now: options.clock.now } : {}), ...(options.limits ? { limits: options.limits } : {}) });
  const engineState = createEngineStore();
  const thumbnails = createThumbnailCache({ createImage: (rgba, size) => ({ data: rgba, width: size, height: size }) });
  let placed = 0;
  return {
    doc, engineState, ui, thumbnails,
    add(type, params = {}, inputs = {}) {
      let id = '';
      const title = REGISTRY.get(type)?.title ?? type;
      doc.getState().transact(`Add ${title}`, (draft) => {
        id = addNode(draft, REGISTRY, type, { x: 280 * placed++, y: 0 });
        for (const [name, value] of Object.entries(params)) setParam(draft, REGISTRY, id, name, value);
        for (const [port, from] of Object.entries(inputs)) {
          const dot = from.lastIndexOf('.');
          connect(draft, REGISTRY, { node: from.slice(0, dot), port: from.slice(dot + 1) }, { node: id, port });
        }
      });
      return id;
    },
  };
}

/** The settings of these tests: the two that are outside the history go in a transaction of their own (runtime.md 8.5 rule 5). */
export function applySettings(page: Page, settings: ProjectSettings = SETTINGS): void {
  const { buildResolution, previewLevel, ...undoable } = settings;
  page.doc.getState().transact('Resolution', (draft) => setSettings(draft, { buildResolution, previewLevel }), { undoable: false });
  page.doc.getState().transact('Settings', (draft) => setSettings(draft, undoable));
}

export function showHeight(page: Page, node: string, port = 'out'): void {
  page.doc.getState().transact('View', (draft) => setView(draft, { height: { node, port } }), { undoable: false });
}

/**
 * `a` is the very object `b`. Not assert.equal: when that fails it prints both sides whole, and a state of a
 * store holds a document and a history (testing.md 8.2).
 */
export function same(a: unknown, b: unknown, message = 'the very same object'): void {
  if (a !== b) throw new assert.AssertionError({ message: `Not the same object: ${message}`, operator: '===', stackStartFn: same });
}

export function different(a: unknown, b: unknown, message = 'another object'): void {
  if (a === b) throw new assert.AssertionError({ message: `The same object: ${message}`, operator: '!==', stackStartFn: different });
}

/**
 * The first difference between two JSON values, as a path and the two values there; null when they hold the
 * same. The order of an object's members does not count: a record that lost a member and got it back holds it
 * last. A loop of its own, because assert.deepEqual on a document builds a textual diff of both sides (testing.md 8.2).
 */
export function difference(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  const brief = (v: unknown): string => (JSON.stringify(v) ?? String(v)).slice(0, 80);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: ${brief(a)} against ${brief(b)}`;
    if (a.length !== b.length) return `${path}: ${a.length} items against ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const found = difference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      if (!Object.hasOwn(right, key)) return `${path}.${key}: only the first has it`;
      const found = difference(left[key], right[key], `${path}.${key}`);
      if (found) return found;
    }
    for (const key of Object.keys(right)) if (!Object.hasOwn(left, key)) return `${path}.${key}: only the second has it`;
    return null;
  }
  return `${path}: ${brief(a)} against ${brief(b)}`;
}
