// What the shell writes for a person: sizes, durations, the name of a project and of an adapter, and which
// errors it has to say. No DOM.

import type { GpuCaps, GraphDoc, NodeError } from '../../core/runtime.ts';
import type { EngineState } from '../state/engine-store.ts';

const GIB = 2 ** 30;
const MIB = 2 ** 20;

/** A byte count: whole megabytes below a gigabyte, gigabytes with one decimal from there. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < GIB) return `${Math.max(1, Math.round(bytes / MIB))} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** A duration: '0.4 s', '12 s', '3 min 20 s', '1 h 05 min'. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`;
}

/** The last segment of a path, whichever separator it is written with. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The folder of a path, without the last separator; '' when the path has none. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? '' : path.slice(0, cut);
}

export const isAbsolutePath = (path: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(path);

export const UNTITLED = 'Untitled';

/** The name a project is shown under: its file name without the extension. */
export function projectName(path: string | null): string {
  if (path === null) return UNTITLED;
  const name = baseName(path);
  return name.toLowerCase().endsWith('.orogen') ? name.slice(0, -'.orogen'.length) || name : name;
}

/** The title of the window: the project, a star while it has unsaved changes, the application. */
export function windowTitle(path: string | null, unsaved: boolean): string {
  return `${projectName(path)}${unsaved ? '*' : ''} - Orogen`;
}

/** WebGPU reports adapter strings in lower case with hyphens (runtime.md 1.3); this is how they read. */
function spoken(text: string): string {
  return text.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const VENDORS: Readonly<Record<string, string>> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', microsoft: 'Microsoft', google: 'Google', mesa: 'Mesa', apple: 'Apple', qualcomm: 'Qualcomm' };

/** A PCI id, which is what `device` holds where the driver gives the name in `description`. */
const isId = (text: string): boolean => /^(0x)?[0-9a-f]{4}$/i.test(text.trim());

/**
 * The adapter as the status bar names it: the vendor and the device. Which member holds the device's name is the
 * platform's choice (runtime.md 1.3): `device` where it is a name, else `description`.
 */
export function adapterName(adapter: GpuCaps['adapter']): string {
  const vendor = VENDORS[adapter.vendor.toLowerCase()] ?? spoken(adapter.vendor);
  const device = [adapter.device, adapter.description, adapter.architecture].map(spoken).find((text) => text !== '' && !isId(text)) ?? '';
  if (device === '') return vendor || 'Unknown adapter';
  return vendor === '' || device.toLowerCase().startsWith(vendor.toLowerCase()) ? device : `${vendor} ${device}`;
}

/**
 * The errors of the nodes the document holds, in the document's order. engineStore keeps what the engine last
 * said of every node it has reported on (8.5), one that was deleted since included, and the undo that brings the
 * node back finds it there: a node that is gone has nothing to say to the user.
 */
export function failedNodes(nodes: EngineState['nodes'], held: GraphDoc['nodes']): NodeError[] {
  const failed: NodeError[] = [];
  for (const id of Object.keys(held)) {
    const known = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (known?.state === 'error' && known.error) failed.push(known.error);
  }
  return failed;
}
