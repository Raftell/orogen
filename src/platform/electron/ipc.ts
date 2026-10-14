// The bridge between the page and the main process (runtime.md 8.6): the one object the preload script exposes,
// and the channels it is carried on. The page imports the types of this file and nothing else of src/platform/.

import type { EnginePreferences, GpuProfile } from '../../core/runtime.ts';

export interface Preferences {
  readonly gpu: EnginePreferences;
  readonly keymap: Readonly<Record<string, string>>;     // command id → key, overriding defaults (8.8)
  readonly layout: unknown;                              // the dock layout
  readonly recent: readonly string[];
  readonly viewport: unknown;                            // the viewport panel's cameras and display options; opaque, as `layout` is
  readonly panels: Readonly<Record<string, unknown>>;    // panel id → what that panel keeps for itself; each value opaque
}

/**
 * What is kept of a project that has changes no file holds, for the start after a run that ended without a
 * save: the page's process went, the application was ended, the machine lost power.
 */
export interface RecoveryRecord {
  /** The project file the changes belong to; null for a project that was never saved. */
  readonly path: string | null;
  /** The project as `serializeDoc` writes it. */
  readonly text: string;
  /** When it was kept: milliseconds since the epoch. */
  readonly savedAt: number;
}

/** What `statPath` tells of a path. One that names nothing is `{ exists: false, isFile: false, size: 0, mtimeMs: 0 }`. */
export interface PathStat {
  readonly exists: boolean;
  readonly isFile: boolean;                              // false for a folder
  readonly size: number;                                 // bytes of a file; 0 for a folder
  readonly mtimeMs: number;                              // last modified, milliseconds since the epoch
}

export interface PlatformApi {
  readonly gpuProfile: GpuProfile;
  /** The application runs under OROGEN_TEST=1: the page assigns `window.orogenTest` (testing.md 2.9). */
  readonly testMode: boolean;
  /** The project file given on the command line, as an absolute path; null: none. The page opens it at start-up. */
  readonly launchProject: string | null;
  /** This run asked Chromium for its software adapter: the user restarted with software rendering, or OROGEN_ELECTRON_GPU=software. */
  readonly softwareRendering: boolean;
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
  /** What `path` names. A relative path is taken from the folder of `projectPath`, the form 6.1 rule 2 stores; without one it names nothing. */
  statPath(path: string, projectPath?: string | null): Promise<PathStat>;
  /** Opens a web address in the system's browser: `http` and `https` alone. False: refused, or the system could not. */
  openExternal(url: string): Promise<boolean>;
  /** Opens a page or a picture of the user documentation in the system's program for it, by its name in docs/user: 'unreal-import.md'. */
  openDocument(name: string): Promise<boolean>;
  /** Opens a file a build wrote in the system's program for it. `path` is absolute, and its folder holds that build. */
  openBuildFile(path: string): Promise<boolean>;
  /** What a run before this one kept of a project with unsaved changes; null: nothing was kept, or it cannot be read. */
  readRecovery(): Promise<RecoveryRecord | null>;
  /** Keeps the project as it is now, in place of what was kept before; `null` removes what is kept. */
  writeRecovery(record: { readonly path: string | null; readonly text: string } | null): Promise<void>;
  /** A project file a second start of the application was given: the running application opens it. */
  onOpenRequested(listener: (path: string) => void): () => void;
  onMenuCommand(listener: (commandId: string) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  confirmClose(): void;
  /**
   * Ends this run and starts another with software rendering, which opens `project` (an absolute path; null: none).
   * The page has asked about unsaved changes first. False: refused. In test mode nothing ends and nothing starts.
   */
  restartWithSoftwareRendering(project: string | null): Promise<boolean>;
}

/** The page's window as the preload script leaves it: `window.orogenPlatform` is the PlatformApi. */
export interface PlatformGlobal { readonly orogenPlatform: PlatformApi }
export const PLATFORM_GLOBAL: keyof PlatformGlobal = 'orogenPlatform';

/** What the preload script asks the main process for, once and synchronously, before the page runs. */
export interface LaunchInfo {
  readonly gpuProfile: GpuProfile;
  readonly testMode: boolean;
  readonly launchProject: string | null;
  readonly softwareRendering: boolean;
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
  readRecovery: 'orogen:read-recovery',
  writeRecovery: 'orogen:write-recovery',
  statPath: 'orogen:stat-path',
  openExternal: 'orogen:open-external',
  openDocument: 'orogen:open-document',
  openBuildFile: 'orogen:open-build-file',
  restartWithSoftwareRendering: 'orogen:restart-with-software-rendering',
  // preload → main, not answered (ipcRenderer.send)
  setBuildActive: 'orogen:set-build-active',
  showInFolder: 'orogen:show-in-folder',
  confirmClose: 'orogen:confirm-close',
  // main → preload
  menuCommand: 'orogen:menu-command',
  openRequested: 'orogen:open-requested',
  closeRequested: 'orogen:close-requested',
} as const;

/** The extension of a project file, without the dot. */
export const PROJECT_EXTENSION = 'orogen';
