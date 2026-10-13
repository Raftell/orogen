// The geometry of the graph: how large a node is, where its ports are, the curve of a wire, and the tests that
// follow from them (a node on a wire, a stroke across wires, a node inside a group). A node's size is a function
// of its ports alone, so everything here is computed from the document without a window. The style sheet takes
// its sizes from the same constants (GraphPanel sets them as custom properties). Pure: no DOM, no React.

export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** CSS pixels at zoom 1. The least width of a node: its thumbnail between two columns of ports with short labels. */
export const NODE_WIDTH = 224;
export const BORDER = 1;
export const HEADER_HEIGHT = 22;
export const ROW_HEIGHT = 18;
export const BODY_PADDING = 4;
/** The thumbnail is drawn at 96; its image is 128 × 128 (runtime.md 5.12). */
export const THUMBNAIL_SIZE = 96;
export const FOOTER_HEIGHT = 16;
/** The square of a port's dot. Its centre lies on the node's edge. */
export const HANDLE_SIZE = 10;

export const GROUP_HEADER_HEIGHT = 22;
/** The space a new group leaves around the nodes it is made for. */
export const GROUP_PADDING = 16;
export const GROUP_MIN_WIDTH = 120;
export const GROUP_MIN_HEIGHT = 60;

export interface NodeShape {
  readonly inputs: number;
  readonly outputs: number;
  /** A thumbnail is drawn: the node has an output and is not collapsed. */
  readonly thumbnail: boolean;
  /** The length of the longest label among its inputs and among its outputs, in characters; without them the node has the least width. */
  readonly inputLabel?: number;
  readonly outputLabel?: number;
}

/**
 * What a port's label is given beside its text: the half of the dot that lies inside the node, and the space on
 * either side of the text (graph.module.css, .port).
 */
const LABEL_MARGIN = 15;
/**
 * The width a character of a label is counted as, at the small font of the theme. Measured on Linux: the widest
 * label of the product, 'Water surface', is 69 px, 5.3 a letter; a hidden-window test holds every type to its column.
 */
const LABEL_CHARACTER = 6;
/** Column widths are multiples of this, so that nodes come in a few widths and not in one per label. */
const COLUMN_STEP = 8;

/**
 * The width of one of the two columns of ports, for labels of at most `label` characters. A label that is cut
 * reads as another: 'Water surface' and 'Water depth' are both 'Water …' in the least column.
 */
export function portColumn(label: number): number {
  const least = (NODE_WIDTH - THUMBNAIL_SIZE) / 2;
  return Math.max(least, Math.ceil((LABEL_MARGIN + label * LABEL_CHARACTER) / COLUMN_STEP) * COLUMN_STEP);
}

/**
 * The column of the inputs, the thumbnail, the column of the outputs. Each column is as wide as its own labels
 * need, so one long label widens one side only; a collapsed node keeps its width, and its wires their places.
 */
export function nodeWidth(shape: Pick<NodeShape, 'inputLabel' | 'outputLabel'>): number {
  return portColumn(shape.inputLabel ?? 0) + THUMBNAIL_SIZE + portColumn(shape.outputLabel ?? 0);
}

export function nodeHeight(shape: NodeShape): number {
  const rows = Math.max(shape.inputs, shape.outputs);
  const ports = rows * ROW_HEIGHT;
  const content = shape.thumbnail ? Math.max(THUMBNAIL_SIZE, ports) : ports;
  const body = content > 0 ? content + 2 * BODY_PADDING : 0;
  return BORDER + HEADER_HEIGHT + body + FOOTER_HEIGHT + BORDER;
}

/** The height of the centre of the port in row `row`, from the node's top edge. */
export function portY(row: number): number {
  return BORDER + HEADER_HEIGHT + BODY_PADDING + row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Where a wire leaves the output in row `row` of a node of `width` at `position`: the outer edge of the port's dot. */
export function outputAnchor(position: Point, row: number, width: number = NODE_WIDTH): Point {
  return { x: position.x + width + HANDLE_SIZE / 2, y: position.y + portY(row) };
}

export function inputAnchor(position: Point, row: number): Point {
  return { x: position.x - HANDLE_SIZE / 2, y: position.y + portY(row) };
}

export function nodeRect(position: Point, shape: NodeShape): Rect {
  return { x: position.x, y: position.y, w: nodeWidth(shape), h: nodeHeight(shape) };
}

export const centerOf = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

export function containsPoint(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** Whether `inner` lies wholly inside `outer`: what makes a node part of a group. */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** The smallest rectangle around all of `rects`; null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + 2 * by, h: rect.h + 2 * by };
}

/** The rectangle of a group made around `rects`: room on every side, and for its title bar above. */
export function groupRectAround(rects: readonly Rect[]): Rect | null {
  const bounds = boundsOf(rects);
  if (!bounds) return null;
  return {
    x: bounds.x - GROUP_PADDING,
    y: bounds.y - GROUP_PADDING - GROUP_HEADER_HEIGHT,
    w: bounds.w + 2 * GROUP_PADDING,
    h: bounds.h + 2 * GROUP_PADDING + GROUP_HEADER_HEIGHT,
  };
}

