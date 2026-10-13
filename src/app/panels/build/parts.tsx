// The small pieces the sections of the build panel are made of, and how they reach the stores.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { BuildPlan } from '../../../core/runtime.ts';
import type { DocState } from '../../state/doc-store.ts';
import type { EngineState } from '../../state/engine-store.ts';
import { Icon, Tooltip, useApp, useCommandContext, type IconName } from '../../ui/index.ts';
import styles from './build.module.css';
import type { StageState } from './model/log.ts';
import { exportNodes, knownProblems, type ExportNodeView } from './model/plan.ts';
import { viewProblems, type ProblemView } from './model/problems.ts';
import { buildModel, buildSignature, builtOf, scopeOf, type BuildModel, type BuildScope, type PanelState } from './model/store.ts';

export const css: Readonly<Record<string, string>> = styles;

// ---- the stores --------------------------------------------------------------------------------------------------------
// A selector returns what the store holds, never an object it makes: a new object is a new state to React.

export function useModel(): BuildModel {
  return buildModel(useCommandContext());
}
export function usePanel<T>(selector: (state: PanelState) => T): T {
  return useStore(useModel().state, selector);
}
export function useEngine<T>(selector: (state: EngineState) => T): T {
  return useStore(useCommandContext().engineState, selector);
}
export function useDoc<T>(selector: (state: DocState) => T): T {
  return useStore(useCommandContext().doc, selector);
}

/**
 * The last build as it stands for the project that is open (model/store.ts). The document is asked one thing,
 * whether it still builds to what was built, and a component is drawn again when the answer changes: an edit
 * of a project that has already changed since its build draws nothing here.
 */
export function useBuildScope(): BuildScope {
  const build = useEngine((state) => state.build);
  const built = usePanel((state) => state.built);
  const project = usePanel((state) => state.project);
  const log = usePanel((state) => state.log);
  const signature = builtOf(build, { built })?.signature ?? null;
  const differs = useDoc((state) => signature !== null && buildSignature(state.doc) !== signature);
  return useMemo(() => scopeOf(build, { built, project, log }, differs), [build, built, project, log, differs]);
}

/** The export nodes of the document, and what the document alone says would stop a build of them (model/plan.ts). */
export function useExports(): { readonly nodes: readonly ExportNodeView[]; readonly problems: readonly ProblemView[] } {
  const { registry } = useCommandContext();
  const nodes = useDoc((state) => state.doc.nodes);
  const edges = useDoc((state) => state.doc.edges);
  return useMemo(() => {
    const found = exportNodes({ nodes, edges }, registry);
    return { nodes: found, problems: viewProblems(knownProblems(found), { nodes }) };
  }, [nodes, edges, registry]);
}

export interface CurrentPlan {
  readonly plan: BuildPlan;
  /** A build of this very state of the project sent it, or the session planned it without a build. */
  readonly from: 'running' | 'last' | 'draft';
}

/** The plan of the project as it stands; null when the project has changed since the last plan and nothing plans without a build. */
export function usePlan(): CurrentPlan | null {
  const { build, mine, changed } = useBuildScope();
  const draft = usePanel((state) => state.draft);
  const drafted = useDoc((state) => draft !== null && draft.signature === buildSignature(state.doc));
  return useMemo(() => {
    if (mine && build.plan !== null && !changed) return { plan: build.plan, from: build.running ? 'running' : 'last' };
    if (draft !== null && drafted && !build.running) return { plan: draft.plan, from: 'draft' };
    return null;
  }, [build.plan, build.running, mine, changed, draft, drafted]);
}

/** The clock, read again twice a second while `active`: what the elapsed time of a running build is drawn from. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : performance.now();
}

/** The title a node is shown under: the user's, else that of its type. */
export function useNodeTitle(): (nodeId: string) => string {
  const { registry } = useCommandContext();
  const nodes = useDoc((state) => state.doc.nodes);
  return (nodeId) => {
    const instance = Object.hasOwn(nodes, nodeId) ? nodes[nodeId] : undefined;
    if (!instance) return nodeId;
    return typeof instance.title === 'string' && instance.title !== '' ? instance.title : registry.get(instance.type)?.title ?? instance.type;
  };
}

// ---- layout ------------------------------------------------------------------------------------------------------------

