import { NodeDefError } from '../gpu/errors.ts';
import { assertUnsealed } from '../gpu/seal.ts';

export interface CpuEnv { progress(fraction: number): void }
export interface CpuTask<A, R> {
  readonly name: string;
  readonly run: (args: A, env: CpuEnv) => R;
}
export type AnyCpuTask = CpuTask<any, any>;

// A kernel name without the variant suffix (engine.md 3.13, 4.11 rule 1).
const TASK_NAME = /^[a-z]+\/[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

// One table per thread: a worker thread loads its own instance of this module.
const table = new Map<string, { readonly task: AnyCpuTask; readonly run: unknown }>();

export function defineCpuTask<A, R>(def: { name: string; run(args: A, env: CpuEnv): R }): CpuTask<A, R> {
  assertUnsealed('defineCpuTask');
  const name: unknown = def?.name;
  if (typeof name !== 'string' || !TASK_NAME.test(name)) {
    throw new NodeDefError(`task ${JSON.stringify(name)}: invalid task name`);
  }
  if (typeof def.run !== 'function') throw new NodeDefError(`task "${name}": run must be a function`);
  const defined = table.get(name);
  if (defined) {
    if (defined.run === def.run) return defined.task;
    throw new NodeDefError(`task "${name}": a different task with this name is already defined`);
  }
  const run = def.run;
  const task: CpuTask<A, R> = Object.freeze({ name, run: (args: A, env: CpuEnv): R => def.run(args, env) });
  table.set(name, { task, run });
  return task;
}

/** The task of that name in this thread's table (engine.md, Module scope), or undefined. */
export function findCpuTask(name: string): AnyCpuTask | undefined {
  return table.get(name)?.task;
}
