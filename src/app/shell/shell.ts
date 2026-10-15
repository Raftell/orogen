// The shell without its window (runtime.md 8.7 rule 3, 8.8): the command registry and the keymap in force, the
// project's life, the preferences, what the shell shows beside the panels (palette, dialogs, notices), and what
// it does when the engine or the main process speaks. Shell.tsx draws this; a window-free test drives it with
// stand-ins for the bridge and the engine. No DOM and no React.

import { createStore, type StoreApi } from 'zustand/vanilla';

import { foundNoAdapter, type DocProblem, type EngineEvent, type EngineSession, type NodeRegistry } from '../../core/runtime.ts';
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
import { createProjectService, type ChangedAnswer, type Leaving, type ProjectService, type UnsavedAnswer } from './project.ts';

export type ShellDialog =
  | { readonly kind: 'unsaved'; readonly project: string }
  | { readonly kind: 'building'; readonly leaving: Leaving }
  /** The project file was changed by another program since this application read or wrote it. */
  | { readonly kind: 'changed'; readonly file: string }
  /** A run before this one kept a project with unsaved changes: `project` is its name, `savedAt` when it was kept. */
  | { readonly kind: 'recover'; readonly project: string; readonly savedAt: number }
  /** A page of the user documentation, shown in the application: its name in docs/user, and a heading or an anchor of it to show first. */
  | { readonly kind: 'help'; readonly page: string; readonly anchor?: string }
  | { readonly kind: 'about' }
  | { readonly kind: 'preferences' }
  | { readonly kind: 'errors' }
  | { readonly kind: 'gallery' }
  | { readonly kind: 'problems'; readonly file: string; readonly problems: readonly DocProblem[] }
  | { readonly kind: 'failure'; readonly title: string; readonly message: string }
  /** The engine found no graphics device at all: why, what helps, and, where the system has it, software rendering (8.7 rule 16). */
  | { readonly kind: 'noDevice' };

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
/** How long a build that was told to stop is waited for before the project is left all the same. */
export const BUILD_STOP_BACKSTOP_MS = 15_000;

export const DEVICE_LOST_NOTICE = 'The graphics device was lost and is being recovered';
export const DEVICE_BACK_NOTICE = 'The graphics device is back';
/** Said when the engine has a software adapter after it had the graphics card: everything still works, a hundred times slower. */
export const SOFTWARE_ADAPTER_NOTICE = 'The engine is now on a software adapter, without the graphics card: previews and builds are many times slower. Restart Orogen to get the graphics card back';
/** The words of 8.7 rule 16: what WebGPU needs, what helps, and what software rendering is for where the system has it. */
export const NO_DEVICE_TEXT = {
  title: 'Orogen found no graphics device it can use',
  why: 'Orogen computes and draws terrains on the graphics card, through WebGPU, and the system offered it none.',
  needs: 'On Windows, WebGPU needs a graphics card with DirectX 12 and a current driver from its maker (NVIDIA, AMD or Intel). A remote desktop session or a virtual machine often has none. Install or update the driver, then choose Retry.',
  software: 'Orogen can also restart with software rendering: the processor does the graphics card\'s work, many times slower. It is for opening and checking a project, not for builds. It lasts until Orogen is closed; the next start uses the graphics card again.',
  onSoftware: 'This run already uses software rendering, and no software adapter was offered either.',
  unoffered: 'On Windows Orogen cannot work without the graphics card: there is no software rendering to fall back on, because Chromium, which Orogen runs in, gives WebGPU no software adapter there.',
  /** The words of the link to NO_DEVICE_HELP; the sentence goes on with `helpAfter`. */
  help: 'Troubleshooting the graphics device',
  helpAfter: ', in the User Guide, lists what to check and what to send when it does not help.',
} as const;

/** Where the User Guide says what to check when there is no graphics device: a page of docs/user and a heading of it. */
export const NO_DEVICE_HELP = { page: 'application.md', anchor: 'troubleshooting-the-graphics-device' } as const;