/** A titled part of the panel that can be folded away. What is folded stays folded: the panel's model keeps it. */
export function Section(props: { readonly id: string; readonly title: string; readonly aside?: ReactNode; readonly children: ReactNode }) {
  const model = useModel();
  const open = !usePanel((state) => state.folded).includes(props.id);
  return (
    <section className={css.section} data-build-section={props.id}>
      <button type="button" className={css.sectionHead} aria-expanded={open} onClick={() => model.setFolded(props.id, open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className={css.sectionTitle}>{props.title}</span>
        {props.aside !== undefined && props.aside !== null ? <span className={css.sectionAside}>{props.aside}</span> : null}
      </button>
      {open ? <div className={css.sectionBody}>{props.children}</div> : null}
    </section>
  );
}

const NOTE_ICON: Readonly<Record<'info' | 'ok' | 'warning' | 'error', IconName>> = { info: 'info', ok: 'check', warning: 'warning', error: 'error' };

/** A few sentences that stand apart: what a build does to the previews, why a folder is refused, how a build ended. */
export function Note(props: { readonly tone?: 'info' | 'ok' | 'warning' | 'error'; readonly id?: string; readonly children: ReactNode }) {
  const tone = props.tone ?? 'info';
  return (
    <div className={css.note} data-tone={tone} data-build-note={props.id} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={NOTE_ICON[tone]} />
      <div className={css.noteText}>{props.children}</div>
    </div>
  );
}

export function Meter(props: {
  readonly fraction: number;
  /** What the bar measures, for a reader that cannot see it. */
  readonly label: string;
  readonly kind?: 'progress';
  readonly level?: string;
  readonly state?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(props.fraction) ? props.fraction : 0)) * 100);
  return (
    <div
      className={css.meter} data-kind={props.kind} data-level={props.level} data-state={props.state}
      role={props.kind === 'progress' ? 'progressbar' : 'meter'} aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    >
      <div className={css.meterFill} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATE_WORD: Readonly<Record<StageState, string>> = { waiting: 'Waiting', running: 'Running', done: 'Done', stopped: 'Stopped', skipped: 'Not reached' };

/** How a stage or a target stands, as a sign. `neutral`: a build that was cancelled stopped without a fault. */
export function StateMark(props: { readonly state: StageState; readonly neutral?: boolean }) {
  const { state } = props;
  return (
    <span className={css.mark} data-state={state} data-neutral={props.neutral ? '' : undefined} role="img" aria-label={STATE_WORD[state]}>
      {state === 'done' ? <Icon name="check" />
        : state === 'stopped' ? <Icon name="close" />
          : state === 'skipped' ? <Icon name="minus" />
            : <span className={css.dot} data-filled={state === 'running' ? '' : undefined} />}
    </span>
  );
}

/** Selects a node in the graph, which shows it and opens its parameters in the inspector. */
export function NodeLink(props: { readonly nodeId: string; readonly children?: ReactNode }) {
  const model = useModel();
  return (
    <Tooltip content="Select this node in the graph">
      <button type="button" className={css.linkButton} data-build-select={props.nodeId} onClick={() => model.selectNode(props.nodeId)}>
        {props.children ?? 'Select node'}
      </button>
    </Tooltip>
  );
}

/** Problems of a plan or of a build: what each means in plain words, its code, the pipeline's sentence, what to do, and its node. */
export function ProblemList(props: { readonly problems: readonly ProblemView[]; readonly id: string }) {
  if (props.problems.length === 0) return null;
  return (
    <ul className={css.list} data-build={props.id}>
      {props.problems.map((problem) => (
        <li key={problem.key} className={css.problem} data-build-problem={problem.code} data-severity={problem.severity}>
          <Icon name={problem.severity === 'error' ? 'error' : 'warning'} />
          <div className={css.problemBody}>
            <div className={css.problemHead}>
              <span className={css.problemTitle}>{problem.title}</span>
              <span className={css.problemCode}>{problem.code}</span>
            </div>
            <p className={css.problemMessage}>{problem.message}</p>
            {problem.advice !== '' ? <p className={css.problemAdvice}>{problem.advice}</p> : null}
            {problem.nodeId !== null ? <div className={css.problemTools}><NodeLink nodeId={problem.nodeId} /></div> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- the clipboard -----------------------------------------------------------------------------------------------------

/** Puts text on the clipboard. False when the window may not: it has no focus, or the system refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A document without the focus may not write to the clipboard; a selection it copies itself needs no leave.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function CopyIcon() {
  return (
    <svg className="og-icon" viewBox="0 0 16 16" aria-hidden="true" data-icon="copy">
      <path d="M5.5 5.5h7v8h-7zM3.5 10.5v-8h7" />
    </svg>
  );
}

/** Copies a value as it is written in the manifest, with every digit. */
export function CopyButton(props: { readonly text: string; readonly label: string; readonly id?: string }) {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const copy = (): void => {
    void copyText(props.text).then((done) => {
      if (!mounted.current) return;
      if (!done) {
        app.notify({ level: 'warning', message: 'The value could not be copied: select it and copy it by hand' });
        return;
      }
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Tooltip content={copied ? 'Copied' : props.label}>
      <button
        type="button" className={`og-icon-button ${css.copy}`} data-size="small" aria-label={props.label}
        data-build-copy={props.id} data-copy-text={props.text} data-copied={copied ? '' : undefined} onClick={copy}
      >
        {copied ? <Icon name="check" /> : <CopyIcon />}
      </button>
    </Tooltip>
  );
}
