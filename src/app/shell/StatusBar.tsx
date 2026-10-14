// The status bar: the engine and its device, the adapter, what is being computed and on which node, memory
// against the budget, and the way to the errors.

import { useStore } from 'zustand';

import { Icon, isFailure } from '../ui/index.ts';
import type { EngineState } from '../state/engine-store.ts';
import { adapterName, failedNodes, formatBytes, formatDuration } from './format.ts';
import { noGraphicsDevice, type Shell } from './shell.ts';

const PURPOSE: Readonly<Record<NonNullable<EngineState['evaluation']>['purpose'], string>> = {
  view: 'Computing', draft: 'Computing draft', thumbnails: 'Thumbnails', build: 'Building',
};

/** The id of the node that is running, or null. A string, so that a component renders again only when it changes. */
function runningNode(state: EngineState): string | null {
  for (const id in state.nodes) if (state.nodes[id]!.state === 'running') return id;
  return null;
}

function Device(props: { readonly shell: Shell }) {
  const { shell } = props;
  const device = useStore(shell.ctx.engineState, (state) => state.device);
  // The store of the engine is what every panel reads the pause from; the shell's own member is the same pause.
  const pausedHere = useStore(shell.state, (state) => state.paused);
  const paused = useStore(shell.ctx.engineState, (state) => state.paused) || pausedHere;
  // 8.5: an engine that answers nothing sends no event either. "Ready" would be the last thing it said.
  const silent = useStore(shell.ctx.engineState, (state) => state.silent) && device.state !== 'starting' && device.state !== 'failed';
  // 8.7 rule 16: no device at all is said as such, and Details explains it and offers software rendering.
  const none = noGraphicsDevice(device);
  const text = silent ? 'Engine not responding'
    : device.state === 'starting' ? 'Starting graphics device'
      : device.state === 'lost' ? 'Graphics device lost, recovering'
        : none ? 'No graphics device'
          : device.state === 'failed' ? 'Graphics device failed'
            : paused ? 'Previews paused' : 'Ready';
  return (
    <>
      <div className="og-status-item" data-status="device" data-state={device.state} data-silent={silent ? '' : undefined} title={silent ? 'The engine has not answered for several seconds. Engine > Restart Engine starts another; the project is not in the engine, so nothing of it is lost.' : device.message ?? undefined}>
        <span className="og-status-dot" data-state={silent ? 'failed' : device.state} />
        <span className={device.state === 'failed' || silent ? 'og-status-error' : paused && device.state === 'ready' ? 'og-status-warning' : 'og-status-strong'}>{text}</span>
        {device.state === 'failed' ? (
          <button type="button" className="og-status-button" data-command="engine.retryDevice" onClick={() => shell.runner.run('engine.retryDevice')}>Retry</button>
        ) : null}
        {none ? (
          <button type="button" className="og-status-button" data-action="no-device" onClick={() => shell.showDialog({ kind: 'noDevice' })}>Details…</button>
        ) : null}
        {silent ? (
          <button type="button" className="og-status-button" data-command="engine.restart" onClick={() => shell.runner.run('engine.restart')}>Restart Engine</button>
        ) : null}
      </div>
      {device.caps ? (
        <div className="og-status-item" data-status="adapter">
          <Icon name="chip" />
          <span className="og-status-text">{adapterName(device.caps.adapter)}</span>
          {/* runtime.md 1.3: a software adapter is said for as long as it is one. */}
          {device.caps.software ? <span className="og-status-pill" data-status="software">Software adapter: everything is slow</span> : null}
        </div>
      ) : null}
    </>
  );
}

function Progress(props: { readonly shell: Shell }) {
  const { shell } = props;
  const { engineState, doc, registry } = shell.ctx;
  const purpose = useStore(engineState, (state) => state.evaluation?.purpose ?? null);
  const fraction = useStore(engineState, (state) => state.evaluation?.fraction ?? 0);
  const etaMs = useStore(engineState, (state) => state.evaluation?.etaMs ?? null);
  const nodeId = useStore(engineState, runningNode);
  const label = useStore(engineState, (state) => (nodeId === null ? null : state.nodes[nodeId]?.label ?? null));
  const target = useStore(engineState, (state) => (state.build.running ? state.build.target : null));
  const instance = useStore(doc, (state) => (nodeId !== null && Object.hasOwn(state.doc.nodes, nodeId) ? state.doc.nodes[nodeId]! : null));
  if (purpose === null) return null;
  const title = instance ? instance.title ?? registry.get(instance.type)?.title ?? instance.type : null;
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="og-status-item" data-status="evaluation" data-purpose={purpose}>
      <span className="og-status-strong">{PURPOSE[purpose]}</span>
      <div className="og-meter" data-kind="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="og-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <span>{percent} %</span>
      {target ? <span className="og-status-text">{target.index + 1} of {target.count}: {target.label}</span> : null}
      {title ? <span className="og-status-text" data-status="node">{title}{label ? `: ${label}` : ''}</span> : null}
      {etaMs !== null && etaMs > 0 ? <span>about {formatDuration(etaMs)} left</span> : null}
    </div>
  );
}

