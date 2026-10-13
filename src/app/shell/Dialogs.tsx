// The shell's own dialogs: the question about unsaved changes, the problems of a project that was opened, a
// file that could not be read or written, and the list of errors with their details.

import { useStore } from 'zustand';

import type { NodeError } from '../../core/runtime.ts';
import { Button, Dialog, Icon, isFailure, nodeErrorText } from '../ui/index.ts';
import { baseName, failedNodes } from './format.ts';
import { Gallery } from './Gallery.tsx';
import { PreferencesDialog } from './Preferences.tsx';
import type { Shell, ShellDialog } from './shell.ts';

function Unsaved(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'unsaved' }> }) {
  const { shell } = props;
  return (
    <Dialog
      open
      name="unsaved"
      title={`Save the changes to ${props.dialog.project}?`}
      description="The changes are lost if they are not saved."
      onClose={() => shell.answerUnsaved('cancel')}
      actions={
        <>
          <Button className="og-dialog-actions-start" variant="danger" data-action="discard" onClick={() => shell.answerUnsaved('discard')}>Don&rsquo;t Save</Button>
          <Button data-action="cancel" onClick={() => shell.answerUnsaved('cancel')}>Cancel</Button>
          <Button variant="primary" data-action="save" autoFocus onClick={() => shell.answerUnsaved('save')}>Save</Button>
        </>
      }
    />
  );
}

function Problems(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'problems' }> }) {
  const { shell, dialog } = props;
  const count = dialog.problems.length;
  return (
    <Dialog
      open
      name="problems"
      width={560}
      title={`${baseName(dialog.file)} was opened with ${count} problem${count === 1 ? '' : 's'}`}
      description="The project is open. The file itself is unchanged until the project is saved."
      onClose={() => shell.closeDialog()}
      actions={<Button variant="primary" data-action="ok" autoFocus onClick={() => shell.closeDialog()}>OK</Button>}
    >
      <ul className="og-list" data-ui="problems">
        {dialog.problems.map((problem, index) => (
          <li key={index} className="og-list-item">
            <Icon className="og-text-warning" name="warning" />
            <div className="og-list-main">
              <div className="og-list-title">{problem.message}</div>
              {problem.nodeId || problem.edgeId ? (
                <div className="og-list-note">{problem.nodeId ? `Node ${problem.nodeId}` : `Connection ${problem.edgeId}`}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function Failure(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'failure' }> }) {
  const { shell, dialog } = props;
  return (
    <Dialog
      open
      name="failure"
      title={dialog.title}
      description={dialog.message}
      onClose={() => shell.closeDialog()}
      actions={<Button variant="primary" data-action="ok" autoFocus onClick={() => shell.closeDialog()}>OK</Button>}
    />
  );
}

/** What a node's error has beyond its sentence: the kernel, the place in the WGSL, the GPU's own words. */
function detailOf(error: NodeError): string {
  const lines: string[] = [];
  if (error.kernel) lines.push(`Kernel ${error.kernel}`);
  if (error.wgsl) lines.push(JSON.stringify(error.wgsl, null, 2));
  if (error.detail) lines.push(error.detail);
  return lines.join('\n');
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ErrorList(props: { readonly shell: Shell }) {
  const { shell } = props;
  const { engineState, doc, registry } = shell.ctx;
  const device = useStore(engineState, (state) => state.device);
  const nodes = useStore(engineState, (state) => state.nodes);
  const build = useStore(engineState, (state) => state.build);
  const held = useStore(doc, (state) => state.doc.nodes);
  const log = useStore(shell.state, (state) => state.log);

  const failed = failedNodes(nodes, held);
  const titleOf = (error: NodeError): string => {
    const instance = Object.hasOwn(held, error.nodeId) ? held[error.nodeId] : undefined;
    return instance?.title ?? registry.get(error.nodeType)?.title ?? error.nodeType;
  };
  // The plan's problems arrive as events of their own; those of the pipeline with the result, which holds both.
  const problems = build.result?.problems ?? build.problems;
  const empty = failed.length === 0 && problems.length === 0 && log.length === 0 && device.state !== 'failed';

  return (
    <Dialog
      open
      name="errors"
      width={640}
      title="Errors and Messages"
      onClose={() => shell.closeDialog()}
      actions={<Button variant="primary" data-action="ok" autoFocus onClick={() => shell.closeDialog()}>Close</Button>}
    >
      {empty ? <div className="og-text-dim">Nothing has gone wrong</div> : null}
      <ul className="og-list" data-ui="errors">
        {device.state === 'failed' ? (
          <li className="og-list-item" data-error="device">
            <Icon className="og-text-error" name="error" />
            <div className="og-list-main">
              <div className="og-list-title">The graphics device could not be opened</div>
              {device.message ? <pre className="og-list-detail">{device.message}</pre> : null}
            </div>
            <Button size="small" onClick={() => shell.runner.run('engine.retryDevice')}>Retry</Button>
          </li>
        ) : null}
        {failed.map((error) => {
          const detail = detailOf(error);
          return (
            <li key={`node:${error.nodeId}`} className="og-list-item" data-error="node" data-node={error.nodeId} data-failure={isFailure(error) ? '' : undefined}>
              <Icon className={isFailure(error) ? 'og-text-error' : 'og-text-warning'} name={isFailure(error) ? 'error' : 'warning'} />
              <div className="og-list-main">
                <div className="og-list-title">{titleOf(error)}: {nodeErrorText(error, registry)}</div>
                <div className="og-list-note">{error.nodeType}, {error.kind}</div>
                {detail ? <pre className="og-list-detail">{detail}</pre> : null}
              </div>
            </li>
          );
        })}
        {problems.map((problem, index) => (
          <li key={`build:${index}`} className="og-list-item" data-error="build">
            <Icon className={problem.severity === 'error' ? 'og-text-error' : 'og-text-warning'} name={problem.severity === 'error' ? 'error' : 'warning'} />
            <div className="og-list-main">
              <div className="og-list-title">{problem.message}</div>
              <div className="og-list-note">Last build, {problem.code}</div>
            </div>
          </li>
        ))}
        {[...log].reverse().map((entry, index) => (
          <li key={`log:${index}`} className="og-list-item" data-error="log" data-level={entry.level}>
            <Icon className={entry.level === 'error' ? 'og-text-error' : entry.level === 'warning' ? 'og-text-warning' : 'og-text-dim'} name={entry.level === 'info' ? 'info' : entry.level} />
            <div className="og-list-main">
              <div className="og-list-title">{entry.message}</div>
              <div className="og-list-note">{TIME.format(entry.time)}</div>
              {entry.detail ? <pre className="og-list-detail">{entry.detail}</pre> : null}
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function Dialogs(props: { readonly shell: Shell }) {
  const { shell } = props;
  const dialog = useStore(shell.state, (state) => state.dialog);
  if (dialog === null) return null;
  switch (dialog.kind) {
    case 'unsaved': return <Unsaved shell={shell} dialog={dialog} />;
    case 'problems': return <Problems shell={shell} dialog={dialog} />;
    case 'failure': return <Failure shell={shell} dialog={dialog} />;
    case 'errors': return <ErrorList shell={shell} />;
    case 'preferences': return <PreferencesDialog shell={shell} />;
    case 'gallery': return <Gallery shell={shell} />;
  }
}
