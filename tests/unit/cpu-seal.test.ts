// engine.md, Module scope: createEngine seals defineCpuTask. A file of its own, because a sealed process stays sealed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCpuTask } from '../../src/core/api.ts';
import { findCpuTask } from '../../src/core/cpu/tasks.ts';
import { sealDefinitions } from '../../src/core/gpu/seal.ts';

test('defineCpuTask throws once the definitions are sealed, and the tasks defined before stay', () => {
  const before = defineCpuTask({ name: 'test/seal.before', run: (): number => 1 });
  sealDefinitions();
  assert.throws(() => defineCpuTask({ name: 'test/seal.after', run: (): number => 2 }), /defineCpuTask\(\) was called after createEngine\(\)/);
  assert.equal(findCpuTask('test/seal.after'), undefined);
  assert.equal(findCpuTask('test/seal.before'), before);
  assert.ok(findCpuTask('core/decode-image'));
  assert.ok(findCpuTask('core/decode-raw'));
});
