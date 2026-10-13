// The build panel (runtime.md 8.7): from the settings of a build to the numbers Unreal needs. At the top, always
// in sight, the one button that starts or cancels a build and how the build stands; below it what is newest
// first: the running or last build, what it wrote, then the settings and the plan.

import { useMemo } from 'react';

import { CommandButton } from '../../ui/index.ts';
import { GuideDialog } from './GuideDialog.tsx';
import { folderWarning } from './model/folder.ts';
import { viewProgress } from './model/log.ts';
import { describeOutcome } from './model/outcome.ts';
import { viewProblems } from './model/problems.ts';
import { describeStatus } from './model/status.ts';
import { css, useBuildScope, useDoc, useEngine, useExports, useModel, useNow, usePanel, usePlan } from './parts.tsx';
import { PlanSection } from './PlanSection.tsx';
import { FilesSection, ReportSection, UnrealSection } from './ResultSection.tsx';
import { RunSection } from './RunSection.tsx';
import { SettingsSection } from './SettingsSection.tsx';

function Status() {
  const model = useModel();
  const device = useEngine((state) => state.device.state);
  const projectPath = useDoc((state) => state.path);
  const nodes = useDoc((state) => state.doc.nodes);
  const { build, mine, changed, log } = useBuildScope();
  const exports = useExports();
  const current = usePlan();
  usePanel((state) => state.folders);
  const now = useNow(build.running);
  const folder = model.folder();
  // What would stop a build of the project as it stands: a plan of this state says it all, the document the least.
  const blockers = useMemo(
    () => (current?.from === 'draft' ? viewProblems(current.plan.problems, { nodes }) : exports.problems).filter((problem) => problem.severity === 'error'),
    [current, exports, nodes],
  );

  const progress = build.running && log ? viewProgress({ log, plan: build.plan, fraction: build.fraction, now }) : null;
  const status = describeStatus({
    device,
    running: build.running ? {
      targets: log && build.target ? { begun: log.order.length, count: build.target.count } : null,
      elapsedMs: progress?.elapsedMs ?? null, remaining: progress?.remaining ?? null, finishing: build.phase === 'commit',
    } : null,
    last: mine && !build.running && build.result !== null ? {
      outcome: describeOutcome(build.result, log?.outDir ?? folder, build.plan),
      ok: build.result.status === 'ok',
      durationMs: log?.endedAt != null ? log.endedAt - log.startedAt : null,
      computed: log?.evalStartedAt != null,
      changed,
    } : null,
    blockers,
    blockersUnder: current ? 'Plan' : 'Exports',
    folder,
    folderWarning: folder === null ? null : folderWarning(folder, projectPath),
  });
  return (
    <div className={css.barStatus} data-build="status" data-running={build.running ? '' : undefined}>
      {/* The line is said when it changes; the time under it changes twice a second, and is not. */}
      <div className={css.barLine} data-tone={status.tone ?? undefined} data-build="status-line" aria-live="polite" title={status.line}>{status.line}</div>
      {status.sub !== '' ? <div className={css.barSub} data-build="status-sub" title={status.sub}>{status.sub}</div> : null}
    </div>
  );
}

export function BuildPanel() {
  const running = useEngine((state) => state.build.running);
  return (
    <div className={css.root} data-build="panel">
      <div className={css.bar}>
        {running
          ? <CommandButton command="build.cancel" variant="danger" icon="stop">Cancel</CommandButton>
          : <CommandButton command="build.start" variant="primary" icon="build">Build</CommandButton>}
        <Status />
        <div className={css.barTools}>
          <CommandButton command="build.revealFolder" icon="folder" />
          <CommandButton command="build.importGuide" icon="info" />
        </div>
      </div>
      <div className={css.scroll} data-build="scroll">
        <RunSection key="run" />
        {/* While a build runs its plan is what there is to read; afterwards, what it wrote. */}
        {running ? <PlanSection key="plan" /> : null}
        <UnrealSection key="unreal" />
        <FilesSection key="files" />
        <ReportSection key="report" />
        <SettingsSection key="settings" />
        {running ? null : <PlanSection key="plan" />}
      </div>
      <GuideDialog />
    </div>
  );
}
