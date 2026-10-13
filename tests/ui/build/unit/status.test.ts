// The two lines at the head of the panel (model/status.ts): one wording per state of a build and of what stands
// in the way of one, so that no two states look alike and none says more than is known.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOutcome } from '../../../../src/app/panels/build/model/outcome.ts';
import { describeStatus, type StatusInput } from '../../../../src/app/panels/build/model/status.ts';
import { resultOf } from './_docs.ts';

const OUT = '/home/ada/Builds/Ridge';
const IDLE: StatusInput = { device: 'ready', running: null, last: null, blockers: [], blockersUnder: 'Exports', folder: null, folderWarning: null };
const said = (input: Partial<StatusInput>): [string, string, string | null] => {
  const { line, sub, tone } = describeStatus({ ...IDLE, ...input });
  return [line, sub, tone];
};
const last = (status: 'ok' | 'errors' | 'aborted' | 'device-lost', rest: Partial<NonNullable<StatusInput['last']>> = {}, codes: readonly string[] = []): StatusInput['last'] => ({
  outcome: describeOutcome(resultOf(status, { problems: codes.map((code) => ({ severity: 'error', code, message: '' })) as never }), OUT, null),
  ok: status === 'ok', durationMs: 2400, computed: true, changed: false, ...rest,
});

test('before any build: where it will go, or what stands in its way', () => {
  assert.deepEqual(said({}), ['Not built yet', 'Build asks for the output folder', null]);
  assert.deepEqual(said({ folder: OUT }), ['Not built yet', `into ${OUT}`, null]);
  // A long path is shown by its end, which is what tells two build folders apart.
  assert.match(said({ folder: '/media/ada/0a1b2c3d-1111-4222-8333-444455556666/Projects/Ridge/Builds/Final' })[1], /^into ….*Builds\/Final$/);

  // What the document says would stop a build is said before the build is started, in the words of the problem.
  const loose = { title: 'An export node has no input', message: 'Color Texture: nothing is connected to its input.' };
  assert.deepEqual(said({ folder: OUT, blockers: [loose] }), ['An export node has no input', 'Color Texture: nothing is connected to its input.', 'warning']);
  assert.deepEqual(said({ blockers: [loose, loose, loose] }), ['3 problems would stop a build', 'They are listed under Exports', 'warning']);
  // Where a plan was made without a build, the section that lists them is the plan's.
  assert.equal(said({ blockers: [loose, loose], blockersUnder: 'Plan' })[1], 'They are listed under Plan');
  assert.deepEqual(
    said({ blockers: [{ title: 'Nothing to export', message: 'The project has no export node, so a build would write nothing.' }] }),
    ['Nothing to export', 'The project has no export node, so a build would write nothing.', 'warning'],
  );
  // A folder the build is certain to refuse.
  assert.deepEqual(said({ folder: '/home/ada/Terrain', folderWarning: 'This folder holds the project file' }), ['The output folder would be refused', 'Build asks for another folder', 'warning']);
  // Without a device nothing can be built, whatever else there is to say.
  assert.deepEqual(said({ device: 'starting', blockers: [loose] }), ['Waiting for the graphics device', '', null]);
  assert.deepEqual(said({ device: 'lost' }), ['The graphics device is being recovered', '', null]);
  assert.deepEqual(said({ device: 'failed' }), ['No graphics device: a build cannot start', '', 'error']);
});

