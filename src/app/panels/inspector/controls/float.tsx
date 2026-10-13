// A float parameter: the number field, with the range, the scale and the units of the parameter's unit. A length
// and a height show their metres beside the stored fraction and are typed in either (runtime.md 8.7 rule 6); a
// direction has a dial before the field (rule 5).

import type { FloatParam } from '../../../../core/api.ts';
import { NumberField } from '../../../ui/index.ts';
import styles from '../inspector.module.css';
import { Dial } from '../Dial.tsx';
import { floatSpec, isDirection, secondaryOf, shownPrecision } from '../model.ts';
import type { ControlProps } from './types.ts';

export function FloatControl(props: ControlProps<FloatParam, number>) {
  const { param, value } = props;
  const spec = floatSpec(param, props.settings);
  const field = (
    <NumberField
      id={props.id}
      className={styles.fill}
      aria-label={props.label}
      value={value}
      {...spec.range}
      precision={shownPrecision(spec, value)}
      unit={spec.unit}
      units={spec.units}
      secondary={secondaryOf(spec, value)}
      disabled={props.disabled}
      onChange={props.change}
      onScrubStart={props.begin}
      onScrubEnd={props.end}
    />
  );
  if (!isDirection(param)) return field;
  return (
    <>
      <Dial value={value} label={`${props.label} dial`} disabled={props.disabled} change={props.change} begin={props.begin} end={props.end} />
      {field}
    </>
  );
}
