// The recovery file (runtime.md 8.6): what the page keeps of a project with unsaved changes, so that a run that
// ended without a save (the page's process went, the application was ended, the power failed) costs the changes
// of the last seconds and not the project. One JSON file in the folder main.ts names, which is the user-data
// folder, written as every text file of the bridge is: whole, or not at all. No Electron import.

import fs from 'node:fs';
import path from 'node:path';

import type { RecoveryRecord } from '../ipc.ts';
import { MAX_TEXT_BYTES, writeTextFile } from './files.ts';

export const RECOVERY_FILE = 'recovery.json';

export interface RecoveryStore {
  /** What is kept; null when nothing is, and when what is there cannot be read: a file that is no record is no project. */
  read(): Promise<RecoveryRecord | null>;
  /** Keeps `record` in place of what was kept, stamped with the time of this call; `null` removes what is kept. Calls are applied in the order made. */
  write(record: unknown): Promise<void>;
}

/** A record as the page hands it over: a path or none, and the text of a project. */
function shaped(record: unknown): { readonly path: string | null; readonly text: string } | null {
  if (typeof record !== 'object' || record === null) return null;
  const { path: file, text } = record as { readonly path?: unknown; readonly text?: unknown };
  if (typeof text !== 'string' || text === '' || text.length > MAX_TEXT_BYTES) return null;
  if (file !== null && (typeof file !== 'string' || file === '' || file.includes('\0') || !path.isAbsolute(file))) return null;
  return { path: file, text };
}

export function createRecoveryStore(folder: string, now: () => number = () => Date.now()): RecoveryStore {
  const file = path.join(folder, RECOVERY_FILE);
  let writing: Promise<void> = Promise.resolve();
  return {
    async read(): Promise<RecoveryRecord | null> {
      // After what is being written: a read never sees the file of the write before the last.
      await writing;
      try {
        if ((await fs.promises.stat(file)).size > 2 * MAX_TEXT_BYTES) return null;
        const held: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        const record = shaped(held);
        const savedAt = (held as { readonly savedAt?: unknown } | null)?.savedAt;
        return record === null ? null : { ...record, savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0 };
      } catch {
        return null;
      }
    },
    write(record: unknown): Promise<void> {
      const applied = writing.then(async () => {
        if (record === null || record === undefined) {
          await fs.promises.rm(file, { force: true });
          return;
        }
        const kept = shaped(record);
        if (kept === null) throw new TypeError('What is to be kept for recovery is no project: a path or null, and its text');
        await fs.promises.mkdir(folder, { recursive: true });
        await writeTextFile(file, `${JSON.stringify({ ...kept, savedAt: now() })}\n`);
      });
      // A failed write fails its own call and not the calls after it.
      writing = applied.catch(() => {});
      return applied;
    },
  };
}
