// A wire: a cubic curve from an output to an input, in the colour of what it carries. The curve is the one
// geometry.ts tests against, so a node dropped on a wire and a stroke across it meet what is drawn.

import type { ConnectionLineComponentProps, EdgeProps } from '@xyflow/react';
import { memo } from 'react';

import type { NodeView, WireData } from './flow.ts';
import { wirePath } from './geometry.ts';
import styles from './graph.module.css';

export const Wire = memo(function Wire(props: EdgeProps) {
  const data = props.data as unknown as WireData | undefined;
  const path = wirePath({ x: props.sourceX, y: props.sourceY }, { x: props.targetX, y: props.targetY });
  return (
    <>
      <path className={`react-flow__edge-path ${styles.wire}`} d={path} data-tone={data?.tone ?? 'any'} data-drop={data?.drop ? '' : undefined} />
      {/* Wider than the wire and not drawn: what the pointer picks the wire by. */}
      <path className={`react-flow__edge-interaction ${styles.wireHit}`} d={path} />
    </>
  );
});

/** The wire being dragged: from the port it started at to the pointer, or to the port it would connect to. */
export function ConnectionLine(props: ConnectionLineComponentProps) {
  const fromOutput = props.fromHandle.type === 'source';
  const start = { x: props.fromX, y: props.fromY };
  const end = { x: props.toX, y: props.toY };
  const view = props.fromNode.data as unknown as NodeView;
  const port = (fromOutput ? view.outputs : view.inputs)?.find((candidate) => candidate.handle === props.fromHandle.id);
  return (
    <path
      className={`${styles.wire} ${styles.connection}`}
      d={fromOutput ? wirePath(start, end) : wirePath(end, start)}
      data-tone={port?.tone ?? 'any'}
      data-valid={props.connectionStatus === null ? undefined : String(props.connectionStatus === 'valid')}
    />
  );
}
