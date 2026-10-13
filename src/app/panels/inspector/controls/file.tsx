// A file parameter: the name of the file, a button that opens the bridge's dialog, and one that has the engine
// look at the file again. A path is stored as the bridge writes it for the project (engine.md 4.12 rule 1).
// The control lies below its label, as wide as the panel: a file's name is long, and what tells two files of a
// project apart is often its end, so a name that does not fit is cut in the middle and keeps its extension.
// The interface thread cannot look at a file itself: that a file is missing is what the engine says when the
// node that reads it has run.

import { useStore } from 'zustand';

import type { FileParam } from '../../../../core/api.ts';
import { Button, Icon, IconButton, Tooltip, useApp } from '../../../ui/index.ts';
import type { EngineState } from '../../../state/engine-store.ts';
import styles from '../inspector.module.css';
import { fileNameParts } from '../model.ts';
import type { ControlProps } from './types.ts';

/**
 * What the engine said of the file when a node of the control last ran, in a word or two: the beginning of its
 * `io` error, "File not found" of "File not found: <path>". The head of the panel shows the whole message.
 */
function fileProblem(nodes: EngineState['nodes'], ids: readonly string[]): string | null {
  for (const id of ids) {
    const known = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (known?.state === 'error' && known.error?.kind === 'io') return known.error.message.split(': ')[0]!;
  }
  return null;
}

export function FileControl(props: ControlProps<FileParam, string>) {
  const app = useApp();
  const { platform, doc, engineState } = app.ctx;
  const problem = useStore(engineState, (state) => fileProblem(state.nodes, props.nodeIds));
  const { value } = props;
  const state = value === '' ? 'empty' : problem !== null ? 'missing' : 'chosen';
  const name = fileNameParts(value);

  const choose = async (): Promise<void> => {
    try {
      const picked = await platform.openFileDialog(props.param.filters);
      if (picked !== null) props.change(platform.toProjectPath(doc.getState().path, picked));
    } catch (thrown) {
      app.notify({ level: 'error', message: 'The file could not be chosen', detail: thrown instanceof Error ? thrown.message : String(thrown) });
    }
  };

  return (
    <div className={styles.file} data-control="file" data-state={state}>
      <div className={styles.fileLine}>
        <Tooltip content={value === '' ? `Choose a file: ${props.param.filters.join(', ')}` : value}>
          <button type="button" id={props.id} className={styles.fileName} data-action="choose" aria-label={props.label} disabled={props.disabled} onClick={() => void choose()}>
            {state === 'missing' ? <Icon name="warning" /> : <Icon name="file" />}
            <span className={styles.fileText}>
              <span className={styles.fileStem} data-file-stem="">{value === '' ? 'No file selected' : name.stem}</span>
              {name.extension === '' ? null : <span className={styles.fileExtension} data-file-extension="">{name.extension}</span>}
            </span>
          </button>
        </Tooltip>
        <IconButton icon="folder" label="Choose file…" size="small" disabled={props.disabled} data-action="browse" onClick={() => void choose()} />
        <Tooltip content="Reads the file again">
          <Button size="small" disabled={value === ''} data-action="reload" onClick={() => app.ctx.run('inspector.reloadFiles')}>Reload</Button>
        </Tooltip>
      </div>
      {state === 'missing' ? <div className={styles.fileProblem} data-file-problem="">{problem}</div> : null}
    </div>
  );
}