function View(props: { readonly shell: Shell }) {
  const { engineState, doc } = props.shell.ctx;
  const view = useStore(engineState, (state) => state.view);
  // What computes the view is an evaluation for it: a build and an evaluation for thumbnails bring no newer picture,
  // and the viewport's own word for a picture behind them is "Out of date" as well.
  const computing = useStore(engineState, (state) => state.evaluation !== null && (state.evaluation.purpose === 'view' || state.evaluation.purpose === 'draft'));
  const sent = useStore(doc, (state) => state.engineRevision);
  const paused = useStore(engineState, (state) => state.paused);
  if (!view) return null;
  // 7.3 rule 7: what is shown is behind the document, or coarser than the preview. Behind with nothing being
  // computed: the newer document could not be shown (rule 6), and the nodes that failed say why. Behind because
  // previews are paused is no fault: it is said as what it is, in every panel alike.
  const behind = view.revision < sent;
  const state = view.draft ? 'Draft' : !behind ? null : computing ? 'Updating' : paused ? 'Paused' : 'Out of date';
  return (
    <div className="og-status-item" data-status="view" data-behind={behind ? '' : undefined} data-draft={view.draft ? '' : undefined} data-paused={paused ? '' : undefined}>
      <span>{view.resolution} × {view.resolution}</span>
      {state ? <span className={state === 'Out of date' || state === 'Paused' ? 'og-status-warning' : 'og-status-strong'}>{state}</span> : null}
    </div>
  );
}

function Memory(props: { readonly shell: Shell }) {
  const memory = useStore(props.shell.ctx.engineState, (state) => state.memory);
  if (!memory) return null;
  const used = memory.workingBytes + memory.cacheBytes + memory.pinnedBytes + memory.freeBytes + memory.reservedBytes;
  const share = memory.budgetBytes > 0 ? Math.min(1, used / memory.budgetBytes) : 0;
  const detail = `In use ${formatBytes(memory.workingBytes)}, shown ${formatBytes(memory.pinnedBytes)}, cache ${formatBytes(memory.cacheBytes)}, `
    + `free for reuse ${formatBytes(memory.freeBytes)}, engine ${formatBytes(memory.reservedBytes)}`;
  return (
    <div className="og-status-item" data-status="memory" title={detail}>
      <span>GPU memory</span>
      <div className="og-meter" data-level={share > 0.9 ? 'high' : 'normal'} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className="og-meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <span>{formatBytes(used)} of {formatBytes(memory.budgetBytes)}</span>
    </div>
  );
}

function Errors(props: { readonly shell: Shell }) {
  const { shell } = props;
  // Of the nodes the document holds: the engine's last word on a deleted node is no error to show.
  const held = useStore(shell.ctx.doc, (state) => state.doc.nodes);
  const failed = useStore(shell.ctx.engineState, (state) => failedNodes(state.nodes, held).filter(isFailure).length);
  // A node that was asked for and lacks a wire is unfinished, not failed: said, and not in the colour of an error.
  const unwired = useStore(shell.ctx.engineState, (state) => failedNodes(state.nodes, held).filter((error) => !isFailure(error)).length);
  const logged = useStore(shell.state, (state) => state.log.length);
  if (failed === 0 && unwired === 0 && logged === 0) return null;
  const tone = failed > 0 ? 'error' : unwired > 0 ? 'warning' : null;
  return (
    <button
      type="button"
      className={tone === null ? 'og-status-button' : `og-status-button og-status-${tone}`}
      data-status="errors"
      data-tone={tone ?? undefined}
      data-command="view.showErrors"
      onClick={() => shell.runner.run('view.showErrors')}
    >
      <Icon name={tone ?? 'info'} />
      {failed > 0 ? `${failed} node${failed === 1 ? '' : 's'} failed`
        : unwired > 0 ? `${unwired} node${unwired === 1 ? ' lacks' : 's lack'} an input`
          : 'Messages'}
    </button>
  );
}

export function StatusBar(props: { readonly shell: Shell }) {
  const { shell } = props;
  return (
    <footer className="og-statusbar" data-shell="statusbar">
      <Device shell={shell} />
      <Progress shell={shell} />
      <div className="og-status-spacer" />
      <View shell={shell} />
      <Memory shell={shell} />
      <Errors shell={shell} />
    </footer>
  );
}
