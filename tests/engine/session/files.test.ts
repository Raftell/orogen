// The project's files through the session (runtime.md 7.1 setProject, 6.1 rule 6, 7.3): the FileSource follows
// the project path, the files the document names are watched, and a change of one re-evaluates.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testGpu } from '../gpu/rig.ts';
import { doc, endings, resetSlow, startSession, watchedFiles } from './rig.ts';

await testGpu();

/** file → out. `out.out` is twice the first byte of the file. */
const graph = (file: string) => doc({
  file: { type: 'ref/file-level', params: { file } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'file.out' } },
}, { height: { node: 'out', port: 'out' } });
const OUT = { node: 'out', port: 'out' };

test('the session watches the files the document names and evaluates again when one changes', async () => {
  resetSlow();
  const a = watchedFiles();
  const b = watchedFiles();
  a.put('level.bin', Uint8Array.of(3));
  a.put('other.bin', Uint8Array.of(7));
  b.put('other.bin', Uint8Array.of(9));
  const created: (string | null)[] = [];
  const t = await startSession({
    createFiles: (path) => {
      created.push(path);
      return path === '/projects/b.orogen' ? b : a;
    },
  });
  try {
    // Before the first document, as the interface does it (8.3).
    t.session.setProject({ path: '/projects/a.orogen' });
    assert.deepEqual(created, ['/projects/a.orogen']);
    assert.deepEqual(a.watching(), [], 'no document, nothing to watch');

    t.session.setDocument(graph('level.bin'), 1);
    await t.next('view-updated');
    await t.idle();
    assert.equal((await t.session.inspect(OUT))?.mean, 6, 'the engine reads through the source of the project');
    assert.deepEqual(a.watching(), ['/mem/level.bin'], 'the resolved path of the file param');
    const firstKeys = t.of('keys').at(-1)!.keys;

    // The file changes on disk: same document, same revision, new content.
    let from = t.mark();
    a.change('level.bin', Uint8Array.of(5));
    const again = await t.next('view-updated');
    await t.idle();
    assert.equal(again.revision, 1);
    assert.equal((await t.session.inspect(OUT))?.mean, 10);
    assert.deepEqual(t.of('request-start', from).map((e) => [e.revision, e.purpose]), [[1, 'view']]);
    assert.deepEqual(endings(t.events.slice(from), again.requestId), { file: 'run', out: 'run' });
    // The identity of the file is in its node's key, so the keys are computed and emitted again.
    const changed = t.of('keys', from);
    assert.deepEqual(changed.map((e) => e.revision), [1]);
    assert.notEqual(changed[0]!.keys.file, firstKeys.file);
    assert.notEqual(changed[0]!.keys.out, firstKeys.out);

    // The document names another file: that one is watched, the first no longer.
    t.session.setDocument(graph('other.bin'), 2);
    await t.next('view-updated');
    await t.idle();
    assert.deepEqual(a.watching(), ['/mem/other.bin']);
    assert.equal((await t.session.inspect(OUT))?.mean, 14);
    from = t.mark();
    a.change('level.bin', Uint8Array.of(1));
    await t.idle();
    assert.equal(t.of('request-start', from).length, 0, 'a file the document no longer names is nobody\'s business');

    // The project is saved under another name: another source, watched in place of the first, and the result made again.
    t.session.setProject({ path: '/projects/b.orogen' });
    const moved = await t.next('view-updated');
    await t.idle();
    assert.deepEqual(created, ['/projects/a.orogen', '/projects/b.orogen']);
    assert.deepEqual([a.watching(), b.watching()], [[], ['/mem/other.bin']]);
    assert.equal(moved.revision, 2);
    assert.equal((await t.session.inspect(OUT))?.mean, 18, 'the same path now names the file of the new project');
    from = t.mark();
    a.change('other.bin', Uint8Array.of(2));
    await t.idle();
    assert.equal(t.of('request-start', from).length, 0);
    b.change('other.bin', Uint8Array.of(4));
    await t.next('view-updated');
    assert.equal((await t.session.inspect(OUT))?.mean, 8);

    // No file named: nothing is watched. The node fails, and its error says why nothing new is shown.
    from = t.mark();
    t.session.setDocument(graph(''), 3);
    const end = await t.next('eval-end');
    await t.idle();
    assert.equal(end.status, 'errors');
    assert.deepEqual(b.watching(), []);
    assert.equal(t.of('view-updated', from).length, 0);

    t.session.setDocument(graph('other.bin'), 4);
    await t.next('view-updated');
    assert.deepEqual(b.watching(), ['/mem/other.bin']);
  } finally {
    await t.dispose();
  }
  assert.deepEqual([a.watching(), b.watching()], [[], []], 'dispose stops watching');
});
