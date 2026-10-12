/** Throws unless Engine.memory() reports workingBytes === 0 and pinnedBytes === 0. The message carries the MemoryReport. */
export function expectNoLeaks(): Promise<void> {
  throw new Error('not implemented: expectNoLeaks');
}
