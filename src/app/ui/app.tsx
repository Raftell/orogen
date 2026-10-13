// How a panel component reaches the application (runtime.md 8.7 rule 2): a PanelDef's component takes no
// props, so the shell provides the command context and its own services here.

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { AppServices, CommandContext } from './types.ts';

const AppContext = createContext<AppServices | null>(null);

export function AppProvider(props: { readonly services: AppServices; readonly children: ReactNode }) {
  return <AppContext.Provider value={props.services}>{props.children}</AppContext.Provider>;
}

/** The shell's services. Throws outside the application's frame: a component test wraps its panel in an AppProvider. */
export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('useApp: no AppProvider above this component');
  return services;
}

/** The stores, the engine client, the bridge and the node registry (8.8). */
export function useCommandContext(): CommandContext {
  return useApp().ctx;
}

/**
 * Whether a command can run now, kept current: the component renders again when the answer changes. A command's
 * `enabled` reads the three stores, so their changes are when the answer is asked again.
 */
export function useCommandEnabled(commandId: string): boolean {
  const app = useApp();
  const { doc, ui, engineState } = app.ctx;
  return useSyncExternalStore(
    (changed) => {
      const stops = [doc.subscribe(changed), ui.subscribe(changed), engineState.subscribe(changed)];
      return () => { for (const stop of stops) stop(); };
    },
    () => app.enabled(commandId),
  );
}
