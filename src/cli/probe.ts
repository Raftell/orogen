// `orogen probe` (testing.md 8.6): the device's GpuCaps as indented JSON on standard output. Every CI job runs
// it first, so a log shows what the tests ran on; opening a device prints nothing by itself (runtime.md 1.3).

import { createNodeGpu } from '../platform/node/gpu.ts';
import type { ProbeCommand } from './args.ts';

/** Resolves with the exit code; rejects with GpuUnavailableError when the options give no usable device. */
export async function probe(command: ProbeCommand): Promise<number> {
  const { profile, adapter } = command.device;
  const gpu = await createNodeGpu({ profile, ...(adapter !== undefined ? { adapter } : {}) });
  try {
    process.stdout.write(`${JSON.stringify(gpu.caps, null, 2)}\n`);
  } finally {
    gpu.destroy();
  }
  return 0;
}
