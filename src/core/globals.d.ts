// The globals src/core/ may use (runtime.md 8.4), and no others. tsconfig.core.json has neither DOM nor Node
// types; the files of core are compiled again under Node's, a worker's and a page's types by the programs
// that import them. Each shape below is therefore the part all three environments share: results are typed
// as widely and arguments as narrowly as any of them does.

declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

declare const performance: { now(): number };

// A timer handle is a number in a browser and an object in Node. Its type is ReturnType<typeof setTimeout>, never number.
declare function setTimeout(handler: () => void, ms?: number): { readonly __timeout: never };
declare function clearTimeout(id: ReturnType<typeof setTimeout> | undefined): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T, options?: { transfer: ArrayBuffer[] }): T;

interface DOMException extends Error {
  readonly name: string;
  readonly message: string;
}
declare const DOMException: { new (message?: string, name?: string): DOMException; readonly prototype: DOMException };

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
declare const AbortSignal: {
  readonly prototype: AbortSignal;
  abort(reason?: unknown): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare const AbortController: { new (): AbortController; readonly prototype: AbortController };

interface TextEncoder {
  encode(input?: string): Uint8Array;
}
declare const TextEncoder: { new (): TextEncoder; readonly prototype: TextEncoder };
interface TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare const TextDecoder: { new (label?: string, options?: { fatal?: boolean }): TextDecoder; readonly prototype: TextDecoder };

declare const crypto: {
  getRandomValues<T extends Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>>(array: T): T;
};

// A type only, and opaque: core passes a canvas on and never touches it. Node's types know no members of it.
interface OffscreenCanvas {}
