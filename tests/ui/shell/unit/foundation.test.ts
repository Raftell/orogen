// What parallel panel work stands on (runtime.md 8.10, "What makes parallel panel work safe"): the frozen
// pieces are complete, each as the contract prints it, and a panel brings its commands, keys and menu entries
// in its own PanelDef. The contract's declarations are read from runtime.md itself, so a member added to one
// side and not the other fails here.
//
// The last test is a throwaway panel: a PanelDef written as a panel folder writes it, handed to the real shell
// in the place of the graph panel. No file of the shell, the stores or the registry knows of it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createEngineClient } from '../../../../src/app/engine/client.ts';
import { PANEL_IDS, RegistrationError } from '../../../../src/app/shell/commands.ts';
import { formatKey } from '../../../../src/app/shell/keys.ts';
import { createDocStore } from '../../../../src/app/state/doc-store.ts';
import { createEngineStore, reduceEngineEvent } from '../../../../src/app/state/engine-store.ts';
import { createUiStore, setSelection } from '../../../../src/app/state/ui-store.ts';
import type { CommandDef, KeyBinding, MenuEntry, PanelDef } from '../../../../src/app/ui/types.ts';
import { addNode, connect, setParam, type SessionPort } from '../../../../src/core/runtime.ts';
import { createRig, fakePanels, REGISTRY, run } from './_shell.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const RUNTIME = read('docs/contract/runtime.md');

/**
 * The member names of `interface <name>` as a text declares it, in order: of the contract's code blocks, or of a
 * source file. Members of nested object types are not members of the interface.
 */
