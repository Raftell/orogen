// The dock (runtime.md 8.7 rules 3 and 7): the panels of the panel registry in dockview. The default layout is
// made from their placements; the layout is saved to the preferences whenever it changes and restored at start.
// A panel that owns a canvas is rendered 'always': dockview's default renderer takes a hidden panel's element
// out of the document, and a canvas whose control was transferred cannot be made again from the same element.

import {
  DockviewDefaultTab, DockviewReact,
  type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelHeaderProps, type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Component, useEffect, useMemo, useRef, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react';

import type { PanelDef } from '../ui/types.ts';
import { initialSize, LAYOUT_VERSION, placementOrder, savedDock, type SavedLayout } from './layout.ts';
import type { Shell } from './shell.ts';

const THEME: DockviewTheme = { name: 'orogen', className: 'dockview-theme-orogen', colorScheme: 'dark', dndOverlayMounting: 'relative', dndPanelOverlay: 'group' };
/** How long the layout rests before it is written to the preferences. */
const SAVE_DELAY_MS = 250;

export interface DockHandle {
  /** The layout as it would be saved. */
  layout(): SavedLayout;
  /** Applies a value of Preferences.layout as start-up does: the default layout when it is none this build restores. */
  restore(saved: unknown): 'restored' | 'default';
}

/** A panel that throws while it renders shows what went wrong in its own frame; the others go on. */
class PanelBoundary extends Component<{ readonly panel: PanelDef; readonly children: ReactNode }, { readonly failure: Error | null }> {
  override state: { readonly failure: Error | null } = { failure: null };

  static getDerivedStateFromError(thrown: unknown): { failure: Error } {
    return { failure: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    console.error(`[orogen] the panel "${this.props.panel.id}" failed to render`, thrown, info.componentStack);
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    return (
      <div className="og-panel-error" data-panel-error={this.props.panel.id}>
        <h3>{this.props.panel.title} could not be shown</h3>
        <div>{failure.message}</div>
        <pre>{failure.stack}</pre>
      </div>
    );
  }
}

function panelComponent(panel: PanelDef): FunctionComponent<IDockviewPanelProps> {
  const Content = panel.component;
  function DockedPanel() {
    return (
      <div className="og-panel" data-panel={panel.id} tabIndex={-1}>
        <PanelBoundary panel={panel}><Content /></PanelBoundary>
      </div>
    );
  }
  DockedPanel.displayName = `Panel(${panel.id})`;
  return DockedPanel;
}

/** A panel cannot be closed: there would be no way to bring it back. */
function Tab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />;
}

const rendererOf = (panel: PanelDef): 'always' | 'onlyWhenVisible' => (panel.keepMounted ? 'always' : 'onlyWhenVisible');

/**
 * `size` is that of the dock's element. The dock itself learns its size from an observer, some time after it is
 * ready: a layout made from what it knows before would differ from one start to the next.
 */
function applyDefault(api: DockviewApi, panels: readonly PanelDef[], size: { readonly width: number; readonly height: number }): void {
  api.clear();
  if (size.width > 0 && size.height > 0) api.layout(size.width, size.height);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  for (const step of placementOrder(panels)) {
    const panel = byId.get(step.id)!;
    const position = step.direction === null ? {}
      : step.relativeTo === null ? { position: { direction: step.direction } }
        : { position: { referencePanel: step.relativeTo, direction: step.direction } };
    api.addPanel({
      id: panel.id,
      component: panel.id,
      title: panel.title,
      renderer: rendererOf(panel),
      // A panel added as a tab stays behind the one it joins.
      inactive: step.direction === 'within',
      ...position,
      ...initialSize(panel.id, size),
    });
  }
  // Said once more when all are placed: a panel added later takes its share from those before it.
  for (const panel of panels) {
    const { initialWidth: width, initialHeight: height } = initialSize(panel.id, size);
    if (width !== undefined || height !== undefined) api.getPanel(panel.id)?.group.api.setSize({ width, height });
  }
}

/** True when `dock` was restored. A layout dockview refuses, or one that lost a panel on the way, leaves the dock empty. */
function applySaved(api: DockviewApi, panels: readonly PanelDef[], dock: Record<string, unknown>): boolean {
  try {
    api.fromJSON(dock as unknown as Parameters<DockviewApi['fromJSON']>[0]);
  } catch (thrown) {
    console.warn('[orogen] the saved layout could not be restored; the default layout is used', thrown);
    api.clear();
    return false;
  }
  for (const panel of panels) {
    const docked = api.getPanel(panel.id);
    if (!docked) {
      api.clear();
      return false;
    }
    // The saved layout holds the title and the renderer of the build that wrote it.
    if (docked.api.title !== panel.title) docked.api.setTitle(panel.title);
    if (docked.api.renderer !== rendererOf(panel)) docked.api.setRenderer(rendererOf(panel));
  }
  return true;
}

export function Dock(props: { readonly shell: Shell; expose?(handle: DockHandle | null): void }) {
  const { shell } = props;
  const api = useRef<DockviewApi | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const sizeOf = (): { width: number; height: number } => {
    const rect = element.current?.getBoundingClientRect();
    return { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) };
  };
  const components = useMemo(() => Object.fromEntries(shell.panels.map((panel) => [panel.id, panelComponent(panel)])), [shell]);

  function restore(saved: unknown): 'restored' | 'default' {
    const dock = api.current;
    if (!dock) return 'default';
    const held = savedDock(saved, shell.panels.map((panel) => panel.id));
    const restored = held !== null && applySaved(dock, shell.panels, held);
    if (!restored) {
      applyDefault(dock, shell.panels, sizeOf());
      // The graph is where work begins. A restored layout has the panel in front that it was saved with.
      dock.getPanel('graph')?.api.setActive();
    }
    const active = shell.panels.find((panel) => panel.id === dock.activePanel?.id);
    if (active && shell.ctx.ui.getState().focusedPanel !== active.id) shell.ctx.ui.setState({ focusedPanel: active.id });
    return restored ? 'restored' : 'default';
  }

  function onReady(event: DockviewReadyEvent): void {
    const dock = event.api;
    api.current = dock;
    const { ui } = shell.ctx;
    restore(shell.state.getState().preferences.layout);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = (): void => {
      timer = null;
      if (api.current !== dock || dock.totalPanels !== shell.panels.length) return;
      shell.setPreferences({ layout: { version: LAYOUT_VERSION, dock: dock.toJSON() } satisfies SavedLayout });
    };
    dock.onDidLayoutChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    });
    dock.onDidActivePanelChange((change) => {
      const panel = shell.panels.find((candidate) => candidate.id === change.panel?.id);
      if (panel && ui.getState().focusedPanel !== panel.id) ui.setState({ focusedPanel: panel.id });
    });
    props.expose?.({
      layout: () => ({ version: LAYOUT_VERSION, dock: dock.toJSON() }),
      restore,
    });
    // What a panel's command asks for through `useApp().showPanel`: its tab in front, and the focus with it.
    shell.attachDock({
      show(id) {
        const panel = dock.getPanel(id);
        if (!panel) return;
        if (!panel.api.isActive) panel.api.setActive();
        if (ui.getState().focusedPanel !== id) ui.setState({ focusedPanel: id });
      },
    });
  }

  // "Reset layout" (8.7 rule 7): every raise of the counter lays the dock out anew.
  useEffect(() => {
    let resets = shell.state.getState().layoutResets;
    return shell.state.subscribe((state) => {
      if (state.layoutResets === resets) return;
      resets = state.layoutResets;
      if (!api.current) return;
      applyDefault(api.current, shell.panels, sizeOf());
      api.current.getPanel('graph')?.api.setActive();
      shell.ctx.ui.setState({ focusedPanel: 'graph' });
    });
  }, [shell]);

  // When the dock goes, nobody holds its handle.
  useEffect(() => () => {
    api.current = null;
    props.expose?.(null);
    shell.attachDock(null);
  }, []);

  return <DockviewReact ref={element} className="og-dock" theme={THEME} components={components} defaultTabComponent={Tab} onReady={onReady} />;
}
