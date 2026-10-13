// What the library does when it is asked to: add the selected node, open an example. The commands of index.ts
// and the components both call these, so a key, a menu item and a double-click do the same thing.

import type { AppServices, CommandContext } from '../../ui/index.ts';
import { requestAddNode } from './add-node.ts';
import { EXAMPLES } from './example-files.ts';
import { exampleDoc } from './examples.ts';
import { libraryStore, typeOfRow, type UnsavedAnswer } from './state.ts';

/** What the panel's component hands over while it is mounted: the notification area, and its element. */
const mounted: { services: AppServices | null; element: HTMLElement | null } = { services: null, element: null };

/** Ends the wait of the answer "Save" for the project to be saved. */
let stopWaiting: (() => void) | null = null;
function endWait(): void {
  stopWaiting?.();
  stopWaiting = null;
}

export function bindPanel(services: AppServices | null): void {
  mounted.services = services;
  if (services === null) endWait();
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
 * Opens an example as a new project that has no file. The project that was open is replaced without a
 * question: `requestExample` asks first.
 */
export function openExample(ctx: CommandContext, id: string): boolean {
  const example = EXAMPLES.find((candidate) => candidate.id === id);
  if (!example) return false;
  const { services } = mounted;
  let parsed: ReturnType<typeof exampleDoc>;
  try {
    parsed = exampleDoc(example.text, ctx.registry);
  } catch (thrown) {
    services?.notify({ level: 'error', message: `The example ${example.title} could not be opened`, detail: messageOf(thrown) });
    return false;
  }
  endWait();
  ctx.doc.getState().load(parsed.doc, null);
  libraryStore.setState({ example: id, gallery: false, confirm: null });
  if (parsed.problems.length > 0) {
    const count = parsed.problems.length;
    services?.notify({ level: 'warning', message: `${example.title} was opened with ${count} problem${count === 1 ? '' : 's'}`, detail: parsed.problems.map((problem) => problem.message).join('\n') });
  }
  return true;
}

/** Opens an example, after a question when the project that is open has unsaved changes. */
export function requestExample(ctx: CommandContext, id: string): void {
  if (!EXAMPLES.some((candidate) => candidate.id === id)) return;
  if (ctx.doc.getState().unsaved) libraryStore.setState({ example: id, confirm: id });
  else openExample(ctx, id);
}

/**
 * The answer to the question about the unsaved changes, for the example that waits (`confirm`). "Save" runs the
 * shell's own command, which may ask for a file, be cancelled there, or fail: the example opens when the
 * project has nothing unsaved any more, and until then the question stays open to be answered again.
 */
export function answerUnsaved(ctx: CommandContext, answer: UnsavedAnswer): void {
  const id = libraryStore.getState().confirm;
  if (id === null) return;
  if (answer !== 'save') {
    endWait();
    if (answer === 'discard') openExample(ctx, id);
    else libraryStore.setState({ confirm: null });
    return;
  }
  if (stopWaiting === null) {
    stopWaiting = ctx.doc.subscribe((state) => {
      if (state.unsaved) return;
      endWait();
      // Not from inside the store's notification: whoever saved has not finished with the project it saved.
      setTimeout(() => {
        if (libraryStore.getState().confirm === id && !ctx.doc.getState().unsaved) openExample(ctx, id);
      }, 0);
    });
  }
  ctx.run('file.save');
}
