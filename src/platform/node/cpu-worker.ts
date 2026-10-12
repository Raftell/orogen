// The entry file of the CPU worker thread (runtime.md 6.3).
import { parentPort } from 'node:worker_threads';
// Defines every CPU task of the product in this thread.
import '../../core/nodes/index.ts';
import { serveCpuTasks } from '../../core/runtime.ts';

if (parentPort === null) throw new Error('cpu-worker.ts runs as a worker thread only');
serveCpuTasks(parentPort);
