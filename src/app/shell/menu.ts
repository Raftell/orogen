// The menu bar as data (runtime.md 8.8 rule 1): built from the menu entries the shell and the panels registered,
// so a panel adds an item in its own PanelDef. No DOM and no React: MenuBar.tsx draws what this returns.

import type { CommandRegistry } from './commands.ts';
import type { Keymap } from './keys.ts';

export interface MenuCommandItem {
  readonly kind: 'command';
  readonly command: string;
  readonly title: string;
  /** The key shown beside the title, in the notation of 8.8; null: none. */
  readonly key: string | null;
}
export interface MenuSeparatorItem { readonly kind: 'separator' }
export type MenuItemModel = MenuCommandItem | MenuSeparatorItem;

export interface MenuModel {
  readonly title: string;
  readonly items: readonly MenuItemModel[];
}

/** The shell's menus come first, in this order; a panel's own menu follows them; Help is last. */
export const MENU_ORDER: readonly string[] = ['File', 'Edit', 'View', 'Engine'];
const LAST = 'Help';

/**
 * One menu per title. Inside a menu the groups follow each other in the order their first entry was registered,
 * with a separator between two groups; entries without a group form one group per owner.
 */
export function buildMenus(registry: CommandRegistry, keymap: Keymap): MenuModel[] {
  const menus = new Map<string, Map<string, MenuCommandItem[]>>();
  for (const title of MENU_ORDER) menus.set(title, new Map());
  for (const entry of registry.menu) {
    const command = registry.get(entry.command);
    if (!command) continue;
    let groups = menus.get(entry.menu);
    if (!groups) menus.set(entry.menu, groups = new Map());
    const name = entry.group ?? `owner:${entry.owner}`;
    let group = groups.get(name);
    if (!group) groups.set(name, group = []);
    group.push({ kind: 'command', command: entry.command, title: command.def.title, key: keymap.keysOf(entry.command)[0] ?? null });
  }
  const titles = [...menus.keys()].filter((title) => title !== LAST);
  if (menus.has(LAST)) titles.push(LAST);
  const out: MenuModel[] = [];
  for (const title of titles) {
    const items: MenuItemModel[] = [];
    for (const group of menus.get(title)!.values()) {
      if (items.length > 0) items.push({ kind: 'separator' });
      items.push(...group);
    }
    if (items.length > 0) out.push({ title, items });
  }
  return out;
}
