// The shell without a window: createShell on stores of its own, with a bridge that keeps its files and its
// preferences in memory and an engine that records what it is told. Shared by the window-free tests of the
// shell. Not a test file. It loads no GPU code, no React component and no CSS.

import path from 'node:path';
import type { StoreApi } from 'zustand/vanilla';

import { nodes } from '../../../../src/core/nodes/index.ts';
import {
  createRegistry, DEFAULT_PREFERENCES,
  type EngineEvent, type EnginePreferences, type EngineSession, type GpuCaps, type NodeRegistry,
} from '../../../../src/core/runtime.ts';
import type { PlatformApi, Preferences } from '../../../../src/app/platform.ts';
import type { EditAction } from '../../../../src/app/shell/app-commands.ts';
import { createShell, type Shell } from '../../../../src/app/shell/shell.ts';
import { createDocStore, type DocState } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore, reduceEngineEvent, type EngineState } from '../../../../src/app/state/engine-store.ts';
import { createUiStore, type UiState } from '../../../../src/app/state/ui-store.ts';
import type { CommandDef, PanelDef, PanelId } from '../../../../src/app/ui/types.ts';

export const REGISTRY: NodeRegistry = createRegistry(nodes);

export const CAPS = {
  adapter: { vendor: 'nvidia', architecture: 'turing', device: '0x2191', description: 'NVIDIA GeForce GTX 1660 Ti', isFallbackAdapter: false, backend: 'vulkan' },
  software: false,
  vramBytes: null,
} as unknown as GpuCaps;

export interface FakePlatform extends PlatformApi {
  readonly files: Map<string, string>;
  /** What the next dialogs answer, first in, first out; an empty list answers as a cancelled dialog. */
  readonly answers: { open: (string | null)[]; save: (string | null)[]; folder: (string | null)[] };
  readonly asked: string[];
  preferences: Preferences;
  readonly buildActive: boolean[];
  /** The pages of the documentation that were asked for, in order. */
  readonly opened: string[];
  /** The pages `openDocument` finds: the others answer false, as a page the package lacks does. */
  documents: readonly string[];
  confirmed: number;
  /** The projects `restartWithSoftwareRendering` was asked to open, in order; `restartAnswer` is what it answers. */
  readonly restarts: (string | null)[];
  restartAnswer: boolean;
  /** Fails the next write or read with this message. */
  failNext: string | null;
  /** What `statPath` says of each file that was written: its time moves with every write, here or by `touch`. */
  readonly times: Map<string, number>;
  /** Another program writes the file: its text and its time change behind the application's back. */
  touch(file: string, text: string): void;
  /** What is kept for recovery, as the main process keeps it; null: nothing. */
  recovery: { path: string | null; text: string; savedAt: number } | null;
  /** Every call of `writeRecovery`: the revision-free text, or null for a removal. */
  readonly recoveryWrites: (string | null)[];
  menu(commandId: string): void;
  requestClose(): void;
  /** A second start of the application was given this project file. */
  requestOpen(file: string): void;
}

