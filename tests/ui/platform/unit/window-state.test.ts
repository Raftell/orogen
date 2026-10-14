// Where the window goes (runtime.md 8.2 rule 9): the size of a first start cut to the screen, a kept place while
// it is still on a screen, and the log file of rule 10. No Electron.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createLog, LOG_FILE, LOG_FOLDER, LOG_MAX_BYTES } from '../../../../src/platform/electron/main/log.ts';
import { windowOptions } from '../../../../src/platform/electron/main/window.ts';
import { DEFAULT_SIZE, parseWindowState, placeWindow, readWindowState, WINDOW_FILE, writeWindowState } from '../../../../src/platform/electron/main/window-state.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-platform-window-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 };
/** 1920 × 1080 at 125 % with a taskbar: what Windows 11 gives a laptop. */
const SCALED = { x: 0, y: 0, width: 1536, height: 816 };

test('window: a first start is 1600 × 1000 where the screen has room, and no larger than the screen where it has not', () => {
  assert.deepEqual(placeWindow(null, [{ x: 0, y: 0, width: 2560, height: 1400 }]), { ...DEFAULT_SIZE, maximized: false });
  assert.deepEqual(placeWindow(null, [FULL_HD]), { width: 1600, height: 1000, maximized: false });
  // The reported case: the window was larger than the work area and its lower edge off the screen.
  assert.deepEqual(placeWindow(null, [SCALED]), { width: 1536, height: 816, maximized: false });
  // A screen smaller than the least window: the window fits it all the same, and so does its least size.
  const small = placeWindow(null, [{ x: 0, y: 0, width: 800, height: 500 }]);
  assert.deepEqual(small, { width: 800, height: 500, maximized: false });
  const options = windowOptions('/app/preload.cjs', small);
  assert.deepEqual([options.width, options.height, options.minWidth, options.minHeight], [800, 500, 800, 500]);
  assert.deepEqual([windowOptions('/app/preload.cjs').width, windowOptions('/app/preload.cjs').minWidth, windowOptions('/app/preload.cjs').x], [1600, 960, undefined]);
  // No screen is known: the default size, centred by the system.
  assert.deepEqual(placeWindow(null, []), { ...DEFAULT_SIZE, maximized: false });
});

test('window: the place it was closed at is used while it lies on a screen, and given up when its screen is gone', () => {
  const kept = { bounds: { x: 100, y: 60, width: 1400, height: 900 }, maximized: false };
  assert.deepEqual(placeWindow(kept, [FULL_HD]), { x: 100, y: 60, width: 1400, height: 900, maximized: false });
  assert.equal(placeWindow({ ...kept, maximized: true }, [FULL_HD]).maximized, true);
  // Hanging over the edge: moved back by what hangs over; larger than the screen: cut to it.
  assert.deepEqual(placeWindow({ bounds: { x: 900, y: 500, width: 1400, height: 900 }, maximized: false }, [FULL_HD]), { x: 520, y: 140, width: 1400, height: 900, maximized: false });
  assert.deepEqual(placeWindow({ bounds: { x: 0, y: 0, width: 1920, height: 1040 }, maximized: false }, [SCALED]), { x: 0, y: 0, width: 1536, height: 816, maximized: false });
  // On a second screen that is still there.
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };
  assert.deepEqual(placeWindow({ bounds: { x: 2200, y: 100, width: 1600, height: 1000 }, maximized: false }, [FULL_HD, second]), { x: 2200, y: 100, width: 1600, height: 1000, maximized: false });
  // That screen was unplugged: centred on the primary one, at the size it had as far as that fits.
  const gone = placeWindow({ bounds: { x: 2200, y: 100, width: 1600, height: 1000 }, maximized: false }, [FULL_HD]);
  assert.deepEqual(gone, { width: 1600, height: 1000, maximized: false });
  assert.equal('x' in gone, false);
});

test('window: the kept state is a small file that anything else is not', () => {
  const dir = path.join(ROOT, 'state');
  assert.equal(readWindowState(dir), null);
  writeWindowState(dir, { bounds: { x: 10.4, y: 20, width: 1200, height: 800 }, maximized: true });
  assert.deepEqual(readWindowState(dir), { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true });
  assert.deepEqual(fs.readdirSync(dir), [WINDOW_FILE]);
  for (const text of ['', '{', 'null', '{"bounds":null}', '{"bounds":{"x":0,"y":0,"width":0,"height":10}}', '{"bounds":{"x":"a","y":0,"width":5,"height":5}}']) assert.equal(parseWindowState(text), null, text);
});

test('log: an entry is a line with its time and its source; the file begins anew when it has grown, and never throws', () => {
  const dir = path.join(ROOT, 'log');
  const log = createLog(dir, () => new Date(Date.UTC(2026, 9, 14, 12, 0, 0)));
  assert.equal(log.file, path.join(dir, LOG_FOLDER, LOG_FILE));
  assert.equal(fs.existsSync(log.file), false, 'nothing is written before something went wrong');
  log.write('gpu', 'the GPU process is gone: crashed (exit code 139)');
  log.write('page', 'Error: first line\n    at second line');
  assert.equal(fs.readFileSync(log.file, 'utf8'), '2026-10-14T12:00:00.000Z [gpu] the GPU process is gone: crashed (exit code 139)\n2026-10-14T12:00:00.000Z [page] Error: first line\n        at second line\n');
  // Grown past its limit: it becomes the one older file.
  fs.appendFileSync(log.file, 'x'.repeat(LOG_MAX_BYTES));
  log.write('main', 'after the limit');
  assert.deepEqual(fs.readdirSync(path.dirname(log.file)).sort(), [LOG_FILE, `${LOG_FILE}.1`]);
  assert.equal(fs.readFileSync(log.file, 'utf8'), '2026-10-14T12:00:00.000Z [main] after the limit\n');
  // A folder that cannot be made: nothing is thrown.
  fs.writeFileSync(path.join(ROOT, 'taken'), '');
  assert.doesNotThrow(() => createLog(path.join(ROOT, 'taken')).write('main', 'lost'));
});
