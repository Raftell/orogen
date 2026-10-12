export interface CpuRunner {
  run(taskName: string, args: unknown, transfer: readonly ArrayBuffer[],
      opts: { readonly signal: AbortSignal; readonly onProgress: (fraction: number) => void }): Promise<unknown>;
  dispose(): Promise<void>;
}
