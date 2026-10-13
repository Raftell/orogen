// The command registry (runtime.md 8.8 rules 1 and 4): what is collected from the shell and the panels, what
// stops start-up and how it says so, and how a command is run.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCommandRegistry, createCommandRunner, panelSources, RegistrationError, type CommandSource, type RegisteredCommand,
} from '../../../../src/app/shell/commands.ts';
import type { CommandContext, CommandDef, PanelDef } from '../../../../src/app/ui/types.ts';

const command = (id: string, extra: Partial<CommandDef> = {}): CommandDef => ({ id, title: id, run: () => undefined, ...extra });

const SHELL: CommandSource = {
  owner: 'shell',
  commands: [command('file.save'), command('edit.undo'), command('view.commandPalette'), command('engine.togglePause')],
  keys: [{ key: 'Mod+S', command: 'file.save', scope: 'global' }, { key: 'Mod+B', command: 'build.start', scope: 'global' }],
  menu: [{ menu: 'File', command: 'file.save' }],
};
const GRAPH: CommandSource = {
  owner: 'graph',
  commands: [command('graph.delete'), command('graph.fit')],
  keys: [{ key: 'Delete', command: 'graph.delete', scope: 'graph' }, { key: 'Backspace', command: 'graph.delete', scope: 'graph' }],
  menu: [{ menu: 'Graph', command: 'graph.fit' }],
};
const BUILD: CommandSource = { owner: 'build', commands: [command('build.start')], keys: [] };

function faults(sources: readonly CommandSource[]): readonly string[] {
  try {
    createCommandRegistry(sources);
  } catch (thrown) {
    assert.ok(thrown instanceof RegistrationError, String(thrown));
    assert.ok(thrown.message.startsWith('The application cannot start: '), thrown.message);
    for (const fault of thrown.faults) assert.ok(thrown.message.includes(fault));
    return thrown.faults;
  }
  return [];
}

test('the registry holds every command, binding and menu entry with its owner, in the order registered', () => {
  const registry = createCommandRegistry([SHELL, GRAPH, BUILD]);
  assert.deepEqual(registry.commands.map((c) => `${c.owner}:${c.def.id}`), [
    'shell:file.save', 'shell:edit.undo', 'shell:view.commandPalette', 'shell:engine.togglePause', 'graph:graph.delete', 'graph:graph.fit', 'build:build.start',
  ]);
  assert.equal(registry.get('graph.fit')?.owner, 'graph');
  assert.equal(registry.get('graph.nothing'), undefined);
  assert.deepEqual(registry.bindings.map((b) => `${b.owner}:${b.scope}:${b.key}:${b.command}`), [
    'shell:global:Mod+S:file.save', 'shell:global:Mod+B:build.start', 'graph:graph:Delete:graph.delete', 'graph:graph:Backspace:graph.delete',
  ]);
  assert.deepEqual(registry.menu, [{ menu: 'File', command: 'file.save', owner: 'shell' }, { menu: 'Graph', command: 'graph.fit', owner: 'graph' }]);
  assert.deepEqual(registry.keymapCommands.find((c) => c.id === 'graph.fit'), { id: 'graph.fit', scope: 'graph' });
  assert.deepEqual(registry.keymapCommands.find((c) => c.id === 'file.save'), { id: 'file.save', scope: 'global' });
});

test('two commands with one id stop start-up with a message that names both owners', () => {
  const twice = faults([SHELL, { ...GRAPH, commands: [...GRAPH.commands, command('graph.delete')] }, BUILD]);
  assert.deepEqual(twice, ['The command "graph.delete" is declared twice: by graph and by graph']);
});

test('a command belongs to the owner its id begins with', () => {
  assert.deepEqual(faults([SHELL, { ...GRAPH, commands: [...GRAPH.commands, command('build.start')] }]), [
    'graph declares the command "build.start": its commands begin with "graph."',
    'shell binds Mod+B to "build.start", which nobody declares',
  ]);
  assert.deepEqual(faults([{ ...SHELL, commands: [...SHELL.commands, command('graph.new')] }, GRAPH, BUILD]), [
    'shell declares the command "graph.new": its commands begin with "file.", "edit.", "view.", "engine."',
  ]);
  assert.deepEqual(faults([{ owner: 'graph', commands: [command('Graph Delete')], keys: [] }]), ['graph declares the command "Graph Delete": an id is "<owner>.<name>"']);
  assert.deepEqual(faults([{ owner: 'graph', commands: [command('graph.fit', { title: ' ' })], keys: [] }]), ['graph declares the command "graph.fit" without a title']);
});

test('a binding to a command nobody declares stops start-up', () => {
  assert.deepEqual(faults([SHELL, GRAPH]), ['shell binds Mod+B to "build.start", which nobody declares']);
});

test('two bindings with one key in one scope stop start-up with a message that names both owners', () => {
  const sources: CommandSource[] = [
    { ...SHELL, keys: [...SHELL.keys, { key: 'Mod+S', command: 'edit.undo', scope: 'global' }] },
    GRAPH,
    BUILD,
  ];
  assert.deepEqual(faults(sources), ['The key Mod+S is bound twice in the scope "global": by shell to "file.save" and by shell to "edit.undo"']);
  // One key in two scopes is two bindings: F locks the view in the graph and frames the terrain in the viewport.
  createCommandRegistry([
    SHELL, BUILD,
    { owner: 'graph', commands: [command('graph.toggleViewLock')], keys: [{ key: 'F', command: 'graph.toggleViewLock', scope: 'graph' }] },
    { owner: 'viewport', commands: [command('viewport.frame')], keys: [{ key: 'F', command: 'viewport.frame', scope: 'viewport' }] },
  ]);
});

