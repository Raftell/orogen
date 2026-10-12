// Estimates (runtime.md 5.10) and the kinds of node errors (5.8). No device is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BudgetExceededError, DeviceLostError, FieldAccessError, FileError, KernelBindingError } from '../../../src/core/api.ts';
import { budgetMessage, byContext, ContextError, InternalError, nodeErrorFrom, outOfMemoryMessage } from '../../../src/core/eval/errors.ts';
import { buildPlan } from '../../../src/core/eval/plan.ts';
import { etaMs, nodeWeights } from '../../../src/core/eval/progress.ts';
import { KernelCompileError } from '../../../src/core/gpu/pipelines.ts';
import { GpuOutOfMemoryError, GpuValidationError, WatchdogError } from '../../../src/core/gpu/stream.ts';
import { createRegistry, type GraphDoc, type MemoryReport } from '../../../src/core/runtime.ts';
import { node } from '../graph-fixtures.ts';

test('etaMs: elapsed x (1 - f) / f once f is at least 0.05 and enough time has passed', () => {
  assert.equal(etaMs(1000, 0.25, 500), 3000);
  assert.equal(etaMs(1000, 1, 500), 0);
  assert.equal(etaMs(1000, 0.05, 500), 19000);
  assert.equal(etaMs(1000, 0.049, 500), null);
  assert.equal(etaMs(499, 0.5, 500), null);
  assert.equal(etaMs(500, 0.5, 500), 500);
  assert.equal(etaMs(1000, 0.5, 1000), 1000);
  assert.equal(etaMs(1000, NaN, 0), null);
  assert.equal(etaMs(1000, 3, 0), 0, 'a fraction above 1 counts as 1');
});

test('node weights: the last timing scaled by texel count, the median for a node without one, 0 for a settled node', () => {
  const registry = createRegistry([node({ type: 'ref/gen' })]);
  const nodes: Record<string, unknown> = {};
  for (const id of ['a', 'b', 'c', 'd', 'e']) nodes[id] = { id, type: 'ref/gen', version: 1, position: { x: 0, y: 0 }, params: {} };
  const doc = { format: 'orogen', version: 1, settings: {}, nodes, edges: {}, groups: {}, ui: {} } as unknown as GraphDoc;
  const plan = buildPlan(doc, registry, ['a', 'b', 'c', 'd', 'e'].map((id) => ({ node: id })));
  const timings: Record<string, { resolution: number; wallMs: number }> = {
    a: { resolution: 257, wallMs: 10 }, b: { resolution: 513, wallMs: 40 }, c: { resolution: 129, wallMs: 1000 },
  };
  const weights = nodeWeights(plan, new Set(['c']), 513, (id) => timings[id] ?? null);
  const scaled = 10 * (513 / 257) ** 2;
  assert.deepEqual([...weights], [['a', scaled], ['b', 40], ['c', 0], ['d', (scaled + 40) / 2], ['e', (scaled + 40) / 2]]);
  assert.deepEqual([...nodeWeights(plan, new Set(['a', 'b']), 513, () => null).values()], [0, 0, 1, 1, 1], 'no timing anywhere: 1');
  assert.deepEqual([...nodeWeights(plan, new Set(), 100, (id) => (id === 'd' ? { resolution: 100, wallMs: 7 } : null)).values()], [7, 7, 7, 7, 7]);
});

