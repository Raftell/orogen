// The preload script (runtime.md 8.6): exposes the one object of ipc.ts on the page's window. Built to
// dist/preload.cjs. The page itself has no Node; a worker never sees this object (8.2 rule 1).

import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS, PLATFORM_GLOBAL, type LaunchInfo, type PathStat, type PlatformApi, type Preferences, type RecoveryRecord } from '../ipc.ts';
import { toProjectPath } from '../main/files.ts';

const launch = ipcRenderer.sendSync(CHANNELS.launchInfo) as LaunchInfo | null;
if (launch === null) throw new Error('The main process did not answer the preload script');

/** Calls every listener; one that throws does not keep the others from being called. */
function tell<A extends unknown[]>(listeners: ReadonlySet<(...args: A) => void>, ...args: A): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (thrown) {
      console.error('[orogen] a listener of the platform bridge threw', thrown);
    }
  }
}

function subscribe<A extends unknown[]>(listeners: Set<(...args: A) => void>, listener: (...args: A) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const menuListeners = new Set<(commandId: string) => void>();
const closeListeners = new Set<() => void>();
const openListeners = new Set<(path: string) => void>();
ipcRenderer.on(CHANNELS.openRequested, (_event, file: unknown) => {
  if (typeof file === 'string' && file !== '') tell(openListeners, file);
});
ipcRenderer.on(CHANNELS.menuCommand, (_event, commandId: unknown) => {
  if (typeof commandId === 'string') tell(menuListeners, commandId);
});
ipcRenderer.on(CHANNELS.closeRequested, () => {
  // A page that does not listen has nothing to save: the window closes.
  if (closeListeners.size === 0) ipcRenderer.send(CHANNELS.confirmClose);
  else tell(closeListeners);
});

const api: PlatformApi = {
  gpuProfile: launch.gpuProfile,
  testMode: launch.testMode,
  launchProject: launch.launchProject,
  openProjectDialog: () => ipcRenderer.invoke(CHANNELS.openProjectDialog) as Promise<string | null>,
  saveProjectDialog: (suggestedPath?: string) => ipcRenderer.invoke(CHANNELS.saveProjectDialog, suggestedPath) as Promise<string | null>,
  openFileDialog: (extensions: readonly string[]) => ipcRenderer.invoke(CHANNELS.openFileDialog, [...extensions]) as Promise<string | null>,
  chooseFolder: () => ipcRenderer.invoke(CHANNELS.chooseFolder) as Promise<string | null>,
  readTextFile: (file: string) => ipcRenderer.invoke(CHANNELS.readTextFile, file) as Promise<string>,
  writeTextFile: (file: string, text: string) => ipcRenderer.invoke(CHANNELS.writeTextFile, file, text) as Promise<void>,
  toProjectPath: (projectPath: string | null, filePath: string) => toProjectPath(projectPath, filePath),
  getPreferences: () => ipcRenderer.invoke(CHANNELS.getPreferences) as Promise<Preferences>,
  setPreferences: (patch: Partial<Preferences>) => ipcRenderer.invoke(CHANNELS.setPreferences, patch) as Promise<void>,
  setBuildActive: (active: boolean) => ipcRenderer.send(CHANNELS.setBuildActive, active === true),
  showInFolder: (file: string) => ipcRenderer.send(CHANNELS.showInFolder, file),
  statPath: (file: string, projectPath: string | null = null) => ipcRenderer.invoke(CHANNELS.statPath, file, projectPath) as Promise<PathStat>,
  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url) as Promise<boolean>,
  openDocument: (name: string) => ipcRenderer.invoke(CHANNELS.openDocument, name) as Promise<boolean>,
  openBuildFile: (file: string) => ipcRenderer.invoke(CHANNELS.openBuildFile, file) as Promise<boolean>,
  readRecovery: () => ipcRenderer.invoke(CHANNELS.readRecovery) as Promise<RecoveryRecord | null>,
  writeRecovery: (record) => ipcRenderer.invoke(CHANNELS.writeRecovery, record) as Promise<void>,
  onOpenRequested: (listener) => subscribe(openListeners, listener),
  onMenuCommand: (listener) => subscribe(menuListeners, listener),
  onCloseRequested: (listener) => subscribe(closeListeners, listener),
  confirmClose: () => ipcRenderer.send(CHANNELS.confirmClose),
};

contextBridge.exposeInMainWorld(PLATFORM_GLOBAL, api);
