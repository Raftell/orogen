// The card's memory from nvidia-smi where the adapter reports none (runtime.md 1.3), and the budget line of the
// command line (2.4): the answer read and matched to the adapter, every way the tool can fail given as an injected
// result, the runner on real programs, and the real nvidia-smi where this machine has one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { GpuCaps } from '../../src/core/runtime.ts';
import {
  budgetLine, memoryOfCard, NVIDIA_SMI_ARGS, NVIDIA_SMI_TIMEOUT_MS, nvidiaSmiPrograms, parseNvidiaSmi, queryNvidiaSmi, runProgram, withCardMemory,
  type NvidiaCard, type ProgramResult,
} from '../../src/platform/node/vram.ts';

const MIB = 2 ** 20;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-vram-'));
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

/** The adapters as Dawn in Node names them: the target machine's under D3D12 and the development machine's under Vulkan, as measured. */
const RTX_3080 = { device: 'nvidia-geforce-rtx-3080', description: 'D3D12 driver version 32.0.16.1714' };
const GTX_1660_TI = { device: 'nvidia-geforce-gtx-1660-ti', description: 'NVIDIA: 595.99.02 595.99.2.0' };
const card = (name: string, mib: number): NvidiaCard => ({ name, bytes: mib * MIB });

test('nvidia-smi: its answer is read as a figure in MiB and a name a line, and a line without a figure is left out', () => {
  assert.deepEqual(parseNvidiaSmi('10240, NVIDIA GeForce RTX 3080\r\n'), [card('NVIDIA GeForce RTX 3080', 10240)], 'as on Windows, with CRLF');
  assert.deepEqual(parseNvidiaSmi('6144, NVIDIA GeForce GTX 1660 Ti\n'), [card('NVIDIA GeForce GTX 1660 Ti', 6144)]);
  assert.deepEqual(
    parseNvidiaSmi('24576, NVIDIA RTX A5000\n[N/A], NVIDIA Something\n\n8192,Tesla, rev 2\n0, Nothing\n-1, Less\n12.5, Half\n1024,\nNo devices were found\n'),
    [card('NVIDIA RTX A5000', 24576), card('Tesla, rev 2', 8192)],
  );
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n"), []);
});

test("nvidia-smi: the card is the one whose name is the adapter's, compared by letters and digits", () => {
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce RTX 3080', 10240)]), 10240 * MIB);
  assert.equal(memoryOfCard(GTX_1660_TI, [card('NVIDIA GeForce GTX 1660 Ti', 6144)]), 6144 * MIB);
  // Chromium names the adapter by its description and gives the device as a number.
  assert.equal(memoryOfCard({ device: '0x2216', description: 'NVIDIA GeForce RTX 3080' }, [card('NVIDIA GeForce RTX 3080', 10240)]), 10240 * MIB);
  // Older drivers leave the maker out of the name.
  assert.equal(memoryOfCard({ device: 'nvidia-geforce-gtx-1080', description: '' }, [card('GeForce GTX 1080', 8192)]), 8192 * MIB);
  // Of several cards, the adapter's.
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce GTX 1660 Ti', 6144), card('NVIDIA GeForce RTX 3080', 10240)]), 10240 * MIB);
  // Two cards of the same name and memory: either.
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce RTX 3080', 10240), card('NVIDIA GeForce RTX 3080', 10240)]), 10240 * MIB);
});

test('nvidia-smi: an answer that names other cards, or two figures for one name, gives nothing', () => {
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce GTX 1660 Ti', 6144)]), null);
  // A name that is only a part of the adapter's, or holds it, is another card.
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce RTX 3080 Ti', 12288)]), null);
  assert.equal(memoryOfCard({ device: 'nvidia-geforce-rtx-3080-ti', description: '' }, [card('NVIDIA GeForce RTX 3080', 10240)]), null);
  assert.equal(memoryOfCard(RTX_3080, [card('NVIDIA GeForce RTX 3080', 10240), card('NVIDIA GeForce RTX 3080', 12288)]), null);
  // The software adapters CI selects, on a machine that also has an NVIDIA card.
  assert.equal(memoryOfCard({ device: 'microsoft-basic-render-driver', description: 'D3D12 driver version 10.0.26100.33438' }, [card('NVIDIA GeForce RTX 3080', 10240)]), null);
  assert.equal(memoryOfCard({ device: 'llvmpipe-llvm-20-1-2-256-bits-', description: 'Mesa 25.0.7' }, [card('NVIDIA GeForce GTX 1660 Ti', 6144)]), null);
  assert.equal(memoryOfCard({ device: 'nvidia', description: '' }, [card('NVIDIA', 6144)]), null, 'a maker is no card');
  assert.equal(memoryOfCard(RTX_3080, []), null);
});

