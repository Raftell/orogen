// The shell without its window (runtime.md 8.7 rule 3, 8.8): the command registry and the keymap in force, the
// project's life, the preferences, what the shell shows beside the panels (palette, dialogs, notices), and what
// it does when the engine or the main process speaks. Shell.tsx draws this; a window-free test drives it with
// stand-ins for the bridge and the engine. No DOM and no React.

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { DocProblem, EngineEvent, EngineSession, NodeRegistry } from '../../core/runtime.ts';
import type { PlatformApi, Preferences } from '../platform.ts';
import type { DocState } from '../state/doc-store.ts';
import type { EngineState } from '../state/engine-store.ts';
import type { UiState } from '../state/ui-store.ts';
import type { AppServices, CommandContext, Notice, PanelDef, PanelId } from '../ui/types.ts';
import { shellSource, type EditHost, type PaletteMode } from './app-commands.ts';
import {
  createCommandRegistry, createCommandRunner, panelSources, type CommandRegistry, type CommandRunner, type RegisteredCommand,
} from './commands.ts';
import { baseName, projectName } from './format.ts';
import { createKeymap, formatKey, type Keymap, type KeyPlatform } from './keys.ts';
import { buildMenus, type MenuModel } from './menu.ts';
import { createProjectService, type ProjectService, type UnsavedAnswer } from './project.ts';

export type ShellDialog =
  | { readonly kind: 'unsaved'; readonly project: string }
  | { readonly kind: 'preferences' }
  | { readonly kind: 'errors' }
  | { readonly kind: 'gallery' }
  | { readonly kind: 'problems'; readonly file: string; readonly problems: readonly DocProblem[] }
  | { readonly kind: 'failure'; readonly title: string; readonly message: string };

export interface ShownNotice extends Notice {
  readonly id: number;
  /** How often the same message arrived in a row. */
  readonly count: number;
}

export interface LogEntry extends Notice {
  /** Date.now() when it arrived. */
  readonly time: number;
}

export interface ShellState {
  readonly preferences: Preferences;
  readonly paused: boolean;
  readonly palette: PaletteMode | null;
  readonly dialog: ShellDialog | null;
  readonly notices: readonly ShownNotice[];
  /** Every notice, kept for the list of errors; the oldest are dropped. */
  readonly log: readonly LogEntry[];
  /** Raised by one for every "reset layout": the dock lays itself out anew from the panels' placement. */
  readonly layoutResets: number;
}

/** Notices shown at once, and entries the log keeps. */
export const NOTICES_SHOWN = 5;
export const LOG_KEPT = 200;

/** What only a window can do. */
export interface ShellHost {
  readonly edit: EditHost;
  closeWindow(): void;
  /**
   * Ends the engine worker, whether it still answers or not, and gives the engine client another in its place
   * (`EngineClient.connect`, 8.5). The page alone can make a worker.
   */
  restartEngine(): void;
}

export interface ShellOptions {
  readonly doc: StoreApi<DocState>;
  readonly engineState: StoreApi<EngineState>;
  readonly ui: StoreApi<UiState>;
  readonly engine: EngineSession;
  readonly platform: PlatformApi;
  readonly registry: NodeRegistry;
  readonly panels: readonly PanelDef[];
  /** As read from the bridge before the engine client was made. */
  readonly preferences: Preferences;
  readonly host: ShellHost;
  readonly keyPlatform?: KeyPlatform;
  readonly now?: () => number;
}

