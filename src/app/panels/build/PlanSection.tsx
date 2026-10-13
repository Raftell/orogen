// What a build writes. Once the pipeline has planned (the first step of a build, before anything is computed
// or written), every export target with its files, their format and size. Before that, the export nodes the
// document holds, each by what it exports, and what the document alone says would stop a build: the panel plans
// nothing itself (export-unreal.md 3.1).

import { useMemo } from 'react';

import { Tooltip, useCommandContext } from '../../ui/index.ts';
import { formatBytes, plural } from './model/format.ts';
import { viewPlan, type ExportNodeView, type PlanTargetKind, type PlanTargetView } from './model/plan.ts';
import { viewProblems } from './model/problems.ts';
import { css, NodeLink, Note, ProblemList, Section, useDoc, useExports, usePlan, type CurrentPlan } from './parts.tsx';

const KIND_TAG: Readonly<Record<PlanTargetKind, string>> = {
  landscape: 'Landscape', layer: 'Layer', texture: 'Texture', image: 'Image', base: 'Layer', manifest: 'Build',
};

function Target(props: { readonly target: PlanTargetView }) {
  const { target } = props;
  const pixels = target.files.find((file) => file.pixels !== '')?.pixels ?? '';
  return (
    <li className={css.target} data-build-target={target.nodeId ?? target.kind} data-kind={target.kind}>
      <div className={css.targetHead}>
        <span className={css.tag}>{KIND_TAG[target.kind]}</span>
        <span className={css.targetTitle} title={target.title}>{target.title}</span>
        {pixels !== '' ? <span className={`${css.dim} ${css.number} ${css.pixels}`}>{pixels}</span> : null}
        {target.selectable && target.nodeId !== null ? <NodeLink nodeId={target.nodeId}>Select</NodeLink> : null}
      </div>
      <p className={css.targetDetail}>{target.detail}</p>
      {target.files.map((file) => (
        <div key={file.path} className={css.file} data-build-file={file.path}>
          <span className={css.fileName} title={file.path}>{file.path}</span>
          <span className={css.fileFormat}>{file.format}</span>
          <span className={css.number} data-bytes={file.bytes ?? undefined} title={file.bytes === null ? 'Known when the file is written' : `${file.bytes} bytes`}>
            {file.bytes === null ? '—' : formatBytes(file.bytes)}
          </span>
        </div>
      ))}
    </li>
  );
}

function Planned(props: { readonly current: CurrentPlan }) {
  const { registry } = useCommandContext();
  const nodes = useDoc((state) => state.doc.nodes);
  const { plan, from } = props.current;
  const view = useMemo(() => viewPlan(plan, { nodes }, registry), [plan, nodes, registry]);
  // The problems of a build stand with its outcome. A plan made without a build has no other place for them.
  const problems = useMemo(() => (from === 'draft' ? viewProblems(plan.problems, { nodes }) : []), [from, plan, nodes]);
  return (
    <>
      {!view.ok ? (
        <Note tone="error" id="plan-failed">
          {from === 'draft'
            ? 'This plan has an error, so a build would stop here, before it computes or writes anything.'
            : 'This plan has an error, so the build stopped here, before it computed or wrote anything.'}
          {view.targets.length > 0 ? ' Below is what the rest of the plan would write.' : ''}
        </Note>
      ) : null}
      <ProblemList problems={problems} id="plan-problems" />
      {view.layout !== null ? <p className={css.hint} data-build="plan-layout">Landscape of {view.resolution} × {view.resolution}: {view.layout}</p> : null}
      {view.targets.length > 0 ? (
        <>
          <ul className={css.list} data-build="plan-targets">
            {view.targets.map((target) => <Target key={target.key} target={target} />)}
          </ul>
          <div className={css.total} data-build="plan-total">
            <span className={css.totalCount}>{plural(view.fileCount, 'file')}</span>
            <span className={css.totalSum}>
              {view.unsizedFiles > 0 ? `${formatBytes(view.knownBytes)} and ${plural(view.unsizedFiles, 'file')} sized when written` : formatBytes(view.knownBytes)}
            </span>
          </div>
        </>
      ) : null}
      {view.planeBytes > 0 ? (
        <p className={css.hint} data-build="plan-planes">
          The weight-blended layers are held in main memory until they are written together: {formatBytes(view.planeBytes)}.
        </p>
      ) : null}
    </>
  );
}

function ExportRow(props: { readonly node: ExportNodeView }) {
  const { node } = props;
  const renamed = node.title !== node.typeTitle;
  const what = `${renamed ? `${node.title} (${node.typeTitle})` : node.title}${node.name !== '' ? `: ${node.name}` : ''}`;
  const state = !node.enabled ? 'Switched off: a build leaves it out'
    : node.source === null ? 'Nothing is connected to its input: a build stops at its plan'
      : `Exports the output of ${node.source}`;
  return (
    <li className={css.export} data-build-export={node.nodeId} data-enabled={node.enabled ? '' : undefined} data-connected={node.source !== null ? '' : undefined}>
      <Tooltip content={`${what}. ${state}.`}>
        <span className={css.exportWhat}>
          <span className={css.exportTitle}>{node.title}</span>
          {node.name !== '' ? <span className={css.exportName} data-build="export-name">{node.name}</span> : null}
        </span>
      </Tooltip>
      {!node.enabled ? <span className={css.tag} data-tone="off">Off</span>
        : node.source === null ? <span className={css.tag} data-tone="warning">No input</span>
          : <span className={css.exportSource} data-build="export-source">from {node.source}</span>}
      <NodeLink nodeId={node.nodeId}>Select</NodeLink>
    </li>
  );
}

function ExportNodes() {
  const { nodes, problems } = useExports();
  return (
    <>
      <ProblemList problems={problems} id="known-problems" />
      {nodes.length > 0 ? (
        <ul className={css.list} data-build="export-nodes">
          {nodes.map((node) => <ExportRow key={node.nodeId} node={node} />)}
        </ul>
      ) : null}
      <p className={css.hint} data-build="plan-pending">
        {nodes.length === 0
          ? 'A build writes what export nodes declare, and nothing else. They are in the I/O category of the library: Unreal Landscape exports the terrain.'
          : 'A build writes for every export node that is switched on. Its files with their sizes, and what only a plan can find (names that collide, a size no landscape has), are listed here once a build has planned: its first step, before anything is computed or written.'}
      </p>
    </>
  );
}

const ASIDE = { running: 'of the running build', last: 'of the last build', draft: 'of the project as it is' } as const;

export function PlanSection() {
  // A plan is of one state of the project: once the project has changed, what stands here is its export nodes again.
  const current = usePlan();
  return (
    <Section id="plan" title={current ? 'Plan' : 'Exports'} aside={current ? ASIDE[current.from] : undefined}>
      {current ? <Planned current={current} /> : <ExportNodes />}
    </Section>
  );
}