// ---- wires -----------------------------------------------------------------------------------------------------------

/** How far a wire runs level before it turns, for ends `distance` apart along x (negative: the target is to the left). */
function reach(distance: number): number {
  return distance >= 0 ? 0.5 * distance : 6.25 * Math.sqrt(-distance);
}

/** The control points of the cubic from an output at `from` to an input at `to`. */
export function wireControls(from: Point, to: Point): readonly [Point, Point, Point, Point] {
  const r = reach(to.x - from.x);
  return [from, { x: from.x + r, y: from.y }, { x: to.x - r, y: to.y }, to];
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** The SVG path of a wire. */
export function wirePath(from: Point, to: Point): string {
  const [a, b, c, d] = wireControls(from, to);
  return `M${round(a.x)},${round(a.y)} C${round(b.x)},${round(b.y)} ${round(c.x)},${round(c.y)} ${round(d.x)},${round(d.y)}`;
}

/** Segments a wire is tested as: enough that a chord strays from the curve by less than a port's dot. */
export const WIRE_SEGMENTS = 20;

/** Points along a wire, both ends included. */
export function sampleWire(from: Point, to: Point, segments: number = WIRE_SEGMENTS): Point[] {
  const [a, b, c, d] = wireControls(from, to);
  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const wa = u * u * u, wb = 3 * u * u * t, wc = 3 * u * t * t, wd = t * t * t;
    points.push({ x: wa * a.x + wb * b.x + wc * c.x + wd * d.x, y: wa * a.y + wb * b.y + wc * c.y + wd * d.y });
  }
  return points;
}

const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

/** Whether the segments a–b and c–d meet, touching included. */
export function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSegment(c, d, a)) || (d2 === 0 && onSegment(c, d, b)) || (d3 === 0 && onSegment(a, b, c)) || (d4 === 0 && onSegment(a, b, d));
}

/** Whether the polyline `line` meets the polyline `other` anywhere. */
export function polylinesMeet(line: readonly Point[], other: readonly Point[]): boolean {
  for (let i = 1; i < line.length; i++) {
    for (let j = 1; j < other.length; j++) {
      if (segmentsMeet(line[i - 1]!, line[i]!, other[j - 1]!, other[j]!)) return true;
    }
  }
  return false;
}

/** Whether the polyline passes through the rectangle. */
export function polylineMeetsRect(line: readonly Point[], rect: Rect): boolean {
  const corners: Point[] = [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
  ];
  const outline = [...corners, corners[0]!];
  return line.some((point) => containsPoint(rect, point)) || polylinesMeet(line, outline);
}

/** The least distance from `p` to the polyline. */
export function distanceToPolyline(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

// ---- the viewport ----------------------------------------------------------------------------------------------------

/** The graph's viewport as the document keeps it (runtime.md 4.1): the offset of the origin in panel pixels, and the zoom. */
export interface GraphViewport { readonly x: number; readonly y: number; readonly zoom: number }

export function toFlow(viewport: GraphViewport, screen: Point): Point {
  return { x: (screen.x - viewport.x) / viewport.zoom, y: (screen.y - viewport.y) / viewport.zoom };
}

export function toScreen(viewport: GraphViewport, flow: Point): Point {
  return { x: flow.x * viewport.zoom + viewport.x, y: flow.y * viewport.zoom + viewport.y };
}

/** The SVG path of a wire as the panel shows it at `viewport`: the curve of the graph, in pixels of the panel. */
export function wirePathOn(viewport: GraphViewport, from: Point, to: Point): string {
  const [a, b, c, d] = wireControls(from, to).map((point) => toScreen(viewport, point)) as [Point, Point, Point, Point];
  return `M${round(a.x)},${round(a.y)} C${round(b.x)},${round(b.y)} ${round(c.x)},${round(c.y)} ${round(d.x)},${round(d.y)}`;
}

/** The part of the graph a panel of this size shows. */
export function visibleRect(viewport: GraphViewport, size: { readonly width: number; readonly height: number }): Rect {
  return { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, w: size.width / viewport.zoom, h: size.height / viewport.zoom };
}

/** Level of detail (ui-stack.md a.8): what a node still draws at this zoom. */
export type Lod = 'near' | 'mid' | 'far';
/** Below this zoom the labels of the ports and the status line are not drawn; a label of 11 px is under 6 px there. */
export const LOD_MID_ZOOM = 0.55;
/** Below this zoom the thumbnails and the titles are not drawn either: a thumbnail of 96 px is under 30 px there. */
export const LOD_FAR_ZOOM = 0.3;

export function lodOf(zoom: number): Lod {
  return zoom < LOD_FAR_ZOOM ? 'far' : zoom < LOD_MID_ZOOM ? 'mid' : 'near';
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.5;
