// One of every shared control of src/app/ui/, each holding a value of its own: the page that
// tests/ui/shell/controls.test.ts drives with synthesised input and that its captures show. It is reached through
// the command `view.controlGallery`, which exists in test mode only.

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

import {
  Button, Checkbox, ColorSwatch, ContextMenu, Dialog, EmptyState, formatMetres, IconButton, Menu, metricUnits, NumberField, Popover,
  PropertyRow, SearchField, SectionTitle, Select, Slider, TextField, Tooltip, type MenuItemSpec, type Rgb,
} from '../ui/index.ts';
import type { Shell } from './shell.ts';

/** The terrain width the length field converts with. */
const TERRAIN_METRES = 5000;

export interface GalleryState {
  readonly amount: number;
  readonly length: number;
  readonly angle: number;
  readonly count: number;
  readonly frequency: number;
  readonly offset: number;
  readonly slider: number;
  readonly checked: boolean;
  readonly choice: string;
  readonly text: string;
  readonly color: Rgb;
  readonly search: string;
  /** What the controls reported beside their values, oldest first; the last 100. */
  readonly events: readonly string[];
}

export const galleryStore = createStore<GalleryState>()(() => ({
  amount: 0.5, length: 0.1, angle: 45, count: 8, frequency: 4, offset: 0, slider: 0.25, checked: false, choice: 'ridged', text: 'Ridge',
  color: [0.2, 0.4, 0.8], search: '', events: [],
}));

const set = (patch: Partial<GalleryState>): void => galleryStore.setState(patch);
const note = (event: string): void => set({ events: [...galleryStore.getState().events, event].slice(-100) });

const MENU: readonly MenuItemSpec[] = [
  { label: 'Duplicate', keyLabel: 'Ctrl+D', id: 'duplicate', onSelect: () => note('menu:duplicate') },
  { label: 'Bypass', checked: true, id: 'bypass', onSelect: () => note('menu:bypass') },
  { type: 'separator' },
  { type: 'submenu', label: 'Align', id: 'align', items: [
    { label: 'Left', id: 'left', onSelect: () => note('menu:left') },
    { label: 'Right', id: 'right', onSelect: () => note('menu:right') },
  ] },
  { label: 'Unavailable', disabled: true, id: 'unavailable', onSelect: () => note('menu:unavailable') },
  { label: 'Delete', danger: true, keyLabel: 'Del', id: 'delete', onSelect: () => note('menu:delete') },
];

