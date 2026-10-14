// What a build left: the files it wrote with their sizes, its report (the time each stage and each target
// took, the memory it held at its height), and the numbers Unreal needs, read from the manifest and laid out
// as the New Landscape panel asks for them, each with a button that copies it with every digit.

import { CommandButton } from '../../ui/index.ts';
import { formatBytes, formatDuration, plural } from './model/format.ts';
import { peakMemory } from './model/log.ts';
import { importGroups, reportStages, type ImportGroup } from './model/manifest.ts';
import { baseName } from './model/paths.ts';
import { CopyButton, css, Note, Section, useBuildScope, useEngine, useNodeTitle, usePanel } from './parts.tsx';

/** The files of the last build that succeeded. */
export function FilesSection() {
  const { build, mine } = useBuildScope();
  const files = usePanel((state) => state.files);
  const result = build.result;
  if (!mine || build.running || !result || result.status !== 'ok') return null;
  const bytes = result.files.reduce((sum, file) => sum + file.bytes, 0);
  return (
    <Section id="files" title="Files written" aside={`${plural(result.files.length, 'file')}, ${formatBytes(bytes)}`}>
      {result.outDir !== null ? <p className={`${css.hint} ${css.path}`} data-build="result-folder" title={result.outDir}><bdi>{result.outDir}</bdi></p> : null}
      <ul className={css.list} data-build="result-files">
        {result.files.map((file) => (
          <li key={file.path} className={css.file} data-build-written={file.path} data-bytes={file.bytes}>
            <span className={css.fileName}>{file.path}</span>
            <span className={css.fileFormat}>{file.path === result.manifest ? 'manifest' : ''}</span>
            <span className={css.number} title={`${file.bytes} bytes`}>{formatBytes(file.bytes)}</span>
          </li>
        ))}
        {result.report !== null ? (
          <li className={css.file} data-build-written={result.report}>
            <span className={css.fileName}>{result.report}</span>
            <span className={css.fileFormat}>report</span>
            <span />
          </li>
        ) : null}
      </ul>
      {files?.reading ? <p className={css.hint}>Reading the manifest and the report</p> : null}
    </Section>
  );
}

