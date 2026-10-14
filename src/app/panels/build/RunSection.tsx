// The build itself: while it runs, its stages and targets with their progress and time, and an estimate of
// what is left; when it has ended, how it ended, with what was and was not written, and every problem in
// plain words.

import { useMemo } from 'react';

import type { BuildPlan } from '../../../core/runtime.ts';
import { CommandButton, Tooltip } from '../../ui/index.ts';
import { formatDuration, formatEstimate, formatPercent, plural } from './model/format.ts';
import { viewProgress, type BuildLog, type ProgressView, type Remaining } from './model/log.ts';
import { describeOutcome } from './model/outcome.ts';
import { viewProblems } from './model/problems.ts';
import { interruptedBuild } from './model/store.ts';
import { css, Meter, Note, ProblemList, Section, StateMark, useBuildScope, useDoc, useEngine, useModel, useNodeTitle, useNow } from './parts.tsx';

function remainingText(remaining: Remaining | null, finishing: boolean): string {
  if (finishing) return 'Finishing the files';
  if (remaining === null) return 'What is left cannot be estimated yet';
  if (remaining.bound === 'about') return `About ${formatEstimate(remaining.ms)} left, plus the time to finish the files`;
  return `At least ${formatEstimate(remaining.ms)} left: not everything is measured yet`;
}

/** The node that is running in the build, with how far it says it is. */
function RunningNode(props: { readonly requestId: number }) {
  const titleOf = useNodeTitle();
  const nodes = useEngine((state) => state.nodes);
  const found = Object.entries(nodes).find(([, node]) => node.state === 'running' && node.requestId === props.requestId);
  if (!found) return null;
  const [nodeId, node] = found;
  return (
    <span className={css.stageSub} data-build="running-node">
      {' '}· {titleOf(nodeId)}{node.fraction > 0 ? ` ${formatPercent(node.fraction)}` : ''}{node.label ? `, ${node.label}` : ''}
    </span>
  );
}

