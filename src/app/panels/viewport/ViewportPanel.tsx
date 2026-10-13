// The component of the viewport panel in its starting state (index.ts says what the panel is to become).

import { useEffect, useRef } from 'react';

import { useCommandContext } from '../../ui/index.ts';
import styles from './viewport.module.css';

export function ViewportPanel() {
  const { engine, engineState } = useCommandContext();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    let observer: ResizeObserver | null = null;
    const sizeOf = (): { width: number; height: number; dpr: number } => {
      const rect = element.getBoundingClientRect();
      return { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: window.devicePixelRatio || 1 };
    };
    // A new canvas element each time: its control goes to the worker and cannot be taken back (7.5 rule 8).
    function attach(): void {
      const canvas = document.createElement('canvas');
      canvas.className = styles.canvas!;
      element!.replaceChildren(canvas);
      engine.viewport.attach(canvas.transferControlToOffscreen(), sizeOf());
      observer?.disconnect();
      observer = new ResizeObserver(() => engine.viewport.resize(sizeOf()));
      observer.observe(element!);
    }
    attach();
    // 7.8 rule 6: a canvas transferred before the device was lost presents nothing drawn on the new device.
    let lost = false;
    const stop = engine.subscribe((event) => {
      if (event.type === 'device-lost') lost = true;
      if (event.type === 'device-ready' && lost) {
        lost = false;
        attach();
      }
    });
    // 8.5: a `device` that is 'starting' again is the device of another engine worker. The canvas went with the old one.
    const stopStore = engineState.subscribe((next, previous) => {
      if (next.device !== previous.device && next.device.state === 'starting') {
        lost = false;
        attach();
      }
    });
    return () => {
      stop();
      stopStore();
      observer?.disconnect();
      engine.viewport.detach();
      element.replaceChildren();
    };
  }, [engine, engineState]);

  return (
    <>
      <div ref={host} className={styles.host} data-viewport="canvas" />
      <div className={styles.label}>Viewport: camera control and overlays are not built yet</div>
    </>
  );
}
