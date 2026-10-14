// The shell's own dialogs: the questions before a project is left (a build that runs, unsaved changes), before a
// file is overwritten that another program changed, and about what a run before kept of an unsaved project; the
// problems of a project that was opened, a file that could not be read or written, the list of errors with their
// details, and what the application is. The pages of the Help menu are in Help.tsx.

import { useStore } from 'zustand';

import type { NodeError } from '../../core/runtime.ts';
import { Button, Dialog, Icon, isFailure, nodeErrorText } from '../ui/index.ts';
import { adapterName, baseName, failedNodes, formatBytes } from './format.ts';
import { Gallery } from './Gallery.tsx';
import { HelpDialog } from './Help.tsx';
import { PreferencesDialog } from './Preferences.tsx';
import type { Shell, ShellDialog } from './shell.ts';
import { APPLICATION } from './version.ts';

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

function Changed(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'changed' }> }) {
  const { shell } = props;
  const name = baseName(props.dialog.file);
  return (
    <Dialog
      open
      name="changed"
      width={480}
      title={`${name} was changed outside this window`}
      description={`Another program, or another Orogen, has saved ${name} since it was opened or last saved here. Saving now replaces what that program wrote with this project.`}
      onClose={() => shell.answerChanged('cancel')}
      actions={
        <>
          <Button className="og-dialog-actions-start" variant="danger" data-action="overwrite" onClick={() => shell.answerChanged('overwrite')}>Overwrite</Button>
          <Button data-action="cancel" onClick={() => shell.answerChanged('cancel')}>Cancel</Button>
          <Button variant="primary" data-action="save-as" autoFocus onClick={() => shell.answerChanged('saveAs')}>Save As…</Button>
        </>
      }
    />
  );
}

const KEPT_AT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Recover(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'recover' }> }) {
  const { shell, dialog } = props;
  const when = dialog.savedAt > 0 ? ` It was kept on ${KEPT_AT.format(dialog.savedAt)}.` : '';
  return (
    <Dialog
      open
      name="recover"
      width={480}
      dismissible={false}
      title={`Restore the unsaved changes to ${dialog.project}?`}
      description={`Orogen ended before this project was saved, and kept it as it was a few seconds earlier.${when} Restoring opens it with those changes, unsaved; the file of the project is not touched until you save.`}
      onClose={() => shell.answerRecover(false)}
      actions={
        <>
          <Button className="og-dialog-actions-start" variant="danger" data-action="discard" onClick={() => shell.answerRecover(false)}>Discard</Button>
          <Button variant="primary" data-action="restore" autoFocus onClick={() => shell.answerRecover(true)}>Restore</Button>
        </>
      }
    />
  );
}

/** What the user was about to do when a build was found running: the title of the question, and the button that goes on. */
const LEAVING = {
  new: { title: 'A build is running. Stop it and start a new project?', go: 'Stop Build and Continue' },
  open: { title: 'A build is running. Stop it and open another project?', go: 'Stop Build and Continue' },
  close: { title: 'A build is running. Stop it and close Orogen?', go: 'Stop Build and Close' },
} as const;

function Building(props: { readonly shell: Shell; readonly dialog: Extract<ShellDialog, { kind: 'building' }> }) {
  const { shell } = props;
  const words = LEAVING[props.dialog.leaving];
  return (
    <Dialog
      open
      name="building"
      title={words.title}
      description="The build is of this project. A build that is stopped changes nothing in its output folder: what it has written so far stays beside it, in the folder ending in .partial."
      onClose={() => shell.answerBuilding(false)}
      actions={
        <>
          <Button variant="danger" data-action="stop" onClick={() => shell.answerBuilding(true)}>{words.go}</Button>
          <Button variant="primary" data-action="stay" autoFocus onClick={() => shell.answerBuilding(false)}>Keep Building</Button>
        </>
      }
    />
  );
}

function About(props: { readonly shell: Shell }) {
  const { shell } = props;
  const device = useStore(shell.ctx.engineState, (state) => state.device);
  const memory = useStore(shell.ctx.engineState, (state) => state.memory);
  const caps = device.caps;
  const adapter = caps ? adapterName(caps.adapter)
    : device.state === 'starting' ? 'Starting' : device.state === 'failed' ? 'No graphics device could be opened' : 'Not known yet';
  const facts: readonly (readonly [string, string, string])[] = [
    ['version', 'Version', APPLICATION.version],
    ['adapter', 'Graphics adapter', caps?.software ? `${adapter} (software adapter)` : adapter],
    ...(caps?.adapter.backend ? [['backend', 'Graphics backend', caps.adapter.backend] as const] : []),
    ['profile', 'Device profile', shell.ctx.platform.gpuProfile],
    ...(caps ? [['texture', 'Largest texture', `${caps.limits.maxTextureDimension2D} × ${caps.limits.maxTextureDimension2D}`] as const] : []),
    ...(memory ? [['budget', 'Memory budget', formatBytes(memory.budgetBytes)] as const] : []),
  ];
  return (
    <Dialog
      open
      name="about"
      title="Orogen"
      description={APPLICATION.description || undefined}
      onClose={() => shell.closeDialog()}
      actions={<Button variant="primary" data-action="ok" autoFocus onClick={() => shell.closeDialog()}>Close</Button>}
    >
      <dl className="og-facts" data-ui="about">
        {facts.map(([id, label, value]) => (
          <div key={id} className="og-fact" data-about={id}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
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
                {/* The sentence above is for the user. A stack, the WGSL and the GPU's own words are for whoever is asked about it: folded away. */}
                {detail ? (
                  <details className="og-list-more" data-error="details">
                    <summary>Details</summary>
                    <pre className="og-list-detail">{detail}</pre>
                  </details>
                ) : null}
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
    case 'building': return <Building shell={shell} dialog={dialog} />;
    case 'changed': return <Changed shell={shell} dialog={dialog} />;
    case 'recover': return <Recover shell={shell} dialog={dialog} />;
    case 'help': return <HelpDialog shell={shell} page={dialog.page} />;
    case 'about': return <About shell={shell} />;
    case 'problems': return <Problems shell={shell} dialog={dialog} />;
    case 'failure': return <Failure shell={shell} dialog={dialog} />;
    case 'errors': return <ErrorList shell={shell} />;
    case 'preferences': return <PreferencesDialog shell={shell} />;
    case 'gallery': return <Gallery shell={shell} />;
  }
}
