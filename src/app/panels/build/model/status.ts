// The two lines at the head of the panel, beside the button that starts a build: how the build stands, or, when
// there is none to speak of, what stands in the way of one. A pure function of what the panel knows, so that
// every state has one wording and no two look alike. No DOM and no React.

import { formatDuration, formatEstimate, plural } from './format.ts';
import type { Remaining } from './log.ts';
import type { Outcome } from './outcome.ts';
import { shortPath } from './paths.ts';
import type { ProblemView } from './problems.ts';

export interface StatusInput {
  readonly device: 'starting' | 'ready' | 'lost' | 'failed';
  /** A build that runs; null when none does. */
  readonly running: {
    /** The targets begun and the targets in all; null before the plan is known. */
    readonly targets: { readonly begun: number; readonly count: number } | null;
    readonly elapsedMs: number | null;
    readonly remaining: Remaining | null;
    /** The files are being closed and put in place: no estimate reaches that far. */
    readonly finishing: boolean;
  } | null;
  /** The last build of the project that is open; null when it has none. */
  readonly last: {
    readonly outcome: Pick<Outcome, 'headline' | 'tone'>;
    readonly ok: boolean;
    /** How long it ran; null when nobody timed it. */
    readonly durationMs: number | null;
    /** It got as far as computing: a build that was refused at its folder or its plan took no time worth saying. */
    readonly computed: boolean;
    /** The project has changed since. */
    readonly changed: boolean;
  } | null;
  /** What would stop a build of the project as it stands, errors only: a plan's when there is one, else what the document alone says (plan.ts). */
  readonly blockers: readonly Pick<ProblemView, 'title' | 'message'>[];
  /** The title of the section that lists them. */
  readonly blockersUnder: string;
  readonly folder: string | null;
  /** Why the folder is certain to be refused; null when the two paths say nothing. */
  readonly folderWarning: string | null;
}

export interface StatusView {
  readonly line: string;
  /** '' when there is nothing more to say. */
  readonly sub: string;
  readonly tone: 'ok' | 'warning' | 'error' | null;
}

const DEVICE_LINE = {
  starting: 'Waiting for the graphics device',
  lost: 'The graphics device is being recovered',
  failed: 'No graphics device: a build cannot start',
} as const;

/** The path of a folder cut to what the head of a panel has room for. */
const FOLDER_CHARS = 34;

export function describeStatus(input: StatusInput): StatusView {
  const { device, running, last } = input;
  if (running) {
    const left = running.finishing ? 'finishing the files'
      : running.remaining ? `${running.remaining.bound === 'about' ? 'about' : 'at least'} ${formatEstimate(running.remaining.ms)} left` : null;
    return {
      // Targets are written in the order their inputs are computed, which is not the plan's: the count is of those begun.
      line: running.targets && running.targets.begun > 0 ? `Building: target ${running.targets.begun} of ${running.targets.count}` : 'Building',
      sub: [running.elapsedMs !== null ? `${formatDuration(running.elapsedMs)} so far` : null, left].filter((part) => part !== null).join(', '),
      tone: null,
    };
  }
  const away = device === 'ready' ? null : DEVICE_LINE[device];
  if (last && !last.changed) {
    // How the last build ended stays said while the device is away: a lost device is how some builds end.
    const took = last.durationMs === null ? '' : last.ok ? `in ${formatDuration(last.durationMs)}` : last.computed ? `after ${formatDuration(last.durationMs)}` : '';
    return { line: last.outcome.headline, sub: away ?? took, tone: last.outcome.tone === 'neutral' ? null : last.outcome.tone };
  }
  if (away !== null) return { line: away, sub: '', tone: device === 'failed' ? 'error' : null };
  // A build of an earlier state of the project says nothing of this one: what counts is what stands in the way now.
  if (input.blockers.length > 0) {
    const [first] = input.blockers;
    return {
      line: input.blockers.length === 1 ? first!.title : `${plural(input.blockers.length, 'problem')} would stop a build`,
      sub: input.blockers.length === 1 ? first!.message : `They are listed under ${input.blockersUnder}`,
      tone: 'warning',
    };
  }
  if (input.folder !== null && input.folderWarning !== null) {
    return { line: 'The output folder would be refused', sub: 'Build asks for another folder', tone: 'warning' };
  }
  // What was built is still on disk and still shown below, and it is no longer what the project builds to.
  if (last?.ok) return { line: 'Build out of date', sub: 'The project has changed since', tone: 'warning' };
  return {
    line: last ? 'Changed since the last build' : 'Not built yet',
    sub: input.folder !== null ? `into ${shortPath(input.folder, FOLDER_CHARS)}` : 'Build asks for the output folder',
    tone: null,
  };
}