function membersOf(text: string, name: string): string[] {
  const start = text.search(new RegExp(`\\binterface ${name}\\b[^{]*\\{`));
  assert.ok(start >= 0, `interface ${name} is declared`);
  const open = text.indexOf('{', start);
  const members: string[] = [];
  let depth = 0;
  let line = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{' || c === '(') depth++;
    if (c === '}' || c === ')') depth--;
    if (depth === 0) break;
    if (c === '\n') line = '';
    else line += c;
    // A member begins its line at the depth of the interface's own body.
    if (depth === 1 && (c === ':' || c === '?') || depth === 2 && c === '(') {
      const found = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)[?:(]$/.exec(line.replace(/^\s*\/\*\*.*?\*\/\s*/, ''));
      if (found && !members.includes(found[1]!)) members.push(found[1]!);
    }
  }
  // An interface written on one line is not read: it is not compared, rather than compared as empty.
  assert.ok(members.length > 0, `interface ${name} has members, one a line`);
  return members;
}

const sorted = (names: Iterable<string>): string[] => [...names].sort();

// ---- the stores (8.5) ----

test('the three stores hold every member the contract prints, and no other', () => {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  assert.deepEqual(sorted(Object.keys(doc.getState())), sorted(membersOf(RUNTIME, 'DocState')));
  assert.deepEqual(sorted(Object.keys(ui.getState())), sorted(membersOf(RUNTIME, 'UiState')));

  const engine = createEngineStore().getState();
  assert.deepEqual(sorted(Object.keys(engine)), sorted(membersOf(RUNTIME, 'EngineState')));
  assert.deepEqual(sorted(Object.keys(engine.device)), ['caps', 'message', 'state']);
  assert.deepEqual(sorted(Object.keys(engine.build)), ['fraction', 'lastStatus', 'phase', 'plan', 'problems', 'requestId', 'result', 'running', 'target']);
  const ran = reduceEngineEvent(engine, { type: 'node-done', requestId: 1, nodeId: 'a', cached: false, resolution: 257, wallMs: 1, gpuMs: null, peakBytes: 0 });
  assert.deepEqual(sorted(Object.keys(ran.nodes.a!)), sorted(membersOf(RUNTIME, 'NodeRuntime')));

  // A history entry, as a transaction leaves it.
  doc.getState().transact('Seed', (draft) => { draft.settings.seed = 5; });
  assert.deepEqual(sorted(Object.keys(doc.getState().past[0]!)), sorted(membersOf(RUNTIME, 'HistoryEntry')));
});

test('the store files and the source declare the same members as the contract', () => {
  for (const [file, names] of [
    ['src/app/state/doc-store.ts', ['HistoryEntry', 'DocState']],
    ['src/app/state/engine-store.ts', ['NodeRuntime', 'EngineState']],
    ['src/app/state/ui-store.ts', ['UiState']],
    ['src/platform/electron/ipc.ts', ['Preferences', 'PlatformApi']],
    ['src/app/ui/types.ts', ['CommandContext', 'CommandDef', 'KeyBinding', 'MenuEntry', 'PanelDef']],
    ['src/core/session/session.ts', ['EngineSession', 'EnginePreferences', 'BuildRequest']],
    ['src/core/session/viewport.ts', ['ViewportHost', 'ViewportDisplay', 'PickResult']],
  ] as const) {
    const source = read(file);
    for (const name of names) assert.deepEqual(membersOf(source, name), membersOf(RUNTIME, name), `${name} of ${file} against runtime.md`);
  }
});

// ---- the engine client and the bridge (7.1, 7.5, 8.5, 8.6) ----

test('the engine client is a whole EngineSession, with the viewport, the thumbnails and connect', async () => {
  const ui = createUiStore();
  const sent: string[] = [];
  const port: SessionPort = {
    postMessage: (message) => void sent.push((message as { method: string }).method),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const client = createEngineClient({ port, doc: createDocStore({ ui }), engineState: createEngineStore() });
  assert.deepEqual(sorted(Object.keys(client)), sorted([...membersOf(RUNTIME, 'EngineSession'), ...membersOf(RUNTIME, 'EngineClient')]));
  assert.deepEqual(sorted(Object.keys(client.viewport)), sorted(membersOf(RUNTIME, 'ViewportHost')));
  // 8.3: the preferences and the project before the first document.
  assert.deepEqual(sent, ['setPreferences', 'setProject', 'setDocument']);
});

test('the bridge has the members the contract prints, in the page and in the main process', () => {
  const members = membersOf(RUNTIME, 'PlatformApi');
  assert.equal(members.length, 26);
  // The preload script exposes each, and the hidden-window test of the bridge compares the same list with the page's object.
  const preload = read('src/platform/electron/preload/preload.ts');
  for (const member of members) assert.match(preload, new RegExp(`\\b${member}\\b`), `the preload script has ${member}`);
  const listed = /const BRIDGE = \[([^\]]*)\]/.exec(read('tests/ui/platform/pipeline.test.ts'));
  assert.ok(listed, 'tests/ui/platform/pipeline.test.ts lists the bridge');
  assert.deepEqual(sorted(listed[1]!.split(',').map((entry) => entry.trim().replace(/'/g, '')).filter((entry) => entry !== '')), sorted(members));
});

// ---- the panel registry and what a panel imports (8.7, 8.10) ----

test('the panel registry lists the five panels, each a folder whose index exports its PanelDef', () => {
  const registry = read('src/app/registry.ts');
  const imported = [...registry.matchAll(/import \{ panel as (\w+) \} from '\.\/panels\/(\w+)\/index\.ts';/g)].map((found) => [found[1], found[2]]);
  assert.deepEqual(sorted(imported.map(([, folder]) => folder!)), sorted(PANEL_IDS));
  for (const [name, folder] of imported) assert.equal(name, folder);
  const list = /export const panels: readonly PanelDef\[\] = \[([^\]]*)\];/.exec(registry);
  assert.ok(list, 'the registry exports the list');
  assert.deepEqual(sorted(list[1]!.split(',').map((entry) => entry.trim())), sorted(PANEL_IDS));

  for (const id of PANEL_IDS) {
    const index = read(`src/app/panels/${id}/index.ts`);
    assert.match(index, /export const panel: PanelDef = \{/, `${id} exports its PanelDef as "panel"`);
    assert.match(index, new RegExp(`\\n  id: '${id}',`), `the PanelDef of ${id} has its id`);
    // What a panel is to the shell comes from src/app/ui/, never from the shell or the registry (8.7 rule 2).
    assert.match(index, /from '\.\.\/\.\.\/ui\/index\.ts';/);
    const component = /component: (\w+),/.exec(index);
    assert.ok(component && index.includes(`import { ${component[1]} } from './${component[1]}.tsx';`), `the component of ${id} is a file of its folder`);
  }
  // A canvas must survive its panel being hidden (8.7 rule 3).
  for (const id of ['graph', 'viewport']) assert.match(read(`src/app/panels/${id}/index.ts`), /keepMounted: true/);
});

test('no panel folder is a placeholder: each brings a component of its own, its commands under its name, and the keys of 8.8 in its scope', () => {
  /** A panel declares its commands, keys and menu entries in its index.ts or in a commands.ts beside it. */
  const declaring = (id: string): string => ['index.ts', 'commands.ts']
    .map((file) => path.join('src/app/panels', id, file))
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .map(read)
    .join('\n');
  const commandsOf = (id: string): string[] => [...declaring(id).matchAll(/\bid: '(\w+\.\w+)'/g)].map((found) => found[1]!);
  const keysOf = (id: string): string[] => [...declaring(id).matchAll(/\{ key: '([^']+)', command: '([\w.]+)', scope: '(\w+)' \}/g)].map((found) => `${found[1]} ${found[2]} ${found[3]}`);

  for (const id of PANEL_IDS) {
    // The starting state of 8.10 rule 1 is over: no panel is the empty state, and each is more than its two first files.
    const folder = path.join(ROOT, 'src/app/panels', id);
    const files = fs.readdirSync(folder);
    assert.ok(files.length > 2, `${id} is more than a PanelDef and a component: ${files.join(', ')}`);
    const index = read(`src/app/panels/${id}/index.ts`);
    const component = /component: (\w+),/.exec(index)![1]!;
    assert.doesNotMatch(read(`src/app/panels/${id}/${component}.tsx`), /return <EmptyState title="\w+">[^<]+<\/EmptyState>;\s*\}\s*$/, `the component of ${id} is not the empty state`);
    const commands = commandsOf(id);
    assert.ok(commands.length > 0, `${id} declares commands`);
    // 8.8 rule 1: the owner of a command is the prefix of its id.
    for (const command of commands) assert.ok(command.startsWith(`${id}.`), `${command} is declared by ${id}`);
    assert.equal(new Set(commands).size, commands.length, `${id} declares each command once`);
  }

  // The shell's global bindings name commands of two panels; a binding to no command stops start-up (8.8 rule 4).
  assert.ok(commandsOf('viewport').includes('viewport.toggleTop'));
  assert.ok(commandsOf('build').includes('build.start') && commandsOf('build').includes('build.cancel'));

  // The default bindings of 8.8 that are a panel's: each row of the contract's table is declared in that panel's scope.
  const table = RUNTIME.slice(RUNTIME.indexOf('| Key | Command | Scope |'), RUNTIME.indexOf('### 8.9 Libraries'));
  const rows = [...table.matchAll(/^\| (.+?) \| (.+?) \| (\w+) \|$/gm)].slice(1);
  let panelRows = 0;
  for (const [, keyCell, commandCell, scope] of rows) {
    if (scope === 'global') continue;
    panelRows++;
    const command = /`([\w.]+)`/.exec(commandCell!)![1]!;
    for (const [, key] of keyCell!.matchAll(/`([^`]+)`/g)) {
      assert.ok(keysOf(scope!).includes(`${key} ${command} ${scope}`), `${scope} binds ${key} to ${command} (runtime.md 8.8)`);
    }
  }
  assert.equal(panelRows, 11, 'the table of 8.8 has eleven rows of panel bindings');
  // And a panel binds keys in no scope but its own.
  for (const id of PANEL_IDS) for (const bound of keysOf(id)) assert.ok(bound.endsWith(` ${id}`), `${id} binds in its own scope: ${bound}`);
});

test('src/app/ui exports the shared controls and the types of a panel', () => {
  const index = read('src/app/ui/index.ts');
  const exported = new Set([...index.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((found) => found[1]!.split(',').map((name) => name.trim()).filter((name) => name !== '')));
  for (const name of [
    // 8.7: what a panel is to the shell, and its way to the application.
    'PanelDef', 'PanelId', 'CommandDef', 'CommandContext', 'KeyBinding', 'MenuEntry', 'AppServices', 'Notice', 'useApp', 'useCommandContext', 'useCommandEnabled',
    // The shared controls.
    'NumberField', 'Slider', 'Checkbox', 'Select', 'TextField', 'ColorSwatch', 'Button', 'IconButton', 'CommandButton',
    'Popover', 'Menu', 'ContextMenu', 'Tooltip', 'Dialog', 'Icon', 'EmptyState', 'PropertyRow', 'SectionTitle',
  ]) assert.ok(exported.has(name), `src/app/ui/index.ts exports ${name}`);
  // Every control file of the folder is reachable through the index: a panel imports nothing else of it.
  for (const file of fs.readdirSync(path.join(ROOT, 'src/app/ui'))) {
    if (file === 'index.ts' || !/\.tsx?$/.test(file)) continue;
    assert.ok(index.includes(`'./${file}'`), `src/app/ui/index.ts exports from ${file}`);
  }
});

// ---- a throwaway panel ----

/** What a panel's index.ts holds, for a panel that does not exist: commands, keys in its scope, menu entries. */
function throwawayPanel(): { readonly panel: PanelDef; readonly ran: string[] } {
  const ran: string[] = [];
  const commands: readonly CommandDef[] = [
    {
      id: 'graph.addTerraces',
      title: 'Add Terraces',
      enabled: (ctx) => Object.keys(ctx.doc.getState().doc.nodes).length > 0,
      run(ctx) {
        // A document change as a panel makes it: the commands of 4.6 in one transaction, the selection set inside it.
        ctx.doc.getState().transact('Add Terraces', (draft) => {
          const source = Object.keys(draft.nodes)[0]!;
          const id = addNode(draft, ctx.registry, 'surface/terraces', { x: 280, y: 0 });
          connect(draft, ctx.registry, { node: source, port: 'out' }, { node: id, port: 'in' });
          setParam(draft, ctx.registry, id, 'levels', 3);
          setSelection(ctx.ui, [id]);
        });
        ran.push('graph.addTerraces');
      },
    },
    { id: 'graph.delete', title: 'Delete Nodes', run: () => void ran.push('graph.delete') },
  ];
  const keys: readonly KeyBinding[] = [
    { key: 'T', command: 'graph.addTerraces', scope: 'graph' },
    { key: 'Delete', command: 'graph.delete', scope: 'graph' },
  ];
  const menu: readonly MenuEntry[] = [
    { menu: 'Graph', command: 'graph.addTerraces' },
    { menu: 'Edit', command: 'graph.delete', group: 'clipboard' },
  ];
  return { ran, panel: { id: 'graph', title: 'Graph', component: () => null, keepMounted: true, placement: { relativeTo: 'viewport', direction: 'below' }, commands, keys, menu } };
}

test('a throwaway panel adds a command, a key and a menu entry from its own PanelDef, and nothing else is touched', async () => {
  const { panel, ran } = throwawayPanel();
  const rig = createRig({ panels: fakePanels().map((other) => (other.id === 'graph' ? panel : other)) });
  const { shell } = rig;
  await rig.shell.project.start();

  // The command: registered under its panel, known to the services a component uses, and run through the context.
  assert.equal(shell.commands.get('graph.addTerraces')?.owner, 'graph');
  assert.deepEqual([shell.services.commandTitle('graph.addTerraces'), shell.services.enabled('graph.addTerraces')], ['Add Terraces', true]);
  shell.ctx.run('graph.addTerraces');
  const made = rig.doc.getState().doc;
  const added = Object.values(made.nodes).find((node) => node.type === 'surface/terraces')!;
  assert.deepEqual([Object.keys(made.nodes).length, Object.keys(made.edges).length, added.params.levels], [2, 1, 3]);
  assert.deepEqual(rig.ui.getState().selection, [added.id]);
  // It is an undo step like any other, and the shell's own Undo takes it back.
  await run(rig, 'edit.undo');
  assert.equal(Object.keys(rig.doc.getState().doc.nodes).length, 1);
  await run(rig, 'edit.redo');
  assert.equal(Object.keys(rig.doc.getState().doc.nodes).length, 2);

  // The key: in the panel's own scope, so only while the panel has the focus, and never while a field takes text.
  const keymap = shell.keymap();
  assert.equal(keymap.resolve('T', { focusedPanel: 'graph', textField: false }), 'graph.addTerraces');
  assert.equal(keymap.resolve('T', { focusedPanel: 'viewport', textField: false }), null);
  assert.equal(keymap.resolve('T', { focusedPanel: 'graph', textField: true }), null);
  assert.equal(shell.services.keyLabel('graph.addTerraces'), formatKey('T', shell.keyPlatform));
  // The user's keymap reaches it like a command of the shell (8.8 rule 5).
  shell.setPreferences({ keymap: { 'graph.addTerraces': 'Mod+T' } });
  assert.equal(shell.keymap().resolve('Mod+T', { focusedPanel: 'graph', textField: false }), 'graph.addTerraces');
  assert.equal(shell.keymap().resolve('T', { focusedPanel: 'graph', textField: false }), null);
  shell.setPreferences({ keymap: {} });

  // The menu entries: a menu of the panel's own after the shell's four, and an item in one of those.
  const menus = shell.menus();
  assert.deepEqual(menus.map((menu) => menu.title), ['File', 'Edit', 'View', 'Engine', 'Graph', 'Help']);
  const graph = menus.find((menu) => menu.title === 'Graph')!;
  assert.deepEqual(graph.items, [{ kind: 'command', command: 'graph.addTerraces', title: 'Add Terraces', key: 'T' }]);
  const edit = menus.find((menu) => menu.title === 'Edit')!;
  assert.ok(edit.items.some((item) => item.kind === 'command' && item.command === 'graph.delete' && item.key === 'Delete'));

  // The shell's Edit → Delete goes to the panel that has the focus, as its command of that name (8.8 rule 6).
  rig.ui.setState({ focusedPanel: 'graph' });
  await run(rig, 'edit.delete');
  assert.deepEqual(ran, ['graph.addTerraces', 'graph.delete']);
  // The native menu and the palette run it by its id, as they run a command of the shell.
  rig.platform.menu('graph.addTerraces');
  assert.deepEqual(ran, ['graph.addTerraces', 'graph.delete', 'graph.addTerraces']);
  rig.stop();
});

test('a throwaway panel that reaches outside its own names stops start-up, and says who', () => {
  const { panel } = throwawayPanel();
  const withPanel = (changed: Partial<PanelDef>): PanelDef[] => fakePanels().map((other) => (other.id === 'graph' ? { ...panel, ...changed } : other));
  const refused = (changed: Partial<PanelDef>): string => {
    try {
      createRig({ panels: withPanel(changed) });
    } catch (thrown) {
      assert.ok(thrown instanceof RegistrationError, String(thrown));
      return thrown.faults.join('; ');
    }
    return '';
  };
  // A command under another owner's name, a key outside its scope, a key the shell has, an entry to no command.
  assert.match(refused({ commands: [...panel.commands, { id: 'file.export', title: 'Export', run: () => undefined }] }), /graph declares the command "file\.export"/);
  assert.match(refused({ keys: [{ key: 'T', command: 'graph.addTerraces', scope: 'global' }] }), /graph/);
  assert.match(refused({ keys: [{ key: 'T', command: 'graph.addTerraces', scope: 'viewport' }] }), /graph/);
  assert.match(refused({ menu: [{ menu: 'Graph', command: 'graph.nothing' }] }), /graph\.nothing/);
  assert.equal(refused({}), '');
  // The registry it is tested against holds the node the command adds.
  assert.ok(REGISTRY.get('surface/terraces'));
});