export function fakePlatform(options: { readonly launchProject?: string | null; readonly testMode?: boolean; readonly softwareRendering?: boolean } = {}): FakePlatform {
  const menuListeners = new Set<(commandId: string) => void>();
  const closeListeners = new Set<() => void>();
  const openListeners = new Set<(file: string) => void>();
  let clock = 1_000;
  const platform: FakePlatform = {
    gpuProfile: 'core',
    testMode: options.testMode ?? false,
    launchProject: options.launchProject ?? null,
    softwareRendering: options.softwareRendering ?? false,
    files: new Map(),
    answers: { open: [], save: [], folder: [] },
    asked: [],
    preferences: { gpu: DEFAULT_PREFERENCES, keymap: {}, layout: null, recent: [], viewport: null, panels: {} },
    buildActive: [],
    opened: [],
    documents: ['README.md', 'unreal-import.md', 'first-run-on-windows.md'],
    confirmed: 0,
    restarts: [],
    restartAnswer: true,
    failNext: null,
    times: new Map(),
    touch(file, text) {
      platform.files.set(file, text);
      platform.times.set(file, ++clock);
    },
    recovery: null,
    recoveryWrites: [],
    async openProjectDialog() {
      platform.asked.push('open');
      return platform.answers.open.shift() ?? null;
    },
    async saveProjectDialog(suggested) {
      platform.asked.push(`save:${suggested ?? ''}`);
      return platform.answers.save.shift() ?? null;
    },
    async openFileDialog() {
      return null;
    },
    async chooseFolder() {
      platform.asked.push('folder');
      return platform.answers.folder.shift() ?? null;
    },
    async readTextFile(file) {
      if (platform.failNext !== null) {
        const message = platform.failNext;
        platform.failNext = null;
        throw new Error(`Error invoking remote method 'orogen:read-text-file': Error: ${message}`);
      }
      const text = platform.files.get(file);
      if (text === undefined) throw new Error(`Error invoking remote method 'orogen:read-text-file': Error: ENOENT: no such file or directory, open '${file}'`);
      return text;
    },
    async writeTextFile(file, text) {
      if (platform.failNext !== null) {
        const message = platform.failNext;
        platform.failNext = null;
        throw new Error(message);
      }
      platform.files.set(file, text);
      platform.times.set(file, ++clock);
    },
    // The rule of runtime.md 6.1 rule 2, as src/platform/electron/main/files.ts has it, on POSIX paths.
    toProjectPath(projectPath, filePath) {
      const file = path.posix.resolve(filePath);
      if (projectPath === null || projectPath === '') return file;
      const relative = path.posix.relative(path.posix.dirname(path.posix.resolve(projectPath)), file);
      return relative === '' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative) ? file : relative;
    },
    async getPreferences() {
      return platform.preferences;
    },
    // As the main process does (8.6): of `panels` the entries the patch names are replaced, the others kept.
    async setPreferences(patch) {
      platform.preferences = { ...platform.preferences, ...patch, panels: { ...platform.preferences.panels, ...patch.panels } };
    },
    setBuildActive(active) {
      platform.buildActive.push(active);
    },
    showInFolder() {},
    async statPath(file) {
      const text = platform.files.get(file);
      return text === undefined ? { exists: false, isFile: false, size: 0, mtimeMs: 0 } : { exists: true, isFile: true, size: text.length, mtimeMs: platform.times.get(file) ?? 1 };
    },
    async readRecovery() {
      return platform.recovery;
    },
    async writeRecovery(record) {
      platform.recoveryWrites.push(record === null ? null : record.text);
      platform.recovery = record === null ? null : { ...record, savedAt: ++clock };
    },
    onOpenRequested(listener) {
      openListeners.add(listener);
      return () => void openListeners.delete(listener);
    },
    async openExternal() {
      return false;
    },
    async openDocument(name) {
      platform.opened.push(name);
      return platform.documents.includes(name);
    },
    async openBuildFile() {
      return false;
    },
    onMenuCommand(listener) {
      menuListeners.add(listener);
      return () => void menuListeners.delete(listener);
    },
    onCloseRequested(listener) {
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },
    async restartWithSoftwareRendering(project) {
      platform.restarts.push(project);
      return platform.restartAnswer;
    },
    confirmClose() {
      platform.confirmed++;
    },
    menu(commandId) {
      for (const listener of [...menuListeners]) listener(commandId);
    },
    requestClose() {
      for (const listener of [...closeListeners]) listener();
    },
    requestOpen(file) {
      for (const listener of [...openListeners]) listener(file);
    },
  };
  return platform;
}

export interface FakeEngine extends EngineSession {
  /** Every call, as its name and its arguments. */
  readonly calls: [string, ...unknown[]][];
  /** Tells the subscribers and the store, as the engine client does. */
  emit(event: EngineEvent): void;
}

export function fakeEngine(engineState: StoreApi<EngineState>): FakeEngine {
  const listeners = new Set<(event: EngineEvent) => void>();
  const calls: [string, ...unknown[]][] = [];
  const call = (name: string) => (...args: unknown[]): void => void calls.push([name, ...args]);
  const engine: FakeEngine = {
    calls,
    emit(event) {
      engineState.setState(reduceEngineEvent(engineState.getState(), event), true);
      for (const listener of [...listeners]) listener(event);
    },
    setProject: call('setProject'),
    setDocument: call('setDocument'),
    beginGesture: call('beginGesture'),
    endGesture: call('endGesture'),
    setPaused: call('setPaused'),
    requestThumbnails: call('requestThumbnails'),
    inspect: async () => null,
    async build(request) {
      calls.push(['build', request.outDir]);
      return { requestId: 1, status: 'ok', problems: [], files: [], manifest: null, report: null, outDir: request.outDir, peakPoolBytes: null };
    },
    cancelBuild: call('cancelBuild'),
    plan: async () => { throw new Error('This stand-in plans nothing'); },
    setPreferences: call('setPreferences') as (prefs: EnginePreferences) => void,
    retryDevice: call('retryDevice'),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    viewport: { attach() {}, detach() {}, resize() {}, setCamera() {}, setDisplay() {}, pick: async () => null },
    dispose: async () => undefined,
  };
  return engine;
}

