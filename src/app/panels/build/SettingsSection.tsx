// The settings of a build: the resolution with what it means on the ground and in memory, and the output folder
// with the rules the pipeline holds it to, said before a build meets them.

import { useMemo, useRef } from 'react';

import { previewResolution } from '../../../core/runtime.ts';
import { CommandButton, PropertyRow, Select } from '../../ui/index.ts';
import { FOLDER_RULES, folderWarning, sharedWith, STAGING_RULE } from './model/folder.ts';
import { formatBytes } from './model/format.ts';
import { baseName } from './model/paths.ts';
import { describeLayout, describeSpacing, estimateMemory, presetLayout, resolutionOptions } from './model/sizes.ts';
import { css, Meter, Note, Section, useDoc, useEngine, useModel, useNodeTitle, usePanel, usePlan } from './parts.tsx';

function ResolutionHints() {
  const settings = useDoc((state) => state.doc.settings);
  const current = usePlan();
  const resolution = settings.buildResolution;
  const preset = presetLayout(resolution);
  // The plan of this very state of the project says what no table does: the layout of a custom size, or that it has none.
  const plan = current?.plan.resolution === resolution ? current.plan : null;
  const refused = plan?.problems.find((problem) => problem.code === 'E_SIZE_NOT_LANDSCAPE' || problem.code === 'E_RESOLUTION') ?? null;
  const layout = preset ?? plan?.layout ?? null;
  return (
    <div className={css.hints} data-build="resolution-hints">
      <p className={css.hint} data-build="spacing">{describeSpacing(settings, resolution)}</p>
      {layout ? <p className={css.hint} data-build="layout">{describeLayout(layout)}</p>
        : refused ? <p className={css.hint} data-build="layout" data-tone="error">{refused.message}</p>
          : <p className={css.hint} data-build="layout">A custom size: whether Unreal has a landscape of it is checked when a build is planned</p>}
      <p className={css.hint} data-build="preview">Previews run at {previewResolution(settings)} × {previewResolution(settings)}</p>
    </div>
  );
}

function MemoryRow() {
  const resolution = useDoc((state) => state.doc.settings.buildResolution);
  const nodes = useDoc((state) => state.doc.nodes);
  const memory = useEngine((state) => state.memory);
  const peaks = usePanel((state) => state.measurements.peaks);
  const titleOf = useNodeTitle();
  const estimate = useMemo(() => estimateMemory({ resolution, budget: memory, peaks, nodeIds: Object.keys(nodes) }), [resolution, memory, peaks, nodes]);
  return (
    <>
      <PropertyRow
        label="GPU memory"
        help="The least a build at this resolution holds at once: what the engine has reserved, and what the node that needs the most held in a preview, scaled to the build's samples. The build checks the rest before it computes."
      >
        <div className={css.memory} data-build="memory" data-level={estimate.level}>
          <span className={css.memoryText}>
            at least {formatBytes(estimate.needBytes)}{estimate.budgetBytes !== null ? ` of ${formatBytes(estimate.budgetBytes)}` : ''}
          </span>
          {estimate.share !== null ? <Meter fraction={estimate.share} level={estimate.level} label="Share of the memory budget" /> : null}
        </div>
      </PropertyRow>
      <div className={css.hints}>
        <p className={css.hint} data-build="memory-field">One field at this size is {formatBytes(estimate.fieldBytes)}</p>
        <p className={css.hint} data-build="memory-node">
          {estimate.largest
            ? `Largest node: ${titleOf(estimate.largest.nodeId)}, about ${formatBytes(estimate.largest.bytes)} (measured at ${estimate.largest.measuredAt} × ${estimate.largest.measuredAt})`
            : 'No node is measured yet: the next preview measures them'}
        </p>
      </div>
      {estimate.level === 'over' ? (
        <Note tone="error" id="memory-over">
          This is more than the budget for graphics memory, so the build would stop for lack of it. Choose a smaller resolution, or raise the budget in the preferences.
        </Note>
      ) : estimate.level === 'tight' ? (
        <Note tone="warning" id="memory-tight">
          This is close to the budget for graphics memory. The fields that other nodes still need come on top, so the build may stop for lack of it.
        </Note>
      ) : null}
    </>
  );
}

