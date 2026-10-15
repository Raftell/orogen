// The card's memory where the adapter does not report it (runtime.md 1.3). Dawn in Node exposes no
// adapter.info.memoryHeaps, under Vulkan on Linux as under D3D12 on Windows; NVIDIA's driver installs its own
// tool, nvidia-smi, on both. Its answer counts only for the card the adapter is, found by name; a tool that is
// missing, fails, is slow or names other cards leaves the figure unknown, and the budget at its default (2.4).

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_PREFERENCES, type GpuCaps } from '../../core/runtime.ts';

const MIB = 2 ** 20;

/** The memory in MiB and the name of every NVIDIA card, a line each: `6144, NVIDIA GeForce GTX 1660 Ti`. */
export const NVIDIA_SMI_ARGS: readonly string[] = ['--query-gpu=memory.total,name', '--format=csv,noheader,nounits'];
/** It answered in about 30 ms on the development machine; a driver that is still starting takes longer. */
export const NVIDIA_SMI_TIMEOUT_MS = 3000;
/** A line per card: an answer longer than this is not one. */
const OUTPUT_MAX_BYTES = 64 * 1024;

/** How a program ended: what it printed when it ended with 0; `missing` when there is no such program. */
export type ProgramResult =
  | { readonly status: 'ok'; readonly stdout: string }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly reason: string };

/** Runs a program without a shell and gives it `timeoutMs`. Never rejects. */
export type RunProgram = (file: string, args: readonly string[], timeoutMs: number) => Promise<ProgramResult>;

const describe = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * The arguments reach the program as they are: no shell reads them. Without a window on Windows, without input.
 * At the time limit the program is killed and no longer holds this process, whether or not it ends.
 */
export const runProgram: RunProgram = (file, args, timeoutMs) => new Promise((resolve) => {
  let child: ChildProcess;
  try {
    child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (thrown) {
    resolve({ status: 'failed', reason: describe(thrown) });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  let timer: NodeJS.Timeout | undefined;
  const end = (result: ProgramResult): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.unref();
    resolve(result);
  };
  timer = setTimeout(() => end({ status: 'failed', reason: `no answer within ${timeoutMs} ms` }), timeoutMs);
  child.on('error', (error: NodeJS.ErrnoException) => end(error.code === 'ENOENT' ? { status: 'missing' } : { status: 'failed', reason: error.message }));
  child.stdout?.on('error', () => {});
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > OUTPUT_MAX_BYTES) end({ status: 'failed', reason: `printed more than ${OUTPUT_MAX_BYTES} bytes` });
    else chunks.push(chunk);
  });
  child.on('close', (code, signal) => {
    end(code === 0 ? { status: 'ok', stdout: Buffer.concat(chunks).toString('utf8') } : { status: 'failed', reason: `ended with ${code ?? signal}` });
  });
});

/**
 * Where nvidia-smi may be, in the order tried. On Windows only absolute paths: Windows looks for a bare program
 * name in the current folder before PATH. NVIDIA's DCH drivers put it in System32, older ones in NVSMI.
 */
export function nvidiaSmiPrograms(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== 'win32') return ['nvidia-smi'];
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  return [
    path.win32.join(systemRoot, 'System32', 'nvidia-smi.exe'),
    path.win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
}

/** One card of nvidia-smi's answer. */
export interface NvidiaCard { readonly name: string; readonly bytes: number }

/** The cards of nvidia-smi's answer to NVIDIA_SMI_ARGS. A line without a figure in MiB (`[N/A]`) is left out. */
export function parseNvidiaSmi(stdout: string): NvidiaCard[] {
  const cards: NvidiaCard[] = [];
  for (const line of stdout.split('\n')) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const mib = line.slice(0, comma).trim();
    const name = line.slice(comma + 1).trim();
    if (/^[1-9]\d{0,8}$/.test(mib) && name !== '') cards.push({ name, bytes: Number(mib) * MIB });
  }
  return cards;
}

/**
 * Asks nvidia-smi for the memory of every NVIDIA card: the first of `programs` that exists is run. Null when none
 * exists, it fails, it does not answer within NVIDIA_SMI_TIMEOUT_MS, or its answer holds no card. Never rejects.
 */
export async function queryNvidiaSmi(run: RunProgram = runProgram, programs: readonly string[] = nvidiaSmiPrograms()): Promise<NvidiaCard[] | null> {
  try {
    for (const program of programs) {
      const result = await run(program, NVIDIA_SMI_ARGS, NVIDIA_SMI_TIMEOUT_MS);
      if (result.status === 'missing') continue;
      if (result.status === 'failed') return null;
      const cards = parseNvidiaSmi(result.stdout);
      return cards.length > 0 ? cards : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A card's name by its letters and digits, without a leading maker's name, which older drivers leave out:
 * WebGPU's `nvidia-geforce-rtx-3080` is nvidia-smi's `NVIDIA GeForce RTX 3080`.
 */
const cardName = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^nvidia/, '');

/**
 * The memory of the adapter's card: the figure of the cards whose name is the adapter's `device` or
 * `description`, when they all give the same; else null. A name only part of another (RTX 3080 in RTX 3080 Ti) is
 * not it.
 */
export function memoryOfCard(adapter: Pick<GpuCaps['adapter'], 'device' | 'description'>, cards: readonly NvidiaCard[]): number | null {
  const names = [adapter.device, adapter.description].map(cardName).filter((name) => name !== '');
  const figures = new Set(cards.filter((card) => names.includes(cardName(card.name))).map((card) => card.bytes));
  return figures.size === 1 ? [...figures][0]! : null;
}

/** caps with the card's memory from nvidia-smi's answer, where the adapter reported none and the answer names the card. */
export function withCardMemory(caps: GpuCaps, cards: readonly NvidiaCard[] | null): GpuCaps {
  if (caps.vramBytes !== null || cards === null) return caps;
  const bytes = memoryOfCard(caps.adapter, cards);
  return bytes === null ? caps : { ...caps, vramBytes: bytes, vramSource: 'nvidia-smi' };
}

/**
 * The line a command that evaluates prints of its GPU memory budget (runtime.md 2.4): how much, and where the
 * card's figure came from. `given`: the budget is that of --budget-mb, else the default of the formula.
 */
export function budgetLine(caps: Pick<GpuCaps, 'vramBytes' | 'vramSource'>, budgetBytes: number, given: boolean): string {
  const mib = (bytes: number): string => `${Math.floor(bytes / MIB)} MiB`;
  const budget = `GPU memory budget ${mib(budgetBytes)}`;
  const reported = caps.vramBytes !== null && caps.vramSource !== null
    ? `${mib(caps.vramBytes)}, which ${caps.vramSource === 'adapter' ? 'the adapter' : 'nvidia-smi'} reports`
    : null;
  if (given) return `${budget}, from --budget-mb; ${reported === null ? "neither the adapter nor nvidia-smi reports the card's memory" : `the card has ${reported}`}`;
  if (reported === null) return `${budget}: the default for a card whose memory neither the adapter nor nvidia-smi reports; --budget-mb sets another`;
  return `${budget}: ${Math.round(DEFAULT_PREFERENCES.budgetFraction * 100)} % of the card's ${reported}`;
}
