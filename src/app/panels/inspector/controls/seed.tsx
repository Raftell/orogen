// The seed parameter: its number, and a button that draws another. The button is the command that the menu and
// the palette run (runtime.md 8.8 rule 1): the seed of what is selected, which is what this row shows.

import type { SeedParam } from '../../../../core/api.ts';
import { CommandButton, NumberField } from '../../../ui/index.ts';
import styles from '../inspector.module.css';
import { SEED_SPEC } from '../model.ts';
import type { ControlProps } from './types.ts';

export function SeedControl(props: ControlProps<SeedParam, number>) {
  return (
    <>
      <NumberField
        id={props.id}
        className={styles.fill}
        aria-label={props.label}
        value={props.value}
        {...SEED_SPEC.range}
        precision={0}
        disabled={props.disabled}
        onChange={props.change}
        onScrubStart={props.begin}
        onScrubEnd={props.end}
      />
      <CommandButton command="inspector.randomizeSeed" icon="dice" size="small" />
    </>
  );
}
