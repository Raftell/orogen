// The log file (runtime.md 8.2): what went wrong in a run, for whoever is asked what happened on a machine no
// developer sees. Errors of the main process, errors the page wrote to its console, and the processes of the
// application that ended (the page's, the GPU's). One text file, appended to; when it has grown past LOG_MAX_BYTES
// it becomes the one older file and a new one begins. No Electron import.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_FOLDER = 'logs';
export const LOG_FILE = 'orogen.log';
export const LOG_MAX_BYTES = 2 ** 20;
/** A line longer than this is cut: a page that logs a megabyte does not fill the disk by the megabyte. */
const LINE_MAX = 4000;

export interface Log {
  /** The file, whether or not anything was written yet. */
  readonly file: string;
  /** Appends one entry. Never throws: a log that cannot be written is no fault of what it would have said. */
  write(source: string, message: string): void;
}

export function createLog(userData: string, now: () => Date = () => new Date()): Log {
  const folder = path.join(userData, LOG_FOLDER);
  const file = path.join(folder, LOG_FILE);
  let made = false;
  return {
    file,
    write(source, message) {
      try {
        if (!made) {
          fs.mkdirSync(folder, { recursive: true });
          made = true;
        }
        try {
          if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
        } catch {
          // No file yet.
        }
        const text = String(message).replace(/\r?\n/g, '\n    ');
        fs.appendFileSync(file, `${now().toISOString()} [${source}] ${text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text}\n`);
      } catch {
        // A full disk, a folder that cannot be written.
      }
    },
  };
}