/** The panels as the registry lists them, without their components: what the shell reads of a PanelDef. */
export function fakePanels(commands: Partial<Record<PanelId, readonly CommandDef[]>> = {}): PanelDef[] {
  const panel = (id: PanelId, extra: Partial<PanelDef> = {}): PanelDef => ({
    id, title: id[0]!.toUpperCase() + id.slice(1), component: () => null, keepMounted: false, placement: {}, keys: [], ...extra,
    commands: [...(extra.commands ?? []), ...(commands[id] ?? [])],
  });
  return [
    panel('viewport', { commands: [{ id: 'viewport.toggleTop', title: 'Toggle Top View', enabled: () => false, run: () => undefined }], menu: [{ menu: 'View', command: 'viewport.toggleTop', group: 'viewport' }] }),
    panel('graph'),
    panel('inspector'),
    panel('library'),
    panel('build', {
      commands: [{ id: 'build.start', title: 'Build…', run: async (ctx) => { const outDir = await ctx.platform.chooseFolder(); if (outDir !== null) await ctx.engine.build({ doc: ctx.doc.getState().doc, outDir }); } }],
      menu: [{ menu: 'Engine', command: 'build.start', group: 'build' }],
    }),
  ];
}

export interface Rig {
  readonly shell: Shell;
  readonly doc: StoreApi<DocState>;
  readonly engineState: StoreApi<EngineState>;
  readonly ui: StoreApi<UiState>;
  readonly platform: FakePlatform;
  readonly engine: FakeEngine;
  /** What the edit commands did to the window: the action in a text field, or the clipboard event at a panel. */
  readonly edits: string[];
  /** Whether a text field has the focus, for the edit commands. */
  textField: boolean;
  closed: number;
  /** How often the shell asked for another engine worker. */
  restarts: number;
  stop(): void;
}

export function createRig(options: {
  readonly launchProject?: string | null;
  readonly testMode?: boolean;
  /** The run was started with software rendering (PlatformApi.softwareRendering). */
  readonly softwareRendering?: boolean;
  /** navigator.platform of the page; default "Linux x86_64", whatever system the test runs on. */
  readonly system?: string;
  readonly panels?: PanelDef[];
  readonly preferences?: Partial<Preferences>;
  /** How long a build that was told to stop is waited for; default the shell's own. */
  readonly buildStopBackstopMs?: number;
  /** How long an unsaved project rests before it is kept for recovery; default the shell's own. */
  readonly recoveryDelayMs?: number;
  /** What a run before this one kept for recovery. */
  readonly recovery?: { readonly path: string | null; readonly text: string; readonly savedAt: number };
} = {}): Rig {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  const engineState = createEngineStore();
  const platform = fakePlatform(options);
  platform.preferences = { ...platform.preferences, ...options.preferences };
  if (options.recovery) platform.recovery = { ...options.recovery };
  const engine = fakeEngine(engineState);
  const rig = { edits: [] as string[], textField: false, closed: 0, restarts: 0 } as Rig;
  const shell = createShell({
    doc, engineState, ui, engine, platform, registry: REGISTRY, panels: options.panels ?? fakePanels(), preferences: platform.preferences,
    host: {
      edit: {
        textField: () => rig.textField,
        inTextField: (action: EditAction) => void rig.edits.push(`field:${action}`),
        clipboardEvent: (action, panel) => void rig.edits.push(`event:${action}:${panel}`),
      },
      closeWindow: () => { rig.closed++; },
      restartEngine: () => { rig.restarts++; },
    },
    system: options.system ?? 'Linux x86_64',
    now: () => 1_000,
    ...(options.buildStopBackstopMs === undefined ? {} : { buildStopBackstopMs: options.buildStopBackstopMs }),
    ...(options.recoveryDelayMs === undefined ? {} : { recoveryDelayMs: options.recoveryDelayMs }),
  });
  const stop = shell.connect();
  return Object.assign(rig, { shell, doc, engineState, ui, platform, engine, stop });
}

/** Resolves when everything that was started has had its turn: the fakes answer in microtasks. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Runs a command and waits for what it started. */
export async function run(rig: Rig, commandId: string): Promise<void> {
  rig.shell.runner.run(commandId);
  await turn();
}
