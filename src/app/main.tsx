// The page's entry (runtime.md 8.1, 8.3, 8.5): it makes the node registry, the engine worker and its client,
// the shell, and mounts the frame. The stores are those of src/app/state/.
//
// What is made before the first `await` is there when the window has loaded: a test reaches `orogenTest.ctx`
// from its first call (testing.md 2.9), and the engine worker has its preferences, project and document, in
// that order, before it has a device (8.3).

import { createRoot } from 'react-dom/client';

import { nodes } from '../core/nodes/index.ts';
import { createRegistry, DEFAULT_PREFERENCES } from '../core/runtime.ts';
import { createEngineClient } from './engine/client.ts';
import { platform, type Preferences } from './platform.ts';
import { panels } from './registry.ts';
import { createShellDom } from './shell/dom.ts';
import { galleryStore } from './shell/Gallery.tsx';
import { createShell, type Shell } from './shell/shell.ts';
import './shell/theme.css';
import './shell/shell.css';
import { ShellFrame } from './shell/Shell.tsx';
import { answeringPlatform, emptyAnswers, type ShellTestHooks } from './shell/test-hooks.ts';
import { docStore } from './state/doc-store.ts';
import { engineStore } from './state/engine-store.ts';
import { uiStore } from './state/ui-store.ts';
import type { CommandContext } from './ui/types.ts';

/** The built engine worker lies beside the page: dist/engine-worker.js, a classic script (8.3). */
const ENGINE_WORKER = './engine-worker.js';

/** The preferences until the file is read: those of a first start. */
const FIRST_START: Preferences = { gpu: DEFAULT_PREFERENCES, keymap: {}, layout: null, recent: [] };

const root = createRoot(document.getElementById('root')!);

/** Start-up stopped (8.8 rule 4, or a defect): the window says why and nothing else runs. */
function fatal(thrown: unknown): void {
  console.error('[orogen] the application did not start', thrown);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  root.render(
    <div className="og-fatal" data-ui="fatal">
      <h1>Orogen could not start</h1>
      <pre>{message}</pre>
    </div>,
  );
}

function start(): { readonly shell: Shell; readonly hooks: ShellTestHooks | null } {
  const registry = createRegistry(nodes);
  const testMode = platform.testMode;
  const answers = emptyAnswers();
  const bridge = testMode ? answeringPlatform(platform, answers) : platform;

  // Created by the top-level frame: only then has the worker Node's modules (8.2 rule 4).
  const createWorker = (): Worker => new Worker(ENGINE_WORKER, { name: 'orogen-engine' });
  let worker = createWorker();
  const engine = createEngineClient({ port: worker, doc: docStore, engineState: engineStore, preferences: FIRST_START.gpu });
  // 8.5: a worker that is gone, hangs or never started is replaced. Nothing the user made was in it; the client
  // tells the new session everything again, and the viewport panel gives it a canvas.
  const restartEngine = (): void => {
    worker.terminate();
    worker = createWorker();
    engine.connect(worker);
  };
  const dom = createShellDom(uiStore);
  const shell = createShell({
    doc: docStore,
    engineState: engineStore,
    ui: uiStore,
    engine,
    platform: bridge,
    registry,
    panels,
    preferences: FIRST_START,
    host: { edit: dom.edit, closeWindow: dom.closeWindow, restartEngine },
    keyPlatform: /mac/i.test(navigator.platform) ? 'mac' : 'other',
  });
  dom.install(shell);
  shell.connect();

  let hooks: ShellTestHooks | null = null;
  if (testMode) {
    const made: ShellTestHooks = {
      state: shell.state,
      answers,
      gallery: galleryStore,
      dock: null,
      engineWorker: () => worker,
      layout: () => made.dock?.layout() ?? null,
      async restoreLayout() {
        const preferences = await bridge.getPreferences();
        shell.adoptPreferences(preferences);
        if (!made.dock) throw new Error('The dock is not there yet');
        return made.dock.restore(preferences.layout);
      },
    };
    hooks = made;
    (globalThis as unknown as { orogenTest?: { ctx: CommandContext; shell: ShellTestHooks } }).orogenTest = { ctx: shell.ctx, shell: made };
  }
  return { shell, hooks };
}

async function open({ shell, hooks }: ReturnType<typeof start>): Promise<void> {
  try {
    shell.adoptPreferences(await shell.ctx.platform.getPreferences());
  } catch (thrown) {
    shell.notify({ level: 'error', message: 'The preferences could not be read', detail: thrown instanceof Error ? thrown.message : String(thrown) });
  }
  // The dock reads its layout from the preferences when it mounts.
  root.render(<ShellFrame shell={shell} exposeDock={hooks ? (handle) => { hooks.dock = handle; } : undefined} />);
  await shell.project.start();
}

try {
  open(start()).catch(fatal);
} catch (thrown) {
  fatal(thrown);
}