/** caps as Dawn in Node gives them, only what this module reads, and what the adapter said of its memory. */
function capsOf(adapter: { device: string; description: string }, vramBytes: number | null = null): GpuCaps {
  return {
    adapter: { vendor: 'nvidia', architecture: 'ampere', ...adapter, isFallbackAdapter: false, backend: null },
    software: false, vramBytes, vramSource: vramBytes === null ? null : 'adapter',
  } as unknown as GpuCaps;
}

test("nvidia-smi: caps take its figure where the adapter reported none, and say so; the adapter's own figure stays", () => {
  const caps = capsOf(RTX_3080);
  const completed = withCardMemory(caps, [card('NVIDIA GeForce RTX 3080', 10240)]);
  assert.deepEqual(completed, { ...caps, vramBytes: 10240 * MIB, vramSource: 'nvidia-smi' });
  assert.deepEqual([caps.vramBytes, caps.vramSource], [null, null], 'the caps given are not changed');

  assert.equal(withCardMemory(caps, null), caps, 'no answer');
  assert.equal(withCardMemory(caps, [card('NVIDIA GeForce RTX 3080 Ti', 12288)]), caps, 'another card');
  const reported = capsOf(RTX_3080, 9 * 2 ** 30);
  assert.equal(withCardMemory(reported, [card('NVIDIA GeForce RTX 3080', 10240)]), reported, "the adapter's figure is kept");
});

/** A runner that answers from a list and records what it was asked. */
function scripted(...answers: ProgramResult[]): { readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProgramResult>; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (file, args, timeoutMs) => {
      assert.deepEqual(args, NVIDIA_SMI_ARGS);
      assert.equal(timeoutMs, NVIDIA_SMI_TIMEOUT_MS);
      calls.push(file);
      const answer = answers.shift();
      assert.ok(answer, `${file} was run after the last scripted answer`);
      return Promise.resolve(answer);
    },
  };
}

test('nvidia-smi: the first program that exists is asked once, with the arguments and the time limit', async () => {
  assert.deepEqual(NVIDIA_SMI_ARGS, ['--query-gpu=memory.total,name', '--format=csv,noheader,nounits']);
  assert.ok(NVIDIA_SMI_TIMEOUT_MS <= 5000, 'a short time limit');

  const found = scripted({ status: 'ok', stdout: '10240, NVIDIA GeForce RTX 3080\r\n' });
  assert.deepEqual(await queryNvidiaSmi(found.run, ['first', 'second']), [card('NVIDIA GeForce RTX 3080', 10240)]);
  assert.deepEqual(found.calls, ['first']);

  const second = scripted({ status: 'missing' }, { status: 'ok', stdout: '6144, NVIDIA GeForce GTX 1660 Ti\n' });
  assert.deepEqual(await queryNvidiaSmi(second.run, ['first', 'second']), [card('NVIDIA GeForce GTX 1660 Ti', 6144)]);
  assert.deepEqual(second.calls, ['first', 'second']);
});

test('nvidia-smi: missing, failing, slow, or with no card in its answer, it gives nothing, and a failure is not retried elsewhere', async () => {
  const none = scripted({ status: 'missing' }, { status: 'missing' });
  assert.equal(await queryNvidiaSmi(none.run, ['first', 'second']), null);
  assert.deepEqual(none.calls, ['first', 'second']);

  for (const reason of ['ended with 9', `no answer within ${NVIDIA_SMI_TIMEOUT_MS} ms`, 'printed more than 65536 bytes']) {
    const failed = scripted({ status: 'failed', reason });
    assert.equal(await queryNvidiaSmi(failed.run, ['first', 'second']), null, reason);
    assert.deepEqual(failed.calls, ['first'], reason);
  }
  const empty = scripted({ status: 'ok', stdout: 'No devices were found\n' });
  assert.equal(await queryNvidiaSmi(empty.run, ['first']), null);
  assert.equal(await queryNvidiaSmi(() => Promise.reject(new Error('a runner that throws')), ['first']), null, 'it never rejects');
  assert.equal(await queryNvidiaSmi(scripted().run, []), null);
});

