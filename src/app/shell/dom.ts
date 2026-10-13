// What the shell does with the document's keyboard and focus (runtime.md 8.8 rule 3): the one key listener,
// which panel has the focus, and where the edit commands go. keys.ts and app-commands.ts hold the rules; this
// file reads the DOM for them.

import type { StoreApi } from 'zustand/vanilla';

import type { UiState } from '../state/ui-store.ts';
import type { PanelId } from '../ui/types.ts';
import type { EditAction, EditHost } from './app-commands.ts';
import { PANEL_IDS } from './commands.ts';
import { keyOf } from './keys.ts';
import type { Shell, ShellHost } from './shell.ts';

/** Elements that open above the page (menus, lists, popovers, dialogs, the palette) carry this attribute. */
const CHROME = '[data-chrome]';
/** The shell's own bars: the focus in one of them is not the focus of the content. */
const BARS = '[data-shell]';
/** The element of a docked panel carries its id here. */
const PANEL = '[data-panel]';

const TEXT_INPUTS: ReadonlySet<string> = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

/** An element that takes typed text, or one that uses plain keys for itself. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type);
  if (target.isContentEditable) return true;
  // A number field that has the focus takes digits and arrows; a list takes letters to find an item.
  const role = target.getAttribute('role');
  return role === 'spinbutton' || role === 'combobox' || role === 'listbox';
}

function panelOf(target: EventTarget | null): PanelId | null {
  if (!(target instanceof Element)) return null;
  const id = target.closest(PANEL)?.getAttribute('data-panel');
  return PANEL_IDS.find((panel) => panel === id) ?? null;
}

const inChrome = (target: EventTarget | null): boolean => target instanceof Element && target.closest(CHROME) !== null;

/** Commands that go on while their key is held. */
const REPEATING: ReadonlySet<string> = new Set(['edit.undo', 'edit.redo']);

export interface ShellDom extends Pick<ShellHost, 'edit' | 'closeWindow'> {
  /** Attaches the listeners once the shell exists. Returns the function that removes them. */
  install(shell: Shell): () => void;
}

/** `ui` is where the focused panel is kept (8.5). */
export function createShellDom(ui: StoreApi<UiState>): ShellDom {
  /** The element that last had the focus outside menus, popups and the palette. */
  let content: Element | null = null;

  const field = (): HTMLElement | null => (content instanceof HTMLElement && content.isConnected && isTextField(content) && content.getAttribute('role') === null ? content : null);

  function focusPanel(target: EventTarget | null): void {
    const panel = panelOf(target);
    if (panel !== null && ui.getState().focusedPanel !== panel) ui.setState({ focusedPanel: panel });
  }

  const edit: EditHost = {
    textField: () => field() !== null,

    inTextField(action: EditAction) {
      const element = field();
      if (!element) return;
      element.focus();
      if (action === 'selectAll') {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
        else document.execCommand('selectAll');
      } else if (action === 'paste') {
        // Where the page may not paste by itself, the text is read and typed in.
        if (document.execCommand('paste')) return;
        navigator.clipboard.readText().then((text) => {
          if (field() !== element) return;
          element.focus();
          document.execCommand('insertText', false, text);
        }).catch(() => undefined);
      } else {
        document.execCommand(action);
      }
    },

    clipboardEvent(action, panel) {
      const host = document.querySelector(`[data-panel="${panel}"]`);
      if (!host) return;
      const target = content !== null && content.isConnected && host.contains(content) ? content : host;
      const send = (text: string | null): void => {
        const data = new DataTransfer();
        if (text !== null) data.setData('text/plain', text);
        const event = new ClipboardEvent(action, { bubbles: true, cancelable: true, clipboardData: data });
        target.dispatchEvent(event);
        // A panel that took the event says so by preventing its default; what it put there as text is the clipboard's.
        const taken = event.defaultPrevented && action !== 'paste' ? data.getData('text/plain') : '';
        if (taken !== '') navigator.clipboard.writeText(taken).catch(() => undefined);
      };
      if (action !== 'paste') send(null);
      else navigator.clipboard.readText().then(send, () => send(''));
    },
  };

  return {
    edit,
    closeWindow: () => window.close(),

    install(shell) {
      function onKeyDown(event: KeyboardEvent): void {
        if (event.isComposing || event.defaultPrevented) return;
        const { dialog, palette } = shell.state.getState();
        // A dialog, the palette or an open menu has the keyboard.
        if (dialog !== null || palette !== null || inChrome(event.target)) return;
        const key = keyOf(event, shell.keyPlatform);
        if (key === null) return;
        const command = shell.keymap().resolve(key, { focusedPanel: ui.getState().focusedPanel, textField: isTextField(event.target) });
        if (command === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat && !REPEATING.has(command)) return;
        shell.runner.run(command);
      }
      function onFocusIn(event: FocusEvent): void {
        if (inChrome(event.target) || !(event.target instanceof Element) || event.target.closest(BARS) !== null) return;
        content = event.target;
        focusPanel(event.target);
      }
      const onPointerDown = (event: PointerEvent): void => focusPanel(event.target);

      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
      };
    },
  };
}