/** Said when the main process has taken the request to restart with software rendering (8.7 rule 16). */
export const SOFTWARE_RESTART_NOTICE = 'Orogen is restarting with software rendering';

/**
 * Whether Restart with Software Rendering is offered on this system (8.7 rule 16). `system` is navigator.platform
 * as the page has it ("Win32" on every Windows, "Linux x86_64") or Node's process.platform ("win32", "linux"):
 * both name Windows with the letters "win" first. Not on Windows: there Electron 44 gave WebGPU no adapter in
 * software mode, on a runner without a GPU and on a machine with a working RTX 3080 (ARCHITECTURE.md section 2).
 */
export const offersSoftwareRendering = (system: string): boolean => !/^win/i.test(system);

/**
 * What the explanation of 8.7 rule 16 says of software rendering, and whether it offers the restart: `offered`
 * is offersSoftwareRendering of the system, `running` whether this run already has it (PlatformApi.softwareRendering).
 */
export function softwareRenderingChoice(offered: boolean, running: boolean): { readonly restart: boolean; readonly text: string } {
  if (!offered) return { restart: false, text: NO_DEVICE_TEXT.unoffered };
  return running ? { restart: false, text: NO_DEVICE_TEXT.onSoftware } : { restart: true, text: NO_DEVICE_TEXT.software };
}

/**
 * Whether the engine stopped because the platform offers it no graphics device at all, and never had one: the case
 * the shell explains, and offers software rendering for where the system has it (8.7 rule 16). A device that was
 * found and failed, and a recovery that failed after a device was ready, are others: Retry is for them.
 */
export const noGraphicsDevice = (device: EngineState['device']): boolean => device.state === 'failed' && device.caps === null && foundNoAdapter(device.message);