function FolderRows() {
  const model = useModel();
  const projectPath = useDoc((state) => state.path);
  // The folder is the open project's: read again when the folders or the project change.
  const folders = usePanel((state) => state.folders);
  const folder = model.folder();
  const warning = folder === null ? null : folderWarning(folder, projectPath);
  const shared = folder === null || warning !== null ? [] : sharedWith(folder, projectPath, folders);
  return (
    <>
      <PropertyRow label="Output folder" help="Where the build is written. A folder that does not exist yet is made.">
        <span className={css.folder} data-build="folder-name" data-empty={folder === null ? '' : undefined} title={folder ?? undefined}>{folder === null ? 'Not chosen' : baseName(folder)}</span>
        <CommandButton command="build.chooseFolder" size="small">{folder === null ? 'Choose…' : 'Change…'}</CommandButton>
      </PropertyRow>
      {folder !== null
        ? <p className={`${css.hint} ${css.path}`} data-build="folder" title={folder}><bdi>{folder}</bdi></p>
        : <p className={css.hint} data-build="folder-none">Without a folder, Build asks for one.</p>}
      {warning !== null ? <Note tone="error" id="folder-warning">{warning}. Build asks for another folder.</Note> : null}
      {shared.length > 0 ? (
        <Note tone="warning" id="folder-shared">
          {shared.length === 1 ? 'Another project builds into this folder' : `${shared.length} other projects build into this folder`}: {shared.map((path) => baseName(path)).join(', ')}.
          {' '}A build here replaces what {shared.length === 1 ? 'it' : 'they'} built: give every project a folder of its own.
        </Note>
      ) : null}
      <ul className={css.rules} data-build="folder-rules">
        {FOLDER_RULES.map((rule) => <li key={rule}>{rule}</li>)}
        <li>{STAGING_RULE}</li>
      </ul>
    </>
  );
}

/**
 * The sizes the project had that are not of the list, for as long as the project is open. The list must not
 * change in the render its own choice causes: measured, the select then reports a second choice, of another size.
 */
function useCustomSizes(resolution: number): readonly number[] {
  const project = usePanel((state) => state.project);
  const seen = useRef<{ readonly project: number; sizes: readonly number[] }>({ project, sizes: [] });
  if (seen.current.project !== project) seen.current = { project, sizes: [] };
  if (!seen.current.sizes.includes(resolution)) seen.current.sizes = [...seen.current.sizes, resolution];
  return seen.current.sizes;
}

export function SettingsSection() {
  const model = useModel();
  const resolution = useDoc((state) => state.doc.settings.buildResolution);
  const running = useEngine((state) => state.build.running);
  const customs = useCustomSizes(resolution);
  return (
    <Section id="settings" title="Settings">
      <PropertyRow
        label="Resolution" htmlFor="build-resolution"
        help="Vertices per side of the build. An Unreal landscape is made of components of fixed sizes, so only certain resolutions fit."
      >
        <Select
          id="build-resolution" aria-label="Build resolution" disabled={running}
          value={String(resolution)} options={resolutionOptions(resolution, customs)}
          onChange={(value) => model.setResolution(Number(value))}
        />
      </PropertyRow>
      <ResolutionHints />
      <MemoryRow />
      <FolderRows />
      <Note id="previews">
        {running
          ? 'Previews are paused while the build runs, and the viewport keeps its last picture. They resume when the build ends.'
          : 'While a build runs, previews pause and the viewport keeps its last picture. They resume when the build ends.'}
      </Note>
    </Section>
  );
}