test('nvidia-smi: on Windows only absolute paths are run, where NVIDIA installs it; elsewhere the name, from PATH', () => {
  const windows = nvidiaSmiPrograms('win32', { SystemRoot: 'C:\\Windows', ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files (x86)' });
  assert.deepEqual(windows, ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']);
  // Windows looks for a bare program name in the current folder before PATH.
  for (const program of nvidiaSmiPrograms('win32', {})) assert.ok(path.win32.isAbsolute(program), program);
  assert.deepEqual(nvidiaSmiPrograms('linux', {}), ['nvidia-smi']);
});

test('runProgram: the arguments reach a real program as they are, with no shell; its end is told apart', async () => {
  const node = process.execPath;
  const odd = ['$HOME', '%PATH%', 'a & b | c', '"quoted" \'too\'', '; echo no'];
  const echoed = await runProgram(node, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...odd], 30_000);
  assert.equal(echoed.status, 'ok', JSON.stringify(echoed));
  assert.deepEqual(JSON.parse((echoed as { stdout: string }).stdout), odd);

  assert.deepEqual(await runProgram(path.join(scratch, 'no-such-program'), [], 30_000), { status: 'missing' });
  const failed = await runProgram(node, ['-e', 'process.exit(9)'], 30_000);
  assert.deepEqual(failed, { status: 'failed', reason: 'ended with 9' });
  const flood = await runProgram(node, ['-e', 'process.stdout.write("x".repeat(1 << 20))'], 30_000);
  assert.deepEqual(flood, { status: 'failed', reason: 'printed more than 65536 bytes' });
});

test('runProgram: a program that does not end within the time limit is given up and killed', async () => {
  const marker = path.join(scratch, 'still-running');
  // It would write the file 1.5 s after it starts; it is given 100 ms. However late it starts, it never writes.
  const slow = await runProgram(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`], 100);
  assert.deepEqual(slow, { status: 'failed', reason: 'no answer within 100 ms' });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(fs.existsSync(marker), false, 'the program was killed');
});

test('nvidia-smi on this machine: what the query reads is what the tool prints', async (t) => {
  const program = nvidiaSmiPrograms().find((file) => !path.isAbsolute(file) || fs.existsSync(file)) ?? null;
  const direct = program === null ? null : spawnSync(program, NVIDIA_SMI_ARGS, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const cards = await queryNvidiaSmi();
  if (direct === null || direct.error !== undefined || direct.status !== 0) {
    t.diagnostic('this machine has no working nvidia-smi');
    assert.equal(cards, null);
    return;
  }
  const lines = direct.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  t.diagnostic(`nvidia-smi: ${lines.join(' | ')}`);
  assert.deepEqual(cards, lines.map((line) => {
    const [mib, ...name] = line.split(',');
    return card(name.join(',').trim(), Number(mib));
  }));
});

test('the budget line says how much, and where the figure of the card came from', () => {
  const known = (source: 'adapter' | 'nvidia-smi'): Pick<GpuCaps, 'vramBytes' | 'vramSource'> => ({ vramBytes: 10240 * MIB, vramSource: source });
  const unknown: Pick<GpuCaps, 'vramBytes' | 'vramSource'> = { vramBytes: null, vramSource: null };
  assert.equal(budgetLine(known('nvidia-smi'), 6144 * MIB, false), "GPU memory budget 6144 MiB: 60 % of the card's 10240 MiB, which nvidia-smi reports");
  assert.equal(budgetLine(known('adapter'), 6144 * MIB, false), "GPU memory budget 6144 MiB: 60 % of the card's 10240 MiB, which the adapter reports");
  assert.equal(budgetLine(unknown, Math.floor(4 * 2 ** 30 * 0.6), false),
    'GPU memory budget 2457 MiB: the default for a card whose memory neither the adapter nor nvidia-smi reports; --budget-mb sets another');
  assert.equal(budgetLine(known('nvidia-smi'), 6000 * MIB, true), 'GPU memory budget 6000 MiB, from --budget-mb; the card has 10240 MiB, which nvidia-smi reports');
  assert.equal(budgetLine(unknown, 6000 * MIB, true), "GPU memory budget 6000 MiB, from --budget-mb; neither the adapter nor nvidia-smi reports the card's memory");
});