/** What the shell asks of the dock while it is there. */
export interface DockAccess {
  /** Brings the panel's tab to the front of its group and gives the panel the focus. */
  show(id: PanelId): void;
  /** Whether the panel is in view: the tab in front of its group. */
  visible(id: PanelId): boolean;
}

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
  /** The system the page runs on, as offersSoftwareRendering reads it; default navigator.platform. */
  readonly system?: string;
  readonly now?: () => number;
  /** Default BUILD_STOP_BACKSTOP_MS. */
  readonly buildStopBackstopMs?: number;
  /** How long an unsaved project rests before it is kept for recovery; default RECOVERY_DELAY_MS of project.ts. */
  readonly recoveryDelayMs?: number;
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
  /** Whether this system has Restart with Software Rendering (offersSoftwareRendering): not on Windows. */
  readonly softwareRenderingOffered: boolean;
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
  /** Answers the question the dialog of kind 'building' asks: true stops the build and goes on, false keeps the project. */
  answerBuilding(stop: boolean): void;
  /** Answers the question the dialog of kind 'changed' asks. */
  answerChanged(answer: ChangedAnswer): void;
  /** Answers the question the dialog of kind 'recover' asks: true restores what was kept, false gives it up. */
  answerRecover(restore: boolean): void;
  /**
   * The user chose software rendering (8.7 rule 16): the questions of leaving the project are asked, and when the
   * project may be left the main process ends this run and starts another that opens it. Resolves with whether it was asked to.
   * Where the system does not offer it (`softwareRenderingOffered`), nothing is asked and it resolves false.
   */
  restartWithSoftwareRendering(): Promise<boolean>;
  resetLayout(): void;
  /** The dock, while it is there: what `AppServices.showPanel` reaches. Null when it is gone. */
  attachDock(dock: DockAccess | null): void;
  /** The dock tells that a panel came into view: a notice that repeats what the panel shows leaves (`Notice.panel`). */
  panelShown(id: PanelId): void;
  /** Starts listening to the engine and the main process. Returns the function that stops it. */
  connect(): () => void;
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/** Throws RegistrationError when the commands, keys or menu entries of the panels and the shell contradict each other (8.8 rule 4). */
export function createShell(options: ShellOptions): Shell {
  const { doc, engineState, ui, engine, platform, panels, host } = options;
  const keyPlatform = options.keyPlatform ?? 'other';
  const softwareRenderingOffered = offersSoftwareRendering(options.system ?? globalThis.navigator.platform);
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

  let dock: DockAccess | null = null;
  let noticeId = 0;
  /** Shows the notice and returns its id; null for one that is only logged, because its panel is in view. */
  function notify(notice: Notice): number | null {
    const { notices, log } = state.getState();
    const entry = [...log, { ...notice, time: now() }].slice(-LOG_KEPT);
    // What a panel shows in its own place is said here for whoever cannot see that panel, and once (`Notice.panel`).
    const others = notice.panel === undefined ? notices : notices.filter((held) => held.panel !== notice.panel);
    if (notice.panel !== undefined && dock?.visible(notice.panel) === true) {
      state.setState({ notices: others.length === notices.length ? notices : others, log: entry });
      return null;
    }
    const last = others[others.length - 1];
    const repeated = last !== undefined && last.level === notice.level && last.message === notice.message;
    const shown: ShownNotice = repeated ? { ...last, count: last.count + 1 } : { ...notice, id: ++noticeId, count: 1 };
    state.setState({ notices: [...(repeated ? others.slice(0, -1) : others), shown].slice(-NOTICES_SHOWN), log: entry });
    return shown.id;
  }
  function dismissNotice(id: number | null): void {
    const { notices } = state.getState();
    if (id !== null && notices.some((notice) => notice.id === id)) state.setState({ notices: notices.filter((notice) => notice.id !== id) });
  }
  function panelShown(id: PanelId): void {
    const { notices } = state.getState();
    if (notices.some((notice) => notice.panel === id)) state.setState({ notices: notices.filter((notice) => notice.panel !== id) });
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
  // ---- the question about a build that runs ----
  let buildingAnswer: ((stop: boolean) => void) | null = null;
  function answerBuilding(stop: boolean): void {
    const resolve = buildingAnswer;
    buildingAnswer = null;
    if (state.getState().dialog?.kind === 'building') state.setState({ dialog: null });
    resolve?.(stop);
  }
  function askBuilding(leaving: Leaving): Promise<boolean> {
    answerUnsaved('cancel');
    answerBuilding(false);
    return new Promise<boolean>((resolve) => {
      // A build that ends while the question stands has answered it: there is nothing left to stop.
      const stop = engineState.subscribe((next) => {
        if (!next.build.running && buildingAnswer !== null) answerBuilding(true);
      });
      buildingAnswer = (answer) => {
        stop();
        resolve(answer);
      };
      state.setState({ dialog: { kind: 'building', leaving }, palette: null });
    });
  }
  /** Cancels the build; resolves when it has ended, or after the backstop: a hung engine keeps nobody from their project. */
  function stopBuild(): Promise<void> {
    if (!engineState.getState().build.running) return Promise.resolve();
    engine.cancelBuild();
    return new Promise<void>((resolve) => {
      let stop: () => void = () => undefined;
      const done = (): void => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, options.buildStopBackstopMs ?? BUILD_STOP_BACKSTOP_MS);
      stop = engineState.subscribe((next) => {
        if (!next.build.running) done();
      });
      if (!engineState.getState().build.running) done();
    });
  }

  // ---- the question about a file that another program changed ----
  let changedAnswer: ((answer: ChangedAnswer) => void) | null = null;
  function answerChanged(answer: ChangedAnswer): void {
    const resolve = changedAnswer;
    changedAnswer = null;
    if (state.getState().dialog?.kind === 'changed') state.setState({ dialog: null });
    resolve?.(answer);
  }
  function askChanged(file: string): Promise<ChangedAnswer> {
    answerChanged('cancel');
    return new Promise<ChangedAnswer>((resolve) => {
      changedAnswer = resolve;
      state.setState({ dialog: { kind: 'changed', file }, palette: null });
    });
  }
  // ---- the question about what a run before kept ----
  let recoverAnswer: ((restore: boolean) => void) | null = null;
  function answerRecover(restore: boolean): void {
    const resolve = recoverAnswer;
    recoverAnswer = null;
    if (state.getState().dialog?.kind === 'recover') state.setState({ dialog: null });
    resolve?.(restore);
  }
  function askRecover(kept: { readonly path: string | null; readonly savedAt: number }): Promise<boolean> {
    answerRecover(false);
    // The project the application started with may have been opened with problems: its list waits behind this
    // question, and is shown again when the project stays.
    const behind = state.getState().dialog;
    return new Promise<boolean>((resolve) => {
      recoverAnswer = (restore) => {
        if (!restore && behind?.kind === 'problems' && state.getState().dialog === null) state.setState({ dialog: behind });
        resolve(restore);
      };
      state.setState({ dialog: { kind: 'recover', project: projectName(kept.path), savedAt: kept.savedAt }, palette: null });
    });
  }

  function showDialog(dialog: ShellDialog): void {
    if (dialog.kind !== 'unsaved') answerUnsaved('cancel');
    if (dialog.kind !== 'building') answerBuilding(false);
    if (dialog.kind !== 'changed') answerChanged('cancel');
    // What was kept is not given up because another dialog came: it is asked about again at the next start.
    if (dialog.kind !== 'recover' && recoverAnswer !== null) return;
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
    building: () => engineState.getState().build.running,
    askBuilding,
    stopBuild,
    askChanged,
    askRecover,
    ...(options.recoveryDelayMs === undefined ? {} : { recoveryDelayMs: options.recoveryDelayMs }),
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
      // The pages are shown in the application (8.8 rule 7): no program of the system has to know Markdown.
      openHelp: (name) => showDialog({ kind: 'help', page: name }),
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

  const services: AppServices = {
    ctx,
    showPanel(id) {
      dock?.show(id);
    },
    openDocument: (document) => project.openDocument(document),
    keyLabel(commandId) {
      const key = currentKeymap().keysOf(commandId)[0];
      return key === undefined ? null : formatKey(key, keyPlatform);
    },
    commandTitle: (commandId) => commands.get(commandId)?.def.title ?? null,
    enabled: (commandId) => runner.enabled(commandId),
    notify: (notice) => { notify(notice); },
  };

  /** The notice that says the device is being recovered, while a recovery is under way; and whether one is. */
  let lostNotice: number | null = null;
  let recovering = false;
  /** Whether the engine had the graphics card in this run, and whether its last device was a software adapter. */
  let hardwareSeen = false;
  let onSoftware = false;
  /** Whether the explanation of an engine without a device was opened by itself in this run: once at the most. */
  let explained = false;
  function onEngineEvent(event: EngineEvent): void {
    if (event.type === 'engine-error') {
      // A recovery that failed says so in the engine's words: "is being recovered" is no longer true.
      if (event.fatal && recovering) {
        dismissNotice(lostNotice);
        lostNotice = null;
        recovering = false;
      }
      notify({ level: event.fatal ? 'error' : 'warning', message: event.fatal ? `The engine stopped: ${event.message}` : event.message });
      // 8.7 rule 16: an engine that never had a device and was given none says nothing a newcomer can act on. The
      // explanation comes by itself once, unless another question stands; the status bar leads to it after that.
      if (event.fatal && foundNoAdapter(event.message) && engineState.getState().device.caps === null && !explained && state.getState().dialog === null) {
        explained = true;
        showDialog({ kind: 'noDevice' });
      }
    } else if (event.type === 'device-lost') {
      recovering = true;
      lostNotice = notify({ level: 'warning', message: DEVICE_LOST_NOTICE, detail: event.message });
    } else if (event.type === 'device-ready') {
      // A recovery, or a restarted engine, that ends on a software adapter after the graphics card was in use
      // (Chromium gives up hardware acceleration after losses, 7.8 rule 3): the status says "Ready", everything
      // works, and a change that took 60 ms takes seconds. Said once, with what brings the card back.
      const software = event.caps.software === true;
      if (software && hardwareSeen && !onSoftware) notify({ level: 'warning', message: SOFTWARE_ADAPTER_NOTICE });
      onSoftware = software;
      if (!software) hardwareSeen = true;
      // The first device of a session is no news. One that is back is said once, in place of the notice it ends.
      if (!recovering) return;
      recovering = false;
      dismissNotice(lostNotice);
      lostNotice = null;
      notify({ level: 'info', message: DEVICE_BACK_NOTICE });
    } else if (event.type === 'build-start') {
      // A build is the heaviest thing the engine does, and the engine lives in the page's process: what the
      // project has of unsaved changes is kept for recovery before it runs (8.6).
      void project.keepNow();
      // What was said of the build before is of a build that is being replaced.
      panelShown('build');
    } else if (event.type === 'build-result') {
      // The build panel shows the outcome with everything that belongs to it. The notice is for whoever has
      // another panel in front: one at the most, and none that lies over the panel's own words (`Notice.panel`).
      const { result } = event;
      const errors = result.problems.filter((problem) => problem.severity === 'error');
      const detail = result.problems.map((problem) => `${problem.severity}: ${problem.message}`).join('\n') || undefined;
      const panel = 'build' as const;
      if (result.status === 'ok') {
        notify({ level: 'info', message: `Build finished: ${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.outDir ? ` in ${baseName(result.outDir)}` : ''}`, detail, panel });
      } else if (result.status === 'aborted') {
        notify({ level: 'info', message: 'Build cancelled', panel });
      } else if (result.status === 'device-lost') {
        notify({ level: 'error', message: 'Build stopped: the graphics device was lost', detail, panel });
      } else {
        notify({ level: 'error', message: `Build failed: ${errors[0]?.message ?? 'a node could not be evaluated'}`, detail, panel });
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
    softwareRenderingOffered,
    keymap: currentKeymap,
    menus: () => buildMenus(commands, currentKeymap()),
    notify: (notice) => { notify(notice); },
    dismissNotice,
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
      const kind = state.getState().dialog?.kind;
      if (kind === 'unsaved') answerUnsaved('cancel');
      else if (kind === 'building') answerBuilding(false);
      else if (kind === 'changed') answerChanged('cancel');
      else if (kind === 'recover') answerRecover(false);
      else state.setState({ dialog: null });
    },
    answerUnsaved,
    answerBuilding,
    answerChanged,
    answerRecover,
    async restartWithSoftwareRendering() {
      if (!softwareRenderingOffered) return false;
      if (state.getState().dialog?.kind === 'noDevice') state.setState({ dialog: null });
      try {
        // As for closing the window: the project is left with the user's consent, and nothing is kept of it.
        if (!await project.mayLeave('close')) return false;
        await project.closing();
        if (!await platform.restartWithSoftwareRendering(doc.getState().path)) {
          notify({ level: 'error', message: 'Orogen could not restart with software rendering' });
          return false;
        }
      } catch (thrown) {
        notify({ level: 'error', message: 'Orogen could not restart with software rendering', detail: messageOf(thrown) });
        return false;
      }
      notify({ level: 'info', message: SOFTWARE_RESTART_NOTICE });
      return true;
    },
    resetLayout: () => runner.run('view.resetLayout'),
    attachDock(handle) {
      dock = handle;
    },
    panelShown,

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
          project.mayLeave('close').then(
            // Closed with the user's consent: nothing is kept for the next start to offer.
            (go) => (go ? project.closing().then(() => platform.confirmClose()) : undefined),
          ).catch((thrown: unknown) => {
            console.error('[orogen] the window could not ask about unsaved changes', thrown);
            platform.confirmClose();
          });
        }),
        // 8.2 rule 8: the project file a second start was given is opened here, after the questions of 8.8 rule 9.
        platform.onOpenRequested((file) => { void project.openPath(file); }),
        () => project.dispose(),
      ];
      return () => { for (const stop of stops) stop(); };
    },
  };
}
