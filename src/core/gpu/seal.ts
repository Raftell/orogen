// engine.md, Module scope: the first createEngine call of a thread seals the four define functions.

export type DefineFunction = 'defineLib' | 'defineKernel' | 'defineCpuTask' | 'defineNode';

let sealed = false;

/** Called by createEngine. Idempotent. */
export function sealDefinitions(): void {
  sealed = true;
}

/** Called first by each define function; throws once the definitions are sealed. */
export function assertUnsealed(fn: DefineFunction): void {
  if (sealed) {
    throw new Error(`${fn}() was called after createEngine(). Definitions are made at module scope, before the engine exists`);
  }
}