export interface Shell {
  readonly state: StoreApi<ShellState>;
  readonly ctx: CommandContext;
  readonly panels: readonly PanelDef[];
  readonly commands: CommandRegistry;
  readonly runner: CommandRunner;
  readonly project: ProjectService;
  /** What panel components get through `useApp()`. */
  readonly services: AppServices;
  readonly keyPlatform: KeyPlatform;
  /** The bindings in force: the defaults with Preferences.keymap applied. The same object until the keymap changes. */
  keymap(): Keymap;
  menus(): MenuModel[];
  notify(notice: Notice): void;
  dismissNotice(id: number): void;
  /** Replaces the members the patch names, here and in the preferences file; `gpu` also in the engine. */
  setPreferences(patch: Partial<Preferences>): void;
  /** Takes the preferences as they were read from the file at start-up: nothing is written back. */
  adoptPreferences(preferences: Preferences): void;
  setPaused(paused: boolean): void;
  openPalette(mode: PaletteMode): void;
  closePalette(): void;
  showDialog(dialog: ShellDialog): void;
  closeDialog(): void;
  /** Answers the question the dialog of kind 'unsaved' asks. */
  answerUnsaved(answer: UnsavedAnswer): void;
  resetLayout(): void;
  /** The dock, while it is there: what `AppServices.showPanel` reaches. Null when it is gone. */
  attachDock(dock: { show(id: PanelId): void } | null): void;
  /** Starts listening to the engine and the main process. Returns the function that stops it. */
  connect(): () => void;
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** Throws RegistrationError when the commands, keys or menu entries of the panels and the shell contradict each other (8.8 rule 4). */
export function createShell(options: ShellOptions): Shell {
  const { doc, engineState, ui, engine, platform, panels, host } = options;
  const keyPlatform = options.keyPlatform ?? 'other';
  const now = options.now ?? (() => Date.now());

  const state = createStore<ShellState>()(() => ({
    preferences: options.preferences,
    paused: false,
    palette: null,
    dialog: null,
    notices: [],
    log: [],
    layoutResets: 0,
  }));

  let noticeId = 0;
  function notify(notice: Notice): void {
    const { notices, log } = state.getState();
    const last = notices[notices.length - 1];
    const repeated = last !== undefined && last.level === notice.level && last.message === notice.message;
    const shown: ShownNotice = repeated ? { ...last, count: last.count + 1 } : { ...notice, id: ++noticeId, count: 1 };
    state.setState({
      notices: [...(repeated ? notices.slice(0, -1) : notices), shown].slice(-NOTICES_SHOWN),
      log: [...log, { ...notice, time: now() }].slice(-LOG_KEPT),
    });
  }

  // ---- the question about unsaved changes ----
  let unsavedAnswer: ((answer: UnsavedAnswer) => void) | null = null;
  function answerUnsaved(answer: UnsavedAnswer): void {
    const resolve = unsavedAnswer;
    unsavedAnswer = null;
    if (state.getState().dialog?.kind === 'unsaved') state.setState({ dialog: null });
    resolve?.(answer);
  }
  function askUnsaved(): Promise<UnsavedAnswer> {
    // A question that is still open is withdrawn: what it stood before does not happen.
    answerUnsaved('cancel');
    return new Promise<UnsavedAnswer>((resolve) => {
      unsavedAnswer = resolve;
      state.setState({ dialog: { kind: 'unsaved', project: projectName(doc.getState().path) }, palette: null });
    });
  }
  function showDialog(dialog: ShellDialog): void {
    if (dialog.kind !== 'unsaved') answerUnsaved('cancel');
    state.setState({ dialog, palette: null });
  }

  function setPreferences(patch: Partial<Preferences>): void {
    state.setState({ preferences: { ...state.getState().preferences, ...patch } });
    if (patch.gpu) engine.setPreferences(patch.gpu);
    platform.setPreferences(patch).catch((thrown: unknown) => {
      notify({ level: 'error', message: 'The preferences could not be saved', detail: messageOf(thrown) });
    });
  }

  const project = createProjectService({
    doc,
    registry: options.registry,
    platform,
    recent: () => state.getState().preferences.recent,
    setRecent: (recent) => setPreferences({ recent }),
    askUnsaved,
    notify,
    showProblems: (file, problems) => showDialog({ kind: 'problems', file, problems }),
    showFailure: (title, message) => showDialog({ kind: 'failure', title, message }),
  });

  function setPaused(paused: boolean): void {
    if (state.getState().paused === paused) return;
    state.setState({ paused });
    engine.setPaused(paused);
  }

  // The registry needs the shell's commands, and those need the registry to ask what a panel declares.
  let commands!: CommandRegistry;
  commands = createCommandRegistry([
    shellSource({
      project,
      edit: host.edit,
      testMode: platform.testMode,
      hasCommand: (id) => commands.get(id) !== undefined,
      commandEnabled: (id) => runner.enabled(id),
      recent: () => state.getState().preferences.recent,
      paused: () => state.getState().paused,
      setPaused,
      openPalette: (mode) => state.setState({ palette: mode }),
      showDialog: (kind) => showDialog({ kind }),
      resetLayout: () => state.setState({ layoutResets: state.getState().layoutResets + 1 }),
      closeWindow: () => host.closeWindow(),
      restartEngine() {
        host.restartEngine();
        notify({ level: 'info', message: 'The engine was restarted' });
      },
    }),
    ...panelSources(panels),
  ]);

  function failed(command: RegisteredCommand, thrown: unknown): void {
    console.error(`[orogen] the command "${command.def.id}" failed`, thrown);
    notify({ level: 'error', message: `${command.def.title.replace(/…$/, '')} failed: ${messageOf(thrown)}`, detail: thrown instanceof Error ? thrown.stack : undefined });
  }

  let ctx!: CommandContext;
  const runner = createCommandRunner(commands, () => ctx, failed);
  ctx = { doc, engineState, ui, engine, platform, registry: options.registry, run: (id) => runner.run(id) };

  let keymap: { readonly from: Preferences['keymap']; readonly value: Keymap } | null = null;
  function currentKeymap(): Keymap {
    const from = state.getState().preferences.keymap;
    if (keymap?.from !== from) keymap = { from, value: createKeymap(commands.bindings, commands.keymapCommands, from, keyPlatform) };
    return keymap.value;
  }

  let dock: { show(id: PanelId): void } | null = null;
  const services: AppServices = {
    ctx,
    showPanel(id) {
      dock?.show(id);
    },
    keyLabel(commandId) {
      const key = currentKeymap().keysOf(commandId)[0];
      return key === undefined ? null : formatKey(key, keyPlatform);
    },
    commandTitle: (commandId) => commands.get(commandId)?.def.title ?? null,
    enabled: (commandId) => runner.enabled(commandId),
    notify,
  };

  function onEngineEvent(event: EngineEvent): void {
    if (event.type === 'engine-error') {
      notify({ level: event.fatal ? 'error' : 'warning', message: event.fatal ? `The engine stopped: ${event.message}` : event.message });
    } else if (event.type === 'device-lost') {
      notify({ level: 'warning', message: 'The graphics device was lost and is being recovered', detail: event.message });
    } else if (event.type === 'build-result') {
      const { result } = event;
      const errors = result.problems.filter((problem) => problem.severity === 'error');
      const detail = result.problems.map((problem) => `${problem.severity}: ${problem.message}`).join('\n') || undefined;
      if (result.status === 'ok') {
        notify({ level: 'info', message: `Build finished: ${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.outDir ? ` in ${baseName(result.outDir)}` : ''}`, detail });
      } else if (result.status === 'aborted') {
        notify({ level: 'info', message: 'Build cancelled' });
      } else if (result.status === 'device-lost') {
        notify({ level: 'error', message: 'Build stopped: the graphics device was lost', detail });
      } else {
        notify({ level: 'error', message: `Build failed: ${errors[0]?.message ?? 'a node could not be evaluated'}`, detail });
      }
    }
  }

  return {
    state,
    ctx,
    panels,
    commands,
    runner,
    project,
    services,
    keyPlatform,
    keymap: currentKeymap,
    menus: () => buildMenus(commands, currentKeymap()),
    notify,
    dismissNotice: (id) => state.setState({ notices: state.getState().notices.filter((notice) => notice.id !== id) }),
    setPreferences,
    adoptPreferences(preferences) {
      state.setState({ preferences });
      engine.setPreferences(preferences.gpu);
    },
    setPaused,
    openPalette: (mode) => state.setState({ palette: mode }),
    closePalette: () => state.setState({ palette: null }),
    showDialog,
    closeDialog() {
      if (state.getState().dialog?.kind === 'unsaved') answerUnsaved('cancel');
      else state.setState({ dialog: null });
    },
    answerUnsaved,
    resetLayout: () => runner.run('view.resetLayout'),
    attachDock(handle) {
      dock = handle;
    },

    connect() {
      const stops = [
        engine.subscribe(onEngineEvent),
        // 8.2 rule 5: the main process keeps the machine awake while a build runs.
        engineState.subscribe((next, previous) => {
          if (next.build.running !== previous.build.running) platform.setBuildActive(next.build.running);
        }),
        platform.onMenuCommand((commandId) => {
          // The native menu is the main process's list: it may name a command this build of the page lacks.
          if (commands.get(commandId)) runner.run(commandId);
          else console.warn(`[orogen] the menu sent "${commandId}", which is no command`);
        }),
        platform.onCloseRequested(() => {
          project.mayDiscard().then(
            (go) => { if (go) platform.confirmClose(); },
            (thrown: unknown) => {
              console.error('[orogen] the window could not ask about unsaved changes', thrown);
              platform.confirmClose();
            },
          );
        }),
      ];
      return () => { for (const stop of stops) stop(); };
    },
  };
}