function Stages(props: { readonly progress: ProgressView; readonly plan: BuildPlan | null; readonly requestId: number; readonly neutral: boolean; readonly running: boolean }) {
  const { progress, plan } = props;
  const titleOf = useNodeTitle();
  const fileOf = (nodeId: string): string => plan?.files.find((file) => file.nodeId === nodeId)?.path ?? '';
  // While a build runs the targets that wait say what is still to come. Once it is over, those it never came to
  // are a number: a row each for what did not happen would bury what did.
  const shown = props.running ? progress.targets : progress.targets.filter((target) => target.state !== 'skipped' && target.state !== 'waiting');
  const unreached = progress.targets.length - shown.length;
  return (
    <>
      <ul className={css.list} data-build="stages">
        {progress.stages.map((stage) => (
          <li key={stage.id} className={css.stage} data-build-stage={stage.id} data-state={stage.state}>
            <StateMark state={stage.state} neutral={props.neutral} />
            <span className={css.stageLabel} title={stage.label}>
              {stage.label}
              {stage.id === 'compute' && stage.state === 'running' ? <RunningNode requestId={props.requestId} /> : null}
            </span>
            {stage.fraction !== null ? <Meter kind="progress" fraction={stage.fraction} state={stage.state} label={stage.label} /> : <span className={css.meterGap} />}
            <span className={css.number} data-build="stage-percent">{stage.fraction !== null ? formatPercent(stage.fraction) : ''}</span>
            <span className={`${css.number} ${css.dim}`} data-build="stage-time">{stage.ms !== null ? formatDuration(stage.ms) : ''}</span>
          </li>
        ))}
      </ul>
      {progress.targets.length > 0 ? (
        <>
          <h4 className={css.subhead}>Targets</h4>
          <ul className={css.list} data-build="targets">
            {shown.map((target) => (
              <li key={target.index} className={css.stage} data-build-progress={target.nodeId} data-state={target.state}>
                <StateMark state={target.state} neutral={props.neutral} />
                {/* The file first: it tells two layers apart, whose nodes bear the same title. */}
                <span className={css.stageLabel} title={`${fileOf(target.nodeId)}: ${titleOf(target.nodeId)}`}>
                  {fileOf(target.nodeId)}
                  <span className={css.stageSub}> · {titleOf(target.nodeId)}</span>
                </span>
                {target.state === 'running' || target.state === 'done' || target.state === 'stopped'
                  ? <Meter kind="progress" fraction={target.fraction} state={target.state} label={`${titleOf(target.nodeId)}: rows converted`} />
                  : <span className={css.meterGap} />}
                <span className={css.number}>{target.state === 'waiting' || target.state === 'skipped' ? '' : formatPercent(target.fraction)}</span>
                <span className={`${css.number} ${css.dim}`}>{target.ms !== null ? formatDuration(target.ms) : ''}</span>
              </li>
            ))}
          </ul>
          {unreached > 0 ? (
            <p className={css.hint} data-build="targets-unreached">
              {shown.length === 0 ? `None of the ${plural(unreached, 'target')} was reached` : `${plural(unreached, 'target')} ${unreached === 1 ? 'was' : 'were'} not reached`}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Problems() {
  const { build } = useBuildScope();
  const nodes = useDoc((state) => state.doc.nodes);
  const problems = build.result?.problems ?? null;
  const planned = build.plan?.problems ?? null;
  const found = build.problems;
  const views = useMemo(() => viewProblems(problems ?? [...(planned ?? []), ...found], { nodes }), [problems, planned, found, nodes]);
  if (views.length === 0) return null;
  return (
    <>
      <h4 className={css.subhead} data-build="problem-count">{plural(views.length, 'problem')}</h4>
      <ProblemList problems={views} id="problems" />
    </>
  );
}

function Outcome(props: { readonly log: BuildLog | null }) {
  const model = useModel();
  const { build, changed } = useBuildScope();
  const result = build.result!;
  const outcome = describeOutcome(result, props.log?.outDir ?? model.folder(), build.plan);
  return (
    <>
      <Note tone={outcome.tone === 'neutral' ? 'info' : outcome.tone} id="outcome">
        <p className={css.strong} data-build="outcome" data-status={result.status}>{outcome.headline}</p>
        <p data-build="written">{outcome.written}</p>
        {outcome.kept !== null ? <p data-build="kept">{outcome.kept}</p> : null}
        {changed ? <p data-build="stale">The project has changed since this build.</p> : null}
        {outcome.places.map((place) => (
          <p key={place.label} data-build-place={place.label}>
            <span className={css.dim}>{place.label}</span><br />
            <span className={css.path} title={place.path}><bdi>{place.path}</bdi></span>
          </p>
        ))}
      </Note>
      <div className={css.actions}>
        <CommandButton command="build.revealFolder" icon="folder" size="small">Show Folder</CommandButton>
        {result.status === 'ok' ? <CommandButton command="build.importGuide" icon="info" size="small">Import Guide</CommandButton> : null}
      </div>
    </>
  );
}

export function RunSection() {
  const { build, mine, changed, log } = useBuildScope();
  const now = useNow(build.running);
  if (interruptedBuild(build, mine, changed)) {
    return (
      <Section id="run" title="Build">
        <Note tone="warning" id="interrupted">
          <p className={css.strong} data-build="outcome" data-status="interrupted">Build stopped: the engine was restarted</p>
          <p data-build="written">The build ended with the engine that ran it. Nothing was put in place: the output folder holds what it held before, and the next build removes what this one left beside it.</p>
        </Note>
      </Section>
    );
  }
  if (!mine || build.requestId === null || (!build.running && build.result === null)) return null;
  const progress = log ? viewProgress({ log, plan: build.plan, fraction: build.fraction, now }) : null;
  const elapsed = progress ? formatDuration(progress.elapsedMs) : null;
  const neutral = build.lastStatus === 'aborted';
  // A build that was refused at its folder or stopped at its plan has no stages to show: it never began one.
  const began = build.running || log?.evalStartedAt != null;
  return (
    <Section id="run" title="Build" aside={elapsed !== null ? (build.running ? `${elapsed} so far` : began ? `took ${elapsed}` : undefined) : undefined}>
      {!build.running && build.result !== null ? <Outcome log={log} /> : null}
      {/* What went wrong stands right under how the build ended, above everything that only describes its course. */}
      <Problems />
      {build.running ? (
        <Tooltip content="An estimate from what the finished part took. A simulation takes longer at the build resolution than its share of a preview suggests, so it falls slowly at first.">
          <p className={css.hint} data-build="remaining">{remainingText(progress?.remaining ?? null, build.phase === 'commit')}</p>
        </Tooltip>
      ) : null}
      {/* A build that succeeded has its times in its report, below; one that did not shows where it stopped. */}
      {progress && began && (build.running || build.lastStatus !== 'ok') ? (
        <>
          {!build.running ? <h4 className={css.subhead}>Where it stopped</h4> : null}
          <Stages progress={progress} plan={build.plan} requestId={build.requestId} neutral={neutral} running={build.running} />
        </>
      ) : build.running ? (
        // A build that began before the panel listened: engineStore says where it is, not since when.
        <p className={css.hint} data-build="progress-plain">
          {build.target ? `Target ${build.target.index + 1} of ${build.target.count}: ${build.target.label}. ` : ''}{formatPercent(build.fraction)} converted
        </p>
      ) : null}
    </Section>
  );
}
