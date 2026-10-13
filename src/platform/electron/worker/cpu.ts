// The application's CpuRunner (runtime.md 6.3): a dedicated Web Worker that the engine worker creates.

import type { CpuRunner } from '../../../core/runtime.ts';
import { createCpuRunner } from './cpu-queue.ts';

/** The built CPU worker, beside the script of the thread that creates it: dist/cpu-worker.js. */
const ENTRY = 'cpu-worker.js';

export function createWebCpuRunner(): CpuRunner {
  return createCpuRunner((onReply, onFailure) => {
    const worker = new Worker(new URL(ENTRY, self.location.href), { name: 'orogen-cpu' });
    worker.onmessage = (e: MessageEvent<unknown>) => onReply(e.data);
    worker.onmessageerror = () => onFailure('a reply could not be read');
    worker.onerror = (e: ErrorEvent) => {
      // Handled here: the failure rejects the task in progress and is no uncaught error of this thread.
      e.preventDefault();
      onFailure(e.message || 'its script could not be loaded');
    };
    return {
      post: (request, transfer) => worker.postMessage(request, transfer),
      stop: () => worker.terminate(),
    };
  });
}
