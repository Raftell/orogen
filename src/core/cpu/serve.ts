// The core's own tasks are defined in every thread that serves tasks, whatever else that thread imports.
import '../io/image.ts';
import '../io/raw.ts';
import type { CpuTaskReply, CpuTaskRequest } from './protocol.ts';
import { findCpuTask } from './tasks.ts';

/** The port a CPU worker serves on. Satisfied by node:worker_threads' parentPort, by a Web Worker's global scope and by a MessagePort. */
export interface CpuTaskPort {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  /** A Web MessagePort delivers nothing until start() is called; the other two have no such method. */
  start?(): void;
}

function isRequest(data: unknown): data is CpuTaskRequest {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as { id?: unknown; task?: unknown };
  return typeof r.id === 'number' && typeof r.task === 'string';
}

function isPlain(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The buffer of every typed array reachable through plain objects and arrays (runtime.md 6.3 rule 3), each once. */
function buffersOf(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof ArrayBuffer) buffers.add(v);
    else if (ArrayBuffer.isView(v)) {
      // A SharedArrayBuffer is not transferable; it is cloned by reference.
      if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
    } else if (isPlain(v)) {
      // Only objects are worth a visit: a list of a million numbers adds nothing to the stack.
      for (const child of Object.values(v)) if (typeof child === 'object' && child !== null) stack.push(child);
    }
  }
  return [...buffers];
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

async function serveOne(port: CpuTaskPort, request: CpuTaskRequest): Promise<void> {
  const { id } = request;
  const post = (reply: CpuTaskReply, transfer: ArrayBuffer[]): void => port.postMessage(reply, transfer);
  try {
    const task = findCpuTask(request.task);
    if (!task) throw new Error(`CPU task "${request.task}" is not defined in the CPU worker`);
    const value: unknown = await task.run(request.args, {
      progress(fraction: number): void {
        if (Number.isNaN(fraction)) return;
        post({ id, type: 'progress', fraction: Math.min(1, Math.max(0, fraction)) }, []);
      },
    });
    const reply: CpuTaskReply = { id, type: 'result', value };
    try {
      post(reply, buffersOf(value));
    } catch {
      // A buffer that cannot be moved, the memory of a WebAssembly module for one, is copied. Nothing was detached.
      post(reply, []);
    }
  } catch (error) {
    // Also reached when the result cannot be cloned: the request still gets its one answer.
    try {
      post({ id, type: 'error', message: messageOf(error) }, []);
    } catch {
      // The port is closed. A rejection here would stop every later task of the queue.
    }
  }
}

/** The whole worker side: receives task messages on `port`, runs the tasks defined in this thread, posts results. */
export function serveCpuTasks(port: CpuTaskPort): void {
  // One task at a time, in the order the requests arrive (runtime.md 6.3 rule 2).
  let last: Promise<void> = Promise.resolve();
  port.addEventListener('message', (e) => {
    const request = e.data;
    if (!isRequest(request)) return;
    last = last.then(() => serveOne(port, request));
  });
  port.start?.();
}
