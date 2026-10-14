// The head of the inspector for the selected nodes: the title, which renames, the type and what it does, the
// bypass, and what the engine says of the node: its state, the time and the memory of its last run, the range and
// the mean of its first output, and its error with everything the error holds.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { FieldStats, NodeDef } from '../../../core/api.ts';
import { canBypass, missingInputs, portLabel, previewResolution, type GraphDoc, type NodeError, type NodeInstance, type ProjectSettings } from '../../../core/runtime.ts';
import type { NodeRuntime } from '../../state/engine-store.ts';
import { Checkbox, CommandButton, Icon, nodeErrorText, TextField, Tooltip, useApp, useCommandContext, useCommandEnabled } from '../../ui/index.ts';
import { setFlagsOf } from './edit.ts';
import styles from './inspector.module.css';
import { errorFacts, excerptLines, formatStat, formatStatMetres, isSteady, outputRole, statusLine, statusSummary, type EngineSituation, type StatusLine } from './model.ts';
import { inspectorStore } from './state.ts';

const own = <T,>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** engine.md 4.2: a title is at most 24 characters; the user's own may be longer, within reason. */
const TITLE_MAX_LENGTH = 64;

function TitleField(props: { readonly node: NodeInstance; readonly def: NodeDef }) {
  const { doc } = useCommandContext();
  const { node, def } = props;
  const input = useRef<HTMLInputElement>(null);
  const requests = useStore(inspectorStore, (state) => state.renameRequests);
  const answered = useRef(requests);
  useEffect(() => {
    if (requests === answered.current) return;
    answered.current = requests;
    input.current?.focus();
    input.current?.select();
  }, [requests]);
  return (
    <TextField
      ref={input}
      className={styles.title}
      data-field="title"
      aria-label="Node title"
      value={node.title ?? def.title}
      maxLength={TITLE_MAX_LENGTH}
      selectOnFocus
      onCommit={(text) => {
        // The field takes no more by typing; a text that was put there another way is cut to the same length.
        const title = text.trim().slice(0, TITLE_MAX_LENGTH).trim();
        // The type's own title is no title of the node's: it follows the type again.
        setFlagsOf({ doc }, [node.id], 'Rename Node', { title: title === '' || title === def.title ? null : title });
      }}
    />
  );
}

