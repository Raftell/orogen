// The toolbar of the viewport: which view, how it is shaded, the overlay, the sun, the vertical scale, the sea,
// and at its end what is shown, in which state and at which resolution. Every choice runs a command of the panel
// (commands.ts); the values that are scrubbed (angles, the scale, the overlay's opacity) change the state as
// they move. In a narrow panel the controls give way one by one (viewport.module.css) and the state stays: what
// has gone from the toolbar is in the Viewport menu.

import { memo } from 'react';
import { useStore } from 'zustand';

import { Button, Checkbox, CommandButton, Icon, NumberField, Popover, PropertyRow, Select, Slider, Tooltip, useApp } from '../../ui/index.ts';
import { changeView, paletteCommand, SHADING_COMMAND, TOP_STYLE_COMMAND } from './commands.ts';
import {
  outputTitle, PALETTE_LABELS, PALETTES, SHADING_LABELS, STATUS_TEXT, STATUS_WORD, TOP_STYLE_LABELS, type Palette, type Shading, type TopStyle, type ViewStatus,
} from './model.ts';
import { setDisplay, viewportStore } from './state.ts';
import styles from './viewport.module.css';

const SHADINGS = (Object.keys(SHADING_LABELS) as Shading[]).map((value) => ({ value, label: SHADING_LABELS[value] }));
const TOP_STYLES = (Object.keys(TOP_STYLE_LABELS) as TopStyle[]).map((value) => ({ value, label: TOP_STYLE_LABELS[value] }));
const PALETTE_OPTIONS = PALETTES.map((value) => ({ value, label: PALETTE_LABELS[value] }));
const OVERLAY_KIND = { color: 'Color map', mask: 'Mask', heat: 'Data' } as const;

export interface ToolbarProps {
  readonly status: ViewStatus;
  /** The resolution of what is shown; null: nothing is. */
  readonly resolution: number | null;
  /** What the output shown is called; null: the view names none. */
  readonly subject: string | null;
  /** The view is pinned: it stays when the selection changes (runtime.md 7.4 rule 4). */
  readonly locked: boolean;
}

