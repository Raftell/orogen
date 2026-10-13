// A group: a titled, coloured frame behind the nodes it holds (runtime.md 4.1). It is dragged by its title bar
// and resized by its corner; the rest of it lets the pointer through, so that a box can be drawn inside it.
// Moving it moves what lies inside: GraphPanel does that, since it is the document that knows what does.

import { useReactFlow, type NodeProps } from '@xyflow/react';
import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';

import { setSelection } from '../../state/ui-store.ts';
import { useCommandContext } from '../../ui/index.ts';
import { GROUP_TITLE, renameGroup, resizeGroup } from './actions.ts';
import { RenameField } from './GraphNode.tsx';
import type { GroupView } from './flow.ts';
import { GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, type Rect } from './geometry.ts';
import styles from './graph.module.css';
import { own } from './model.ts';
import { graphHost, graphStore, selectWiresAndGroups } from './state.ts';

const FrameBody = memo(function FrameBody(props: { readonly view: GroupView; readonly selected: boolean }) {
  const { view, selected } = props;
  const ctx = useCommandContext();
  const flow = useReactFlow();
  const renaming = useStore(graphStore, (state) => state.renaming?.kind === 'group' && state.renaming.id === view.id);

  /** The corner follows the pointer until the button is let go; the document changes once, then (8.5 rule 4). */
  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const group = own(ctx.doc.getState().doc.groups, view.id);
    if (!group) return;
    const start = { x: event.clientX, y: event.clientY };
    const from: Rect = { x: group.rect.x, y: group.rect.y, w: view.width, h: view.height };
    let latest = from;
    const move = (moved: PointerEvent): void => {
      const zoom = flow.getZoom() || 1;
      latest = {
        ...from,
        w: Math.max(GROUP_MIN_WIDTH, from.w + (moved.clientX - start.x) / zoom),
        h: Math.max(GROUP_MIN_HEIGHT, from.h + (moved.clientY - start.y) / zoom),
      };
      graphStore.setState({ groupRects: { ...graphStore.getState().groupRects, [view.id]: latest } });
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (latest !== from) resizeGroup(ctx, view.id, latest);
      graphStore.setState({ groupRects: null });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  /**
   * A press on the title bar selects the group, before the library begins to drag it: it drags every selected
   * node along, so the nodes that were selected are let go first. With Shift or Control the group joins, or
   * leaves, what is selected.
   */
  function select(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const local = graphStore.getState();
    const held = local.groupSelection.includes(view.id);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      selectWiresAndGroups(graphStore, local.edgeSelection, held ? local.groupSelection.filter((id) => id !== view.id) : [...local.groupSelection, view.id]);
    } else if (!held) {
      setSelection(ctx.ui, []);
      selectWiresAndGroups(graphStore, [], [view.id]);
    }
  }

  return (
    <div
      className={styles.frame}
      data-group={view.id}
      data-selected={selected ? '' : undefined}
      style={view.color ? { ['--graph-group' as string]: view.color } : undefined}
    >
      <div
        className={styles.frameHeader}
        data-group-drag=""
        onPointerDown={select}
        onDoubleClick={(event) => {
          event.stopPropagation();
          graphStore.setState({ renaming: { kind: 'group', id: view.id } });
        }}
      >
        {renaming ? (
          <RenameField
            value={view.title}
            label="Group name"
            onDone={(text) => {
              graphStore.setState({ renaming: null });
              if (text !== null) renameGroup(ctx, view.id, text);
              graphHost()?.focus();
            }}
          />
        ) : (
          <span className={styles.frameTitle} data-role="title" data-unnamed={view.title === '' ? '' : undefined}>{view.title === '' ? GROUP_TITLE : view.title}</span>
        )}
      </div>
      <div className={`${styles.frameGrip} nodrag nopan`} data-group-resize="" title="Drag to resize the group" onPointerDown={startResize} />
    </div>
  );
});

export const GroupFrame = memo(function GroupFrame(props: NodeProps) {
  return <FrameBody view={props.data as unknown as GroupView} selected={props.selected === true} />;
});
