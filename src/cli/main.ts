#!/usr/bin/env node
// The command-line program `orogen` (testing.md 8.6):
//
//   node src/cli/main.ts <subcommand> [options]         npm run orogen -- <subcommand> [options]
//
// This module reads the subcommand, hands over to the module that implements it, and ends the process. Exit
// codes (export-unreal.md 3.11): 0 success, 1 a node failed, 2 usage error, 3 no usable device or device
// lost, 130 cancelled.

import { DeviceLostError, GpuUnavailableError } from '../core/runtime.ts';
import { parseCommand, usageOf, UsageError, type ExportCommand } from './args.ts';

// Not a literal in the import below: the module belongs to the export stage, and a program that names a file
// which does not exist does not type-check.
const EXPORT_CLI = '../export/cli.ts';

/** What src/export/cli.ts exports for `build` and `unreal-test` (testing.md 8.6). */
type RunExportCli = (subcommand: 'build' | 'unreal-test', args: readonly string[], signal: AbortSignal) => Promise<number>;

async function exportCommand(command: ExportCommand, signal: AbortSignal): Promise<number> {
  let run: unknown;
  try {
    run = ((await import(EXPORT_CLI)) as { readonly runExportCli?: unknown }).runExportCli;
  } catch (thrown) {
    // Only the absence of that one file: a module it imports and cannot find is a defect to show, not a missing stage.
    const failure = thrown as { readonly code?: unknown; readonly url?: unknown } | null;
    if (failure?.code !== 'ERR_MODULE_NOT_FOUND' || failure.url !== new URL(EXPORT_CLI, import.meta.url).href) throw thrown;
  }
  if (typeof run !== 'function') {
    process.stderr.write(
      `orogen ${command.subcommand}: this build of Orogen has no build pipeline: "build" and "unreal-test" are implemented by src/export/cli.ts (export-unreal.md 3.11), which ${run === undefined ? 'does not exist' : 'exports no runExportCli'}. Nothing was planned or written.\n`,
    );
    return 2;
  }
  return (run as RunExportCli)(command.subcommand, command.args, signal);
}

/**
 * Standard output carries the result of a subcommand and nothing else: the JSON of `probe` and `render`, the
 * path `gallery` prints. Whatever the engine or a node logs on the way (the device line of OROGEN_GPU_LOG=1,
 * for one) goes to standard error.
 */
function logToStandardError(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}

/** Runs the program with the arguments after `orogen`. Resolves with the exit code. */
export async function run(argv: readonly string[], signal: AbortSignal): Promise<number> {
  try {
    const command = parseCommand(argv, process.env, process.cwd());
    switch (command.command) {
      case 'help':
        process.stdout.write(`${usageOf(command.subcommand)}\n`);
        return 0;
      case 'export':
        return await exportCommand(command, signal);
      case 'probe':
        logToStandardError();
        return await (await import('./probe.ts')).probe(command);
      case 'render':
        logToStandardError();
        return await (await import('./render.ts')).render(command, signal);
      case 'gallery':
        logToStandardError();
        return await (await import('./gallery.ts')).gallery(command, signal);
    }
  } catch (thrown) {
    if (thrown instanceof UsageError) {
      process.stderr.write(`orogen: ${thrown.message}\n${usageOf(thrown.subcommand)}\n`);
      return 2;
    }
    if (thrown instanceof GpuUnavailableError || thrown instanceof DeviceLostError) {
      process.stderr.write(`orogen: ${thrown.message}\n`);
      return 3;
    }
    if (signal.aborted && thrown === signal.reason) {
      process.stderr.write('orogen: cancelled\n');
      return 130;
    }
    process.stderr.write(`orogen: ${thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)}\n`);
    return 1;
  }
}

/** Resolves when everything written to the stream so far has left the process. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) resolve();
    else stream.write('', () => resolve());
  });
}

if (import.meta.main) {
  // A reader that goes away (`orogen probe | head -1`) is no failure of the program.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const controller = new AbortController();
  let signals = 0;
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      // The first signal cancels and the program ends in order; a second one ends it at once.
      if (++signals > 1) process.exit(130);
      controller.abort(new DOMException(`Cancelled by ${name}`, 'AbortError'));
    });
  }

  const code = await run(process.argv.slice(2), controller.signal);
  // runtime.md 1.5 rule 5: with Dawn in the process, a command-line tool ends by process.exit once its output is flushed.
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
