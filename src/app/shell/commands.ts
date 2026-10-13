// The command registry (runtime.md 8.8 rules 1 and 4): at start-up the shell collects the commands, the default
// bindings and the menu entries of every panel and of its own list, and refuses to start on a list that
// contradicts another. Everything a user does that is not direct manipulation then goes through `run(id)`.
// No DOM and no React.

import type { CommandContext, CommandDef, KeyBinding, MenuEntry, PanelDef, PanelId } from '../ui/types.ts';
import { isKey, type KeymapCommand, type KeyScope, type OwnedBinding } from './keys.ts';

/** The owner name of the shell's own list. Its commands begin with one of SHELL_PREFIXES (rule 1). */
export const SHELL_OWNER = 'shell';
export const SHELL_PREFIXES: readonly string[] = ['file', 'edit', 'view', 'engine'];
export const PANEL_IDS: readonly PanelId[] = ['graph', 'viewport', 'inspector', 'library', 'build'];

/** What one owner brings: a panel (its id is the owner) or the shell. */
export interface CommandSource {
  readonly owner: string;
  readonly commands: readonly CommandDef[];
  readonly keys: readonly KeyBinding[];
  readonly menu?: readonly MenuEntry[];
}

export interface RegisteredCommand {
  readonly def: CommandDef;
  readonly owner: string;
}

export interface OwnedMenuEntry extends MenuEntry { readonly owner: string }

/** A list of commands, keys or menu entries that the registry refuses. Its message has one line for each fault. */
export class RegistrationError extends Error {
  override name = 'RegistrationError';
  readonly faults: readonly string[];
  constructor(faults: readonly string[]) {
    super(`The application cannot start: ${faults.join('\n')}`);
    this.faults = faults;
  }
}

export interface CommandRegistry {
  /** In the order registered: the shell's, then each panel's. */
  readonly commands: readonly RegisteredCommand[];
  get(id: string): RegisteredCommand | undefined;
  /** The default bindings. Preferences.keymap is applied by createKeymap. */
  readonly bindings: readonly OwnedBinding[];
  readonly menu: readonly OwnedMenuEntry[];
  readonly keymapCommands: readonly KeymapCommand[];
}