/** The report of the last build, whether it succeeded or not: a build that got as far as computing writes one. */
export function ReportSection() {
  const { build, mine, log } = useBuildScope();
  const files = usePanel((state) => state.files);
  const budget = useEngine((state) => state.memory?.budgetBytes ?? null);
  const titleOf = useNodeTitle();
  if (!mine || build.running || build.result === null) return null;
  const read = files !== null && files.requestId === build.requestId ? files.report : null;
  const peak = log ? peakMemory(log) : null;
  // The one figure that was measured: the most the pool's ledger held while the build ran (export-unreal.md 3.10).
  // The two under it say what it was made of, as far as the build's events tell.
  const measured = typeof build.result.peakPoolBytes === 'number' && build.result.peakPoolBytes > 0 ? build.result.peakPoolBytes : null;
  const parts = peak !== null && (peak.node !== null || peak.outputBytes !== null);
  if (read === null && !parts && measured === null) return null;
  const report = read?.ok ? read.value : null;
  return (
    <Section id="report" title="Report" aside={report ? `${formatDuration(report.durationMs)} in all` : undefined}>
      {read !== null && !read.ok ? <Note tone="warning" id="report-unread">The report could not be read: {read.reason}</Note> : null}
      {report ? (
        <>
          <ul className={css.list} data-build="report-stages">
            {reportStages(report).map((stage) => (
              <li key={stage.label} className={css.total} data-build-report-stage={stage.label}>
                <span>{stage.label}</span>
                <span className={css.number}>{formatDuration(stage.ms)}</span>
              </li>
            ))}
          </ul>
          <h4 className={css.subhead}>Time by target</h4>
          <ul className={css.list} data-build="report-targets">
            {report.targets.map((target, index) => (
              <li key={`${index}:${target.nodeId}`} className={css.file} data-build-report-target={target.nodeId}>
                <span className={css.fileName} title={target.title}>{build.plan?.files.find((file) => file.nodeId === target.nodeId)?.path ?? target.title}</span>
                <span className={css.fileFormat}>
                  {target.evaluateMs === null ? 'not reached' : `computed ${formatDuration(target.evaluateMs)}`}
                </span>
                <span className={css.number}>{target.exportMs === null ? '' : formatDuration(target.exportMs)}</span>
              </li>
            ))}
          </ul>
          <p className={css.hint}>Each target by its first file. The first time is what the nodes took that lead to it, the second its conversion and encoding.</p>
        </>
      ) : null}
      {parts || measured !== null ? (
        <>
          <h4 className={css.subhead}>Graphics memory at its height</h4>
          <ul className={css.list} data-build="report-memory">
            {measured !== null ? (
              <li className={css.total} data-build="peak-pool" data-bytes={measured}>
                <span>Most held at once, measured</span>
                <span className={css.number}>{formatBytes(measured)}</span>
              </li>
            ) : null}
            {peak !== null && peak.outputBytes !== null ? (
              <li className={css.total} data-build="peak-outputs">
                <span>Fields held for later nodes and targets</span>
                <span className={css.number}>{formatBytes(peak.outputBytes)}</span>
              </li>
            ) : null}
            {peak !== null && peak.node !== null ? (
              <li className={css.total} data-build="peak-node">
                <span>Largest working set: {titleOf(peak.node.nodeId)}</span>
                <span className={css.number}>{formatBytes(peak.node.bytes)}</span>
              </li>
            ) : null}
            {budget !== null ? (
              <li className={css.total}>
                <span>Budget</span>
                <span className={css.number}>{formatBytes(budget)}</span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

export function ImportRows(props: { readonly groups: readonly ImportGroup[]; readonly compact?: boolean }) {
  return (
    <>
      {props.groups.map((group) => (
        <div key={group.id} className={css.group} data-build-group={group.id}>
          <div className={css.groupHead}>
            <span className={css.groupTitle}>{group.title}</span>
            {props.compact ? null : <span className={css.hint}>step {group.step}</span>}
          </div>
          {group.rows.map((row) => (
            <div key={row.id} className={css.value} data-build-row={row.id} data-value={row.copy ?? row.value}>
              <span className={css.valueLabel} data-sub={row.label === 'File' ? '' : undefined} title={row.label}>{row.label}</span>
              <span className={css.valueText} data-kind={row.copy !== null && /^-?[\d.e+-]+$/i.test(row.value) ? 'number' : 'words'} title={row.full ?? row.value}>{row.value}</span>
              {row.copy !== null ? <CopyButton text={row.copy} label={`Copy ${row.label === 'File' ? baseName(row.copy) : row.label}`} id={row.id} /> : <span />}
            </div>
          ))}
          {props.compact ? null : <p className={css.hint}>{group.note}</p>}
        </div>
      ))}
    </>
  );
}

/** The numbers Unreal needs, from the manifest of the last build that succeeded. */
export function UnrealSection() {
  const { build, mine, changed } = useBuildScope();
  const files = usePanel((state) => state.files);
  const result = build.result;
  if (!mine || build.running || !result || result.status !== 'ok' || files === null || files.requestId !== build.requestId) return null;
  const read = files.manifest;
  const groups = read?.ok ? importGroups(read.value, files.folder) : [];
  return (
    <Section id="unreal" title="Unreal import" aside={files.manifestPath !== null ? `from ${baseName(files.manifestPath)}` : undefined}>
      {read === null ? <p className={css.hint} data-build="manifest-reading">Reading the manifest</p> : null}
      {read !== null && !read.ok ? <Note tone="error" id="manifest-unread">The manifest could not be read: {read.reason}</Note> : null}
      {read?.ok ? (
        <>
          {changed ? (
            <Note tone="warning" id="unreal-stale">These are the numbers of the last build, and the project has changed since. Build again before you import.</Note>
          ) : null}
          {groups.length === 0 ? (
            <Note id="unreal-none">This build has no landscape and no texture: there is nothing to type into Unreal.</Note>
          ) : (
            <>
              <p className={css.hint} data-build="unreal-lead">
                What the New Landscape panel asks for, in its order, as the manifest states it. Nothing here has been run in Unreal Engine: the
                import guide says how far each statement is checked.
              </p>
              <ImportRows groups={groups} />
              <div className={css.actions}>
                <CommandButton command="build.copyImportValues" size="small">Copy All</CommandButton>
                <CommandButton command="build.importGuide" icon="info" size="small">Import Guide</CommandButton>
              </div>
            </>
          )}
        </>
      ) : null}
    </Section>
  );
}
