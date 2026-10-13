// What is said of a node in more than one place: the name of a port, and the sentence of a node's error. The
// graph, the inspector, the viewport and the status bar say the same words of the same node, so the words are
// made here. No DOM and no React.

import type { PortDef } from '../../core/api.ts';
import type { NodeError, NodeRegistry } from '../../core/runtime.ts';

/** engine.md 4.2: a port's display name is its label, else its name with a capital. */
export function portLabel(port: Pick<PortDef, 'name' | 'label'>): string {
  return port.label ?? port.name.charAt(0).toUpperCase() + port.name.slice(1);
}

/**
 * Whether an error says that the node itself is at fault. A node that lacks a wire is unfinished, not failed:
 * every node is in that state between being added and being connected, and no panel draws it as an error.
 */
export function isFailure(error: Pick<NodeError, 'kind'>): boolean {
  return error.kind !== 'missing-input';
}

/**
 * The sentence of a node's error as a person reads it. The engine names a missing input by the port's own name
 * (`missing input "in"`, runtime.md 5.3); here it is named by its label, in the words the graph uses.
 */
export function nodeErrorText(error: Pick<NodeError, 'kind' | 'message' | 'nodeType'>, registry: Pick<NodeRegistry, 'get'>): string {
  if (error.kind !== 'missing-input') return error.message;
  const name = /"([^"]*)"/.exec(error.message)?.[1];
  if (name === undefined) return 'Missing input';
  const port = registry.get(error.nodeType)?.inputs.find((candidate) => candidate.name === name);
  return `Missing input: ${port ? portLabel(port) : name}`;
}
