// The messages between a platform's CpuRunner and serveCpuTasks (runtime.md 6.3). The runner posts one request
// per task, with the caller's transfer list; the worker answers with progress messages and one result or error.
// There is no cancel message: a runner cancels by terminating its worker.

export interface CpuTaskRequest {
  readonly id: number;
  readonly task: string;       // CpuTask.name
  readonly args: unknown;
}

export type CpuTaskReply =
  | { readonly id: number; readonly type: 'progress'; readonly fraction: number }
  | { readonly id: number; readonly type: 'result'; readonly value: unknown }   // the buffers of its typed arrays are transferred
  | { readonly id: number; readonly type: 'error'; readonly message: string };  // the task threw, or its name is unknown
