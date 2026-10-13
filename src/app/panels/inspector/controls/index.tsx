// The control of a parameter by its kind (runtime.md 8.7 rule 5): one file per ParamDef kind in this folder. A
// new kind is a change to engine.md, and then a file here; the switch below does not compile without it.

import type {
  BoolParam, ColorParam, CurveParam, CurvePoint, EnumParam, FileParam, FloatParam, GradientParam, GradientStop, IntParam, ParamDef, SeedParam,
  TextParam, Vec2Param,
} from '../../../../core/api.ts';
import type { Rgb } from '../../../ui/index.ts';
import { BoolControl } from './bool.tsx';
import { ColorControl } from './color.tsx';
import { CurveControl } from './curve.tsx';
import { EnumControl } from './enum.tsx';
import { FileControl } from './file.tsx';
import { FloatControl } from './float.tsx';
import { GradientControl } from './gradient.tsx';
import { IntControl } from './int.tsx';
import { SeedControl } from './seed.tsx';
import { TextControl } from './text.tsx';
import type { ControlProps } from './types.ts';
import { Vec2Control } from './vec2.tsx';

export type { ControlProps };

/** The kinds whose control lies below its label, as wide as the panel: the two editors, and a file, whose name needs the room. */
export const isBlockKind = (kind: ParamDef['kind']): boolean => kind === 'curve' || kind === 'gradient' || kind === 'file';

/** `value` is the parameter's value as normalizeParams gives it, so it has the type of the parameter's kind. */
export function ParamControl(props: ControlProps) {
  const { param } = props;
  switch (param.kind) {
    case 'float': return <FloatControl {...(props as unknown as ControlProps<FloatParam, number>)} />;
    case 'int': return <IntControl {...(props as unknown as ControlProps<IntParam, number>)} />;
    case 'bool': return <BoolControl {...(props as unknown as ControlProps<BoolParam, boolean>)} />;
    case 'enum': return <EnumControl {...(props as unknown as ControlProps<EnumParam, string>)} />;
    case 'seed': return <SeedControl {...(props as unknown as ControlProps<SeedParam, number>)} />;
    case 'vec2': return <Vec2Control {...(props as unknown as ControlProps<Vec2Param, readonly [number, number]>)} />;
    case 'color': return <ColorControl {...(props as unknown as ControlProps<ColorParam, Rgb>)} />;
    case 'text': return <TextControl {...(props as unknown as ControlProps<TextParam, string>)} />;
    case 'file': return <FileControl {...(props as unknown as ControlProps<FileParam, string>)} />;
    case 'curve': return <CurveControl {...(props as unknown as ControlProps<CurveParam, readonly CurvePoint[]>)} />;
    case 'gradient': return <GradientControl {...(props as unknown as ControlProps<GradientParam, readonly GradientStop[]>)} />;
    default: {
      const unknown: never = param;
      return <span>{String((unknown as ParamDef).kind)}</span>;
    }
  }
}
