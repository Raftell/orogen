// The bridge between the page and the main process (runtime.md 8.6): the one object the preload script exposes,
// and the channels it is carried on. The page imports the types of this file and nothing else of src/platform/.

import type { EnginePreferences, GpuProfile } from '../../core/runtime.ts';

export interface Preferences {
  readonly gpu: EnginePreferences;
  readonly keymap: Readonly<Record<string, string>>;     // command id → key, overriding defaults (8.8)
  readonly layout: unknown;                              // the dock layout
  readonly recent: readonly string[];
}

export interface PlatformApi {
  readonly gpuProfile: GpuProfile;
  /** The application runs under OROGEN_TEST=1: the page assigns `window.orogenTest` (testing.md 2.9). */
  readonly testMode: boolean;
  /** The project file given on the command line, as an absolute path; null: none. The page opens it at start-up. */
  readonly launchProject: string | null;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(suggestedPath?: string): Promise<string | null>;
  openFileDialog(extensions: readonly string[]): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;        // atomic: a temporary file, then a rename
  toProjectPath(projectPath: string | null, filePath: string): string;   // the form 6.1 rule 2 stores
  getPreferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<void>;
  setBuildActive(active: boolean): void;
  showInFolder(path: string): void;
  onMenuCommand(listener: (commandId: string) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  confirmClose(): void;
}

/** The page's window as the preload script leaves it: `window.orogenPlatform` is the PlatformApi. */
export interface PlatformGlobal { readonly orogenPlatform: PlatformApi }
export const PLATFORM_GLOBAL: keyof PlatformGlobal = 'orogenPlatform';

/** What the preload script asks the main process for, once and synchronously, before the page runs. */
export interface LaunchInfo {
  readonly gpuProfile: GpuProfile;
  readonly testMode: boolean;
  readonly launchProject: string | null;
}

/** Every channel between the preload script and the main process. Nothing else is listened to on either side. */
export const CHANNELS = {
  // preload → main, synchronous
  launchInfo: 'orogen:launch-info',
  // preload → main, answered (ipcRenderer.invoke)
  openProjectDialog: 'orogen:open-project-dialog',
  saveProjectDialog: 'orogen:save-project-dialog',
  openFileDialog: 'orogen:open-file-dialog',
  chooseFolder: 'orogen:choose-folder',
  readTextFile: 'orogen:read-text-file',
  writeTextFile: 'orogen:write-text-file',
  getPreferences: 'orogen:get-preferences',
  setPreferences: 'orogen:set-preferences',
  // preload → main, not answered (ipcRenderer.send)
  setBuildActive: 'orogen:set-build-active',
  showInFolder: 'orogen:show-in-folder',
  confirmClose: 'orogen:confirm-close',
  // main → preload
  menuCommand: 'orogen:menu-command',
  closeRequested: 'orogen:close-requested',
} as const;

/** The extension of a project file, without the dot. */
export const PROJECT_EXTENSION = 'orogen';
