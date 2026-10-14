// A color parameter: the swatch that opens the picker, and the color's hex code beside it. The document holds
// linear RGB; the swatch and the code show sRGB (engine.md 1.7).

import type { ColorParam } from '../../../../core/api.ts';
import { ColorSwatch, toHex, type Rgb } from '../../../ui/index.ts';
import styles from '../inspector.module.css';
import type { ControlProps } from './types.ts';

export function ColorControl(props: ControlProps<ColorParam, Rgb>) {
  return (
    <div className={styles.color}>
      <ColorSwatch
        id={props.id}
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        onChange={props.change}
        // A drag in the picker is one history entry, wherever the button is let go: the swatch hears the release on the window.
        onScrubStart={props.begin}
        onScrubEnd={() => props.end(true)}
      />
      <span className={styles.hex} data-color-code="">{toHex(props.value)}</span>
    </div>
  );
}
