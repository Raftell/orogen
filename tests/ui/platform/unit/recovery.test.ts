// The recovery file of runtime.md 8.6, in a temporary folder: what the page hands over is kept whole, read back
// by the next run, and removed; what is no record is neither kept nor offered.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createRecoveryStore, RECOVERY_FILE } from '../../../../src/platform/electron/main/recovery.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-platform-recovery-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let folders = 0;
const folder = (): string => path.join(ROOT, `run-${++folders}`);
const FILE = path.join(path.sep, 'work', 'alps.orogen');
const TEXT = '{"format":"orogen","version":1}\n';

test('recovery: without a file nothing is kept, and reading makes no folder', async () => {
  const dir = folder();
  assert.equal(await createRecoveryStore(dir).read(), null);
  assert.equal(fs.existsSync(dir), false);
});

test('recovery: what is kept is read by the next run, with the time it was kept, and replaced by what is kept after it', async () => {
  const dir = folder();
  let clock = 1_700_000_000_000;
  const store = createRecoveryStore(dir, () => clock);
  await store.write({ path: FILE, text: TEXT });
  assert.deepEqual(await store.read(), { path: FILE, text: TEXT, savedAt: 1_700_000_000_000 });
  // The next run of the application: another store on the same folder.
  assert.deepEqual(await createRecoveryStore(dir).read(), { path: FILE, text: TEXT, savedAt: 1_700_000_000_000 });
  clock += 3000;
  await store.write({ path: null, text: 'second' });
  assert.deepEqual(await createRecoveryStore(dir).read(), { path: null, text: 'second', savedAt: 1_700_000_003_000 });
  assert.deepEqual(fs.readdirSync(dir), [RECOVERY_FILE], 'written whole: no temporary file is left beside it');
});

test('recovery: writes made at once are applied in the order made, and a removal removes', async () => {
  const dir = folder();
  const store = createRecoveryStore(dir);
  await Promise.all(['a', 'b', 'c'].map((text) => store.write({ path: null, text })));
  assert.equal((await store.read())?.text, 'c');
  // A read waits for what is being written.
  void store.write({ path: null, text: 'd' });
  assert.equal((await store.read())?.text, 'd');
  await store.write(null);
  assert.equal(await store.read(), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  await store.write(null);
});

test('recovery: what is no record is not kept, and a file that is none is not offered', async () => {
  const dir = folder();
  const store = createRecoveryStore(dir);
  for (const bad of [{ path: 'relative.orogen', text: TEXT }, { path: FILE, text: '' }, { path: FILE }, { path: 3, text: TEXT }, 'text', 7, { path: `${FILE}\0`, text: TEXT }]) {
    await assert.rejects(store.write(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(await store.read(), null);
  // A write that failed fails its own call: the next one is made.
  await store.write({ path: FILE, text: TEXT });
  assert.equal((await store.read())?.path, FILE);

  for (const held of ['{ "path": null, "text": ', '[]', 'null', JSON.stringify({ path: 'relative', text: 'x', savedAt: 1 }), JSON.stringify({ path: null, text: 5 })]) {
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), held);
    assert.equal(await createRecoveryStore(dir).read(), null, held);
  }
  // A record without a time is still one: the time is unknown.
  fs.writeFileSync(path.join(dir, RECOVERY_FILE), JSON.stringify({ path: null, text: TEXT }));
  assert.deepEqual(await createRecoveryStore(dir).read(), { path: null, text: TEXT, savedAt: 0 });
});
