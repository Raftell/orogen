// Menus: one description of the items, drawn as a menu under a button or as a context menu.

import { ContextMenu as BaseContext } from '@base-ui/react/context-menu';
import { Menu as Base } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';

import './controls.css';
import { Icon } from './icons.tsx';
import type { AppServices } from './types.ts';

export type MenuItemSpec =
  | {
      readonly type?: 'item';
      readonly label: string;
      /** A key as shown to the user ('Ctrl+D'), drawn at the right. */
      readonly keyLabel?: string | null;
      readonly disabled?: boolean;
      /** True draws a check mark; false keeps its place empty. */
      readonly checked?: boolean;
      /** Drawn as something that discards. */
      readonly danger?: boolean;
      /** Names the item for a test or a style: `data-item`. */
      readonly id?: string;
      onSelect(): void;
    }
  | { readonly type: 'separator' }
  | { readonly type: 'label'; readonly label: string }
  | { readonly type: 'submenu'; readonly label: string; readonly disabled?: boolean; readonly id?: string; readonly items: readonly MenuItemSpec[] };

/**
 * Menu items for commands (runtime.md 8.8): each with the command's title, its current key, and disabled while the
 * command is. `null` is a separator. Made when the menu opens, so that what is enabled is current.
 */
export function commandItems(app: AppServices, commands: readonly (string | null)[]): MenuItemSpec[] {
  return commands.map((id): MenuItemSpec => {
    if (id === null) return { type: 'separator' };
    return {
      label: app.commandTitle(id) ?? id,
      keyLabel: app.keyLabel(id),
      disabled: !app.enabled(id),
      id,
      onSelect: () => app.ctx.run(id),
    };
  });
}

/** Nesting a description may have; a deeper submenu is not drawn. */
const DEPTH_MAX = 4;

/** The items of a menu popup. Exported for the menu bar, which has its own triggers. */
export function MenuItems(props: { readonly items: readonly MenuItemSpec[]; readonly depth?: number }) {
  const depth = props.depth ?? 0;
  return (
    <>
      {props.items.map((item, index) => {
        if (item.type === 'separator') return <Base.Separator key={index} className="og-menu-separator" />;
        if (item.type === 'label') return <div key={index} className="og-menu-label">{item.label}</div>;
        if (item.type === 'submenu') {
          if (depth >= DEPTH_MAX) return null;
          return (
            <Base.SubmenuRoot key={index} disabled={item.disabled}>
              <Base.SubmenuTrigger className="og-menu-item" data-item={item.id}>
                <span className="og-menu-item-label">{item.label}</span>
                <span className="og-menu-item-arrow"><Icon name="chevron-right" /></span>
              </Base.SubmenuTrigger>
              <Base.Portal>
                <Base.Positioner sideOffset={-2} alignOffset={-4} collisionPadding={6} data-chrome="">
                  <Base.Popup className="og-popup og-menu" data-ui="menu">
                    <MenuItems items={item.items} depth={depth + 1} />
                  </Base.Popup>
                </Base.Positioner>
              </Base.Portal>
            </Base.SubmenuRoot>
          );
        }
        return (
          <Base.Item
            key={index}
            className="og-menu-item"
            disabled={item.disabled}
            data-item={item.id}
            data-danger={item.danger ? '' : undefined}
            onClick={() => item.onSelect()}
          >
            {item.checked ? <span className="og-menu-item-mark"><Icon name="check" /></span> : null}
            <span className="og-menu-item-label">{item.label}</span>
            {item.keyLabel ? <span className="og-menu-item-key">{item.keyLabel}</span> : null}
          </Base.Item>
        );
      })}
    </>
  );
}

export interface MenuProps {
  /** The element that opens the menu: one element that takes a ref and DOM props. */
  readonly trigger: ReactElement<Record<string, unknown>>;
  /** The items, or a function that makes them when the menu opens. */
  readonly items: readonly MenuItemSpec[] | (() => readonly MenuItemSpec[]);
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly align?: 'start' | 'center' | 'end';
  onOpenChange?(open: boolean): void;
}

const resolve = (items: MenuProps['items']): readonly MenuItemSpec[] => (typeof items === 'function' ? items() : items);

export function Menu(props: MenuProps) {
  return (
    <Base.Root onOpenChange={(open) => props.onOpenChange?.(open)}>
      <Base.Trigger render={props.trigger} />
      <Base.Portal>
        <Base.Positioner side={props.side ?? 'bottom'} align={props.align ?? 'start'} sideOffset={2} collisionPadding={6} data-chrome="">
          <Base.Popup className="og-popup og-menu" data-ui="menu">
            <Lazy items={props.items} />
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** Rendered only while the popup is: a function of items is called at each opening. */
function Lazy(props: { readonly items: MenuProps['items'] }) {
  return <MenuItems items={resolve(props.items)} />;
}

export interface ContextMenuProps {
  readonly items: MenuProps['items'];
  /** What a secondary click opens the menu on. It is wrapped in one element of `className`. */
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function ContextMenu(props: ContextMenuProps) {
  if (props.disabled) return <div className={props.className}>{props.children}</div>;
  return (
    <BaseContext.Root>
      <BaseContext.Trigger className={props.className}>{props.children}</BaseContext.Trigger>
      <BaseContext.Portal>
        <BaseContext.Positioner collisionPadding={6} data-chrome="">
          <BaseContext.Popup className="og-popup og-menu" data-ui="menu">
            <Lazy items={props.items} />
          </BaseContext.Popup>
        </BaseContext.Positioner>
      </BaseContext.Portal>
    </BaseContext.Root>
  );
}
