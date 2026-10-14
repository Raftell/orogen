// What the library does when it is asked to: add the selected node, open an example. The commands of index.ts
// and the components both call these, so a key, a menu item and a double-click do the same thing.

import { requestAddNode, type AppServices, type CommandContext } from '../../ui/index.ts';
import { EXAMPLES } from './example-files.ts';
import { exampleDoc } from './examples.ts';
import { libraryStore, typeOfRow } from './state.ts';

/** What the panel's component hands over while it is mounted: the shell's services, and its element. */
const mounted: { services: AppServices | null; element: HTMLElement | null } = { services: null, element: null };

export function bindPanel(services: AppServices | null): void {
  mounted.services = services;
  if (libraryStore.getState().mounted !== (services !== null)) libraryStore.setState({ mounted: services !== null });
}

export function bindElement(element: HTMLElement | null): void {
  mounted.element = element;
}

/** Whether the panel is the tab in front of its group: the dock takes the element of a hidden panel out of the document. */
export const panelShown = (): boolean => mounted.element?.isConnected === true;

/** Brings the panel's tab to the front, for a command that shows something in it. */
export function revealPanel(): void {
  mounted.services?.showPanel('library');
}

/** The node type the node list has selected, when the list is what the panel shows. */
export function selectedNodeType(): string | null {
  const { tab, active } = libraryStore.getState();
  return tab === 'nodes' ? typeOfRow(active) : null;
}

/** Asks the graph for a node of this type (runtime.md 8.7). The graph adds and selects it; the list of recent nodes follows the document. */
export function addNode(type: string): void {
  requestAddNode(window, type);
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * Opens an example as a new project that has no file, through the shell's project service (`openDocument`): it
 * asks what File > Open asks, about a build that runs and about unsaved changes, and the example opens when the
 * user goes on. Resolves true when the example is the project.
 */
export async function requestExample(ctx: CommandContext, id: string): Promise<boolean> {
  const example = EXAMPLES.find((candidate) => candidate.id === id);
  const { services } = mounted;
  if (!example || !services) return false;
  let parsed: ReturnType<typeof exampleDoc>;
  try {
    parsed = exampleDoc(example.text, ctx.registry);
  } catch (thrown) {
    services.notify({ level: 'error', message: `The example ${example.title} could not be opened`, detail: messageOf(thrown) });
    return false;
  }
  libraryStore.setState({ example: id });
  // The dialog of "Open Example…" stays while the shell asks: an answer of "Cancel" leaves the user where they chose.
  if (!await services.openDocument(parsed.doc)) return false;
  libraryStore.setState({ example: id, gallery: false });
  if (parsed.problems.length > 0) {
    const count = parsed.problems.length;
    services.notify({ level: 'warning', message: `${example.title} was opened with ${count} problem${count === 1 ? '' : 's'}`, detail: parsed.problems.map((problem) => problem.message).join('\n') });
  }
  return true;
}
