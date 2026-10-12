// Run as a process of its own by cpu-runner.test.ts: awaits one task and ends without disposing the runner.

import { createNodeCpuRunner } from '../../src/platform/node/cpu.ts';

const runner = createNodeCpuRunner(new URL('./cpu-runner.worker.ts', import.meta.url));
// Nothing but the task in progress keeps this process alive during the await.
const result = await runner.run('test/sleep', { tag: 'kept alive', ms: 300 }, [], { signal: new AbortController().signal, onProgress(): void {} });
console.log((result as { tag: string }).tag);
// And nothing keeps it alive now: the worker is idle.