export const Toolbar = memo(function Toolbar(props: ToolbarProps) {
  const app = useApp();
  const { ctx } = app;
  const mode = useStore(viewportStore, (state) => state.mode);
  const display = useStore(viewportStore, (state) => state.display);
  const overlay = useStore(ctx.doc, (state) => state.doc.ui.view?.overlay);
  const overlaySource = useStore(ctx.doc, (state) => outputTitle(state.doc, ctx.registry, state.doc.ui.view?.overlay?.ref));
  const topKey = app.keyLabel('viewport.toggleTop');

  const setMode = (next: 'orbit' | 'top'): void => {
    if (viewportStore.getState().mode !== next) ctx.run('viewport.toggleTop');
  };
  const setOpacity = (opacity: number): void => {
    const view = ctx.doc.getState().doc.ui.view;
    if (!view?.overlay || view.overlay.opacity === opacity) return;
    changeView(ctx, 'Overlay opacity', { ...view, overlay: { ...view.overlay, opacity } });
  };

  const word = STATUS_WORD[props.status];
  // A view that names nothing is shown at the preview resolution too (7.4 rule 5); there is nothing to give the size of.
  const nothing = props.status === 'empty' || props.status === 'starting' || props.status === 'failed';
  const size = props.resolution === null || nothing ? null : `${props.resolution} × ${props.resolution}`;
  const subject = nothing ? null : props.subject;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Viewport" data-viewport="toolbar">
      <div className={styles.controls}>
        <div className={styles.segment} role="group" aria-label="View">
          <Tooltip content="3D view" keyLabel={mode === 'top' ? topKey : null}>
            <button type="button" className={styles.segmentButton} aria-pressed={mode === 'orbit'} data-view="orbit" onClick={() => setMode('orbit')}>3D</button>
          </Tooltip>
          <Tooltip content="Top view" keyLabel={mode === 'orbit' ? topKey : null}>
            <button type="button" className={styles.segmentButton} aria-pressed={mode === 'top'} data-view="top" onClick={() => setMode('top')}>Top</button>
          </Tooltip>
        </div>

        <div className={styles.shading}>
          {mode === 'orbit' ? (
            <Select className={styles.select} aria-label="Shading" value={display.shading} options={SHADINGS} onChange={(value) => ctx.run(SHADING_COMMAND[value])} />
          ) : (
            <Select className={styles.select} aria-label="Top view style" value={display.topStyle} options={TOP_STYLES} onChange={(value) => ctx.run(TOP_STYLE_COMMAND[value])} />
          )}
        </div>

        <Popover
          title="Overlay"
          className={styles.popover}
          trigger={<Button size="small" variant="quiet" data-viewport="overlay" data-active={overlay ? '' : undefined} className={styles.menuButton}>Overlay</Button>}
        >
          {overlay ? (
            <>
              <PropertyRow label="Shows">
                <Tooltip content={overlaySource} side="left">
                  <span className={styles.value} data-viewport="overlay-source">{overlaySource ?? 'A node that is gone'}</span>
                </Tooltip>
              </PropertyRow>
              <PropertyRow label="As">
                <span className={styles.value}>{OVERLAY_KIND[overlay.as]}</span>
              </PropertyRow>
              <PropertyRow label="Opacity" help="How much of the overlay lies over the terrain's own color.">
                <Slider aria-label="Overlay opacity" value={overlay.opacity} min={0} max={1} step={0.01} onChange={setOpacity} />
              </PropertyRow>
              <PropertyRow label="Palette" help="The colors a mask is tinted with and a data field is drawn in. A color map has its own.">
                <Select aria-label="Overlay palette" value={display.palette} options={PALETTE_OPTIONS} disabled={overlay.as === 'color'} onChange={(value: Palette) => ctx.run(paletteCommand(value))} />
              </PropertyRow>
              <div className={styles.popoverActions}>
                <CommandButton command="viewport.removeOverlay" size="small" />
              </div>
            </>
          ) : (
            <div className={styles.hint}>No overlay. Select a mask, a data field or a color map in the graph to draw it over the terrain.</div>
          )}
        </Popover>

        <div className={styles.sun}>
          <Popover
            title="Sun"
            className={styles.popover}
            trigger={<Button size="small" variant="quiet" data-viewport="sun" className={styles.menuButton}>Sun</Button>}
          >
            <PropertyRow label="Direction" help="Where the sun stands, seen from above: 0° is to the right of the top view, 90° below it.">
              <NumberField aria-label="Sun direction" value={display.sunAzimuth} min={0} max={360} step={5} unit="°" precision={0} onChange={(sunAzimuth) => setDisplay(viewportStore, { sunAzimuth })} />
            </PropertyRow>
            <PropertyRow label="Elevation" help="How high the sun stands above the horizon. A low sun shows relief; a high one shows color.">
              <NumberField aria-label="Sun elevation" value={display.sunElevation} min={0} max={90} step={1} unit="°" precision={0} onChange={(sunElevation) => setDisplay(viewportStore, { sunElevation })} />
            </PropertyRow>
            <div className={styles.hint}>Shift-drag in the view moves the sun.</div>
            <div className={styles.popoverActions}>
              <CommandButton command="viewport.resetSun" size="small" />
            </div>
          </Popover>
        </div>

        <Tooltip content="Vertical scale of the picture. The terrain itself keeps its heights.">
          <div className={styles.scale}>
            <NumberField
              aria-label="Vertical scale" label="Height" unit="×" value={display.verticalScale} min={0.05} max={20} softMin={0.25} softMax={4} step={0.05} precision={2}
              onChange={(verticalScale) => setDisplay(viewportStore, { verticalScale })}
            />
          </div>
        </Tooltip>

        <Tooltip content="Draws the sea at the project's sea level.">
          <span className={styles.check}>
            <Checkbox checked={display.showSea} label="Sea" onChange={() => ctx.run('viewport.toggleSea')} />
          </span>
        </Tooltip>

        <span className={styles.frame}>
          <CommandButton command="viewport.frame" icon="fit" size="small" />
        </span>
      </div>

      {/* What is left between the controls and the state: the name of what is shown, cut where it must be. */}
      <div className={styles.subject}>
        {subject !== null ? (
          <Tooltip content={props.locked ? `${subject}. The view is pinned: it stays when another node is selected.` : subject}>
            <span className={styles.subjectName} data-viewport="subject" data-locked={props.locked ? '' : undefined}>
              {props.locked ? <Icon name="lock" className={styles.lock} /> : null}
              <span className={styles.subjectText}>{subject}</span>
            </span>
          </Tooltip>
        ) : null}
      </div>

      <div className={styles.status} data-viewport="status" data-state={props.status} role="status">
        {word !== '' ? (
          <Tooltip content={STATUS_TEXT[props.status]}>
            <span className={styles.statusText} data-viewport="state">{word}</span>
          </Tooltip>
        ) : null}
        {size !== null ? <span className={styles.resolution} data-viewport="resolution">{size}</span> : null}
      </div>
    </div>
  );
});