function ErrorDetails(props: { readonly error: NodeError }) {
  const { error } = props;
  const { registry } = useCommandContext();
  return (
    <div className={styles.error} data-node-error={error.kind} role="alert">
      <div className={styles.errorMessage}>
        <Icon name="error" />
        <span>{nodeErrorText(error, registry)}</span>
      </div>
      <dl className={styles.facts}>
        {errorFacts(error).map((fact) => (
          <div key={fact.label} className={styles.fact} data-error-fact={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {error.wgsl ? (
        <>
          {error.wgsl.message !== '' && !error.message.includes(error.wgsl.message) ? <div className={styles.errorNote}>{error.wgsl.message}</div> : null}
          <pre className={styles.excerpt} data-error-excerpt="">
            {excerptLines(error.wgsl).map((line) => (
              <div key={line.number} className={styles.excerptLine} data-failing={line.failing ? '' : undefined}>
                <span className={styles.excerptNumber}>{line.number}</span>
                {line.text}
              </div>
            ))}
          </pre>
        </>
      ) : null}
      {error.detail ? (
        <details className={styles.detail}>
          <summary>Full message</summary>
          <pre data-error-detail="">{error.detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** How long a node must wait or run before the head says so (model.ts, isSteady). */
const UNSTEADY_AFTER_MS = 150;

/**
 * The record of the node as the head shows it: the engine's, except that a record which is not steady (isSteady)
 * is shown only when the node has waited or run for a moment, and until then the last steady one stays. A drag
 * makes a draft many times a second: without this the line would name each of them.
 */
function useSteadyRuntime(nodeId: string, runtime: NodeRuntime | undefined, drafting: boolean): NodeRuntime | undefined {
  const steady = isSteady(runtime, drafting);
  /** The node waits or runs, and has not finished a draft: what is shown once it has lasted. */
  const pending = !steady && runtime?.state !== 'done';
  const [lasted, setLasted] = useState(false);
  const held = useRef<{ readonly nodeId: string; readonly runtime: NodeRuntime | undefined } | null>(null);
  useEffect(() => {
    if (!pending) {
      setLasted(false);
      return undefined;
    }
    const timer = setTimeout(() => setLasted(true), UNSTEADY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending, nodeId]);
  if (steady) {
    held.current = { nodeId, runtime };
    return runtime;
  }
  if (pending && lasted) return runtime;
  return held.current !== null && held.current.nodeId === nodeId ? held.current.runtime : runtime;
}

interface OutputStats {
  /** Null while unknown: the port is no field, the node is not part of what is shown, or nothing is. */
  readonly stats: FieldStats | null;
  /** The numbers are of the result on screen, and the document has changed since: a newer result is on its way. */
  readonly stale: boolean;
}

/**
 * The statistics of the node's first output in the result that is shown (runtime.md 7.1). They are asked for
 * whenever another result is shown, also one of the same revision (a build ended, a device came back), and not of
 * a draft, which a drag replaces many times a second. Until the answer is there the numbers of the result before
 * stay, as the picture of the viewport does (7.3 rule 6): the line never goes blank in the middle of an edit.
 */
function useOutputStats(nodeId: string, port: string | null): OutputStats {
  const { engine, engineState, doc } = useCommandContext();
  const view = useStore(engineState, (state) => state.view);
  const building = useStore(engineState, (state) => state.build.running);
  const sent = useStore(doc, (state) => state.engineRevision);
  const [held, setHeld] = useState<{ readonly nodeId: string; readonly port: string; readonly stats: FieldStats | null; readonly revision: number } | null>(null);
  useEffect(() => {
    // While a build runs the session answers null for every port (7.1); the numbers of before the build stay.
    if (port === null || view === null || view.draft || building) return undefined;
    let current = true;
    const revision = view.revision;
    const keep = (stats: FieldStats | null): void => {
      if (current) setHeld({ nodeId, port, stats, revision });
    };
    engine.inspect({ node: nodeId, port }).then(keep, () => keep(null));
    return () => { current = false; };
    // `view` is another object for every result that is shown, whatever its revision.
  }, [engine, nodeId, port, view, building]);
  if (held === null || held.nodeId !== nodeId || held.port !== port) return { stats: null, stale: false };
  return { stats: held.stats, stale: held.stats !== null && (held.revision < sent || view === null || view.draft) };
}

/** The labels of the required inputs of a node that the evaluator finds unconnected (the core's `missingInputs`, runtime.md 5.3). */
function useMissingInputs(doc: GraphDoc, nodeId: string): string[] {
  const { registry } = useCommandContext();
  // The wiring and the nodes decide it; the settings and the view, which change with every drag elsewhere, do not.
  return useMemo(() => missingInputs(doc, registry, nodeId).map(portLabel), [doc.nodes, doc.edges, registry, nodeId]);
}

function NodeStatus(props: { readonly node: NodeInstance; readonly def: NodeDef; readonly settings: ProjectSettings; readonly locked: boolean }) {
  const { engineState, doc, registry } = useCommandContext();
  const { node, def, settings } = props;
  const runtime: NodeRuntime | undefined = useStore(engineState, (state) => own(state.nodes, node.id));
  const device = useStore(engineState, (state) => state.device.state);
  const evaluating = useStore(engineState, (state) => state.evaluation !== null);
  const building = useStore(engineState, (state) => state.build.running);
  const paused = useStore(engineState, (state) => state.paused);
  // What the viewport shows the project at when no value is being dragged: a draft is coarser for a moment, and
  // the line of a node that was computed for the view does not change with it.
  const viewResolution = previewResolution(settings);
  const draftShown = useStore(engineState, (state) => state.view?.draft === true);
  const gesture = useStore(doc, (state) => state.gesture !== null);
  // The request of the evaluation that refines a drag. Its record of the node is no draft's, although the picture
  // on screen is one until the whole evaluation has ended and is shown.
  const refining = useStore(engineState, (state) => (state.evaluation?.purpose === 'view' ? state.evaluation.requestId : null));
  const refined = useRef<number | null>(null);
  if (refining !== null) refined.current = refining;
  const drafting = gesture || (draftShown && (runtime === undefined || runtime.requestId !== refined.current));
  const output = def.outputs[0];
  const held = useStore(doc, (state) => state.doc);
  const { edges, nodes } = held;
  // Only a field has statistics (runtime.md 7.1), and only heights have metres.
  const role = output ? outputRole({ nodes, edges }, registry, { node: node.id, port: output.name }) : null;
  const measured = role !== null;
  const heights = role === 'height';
  const measuredStats = useOutputStats(node.id, measured && output ? output.name : null);
  // A node that failed, or stands behind one that did, has no output, whatever the result before it held.
  const stats = runtime?.state === 'error' || runtime?.state === 'skipped' ? null : measuredStats.stats;
  const shown = useSteadyRuntime(node.id, runtime, drafting);

  let upstream: string | null = null;
  if (shown?.state === 'skipped' && shown.upstream !== null) {
    const failed = own(nodes, shown.upstream);
    upstream = failed ? failed.title ?? registry.get(failed.type)?.title ?? failed.type : null;
  }
  const situation: EngineSituation = { device, evaluating, building, exports: def.export !== undefined, paused, viewResolution };
  // A required input that nothing is connected to is read off the document by the evaluator's own rule, as the
  // graph reads it, and said in the graph's words: the node is unfinished, not failed, whether or not the engine
  // was asked for it meanwhile.
  const missing = useMissingInputs(held, node.id);
  const status: StatusLine = missing.length > 0 ? { tone: 'skipped', text: `Missing input: ${missing.join(', ')}`, facts: [] } : statusLine(shown, upstream, situation);
  // The notice below the head says that the node is of another version: the engine's error says it in the same words.
  // And the line above says that an input is missing.
  const told = runtime?.state === 'error' && runtime.error ? runtime.error : null;
  const error = told !== null && !(props.locked && told.kind === 'version') && !(told.kind === 'missing-input' && missing.length > 0) ? told : null;

  return (
    <>
      <dl className={styles.facts} data-node-status={runtime?.state ?? 'none'} data-missing-input={missing.length > 0 ? '' : undefined}>
        <div className={styles.fact}>
          <dt>Status</dt>
          <dd className={styles.oneLine} data-status-text="" data-tone={status.tone}>
            <span className={styles.dot} data-tone={status.tone} />
            {[status.text, ...status.facts].join(' · ')}
          </dd>
        </div>
        {measured ? (
          // Always there for a field, with or without numbers: the parameters below do not move when they arrive.
          <div className={styles.fact} data-node-stats={stats ? 'known' : 'unknown'} data-stale={stats !== null && measuredStats.stale ? '' : undefined}>
            <dt>Output</dt>
            <dd className={styles.oneLine}>
              <div>
                {stats ? `${formatStat(stats.min)} to ${formatStat(stats.max)}, mean ${formatStat(stats.mean)}` : '\u2013'}
                {stats !== null && stats.nonFinite > 0 ? <span className={styles.warn}> {stats.nonFinite} values are not finite</span> : null}
              </div>
              {heights ? <div className={styles.dim}>{stats ? `${formatStatMetres(stats.min, settings.heightRange)} to ${formatStatMetres(stats.max, settings.heightRange)}` : '\u00a0'}</div> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {shown?.state === 'running' ? (
        <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, Math.max(0, shown.fraction)) * 100)}>
          <div style={{ width: `${Math.round(Math.min(1, Math.max(0, shown.fraction)) * 100)}%` }} />
        </div>
      ) : null}
      {error ? <ErrorDetails error={error} /> : null}
    </>
  );
}

/** The states of several nodes in one line, and the error of each that failed. */
export function NodesStatus(props: { readonly nodes: readonly NodeInstance[]; readonly locked?: boolean }) {
  const { engineState, registry } = useCommandContext();
  // The records of these nodes alone: the engine reports on some node many times a second.
  const runtimes = useStore(engineState, useShallow((state) => props.nodes.map((node) => own(state.nodes, node.id))));
  const paused = useStore(engineState, (state) => state.paused);
  return (
    <>
      <dl className={styles.facts} data-node-status="several">
        <div className={styles.fact}>
          <dt>Status</dt>
          <dd className={styles.oneLine} data-status-text="">{statusSummary(runtimes, paused)}</dd>
        </div>
      </dl>
      {props.nodes.map((node, index) => {
        const runtime = runtimes[index];
        if (runtime?.state !== 'error' || !runtime.error || (props.locked && runtime.error.kind === 'version')) return null;
        return (
          <div key={node.id} className={styles.failedNode}>
            <div className={styles.dim}>{node.title ?? registry.get(node.type)?.title ?? node.type}</div>
            <ErrorDetails error={runtime.error} />
          </div>
        );
      })}
    </>
  );
}

/** The bypass of the selected nodes, as the command that toggles it. */
export function BypassBox(props: { readonly nodes: readonly NodeInstance[]; readonly available: boolean }) {
  const app = useApp();
  const enabled = useCommandEnabled('inspector.toggleBypass');
  const key = app.keyLabel('inspector.toggleBypass');
  const bypassed = props.nodes.filter((node) => node.bypass === true).length;
  // The shared checkbox has two states: some of several nodes are said in a word, as a row says differing values.
  const mixed = props.available && bypassed > 0 && bypassed < props.nodes.length;
  const help = !props.available ? 'A node without an input of its output’s type cannot be bypassed'
    : mixed ? `Passes the first input through unchanged. ${bypassed} of the ${props.nodes.length} selected nodes are bypassed; a press bypasses all of them.`
      : 'Passes the first input through unchanged';
  return (
    <Tooltip content={help} keyLabel={props.available ? key : null}>
      <span className={styles.bypass} data-action="bypass" data-mixed={mixed ? '' : undefined}>
        <Checkbox
          label={mixed ? <>Bypass<span className={styles.mixed}>mixed</span></> : 'Bypass'}
          checked={props.available && bypassed === props.nodes.length}
          disabled={!enabled}
          onChange={() => app.ctx.run('inspector.toggleBypass')}
        />
      </span>
    </Tooltip>
  );
}

/** The part of the head that stays in place: the title, the bypass, the reset of all parameters, and the type. */
export function NodeHeader(props: { readonly def: NodeDef; readonly nodes: readonly NodeInstance[] }) {
  const { def, nodes } = props;
  const single = nodes.length === 1 ? nodes[0]! : null;
  return (
    <header className={styles.header} data-inspector-header={def.type}>
      <div className={styles.category} style={{ background: `var(--og-category-${def.category})` }} />
      <div className={styles.headerMain}>
        <div className={styles.titleLine}>
          {single ? <TitleField node={single} def={def} /> : <div className={styles.multiTitle} data-field="count">{nodes.length} × {def.title}</div>}
          <BypassBox nodes={nodes} available={canBypass(def)} />
          <CommandButton command="inspector.resetAll" icon="reset" size="small" />
        </div>
        <div className={styles.typeLine}>
          <span className={styles.typeTitle}>{def.title}</span>
          <span className={styles.typeId}>{def.type}</span>
        </div>
      </div>
    </header>
  );
}

/** The part that scrolls with the parameters: what the node does, and what the engine says of it. */
export function NodeAbout(props: { readonly def: NodeDef; readonly nodes: readonly NodeInstance[]; readonly settings: ProjectSettings; readonly locked: boolean }) {
  const { def, nodes, settings, locked } = props;
  return (
    <div className={styles.about} data-inspector-about="">
      <div className={styles.description} data-field="description">{def.description}</div>
      {nodes.length === 1 ? <NodeStatus node={nodes[0]!} def={def} settings={settings} locked={locked} /> : <NodesStatus nodes={nodes} locked={locked} />}
    </div>
  );
}