test('a build that runs: how many targets are begun, the time so far, and what is left as far as it is known', () => {
  const running = { targets: null, elapsedMs: null, remaining: null, finishing: false };
  assert.deepEqual(said({ running }), ['Building', '', null]);
  assert.deepEqual(said({ running: { ...running, targets: { begun: 0, count: 8 }, elapsedMs: 300 } }), ['Building', '0.3 s so far', null]);
  assert.deepEqual(
    said({ running: { targets: { begun: 2, count: 8 }, elapsedMs: 4000, remaining: { ms: 10_000, bound: 'at-least' }, finishing: false } }),
    ['Building: target 2 of 8', '4.0 s so far, at least 10 s left', null],
  );
  assert.deepEqual(
    said({ running: { targets: { begun: 8, count: 8 }, elapsedMs: 64_000, remaining: { ms: 31_000, bound: 'about' }, finishing: false } }),
    ['Building: target 8 of 8', '1 min 04 s so far, about 30 s left', null],
  );
  assert.deepEqual(said({ running: { targets: { begun: 8, count: 8 }, elapsedMs: 9000, remaining: null, finishing: true } })[1], '9.0 s so far, finishing the files');
  // What stands in the way of the next build is not said over one that runs.
  assert.equal(said({ running, blockers: [{ title: 'Nothing to export', message: '' }], device: 'ready' })[0], 'Building');
});

test('a build that has ended: how, and how long it took when it took any time worth saying', () => {
  assert.deepEqual(said({ last: last('ok') }), ['Build finished', 'in 2.4 s', 'ok']);
  assert.deepEqual(said({ last: last('aborted', { durationMs: 300 }) }), ['Build cancelled', 'after 0.3 s', null]);
  assert.deepEqual(said({ last: last('errors', {}, ['E_NODE_FAILED']) }), ['Build failed', 'after 2.4 s', 'error']);
  assert.deepEqual(said({ last: last('device-lost') }), ['Build stopped: device lost', 'after 2.4 s', 'error']);
  // A build that was refused at its folder, or stopped at its plan, did not run: "in 0.0 s" says nothing.
  assert.deepEqual(said({ last: last('errors', { durationMs: 4, computed: false }, ['E_OUT_DIR']) }), ['The output folder was refused', '', 'error']);
  // A build nobody timed.
  assert.deepEqual(said({ last: last('ok', { durationMs: null }) }), ['Build finished', '', 'ok']);
  // While the device is away, how the last build ended stays said: a lost device is how some builds end.
  assert.deepEqual(said({ device: 'lost', last: last('device-lost') }), ['Build stopped: device lost', 'The graphics device is being recovered', 'error']);
});

test('once the project has changed, a build that succeeded is out of date and one that failed says nothing of the project', () => {
  // The green of a build that succeeded must not stand over a project it is no longer the build of.
  assert.deepEqual(said({ folder: OUT, last: last('ok', { changed: true }) }), ['Build out of date', 'The project has changed since', 'warning']);
  // The failure of an earlier state is not the failure of this one: what is said is where the next build goes.
  assert.deepEqual(said({ folder: OUT, last: last('errors', { changed: true }, ['E_NODE_FAILED']) }), ['Changed since the last build', `into ${OUT}`, null]);
  assert.deepEqual(said({ folder: OUT, last: last('aborted', { changed: true }) }), ['Changed since the last build', `into ${OUT}`, null]);
  // What stands in the way now comes first, whatever the last build was.
  const loose = { title: 'An export node has no input', message: 'Color Texture: nothing is connected to its input.' };
  assert.equal(said({ last: last('ok', { changed: true }), blockers: [loose] })[0], 'An export node has no input');
  assert.equal(said({ device: 'lost', last: last('ok', { changed: true }) })[0], 'The graphics device is being recovered');

  // No two states share their two lines.
  const states: Partial<StatusInput>[] = [
    {}, { folder: OUT }, { blockers: [loose] }, { blockers: [loose, loose] }, { folder: OUT, folderWarning: 'x' }, { device: 'starting' }, { device: 'lost' }, { device: 'failed' },
    { running: { targets: null, elapsedMs: null, remaining: null, finishing: false } },
    { last: last('ok') }, { last: last('aborted') }, { last: last('errors', {}, ['E_NODE_FAILED']) }, { last: last('device-lost') },
    { last: last('errors', { computed: false }, ['E_OUT_DIR']) }, { last: last('ok', { changed: true }) }, { folder: OUT, last: last('errors', { changed: true }) },
  ];
  const lines = states.map((state) => said(state).slice(0, 2).join(' / '));
  assert.equal(new Set(lines).size, lines.length, lines.join('\n'));
});
