// The preferences (runtime.md 8.6): the GPU memory budget, the keys, the layout and the recent projects. Every
// change is in force and in the preferences file at once; there is nothing to confirm.

import { Fragment, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';

import { Button, Dialog, IconButton, NumberField, PropertyRow, SectionTitle, Select, Slider } from '../ui/index.ts';
import { formatBytes } from './format.ts';
import { formatKey, keyOf } from './keys.ts';
import type { Shell } from './shell.ts';

const GIB = 2 ** 30;
/** runtime.md 2.4: the share of video memory that may be the budget, and the memory assumed when none is known. */
const FRACTION = { min: 0.3, max: 0.85 } as const;
const VRAM_UNKNOWN = 4 * GIB;

type Tab = 'graphics' | 'keys' | 'general';
const TABS: readonly { readonly id: Tab; readonly title: string }[] = [
  { id: 'graphics', title: 'Graphics' },
  { id: 'keys', title: 'Keys' },
  { id: 'general', title: 'General' },
];

function Graphics(props: { readonly shell: Shell }) {
  const { shell } = props;
  const gpu = useStore(shell.state, (state) => state.preferences.gpu);
  const caps = useStore(shell.ctx.engineState, (state) => state.device.caps);
  const inForce = useStore(shell.ctx.engineState, (state) => state.memory?.budgetBytes ?? null);
  /** The share while its slider is dragged: the preference is written when the drag ends. */
  const [dragged, setDragged] = useState<number | null>(null);

  const detected = caps?.vramBytes ?? null;
  const vram = gpu.vramBytes ?? detected ?? VRAM_UNKNOWN;
  const fraction = Math.min(FRACTION.max, Math.max(FRACTION.min, dragged ?? gpu.budgetFraction));
  const budget = Math.floor(vram * fraction);

  return (
    <div data-tab="graphics">
      <SectionTitle>GPU memory</SectionTitle>
      <PropertyRow label="Video memory" help="How much memory the graphics card has. The budget is a share of it.">
        <Select
          aria-label="Video memory"
          value={gpu.vramBytes === null ? 'auto' : 'manual'}
          options={[{ value: 'auto', label: 'Detect' }, { value: 'manual', label: 'Set by hand' }]}
          onChange={(mode) => shell.setPreferences({ gpu: { ...gpu, vramBytes: mode === 'auto' ? null : vram } })}
        />
        {gpu.vramBytes === null ? null : (
          <NumberField
            aria-label="Video memory in gigabytes"
            value={gpu.vramBytes / GIB}
            min={0.5}
            max={256}
            softMin={1}
            softMax={48}
            step={0.5}
            precision={1}
            unit=" GB"
            units={{ gb: 1, mb: 1 / 1024 }}
            onChange={(gigabytes) => shell.setPreferences({ gpu: { ...gpu, vramBytes: Math.round(gigabytes * GIB) } })}
          />
        )}
      </PropertyRow>
      <PropertyRow label="Share for terrain" help="A larger share lets larger terrains be built and leaves less for the desktop and other programs.">
        <Slider
          aria-label="Share for terrain"
          value={Math.round(fraction * 100)}
          min={FRACTION.min * 100}
          max={FRACTION.max * 100}
          step={1}
          onChange={(percent) => setDragged(percent / 100)}
          onCommit={(percent) => {
            setDragged(null);
            shell.setPreferences({ gpu: { ...gpu, budgetFraction: percent / 100 } });
          }}
        />
        <span className="og-row-value" data-value="budget-fraction">{Math.round(fraction * 100)} %</span>
      </PropertyRow>
      <p className="og-note" data-value="budget">
        Budget {formatBytes(budget)} of {formatBytes(vram)}
        {gpu.vramBytes === null ? (detected === null ? ', which is assumed: this system does not say how much the card has' : ', as detected') : ''}
        {inForce !== null && Math.abs(inForce - budget) > 2 ** 20 ? `. In force now: ${formatBytes(inForce)}` : ''}
      </p>
    </div>
  );
}

function KeyCapture(props: { readonly shell: Shell; readonly command: string }) {
  const { shell, command } = props;
  const [recording, setRecording] = useState(false);
  const keymap = shell.state.getState().preferences.keymap;
  const user = Object.hasOwn(keymap, command);
  const key = shell.keymap().keysOf(command)[0];

  function set(next: string | null): void {
    const { [command]: _dropped, ...others } = shell.state.getState().preferences.keymap;
    shell.setPreferences({ keymap: next === null ? others : { ...others, [command]: next } });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecording(false);
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      // No key at all: the command is reached through the menu and the palette.
      set('');
      setRecording(false);
    } else {
      const pressed = keyOf(event.nativeEvent, shell.keyPlatform);
      if (pressed === null) return;
      set(pressed);
      setRecording(false);
    }
  }

  return (
    <>
      <Button
        className="og-key-capture"
        size="small"
        data-recording={recording ? '' : undefined}
        data-user={user ? '' : undefined}
        data-key-of={command}
        aria-label={`Key for ${shell.services.commandTitle(command) ?? command}`}
        onClick={() => setRecording(!recording)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
      >
        {recording ? 'Press a key' : key === undefined ? 'None' : formatKey(key, shell.keyPlatform)}
      </Button>
      {user ? <IconButton icon="reset" label="Use the Default Key" size="small" data-reset-key={command} onClick={() => set(null)} /> : <span />}
    </>
  );
}

function Keys(props: { readonly shell: Shell }) {
  const { shell } = props;
  // Rendered again whenever a key changes.
  useStore(shell.state, (state) => state.preferences.keymap);
  const { problems } = shell.keymap();
  return (
    <div data-tab="keys">
      <p className="og-note og-keys-note">Press a key&rsquo;s button and then the new key. Backspace leaves the command without a key.</p>
      {/* Above the list: a key that was taken from another command is seen without scrolling. */}
      {problems.length > 0 ? (
        <ul className="og-list og-keys-problems" data-ui="key-problems">
          {problems.map((problem) => <li key={problem} className="og-list-item og-text-warning">{problem}</li>)}
        </ul>
      ) : null}
      <div className="og-keys">
        {shell.commands.commands.map(({ def, owner }) => (
          <Fragment key={def.id}>
            <div className="og-keys-title" title={def.id}>
              {def.title.replace(/…$/, '')} <span className="og-keys-owner">{owner === 'shell' ? def.id.split('.')[0] : owner}</span>
            </div>
            <KeyCapture shell={shell} command={def.id} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function General(props: { readonly shell: Shell }) {
  const { shell } = props;
  const recent = useStore(shell.state, (state) => state.preferences.recent.length);
  const customKeys = useStore(shell.state, (state) => Object.keys(state.preferences.keymap).length);
  return (
    <div data-tab="general">
      <SectionTitle>Window</SectionTitle>
      <PropertyRow label="Panel layout" help="The arrangement of the panels is kept from one start to the next.">
        <Button data-command="view.resetLayout" onClick={() => shell.runner.run('view.resetLayout')}>Reset Layout</Button>
      </PropertyRow>
      <SectionTitle>Projects</SectionTitle>
      <PropertyRow label="Recent projects">
        <Button disabled={recent === 0} data-command="file.clearRecent" onClick={() => shell.runner.run('file.clearRecent')}>Clear {recent} Recent</Button>
      </PropertyRow>
      <SectionTitle>Keys</SectionTitle>
      <PropertyRow label="Changed keys">
        <Button disabled={customKeys === 0} data-action="reset-keys" onClick={() => shell.setPreferences({ keymap: {} })}>Reset {customKeys} to Default</Button>
      </PropertyRow>
    </div>
  );
}

export function PreferencesDialog(props: { readonly shell: Shell }) {
  const { shell } = props;
  const [tab, setTab] = useState<Tab>('graphics');
  return (
    <Dialog
      open
      name="preferences"
      width={560}
      title="Preferences"
      onClose={() => shell.closeDialog()}
      actions={<Button variant="primary" data-action="ok" onClick={() => shell.closeDialog()}>Close</Button>}
    >
      <div className="og-tabs" role="tablist">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" className="og-tab" aria-selected={tab === entry.id} data-tab-button={entry.id} onClick={() => setTab(entry.id)}>
            {entry.title}
          </button>
        ))}
      </div>
      {/* One height for every tab: the dialog does not jump when another is chosen. */}
      <div className="og-preferences-page">
        {tab === 'graphics' ? <Graphics shell={shell} /> : tab === 'keys' ? <Keys shell={shell} /> : <General shell={shell} />}
      </div>
    </Dialog>
  );
}
