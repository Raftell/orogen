import { jsonEqual, own, type GraphDoc, type PortRef, type ViewBinding } from './doc.ts';
import type { NodeRegistry } from './registry.ts';
import { outputKind } from './validate.ts';

/**
 * The view after the user selects an output; selecting a node selects its outputs[0] (runtime.md 7.4).
 * Returns the current view object itself when the selection changes nothing.
 */
export function viewAfterSelect(doc: GraphDoc, registry: NodeRegistry, ref: PortRef): ViewBinding | undefined {
  const current = doc.ui.view;
  if (current?.locked) return current;
  const kind = outputKind(doc, registry, ref);
  if (kind === null) return current;
  const node = own(doc.nodes, ref.node)!;
  const port = registry.get(node.type)!.outputs.find((p) => p.name === ref.port)!;
  const selected: PortRef = { node: ref.node, port: ref.port };

  let next: ViewBinding;
  // A `sameAs` output carries no role; as a field it is a height, the default role.
  const role = port.type === 'field' ? port.role ?? 'height' : 'height';
  if (kind === 'field' && role === 'height') {
    next = { height: selected };
  } else {
    const as = kind === 'color' ? 'color' : role === 'mask' ? 'mask' : 'heat';
    next = { ...(current?.height ? { height: current.height } : {}), overlay: { ref: selected, as, opacity: 1 } };
  }
  return current && jsonEqual(current, next) ? current : next;
}
