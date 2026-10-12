import type { EngineEvent } from './events.ts';

// runtime.md 7.2. `method` is the member's name of EngineSession, with the prefix `viewport.` for ViewportHost.

export type ClientMessage = { readonly id: number; readonly method: string; readonly args: readonly unknown[] };
export type WorkerMessage =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { readonly name: string; readonly message: string } }
  | { readonly event: EngineEvent };
