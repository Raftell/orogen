// Documents for the GPU-free tests of planning: written out as the JSON a project file holds, with the node
// ids the test chooses, because a plan visits export nodes in the order of their ids.

import type { NodeDef } from '../../../src/core/api.ts';
import { nodes as ioNodes } from '../../../src/core/nodes/io/index.ts';
import { nodes as refNodes } from '../../../src/core/nodes/ref/index.ts';
import { createRegistry, type GraphDoc, type NodeRegistry, type ProjectSettings } from '../../../src/core/runtime.ts';

export const SETTINGS: ProjectSettings = { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 1009, previewLevel: 1, seaLevel: 0.25 };

export function registryOf(extra: readonly NodeDef[] = []): NodeRegistry {
  return createRegistry([...refNodes, ...ioNodes, ...extra]);
}
export const REGISTRY = registryOf();

export interface NodeSpec {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** The output that feeds the input `in`, as '<node>.<port>'. */
  readonly in?: string;
  readonly title?: string;
  readonly bypass?: boolean;
}

/** A document of the given nodes, in the order written; an edge per `in`, in that order too. */
export function docOf(nodes: Readonly<Record<string, NodeSpec>>, settings: Partial<ProjectSettings> = {}, registry: NodeRegistry = REGISTRY): GraphDoc {
  const doc = {
    format: 'orogen' as const, version: 1 as const, settings: { ...SETTINGS, ...settings },
    nodes: {} as Record<string, GraphDoc['nodes'][string]>, edges: {} as Record<string, GraphDoc['edges'][string]>, groups: {}, ui: {},
  };
  for (const [id, spec] of Object.entries(nodes)) {
    doc.nodes[id] = {
      id, type: spec.type, version: registry.get(spec.type)?.version ?? 1, position: { x: 0, y: 0 }, params: { ...spec.params },
      ...(spec.title !== undefined ? { title: spec.title } : {}), ...(spec.bypass ? { bypass: true } : {}),
    };
  }
  for (const [id, spec] of Object.entries(nodes)) {
    if (spec.in === undefined) continue;
    const dot = spec.in.lastIndexOf('.');
    const edge = `e-${id}`;
    doc.edges[edge] = { id: edge, from: { node: spec.in.slice(0, dot), port: spec.in.slice(dot + 1) }, to: { node: id, port: 'in' } };
  }
  return doc;
}

/** The sources every test document has: a terrain, a mask of it and a colouring of it. */
export const SOURCES: Readonly<Record<string, NodeSpec>> = {
  land: { type: 'ref/fbm' },
  steep: { type: 'ref/slope-mask', in: 'land.out' },
  paint: { type: 'ref/colorize', in: 'land.out' },
};