export function Gallery(props: { readonly shell: Shell }) {
  const state = useStore(galleryStore);
  const scrub = (name: string) => ({
    onScrubStart: () => note(`${name}:start`),
    onScrubEnd: (kept?: boolean) => note(`${name}:end${kept === false ? ':cancelled' : ''}`),
  });
  return (
    <Dialog open name="gallery" width={760} title="Control Gallery" onClose={() => props.shell.closeDialog()}>
      <div className="og-gallery">
        <div>
          <SectionTitle>Number fields</SectionTitle>
          <PropertyRow label="Amount" help="A ratio between two soft ends. Drag, or click to type.">
            <NumberField aria-label="Amount" value={state.amount} min={0} max={1} step={0.01} onChange={(amount) => set({ amount })} {...scrub('amount')} />
          </PropertyRow>
          <PropertyRow label="Radius" help="A length, stored as a fraction of the terrain and typed in metres as well.">
            <NumberField
              aria-label="Radius"
              value={state.length}
              min={0}
              max={4}
              softMax={1}
              step={0.001}
              units={metricUnits(TERRAIN_METRES)}
              secondary={formatMetres(state.length, TERRAIN_METRES)}
              onChange={(length) => set({ length })}
              {...scrub('length')}
            />
          </PropertyRow>
          <PropertyRow label="Direction">
            <NumberField aria-label="Direction" value={state.angle} min={0} max={360} step={1} unit="°" units={{ '°': 1, deg: 1 }} onChange={(angle) => set({ angle })} {...scrub('angle')} />
          </PropertyRow>
          <PropertyRow label="Octaves">
            <NumberField aria-label="Octaves" value={state.count} min={1} max={64} softMax={16} integer onChange={(count) => set({ count })} {...scrub('count')} />
          </PropertyRow>
          <PropertyRow label="Frequency">
            <NumberField aria-label="Frequency" value={state.frequency} min={0.01} max={1024} softMin={0.5} softMax={64} scale="log" precision={2} onChange={(frequency) => set({ frequency })} {...scrub('frequency')} />
          </PropertyRow>
          <PropertyRow label="Offset">
            <NumberField aria-label="Offset" label="X" value={state.offset} step={0.1} onChange={(offset) => set({ offset })} {...scrub('offset')} />
          </PropertyRow>
          <PropertyRow label="Disabled">
            <NumberField aria-label="Disabled number" value={0.25} min={0} max={1} disabled onChange={() => note('disabled:change')} />
          </PropertyRow>

          <SectionTitle>Slider, checkbox, select</SectionTitle>
          <PropertyRow label="Opacity">
            <Slider aria-label="Opacity" value={state.slider} min={0} max={1} step={0.05} onChange={(slider) => set({ slider })} onCommit={(value) => note(`slider:commit:${value}`)} />
          </PropertyRow>
          <PropertyRow label="Seamless">
            <Checkbox checked={state.checked} label="Wrap at the edges" onChange={(checked) => set({ checked })} />
          </PropertyRow>
          <PropertyRow label="Noise">
            <Select
              aria-label="Noise"
              value={state.choice}
              options={[{ value: 'smooth', label: 'Smooth' }, { value: 'ridged', label: 'Ridged' }, { value: 'billow', label: 'Billow' }, { value: 'cells', label: 'Cells', disabled: true }]}
              onChange={(choice) => set({ choice })}
            />
          </PropertyRow>
        </div>

        <div>
          <SectionTitle>Text and color</SectionTitle>
          <PropertyRow label="Name">
            <TextField aria-label="Name" value={state.text} placeholder="A name" onCommit={(text) => { set({ text }); note(`text:commit:${text}`); }} />
          </PropertyRow>
          <PropertyRow label="Tint">
            <ColorSwatch aria-label="Tint" value={state.color} onChange={(color) => set({ color })} onScrubStart={() => note('color:start')} onScrubEnd={() => note('color:end')} />
          </PropertyRow>

          <SectionTitle>Buttons</SectionTitle>
          <PropertyRow label="Actions">
            <Button data-button="default" onClick={() => note('button:default')}>Apply</Button>
            <Button data-button="primary" variant="primary" onClick={() => note('button:primary')}>Build</Button>
            <Button data-button="danger" variant="danger" onClick={() => note('button:danger')}>Discard</Button>
          </PropertyRow>
          <PropertyRow label="Quiet, small">
            <Button data-button="quiet" variant="quiet" icon="folder" onClick={() => note('button:quiet')}>Browse</Button>
            <Button size="small" onClick={() => note('button:small')}>Reset</Button>
            <Button disabled onClick={() => note('button:disabled')}>Disabled</Button>
          </PropertyRow>
          <PropertyRow label="Icons">
            <IconButton icon="fit" label="Fit to Panel" keyLabel="Home" data-button="icon" onClick={() => note('button:icon')} />
            <IconButton icon="lock" label="Lock the View" pressed onClick={() => note('button:lock')} />
            <IconButton icon="dice" label="New Seed" onClick={() => note('button:dice')} />
            <IconButton icon="trash" label="Delete" disabled onClick={() => note('button:trash')} />
          </PropertyRow>

          <SectionTitle>What opens</SectionTitle>
          <PropertyRow label="Menu">
            <Menu trigger={<Button data-button="menu">Node</Button>} items={MENU} />
            <Popover title="Display" trigger={<Button data-button="popover">Display</Button>}>
              <Checkbox checked={state.checked} label="Show the sea" onChange={(checked) => set({ checked })} />
            </Popover>
            <Tooltip content="A tooltip names what a control does" keyLabel="F6">
              <Button data-button="tooltip" variant="quiet">Hover</Button>
            </Tooltip>
          </PropertyRow>
          <SectionTitle>Search, and a narrow panel</SectionTitle>
          <PropertyRow label="Search">
            <SearchField aria-label="Search the gallery" placeholder="Search" value={state.search} onChange={(search) => set({ search })} onKeyDown={(event) => note(`search:key:${event.key}`)} />
          </PropertyRow>
          {/* As wide as a panel the user dragged narrow: the row stacks, and the metric text gives way with an ellipsis. */}
          <div data-area="narrow" style={{ width: 200 }}>
            <PropertyRow label="Radius of the outer rim">
              <NumberField
                aria-label="Narrow radius"
                label="Outer"
                value={state.length}
                min={0}
                max={4}
                softMax={1}
                precision={6}
                units={metricUnits(TERRAIN_METRES)}
                secondary={`${formatMetres(state.length, TERRAIN_METRES)} of the terrain's width`}
                onChange={(length) => set({ length })}
              />
            </PropertyRow>
          </div>
          <ContextMenu items={() => MENU}>
            <div data-area="context" style={{ height: 64, marginTop: 4, borderRadius: 3, background: 'var(--og-bg-sunken)' }}>
              <EmptyState title="Context menu">Press the secondary button here</EmptyState>
            </div>
          </ContextMenu>
        </div>
      </div>
    </Dialog>
  );
}
