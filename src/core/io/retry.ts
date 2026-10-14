// Renaming a file or a folder that another program holds for a moment (runtime.md 6.2). On Windows a virus
// scanner, the search indexer, a synchronising folder or an editor that is importing the file keeps a handle
// open for a fraction of a second after it was written, and a rename meanwhile is refused with EPERM, EACCES or
// EBUSY. Elsewhere those codes mean what they say and are not waited on. Pure: the operation is handed in.

/** The codes a held file is refused with. */
const BUSY_CODES: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** The waits before the second and every later attempt: eight attempts over about 2.5 s. */
export const BUSY_DELAYS_MS: readonly number[] = [20, 50, 100, 200, 400, 700, 1000];
/** What `fs.promises.rm` is given for the same reason, where `busy` holds: Node repeats the removal itself. */
export const BUSY_RM = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * Runs `work`, and again after each wait while it rejects with a code of a held file. `busy` is whether such a
 * refusal passes by itself on this platform: `process.platform === 'win32'`. The last refusal is thrown as it is.
 */
export async function retryBusy<T>(work: () => Promise<T>, busy: boolean, delaysMs: readonly number[] = BUSY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (thrown) {
      const code = (thrown as { readonly code?: unknown } | null)?.code;
      if (!busy || attempt >= delaysMs.length || !BUSY_CODES.has(code)) throw thrown;
      await new Promise<void>((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
