// What lies where in the graph, from the document alone: the wire a dragged node would go into, the wires a
// stroke cuts, the nodes and groups a group holds, the nodes a panel shows. Pure: no DOM, no React.

import type { GraphDoc, NodeRegistry } from '../../../core/runtime.ts';
import { insertPlan } from './connect.ts';
import { groupRect, rectOfNode, wireEnds, type NodeView } from './flow.ts';
import {
  centerOf, containsRect, distanceToPolyline, intersects, polylineMeetsRect, polylinesMeet, sampleWire,
  type Point, type Rect,
} from './geometry.ts';
import { own } from './model.ts';

type Drag = Readonly<Record<string, Point>> | null | undefined;

/** The part of a node a wire must pass under for the node to go into it: the middle half, so that a wire that only grazes a corner does not count. */
function core(rect: Rect): Rect {
  return { x: rect.x + rect.w / 4, y: rect.y + rect.h / 8, w: rect.w / 2, h: (rect.h * 3) / 4 };
}

/**
 * The wire the node would be inserted into where it is now: of the wires that pass under its middle and that it
 * can go into (`insertPlan`), the one nearest its centre. Null: none.
 */
export function wireUnderNode(doc: GraphDoc, registry: NodeRegistry, views: ReadonlyMap<string, NodeView>, nodeId: string, drag?: Drag): string | null {
  const rect = rectOfNode(doc, views, nodeId, drag);
  if (!rect) return null;
  const target = core(rect);
  const centre = centerOf(rect);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    if (edge.from.node === nodeId || edge.to.node === nodeId) continue;
    const ends = wireEnds(doc, views, edge, drag);
    if (!ends) continue;
    // The curve stays between its two ends in x and, nearly, in y: a wire far from the node is left out before it is sampled.
    const reach = Math.abs(ends.to.x - ends.from.x) + rect.w;
    if (Math.min(ends.from.x, ends.to.x) - reach > target.x + target.w || Math.max(ends.from.x, ends.to.x) + reach < target.x) continue;
    if (Math.min(ends.from.y, ends.to.y) > target.y + target.h || Math.max(ends.from.y, ends.to.y) < target.y) continue;
    const line = sampleWire(ends.from, ends.to);
    if (!polylineMeetsRect(line, target)) continue;
    const distance = distanceToPolyline(centre, line);
    if (distance >= bestDistance || insertPlan(doc, registry, nodeId, edgeId) === null) continue;
    best = edgeId;
    bestDistance = distance;
  }
  return best;
}

/** The wire within `within` of the point and nearest to it; null for none. */
export function wireAtPoint(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, point: Point, within: number, drag?: Drag): string | null {
  let best: string | null = null;
  let bestDistance = within;
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    const ends = wireEnds(doc, views, edge, drag);
    if (!ends) continue;
    const distance = distanceToPolyline(point, sampleWire(ends.from, ends.to));
    if (distance > bestDistance) continue;
    best = edgeId;
    bestDistance = distance;
  }
  return best;
}

/** The edges whose wires the stroke crosses, in record order. */
export function wiresCut(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, stroke: readonly Point[], drag?: Drag): string[] {
  if (stroke.length < 2) return [];
  const cut: string[] = [];
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    const ends = wireEnds(doc, views, edge, drag);
    if (ends && polylinesMeet(stroke, sampleWire(ends.from, ends.to))) cut.push(edgeId);
  }
  return cut;
}

export interface GroupContents { readonly nodes: readonly string[]; readonly groups: readonly string[] }

/**
 * What a group holds and moves with it: the nodes that lie wholly inside its frame, and the groups that do. A
 * group inside a group inside this one is found too, because its frame is inside this one's as well.
 */
export function groupContents(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, groupId: string): GroupContents {
  const group = own(doc.groups, groupId);
  if (!group) return { nodes: [], groups: [] };
  const frame = groupRect(group);
  const nodes = Object.keys(doc.nodes).filter((id) => {
    const rect = rectOfNode(doc, views, id);
    return rect !== null && containsRect(frame, rect);
  });
  const groups = Object.entries(doc.groups).filter(([id, other]) => id !== groupId && containsRect(frame, groupRect(other))).map(([id]) => id);
  return { nodes, groups };
}

/** The nodes any part of which lies in `area`, in record order. */
export function nodesIn(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, area: Rect, drag?: Drag): string[] {
  return Object.keys(doc.nodes).filter((id) => {
    const rect = rectOfNode(doc, views, id, drag);
    return rect !== null && intersects(area, rect);
  });
}

/** The rectangles of the nodes named, where they are; a node that does not exist is left out. */
export function rectsOf(doc: GraphDoc, views: ReadonlyMap<string, NodeView>, ids: readonly string[], drag?: Drag): Rect[] {
  return ids.flatMap((id) => rectOfNode(doc, views, id, drag) ?? []);
}