test('the kind of a node error follows from what was thrown', () => {
  const at = { id: 'n1', type: 'ref/gen' };
  const kind = (thrown: unknown): string => nodeErrorFrom(thrown, at, 513, 64 * 1048576).kind;
  const report: MemoryReport = { budgetBytes: 100 * 1048576, workingBytes: 30 * 1048576, cacheBytes: 5 * 1048576, pinnedBytes: 50 * 1048576, freeBytes: 0, reservedBytes: 10 * 1048576, drainingBytes: 0 };

  const binding = nodeErrorFrom(new KernelBindingError('kernel "ref/talus.step" (node n1, ref/gen): missing param "rate"'), at, 513, 0);
  assert.deepEqual(binding, { nodeId: 'n1', nodeType: 'ref/gen', kind: 'binding', message: 'kernel "ref/talus.step" (node n1, ref/gen): missing param "rate"', kernel: 'ref/talus.step' });
  assert.equal(kind(new FieldAccessError('field #3 was released')), 'binding');
  assert.equal(kind(new ContextError('output "out" was not produced')), 'binding');
  // A RangeError is the context's only when the context raised it.
  assert.equal(kind(byContext(new RangeError('a field side is 1 to 8192 texels'))), 'binding');
  assert.equal(kind(new RangeError('Invalid array length')), 'node-exception');

  const validation = nodeErrorFrom(new GpuValidationError('Texture usage is invalid', 'Texture usage is invalid\n - while encoding'), at, 513, 0);
  assert.deepEqual([validation.kind, validation.message, validation.detail], ['validation', 'Texture usage is invalid', 'Texture usage is invalid\n - while encoding']);

  const budget = nodeErrorFrom(new BudgetExceededError('does not fit', { requestedBytes: 25 * 1048576, kind: 'field', width: 2560, height: 2560, report }), at, 513, 0);
  // 30 working + 50 pinned + 10 reserved + 25 asked for, against 100.
  assert.deepEqual([budget.kind, budget.message, budget.detail], ['budget', 'Needs 15 MB more GPU memory at 513 × 513: budget 100 MB, 30 MB in use by this node, 50 MB pinned', 'does not fit']);
  assert.equal(budgetMessage(1, 65, 3 * 1048576, 0, 0), 'Needs 1 MB more GPU memory at 65 × 65: budget 3 MB, 0 MB in use by this node, 0 MB pinned');

  const oom = nodeErrorFrom(new GpuOutOfMemoryError('The GPU reported out of memory: x'), at, 513, 64 * 1048576);
  assert.deepEqual([oom.kind, oom.message], ['out-of-memory', 'Out of GPU memory at 513 × 513 (budget 64 MB). Lower the resolution or raise the GPU memory budget']);
  assert.equal(outOfMemoryMessage(8129, 6 * 1024 * 1048576), 'Out of GPU memory at 8129 × 8129 (budget 6144 MB). Lower the resolution or raise the GPU memory budget');

  const watchdog = nodeErrorFrom(new WatchdogError('kernel "simulate/flow" cannot be tiled and one dispatch is estimated at 900 ms; the limit is 500 ms'), at, 513, 0);
  assert.deepEqual([watchdog.kind, watchdog.kernel], ['watchdog', 'simulate/flow']);
  assert.deepEqual(nodeErrorFrom(new FileError('not-found', '/a.png', 'File not found: /a.png'), at, 513, 0), { nodeId: 'n1', nodeType: 'ref/gen', kind: 'io', message: 'File not found: /a.png' });
  assert.equal(kind(new InternalError('the conversion failed')), 'internal');

  const diagnostic = { origin: 'code' as const, line: 3, column: 7, length: 2, message: 'unresolved value', excerpt: ['a', 'b'] };
  const compile = nodeErrorFrom(new KernelCompileError('kernel "ref/fbm": unresolved value', { kernel: 'ref/fbm', diagnostic, detail: '3:7 unresolved value' }), at, 513, 0);
  assert.deepEqual(compile, { nodeId: 'n1', nodeType: 'ref/gen', kind: 'shader-compile', message: 'kernel "ref/fbm": unresolved value', detail: '3:7 unresolved value', kernel: 'ref/fbm', wgsl: diagnostic });
  assert.equal('wgsl' in nodeErrorFrom(new KernelCompileError('kernel "x/y": no', { kernel: 'x/y', diagnostic: null, detail: 'no' }), at, 513, 0), false);

  const plain = nodeErrorFrom(new Error('No file selected\nsecond line'), at, 513, 0);
  assert.deepEqual([plain.kind, plain.message, typeof plain.detail], ['node-exception', 'No file selected', 'string']);
  assert.deepEqual(nodeErrorFrom('a string', at, 513, 0), { nodeId: 'n1', nodeType: 'ref/gen', kind: 'node-exception', message: 'a string' });
  assert.deepEqual(nodeErrorFrom(undefined, at, 513, 0).message, 'undefined');
  assert.equal(kind(new DeviceLostError('The GPU device was lost')), 'node-exception', 'a lost device is a status of the evaluation, decided before this is asked');
  structuredClone([binding, validation, budget, oom, watchdog, compile, plain]);   // every error is plain data
});