test('a panel binds keys in its own scope, the shell binds global keys, and a key is written as the contract writes it', () => {
  assert.deepEqual(faults([SHELL, BUILD, { ...GRAPH, keys: [{ key: 'Mod+D', command: 'graph.delete', scope: 'global' }] }]), [
    'graph binds Mod+D to "graph.delete" in the scope "global": a panel binds keys in its own scope, "graph"',
  ]);
  assert.deepEqual(faults([{ ...SHELL, keys: [...SHELL.keys, { key: 'Delete', command: 'graph.delete', scope: 'graph' }] }, GRAPH, BUILD]), [
    'shell binds Delete to "graph.delete" in the scope "graph": the shell binds global keys',
  ]);
  assert.deepEqual(faults([SHELL, BUILD, { ...GRAPH, keys: [{ key: 'Shift+Mod+D', command: 'graph.delete', scope: 'graph' }] }]), [
    'graph binds Shift+Mod+D to "graph.delete": "Shift+Mod+D" is not a key as runtime.md 8.8 writes one',
  ]);
});

test('a menu entry names a command that exists, once per menu', () => {
  assert.deepEqual(faults([SHELL, BUILD, { ...GRAPH, menu: [{ menu: 'Graph', command: 'graph.align' }] }]), [
    'graph puts "graph.align" into the menu Graph, which nobody declares',
  ]);
  assert.deepEqual(faults([SHELL, BUILD, { ...GRAPH, menu: [{ menu: 'Graph', command: 'graph.fit' }, { menu: 'Graph', command: 'graph.fit' }] }]), [
    'graph puts "graph.fit" into the menu Graph, where it is already',
  ]);
  assert.deepEqual(faults([SHELL, BUILD, { ...GRAPH, menu: [{ menu: '', command: 'graph.fit' }] }]), ['graph puts "graph.fit" into a menu without a title']);
});

test('every fault of the lists is reported together', () => {
  const found = faults([{ ...SHELL, commands: [...SHELL.commands, command('file.save')] }, { ...GRAPH, menu: [{ menu: 'Graph', command: 'graph.none' }] }]);
  assert.equal(found.length, 3);
});

test('panelSources takes what each PanelDef brings, a missing menu as none', () => {
  const panel = (id: PanelDef['id'], extra: Partial<PanelDef> = {}): PanelDef =>
    ({ id, title: id, component: () => null, keepMounted: false, placement: {}, commands: [], keys: [], ...extra });
  const sources = panelSources([panel('graph', { commands: [command('graph.fit')], menu: [{ menu: 'Graph', command: 'graph.fit' }] }), panel('build')]);
  assert.deepEqual(sources.map((s) => [s.owner, s.commands.length, s.keys.length, s.menu?.length]), [['graph', 1, 0, 1], ['build', 0, 0, 0]]);
});

// ---- running ----

const CTX = { marker: 'the context' } as unknown as CommandContext;

function runnerOf(commands: readonly CommandDef[]): { run(id: string): void; enabled(id: string): boolean; failures: [string, unknown][] } {
  const registry = createCommandRegistry([{ owner: 'shell', commands, keys: [] }]);
  const failures: [string, unknown][] = [];
  const runner = createCommandRunner(registry, () => CTX, (failed: RegisteredCommand, thrown) => { failures.push([failed.def.id, thrown]); });
  return { ...runner, failures };
}

test('run calls an enabled command with the context and leaves a disabled one alone', () => {
  const calls: string[] = [];
  const given: CommandContext[] = [];
  let allowed = false;
  const runner = runnerOf([
    command('file.a', { run: (ctx) => { calls.push('a'); given.push(ctx); } }),
    command('file.b', { enabled: (ctx) => { given.push(ctx); return allowed; }, run: () => { calls.push('b'); } }),
  ]);
  assert.equal(runner.enabled('file.a'), true);
  runner.run('file.a');
  assert.deepEqual(calls, ['a']);
  assert.equal(runner.enabled('file.b'), false);
  runner.run('file.b');
  allowed = true;
  assert.equal(runner.enabled('file.b'), true);
  runner.run('file.b');
  assert.deepEqual(calls, ['a', 'b']);
  assert.ok(given.length >= 4 && given.every((ctx) => ctx === CTX), 'every call gets the context');
  assert.deepEqual(runner.failures, []);
});

test('run throws for an id that is no command: that is a mistake of the caller', () => {
  const runner = runnerOf([command('file.a')]);
  assert.throws(() => runner.run('file.nothing'), /There is no command "file\.nothing"/);
  assert.equal(runner.enabled('file.nothing'), false);
});

test('a command that throws, a promise that rejects and an enabled that throws are reported and stop nothing', async () => {
  const runner = runnerOf([
    command('file.throws', { run: () => { throw new Error('thrown'); } }),
    command('file.rejects', { run: async () => { throw new Error('rejected'); } }),
    command('file.asks', { enabled: () => { throw new Error('asked'); } }),
    command('file.fine', { run: async () => undefined }),
  ]);
  runner.run('file.throws');
  runner.run('file.rejects');
  runner.run('file.asks');
  runner.run('file.fine');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(runner.failures.map(([id, thrown]) => [id, (thrown as Error).message]), [
    ['file.throws', 'thrown'], ['file.asks', 'asked'], ['file.rejects', 'rejected'],
  ]);
  assert.equal(runner.enabled('file.asks'), false);
});
