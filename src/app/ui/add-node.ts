// The two agreements between the library and the graph (runtime.md 8.7 rule 8): how a node is dragged out of
// the library, and how "add this node now" is asked for from outside the graph. Neither panel imports the other,
// so both import this. The graph owns what happens next: it adds the node at the drop position, or at the centre
// of what it shows, in a transaction of its own. No React.

/** The type of the drag's data: the node type id as text. */
export const NODE_DRAG_TYPE = 'application/x-orogen-node';
/** The CustomEvent on `window` whose `detail` is `{ type }`. */
export const ADD_NODE_EVENT = 'orogen:add-node';

export interface AddNodeDetail { readonly type: string }

/** Fills the data of a drag that starts on a node of the library: `data` is the `dataTransfer` of its `dragstart`. */
export function startNodeDrag(data: { setData(format: string, value: string): void; effectAllowed: string }, type: string): void {
  data.setData(NODE_DRAG_TYPE, type);
  // What a drop outside the application receives: the type, readable.
  data.setData('text/plain', type);
  data.effectAllowed = 'copy';
}

/** Asks the graph to add a node of this type at the centre of its visible area and to select it. */
export function requestAddNode(target: { dispatchEvent(event: Event): boolean }, type: string): void {
  target.dispatchEvent(new CustomEvent<AddNodeDetail>(ADD_NODE_EVENT, { detail: { type } }));
}

/** The node type an `orogen:add-node` event asks for; null for an event that names none. */
export function addNodeType(event: Event): string | null {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  const type = typeof detail === 'object' && detail !== null ? (detail as { readonly type?: unknown }).type : undefined;
  return typeof type === 'string' && type !== '' ? type : null;
}
