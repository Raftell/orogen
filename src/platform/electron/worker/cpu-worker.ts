// The entry file of the application's CPU worker (runtime.md 6.3). Built to dist/cpu-worker.js, a classic
// script. It uses nothing of Node.

// Defines every CPU task of the product in this thread.
import '../../../core/nodes/index.ts';
import { serveCpuTasks, type CpuTaskPort } from '../../../core/runtime.ts';

const port: CpuTaskPort = {
  postMessage: (message, transfer) => self.postMessage(message, transfer),
  addEventListener: (type, listener) => self.addEventListener(type, listener),
};
serveCpuTasks(port);
