// The two agreements between the library and the graph (runtime.md 8.7): how a node is dragged out of the
// library, and how the library asks for a node to be added now. The graph owns what happens next: it adds the
// node at the drop position, or at the centre of what it shows, in a transaction of its own. No React.

/** The type of the drag's data: the node type id as text. */
export const NODE_DRAG_TYPE = 'application/x-orogen-node';
/** The CustomEvent on `window` whose `detail` is `{ type }`. */
export const ADD_NODE_EVENT = 'orogen:add-node';

export interface AddNodeDetail { readonly type: string }

/** Fills the data of a drag that starts on a node of the library. */
export function startNodeDrag(data: Pick<DataTransfer, 'setData'> & { effectAllowed: string }, type: string): void {
  data.setData(NODE_DRAG_TYPE, type);
  // What a drop outside the application receives: the type, readable.
  data.setData('text/plain', type);
  data.effectAllowed = 'copy';
}

/** Asks the graph to add a node of this type at the centre of its visible area and to select it. */
export function requestAddNode(target: Pick<EventTarget, 'dispatchEvent'>, type: string): void {
  target.dispatchEvent(new CustomEvent<AddNodeDetail>(ADD_NODE_EVENT, { detail: { type } }));
}