const COMMAND_ID = /^([a-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)$/;
const isPanel = (owner: string): owner is PanelId => PANEL_IDS.some((id) => id === owner);

/** The sources of the panel registry, in its order. */
export function panelSources(panels: readonly PanelDef[]): CommandSource[] {
  return panels.map((panel) => ({ owner: panel.id, commands: panel.commands, keys: panel.keys, menu: panel.menu ?? [] }));
}

/** Throws RegistrationError with every fault of the lists together. */
export function createCommandRegistry(sources: readonly CommandSource[]): CommandRegistry {
  const faults: string[] = [];
  const byId = new Map<string, RegisteredCommand>();
  const commands: RegisteredCommand[] = [];

  for (const source of sources) {
    for (const def of source.commands) {
      const shaped = COMMAND_ID.exec(def.id);
      if (!shaped) {
        faults.push(`${source.owner} declares the command "${def.id}": an id is "<owner>.<name>"`);
        continue;
      }
      const prefix = shaped[1]!;
      const owns = isPanel(source.owner) ? prefix === source.owner : SHELL_PREFIXES.includes(prefix);
      if (!owns) {
        const may = isPanel(source.owner) ? `"${source.owner}."` : SHELL_PREFIXES.map((p) => `"${p}."`).join(', ');
        faults.push(`${source.owner} declares the command "${def.id}": its commands begin with ${may}`);
        continue;
      }
      if (typeof def.title !== 'string' || def.title.trim() === '') faults.push(`${source.owner} declares the command "${def.id}" without a title`);
      const earlier = byId.get(def.id);
      if (earlier) {
        faults.push(`The command "${def.id}" is declared twice: by ${earlier.owner} and by ${source.owner}`);
        continue;
      }
      const registered: RegisteredCommand = { def, owner: source.owner };
      byId.set(def.id, registered);
      commands.push(registered);
    }
  }

  const bindings: OwnedBinding[] = [];
  const slots = new Map<string, OwnedBinding>();
  for (const source of sources) {
    for (const binding of source.keys) {
      const where = `${source.owner} binds ${binding.key} to "${binding.command}"`;
      if (!isKey(binding.key)) {
        faults.push(`${where}: "${binding.key}" is not a key as runtime.md 8.8 writes one`);
        continue;
      }
      const scope: KeyScope = isPanel(source.owner) ? source.owner : 'global';
      if (binding.scope !== scope) {
        faults.push(`${where} in the scope "${binding.scope}": ${isPanel(source.owner) ? `a panel binds keys in its own scope, "${scope}"` : 'the shell binds global keys'}`);
        continue;
      }
      if (!byId.has(binding.command)) {
        faults.push(`${where}, which nobody declares`);
        continue;
      }
      const slot = `${binding.scope} ${binding.key}`;
      const earlier = slots.get(slot);
      if (earlier) {
        faults.push(`The key ${binding.key} is bound twice in the scope "${binding.scope}": by ${earlier.owner} to "${earlier.command}" and by ${source.owner} to "${binding.command}"`);
        continue;
      }
      const owned: OwnedBinding = { key: binding.key, command: binding.command, scope: binding.scope, owner: source.owner };
      slots.set(slot, owned);
      bindings.push(owned);
    }
  }

  const menu: OwnedMenuEntry[] = [];
  const listed = new Set<string>();
  for (const source of sources) {
    for (const entry of source.menu ?? []) {
      if (typeof entry.menu !== 'string' || entry.menu.trim() === '') {
        faults.push(`${source.owner} puts "${entry.command}" into a menu without a title`);
        continue;
      }
      if (!byId.has(entry.command)) {
        faults.push(`${source.owner} puts "${entry.command}" into the menu ${entry.menu}, which nobody declares`);
        continue;
      }
      const place = `${entry.menu} ${entry.command}`;
      if (listed.has(place)) {
        faults.push(`${source.owner} puts "${entry.command}" into the menu ${entry.menu}, where it is already`);
        continue;
      }
      listed.add(place);
      menu.push({ ...entry, owner: source.owner });
    }
  }

  if (faults.length > 0) throw new RegistrationError(faults);

  const keymapCommands: KeymapCommand[] = commands.map(({ def, owner }) => ({ id: def.id, scope: isPanel(owner) ? owner : 'global' }));
  return { commands, get: (id) => byId.get(id), bindings, menu, keymapCommands };
}

export interface CommandRunner {
  /** Runs the command when it is enabled. Throws for an id that is not registered: that is a mistake of the caller. */
  run(id: string): void;
  /** False for an id that is not registered. */
  enabled(id: string): boolean;
}

/**
 * `failed` is told of a command that threw, or whose promise rejected, and of an `enabled` that threw. A command
 * reports what it expects to go wrong itself (a file that does not open); what arrives here is a defect.
 */
export function createCommandRunner(
  registry: CommandRegistry,
  context: () => CommandContext,
  failed: (command: RegisteredCommand, thrown: unknown) => void,
): CommandRunner {
  function enabled(command: RegisteredCommand): boolean {
    if (!command.def.enabled) return true;
    try {
      return command.def.enabled(context()) === true;
    } catch (thrown) {
      failed(command, thrown);
      return false;
    }
  }
  return {
    enabled(id) {
      const command = registry.get(id);
      return command !== undefined && enabled(command);
    },
    run(id) {
      const command = registry.get(id);
      if (!command) throw new Error(`There is no command "${id}"`);
      if (!enabled(command)) return;
      try {
        const result = command.def.run(context());
        if (result && typeof result.then === 'function') result.then(undefined, (thrown: unknown) => failed(command, thrown));
      } catch (thrown) {
        failed(command, thrown);
      }
    },
  };
}
