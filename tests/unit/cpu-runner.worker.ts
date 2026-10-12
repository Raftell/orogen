// The worker entry of cpu-runner.test.ts: the tasks a test of the runner needs and the product cannot have
// (one that never returns, one that tells its thread), served as the product's worker serves its own.

import { parentPort, threadId } from 'node:worker_threads';
import { serveCpuTasks } from '../../src/core/cpu/serve.ts';
import { defineCpuTask } from '../../src/core/cpu/tasks.ts';

// What `test/double` returned last, to see from inside whether its buffer left this thread.
let returned: Float32Array | null = null;
let served = 0;

defineCpuTask({
  name: 'test/thread',
  run: (): { threadId: number; served: number } => ({ threadId, served: ++served }),
});

defineCpuTask({
  name: 'test/double',
  run(args: { data: Float32Array }, env): { data: Float32Array; sum: number; inputBytes: number } {
    const { data } = args;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      data[i]! *= 2;
      sum += data[i]!;
      if (i === data.length >> 1) env.progress(0.5);
    }
    env.progress(1);
    returned = data;
    return { data, sum, inputBytes: data.buffer.byteLength };
  },
});

defineCpuTask({
  name: 'test/returned-bytes',
  run: (): number => (returned === null ? -1 : returned.buffer.byteLength),
});

defineCpuTask({
  name: 'test/numbers',
  run: (args: { count: number }): number[] => Array.from({ length: args.count }, (_, i) => i),
});

defineCpuTask({
  name: 'test/throw',
  run(args: { message: string }): never {
    throw new Error(args.message);
  },
});

defineCpuTask({
  name: 'test/sleep',
  async run(args: { ms: number; tag: string }): Promise<{ tag: string; served: number }> {
    await new Promise((resolve) => { setTimeout(resolve, args.ms); });
    return { tag: args.tag, served: ++served };
  },
});

defineCpuTask({
  name: 'test/exit',
  run(args: { code: number }): never {
    // In a worker thread this ends the thread, not the process.
    process.exit(args.code);
  },
});

defineCpuTask({
  name: 'test/crash',
  run(args: { message: string }): Promise<never> {
    // Thrown outside the task's own call: nothing answers the request, the thread dies of it.
    setTimeout(() => { throw new Error(args.message); }, 1);
    return new Promise(() => {});
  },
});

defineCpuTask({
  name: 'test/spin',
  run(): never {
    for (;;) { /* never returns: only terminating the thread ends it */ }
  },
});

if (parentPort === null) throw new Error('cpu-runner.worker.ts runs as a worker thread only');
serveCpuTasks(parentPort);
