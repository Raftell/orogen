// A vec2 parameter: a number field for each component. An offset or a position in lengths shows its metres like
// any length, and its two fields then stand one above the other so that each has room for both numbers; in a
// panel wide enough for both they stand side by side (inspector.module.css).

import type { Vec2Param } from '../../../../core/api.ts';
import { NumberField } from '../../../ui/index.ts';
import styles from '../inspector.module.css';
import { secondaryOf, shownPrecision, vec2Spec } from '../model.ts';
import type { ControlProps } from './types.ts';

const AXES = ['X', 'Y'] as const;

export function Vec2Control(props: ControlProps<Vec2Param, readonly [number, number]>) {
  const { value } = props;
  const spec = vec2Spec(props.param, props.settings);
  return (
    <div className={styles.vec2} data-stacked={spec.metres === undefined ? undefined : ''}>
      {AXES.map((axis, index) => (
        <NumberField
          key={axis}
          id={index === 0 ? props.id : undefined}
          label={axis}
          aria-label={`${props.label} ${axis}`}
          value={value[index]!}
          {...spec.range}
          precision={shownPrecision(spec, value[index]!)}
          unit={spec.unit}
          units={spec.units}
          secondary={secondaryOf(spec, value[index]!)}
          disabled={props.disabled}
          onChange={(next) => props.change(index === 0 ? [next, value[1]] : [value[0], next])}
          onScrubStart={props.begin}
          onScrubEnd={props.end}
        />
      ))}
    </div>
  );
}
