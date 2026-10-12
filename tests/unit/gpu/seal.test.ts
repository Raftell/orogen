// engine.md, Module scope: createEngine seals the define functions. This file seals its own process.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineKernel } from '../../../src/core/gpu/kernel.ts';
import { defineLib } from '../../../src/core/gpu/lib.ts';
import { assertUnsealed, sealDefinitions } from '../../../src/core/gpu/seal.ts';

const CODE = 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 0.0; }';

test('definitions are accepted until the engine exists and refused afterwards', () => {
  for (const fn of ['defineLib', 'defineKernel', 'defineCpuTask', 'defineNode'] as const) assert.doesNotThrow(() => assertUnsealed(fn));
  assert.doesNotThrow(() => defineKernel({ name: 'test/before', outputs: { out: 'field' }, code: CODE }));
  assert.doesNotThrow(() => defineLib({ name: 'sealBefore', code: '' }));

  sealDefinitions();
  sealDefinitions();

  const sealed = (fn: string): RegExp => new RegExp(`^${fn}\\(\\) was called after createEngine\\(\\)`);
  assert.throws(() => defineKernel({ name: 'test/after', outputs: { out: 'field' }, code: CODE }), { message: sealed('defineKernel') });
  assert.throws(() => defineLib({ name: 'sealAfter', code: '' }), { message: sealed('defineLib') });
  assert.throws(() => assertUnsealed('defineCpuTask'), { message: sealed('defineCpuTask') });
  assert.throws(() => assertUnsealed('defineNode'), { message: sealed('defineNode') });
});
