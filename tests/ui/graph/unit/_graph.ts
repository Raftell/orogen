// The graph panel's logic without a window: stores of their own, the product's registry, and a document built
// with the commands of runtime.md 4.6. Shared by the window-free tests of the graph. Not a test file. It loads no
// GPU code, no React component and no CSS.

import assert from 'node:assert/strict';
import type { StoreApi } from 'zustand/vanilla';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { addNode, connect, createRegistry, setGroup, type GraphDoc, type NodeGroup, type NodeRegistry } from '../../../../src/core/runtime.ts';
import type { GraphContext } from '../../../../src/app/panels/graph/actions.ts';
import { createFlowMapper, type FlowGraph, type FlowInput, type NodeView } from '../../../../src/app/panels/graph/flow.ts';
import { createGraphStore, type GraphUiState } from '../../../../src/app/panels/graph/state.ts';
import { createDocStore, type DocState } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore, type EngineState } from '../../../../src/app/state/engine-store.ts';
import { createUiStore, type UiState } from '../../../../src/app/state/ui-store.ts';

/** The registry of the application: every node of the product (runtime.md 5.1). */
export const REGISTRY: NodeRegistry = createRegistry(nodes);

export interface Bench extends GraphContext {
  readonly doc: StoreApi<DocState>;
  readonly ui: StoreApi<UiState>;
  readonly engineState: StoreApi<EngineState>;
  readonly local: StoreApi<GraphUiState>;
  readonly registry: NodeRegistry;
  /** The document as it is now. */
  now(): GraphDoc;
  /** One transaction that adds a node at a place and connects the inputs given ('<node id>.<port>'). Returns its id. */
  add(type: string, at: { x: number; y: number }, inputs?: Readonly<Record<string, string>>): string;
  group(group: NodeGroup): void;
  /** The mapping of the document as the stores hold it, by a mapper that lives as long as the bench. */
  flow(overrides?: Partial<FlowInput>): FlowGraph;
  views(): ReadonlyMap<string, NodeView>;
  labels(): string[];
}

export function bench(): Bench {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  const engineState = createEngineStore();
  const local = createGraphStore();
  const mapper = createFlowMapper();
  const made: Bench = {
    doc, ui, engineState, local, registry: REGISTRY,
    now: () => doc.getState().doc,
    add(type, at, inputs = {}) {
      let id = '';
      doc.getState().transact(`Add ${REGISTRY.get(type)?.title ?? type}`, (draft) => {
        id = addNode(draft, REGISTRY, type, at);
        for (const [port, from] of Object.entries(inputs)) {
          const dot = from.lastIndexOf('.');
          connect(draft, REGISTRY, { node: from.slice(0, dot), port: from.slice(dot + 1) }, { node: id, port });
        }
      });
      return id;
    },
    group(group) {
      doc.getState().transact('Group', (draft) => setGroup(draft, group));
    },
    flow(overrides = {}) {
      const state = ui.getState();
      const held = local.getState();
      return mapper({
        doc: doc.getState().doc, registry: REGISTRY, selection: state.selection, dragPositions: state.dragPositions,
        edgeSelection: held.edgeSelection, groupSelection: held.groupSelection, groupRects: held.groupRects, dropEdge: held.dropEdge,
        ...overrides,
      });
    },
    views: () => made.flow().views,
    labels: () => doc.getState().past.map((entry) => entry.label),
  };
  return made;
}

/** The id of the one edge into an input; fails when there is none. */
export function edgeInto(doc: GraphDoc, node: string, port: string): string {
  const found = Object.values(doc.edges).find((edge) => edge.to.node === node && edge.to.port === port);
  assert.ok(found, `an edge into ${node}.${port}`);
  return found.id;
}

/** `a` is the very object `b`. Not assert.equal: when that fails it prints both sides whole (testing.md 8.2). */
export function same(a: unknown, b: unknown, message = 'the very same object'): void {
  if (a !== b) throw new assert.AssertionError({ message: `Not the same object: ${message}`, operator: '===', stackStartFn: same });
}

export function different(a: unknown, b: unknown, message = 'another object'): void {
  if (a === b) throw new assert.AssertionError({ message: `The same object: ${message}`, operator: '!==', stackStartFn: different });
}

/** The edges of a document as 'from.port>to.port', sorted: small enough to compare whole. */
export function wiring(doc: GraphDoc): string[] {
  return Object.values(doc.edges).map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`).sort();
}
