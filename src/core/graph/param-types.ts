import type { CurvePoint, GradientStop } from './curves.ts';

export type Unit = 'length' | 'height' | 'angle' | 'ratio' | 'none';
export type ParamValue =
  | number | boolean | string
  | readonly [number, number] | readonly [number, number, number]
  | readonly CurvePoint[] | readonly GradientStop[];

export interface ParamCommon {
  readonly name: string;
  readonly label?: string;
  readonly help: string;
  readonly group?: string;
  readonly visibleWhen?: { readonly param: string; readonly equals: string | number | boolean };
}

export interface FloatParam extends ParamCommon {
  readonly kind: 'float';
  readonly unit: Unit;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly soft?: boolean;
  readonly scale?: 'linear' | 'log';
  readonly step?: number;
}
export interface IntParam extends ParamCommon { readonly kind: 'int'; readonly default: number; readonly min: number; readonly max: number }
export interface BoolParam extends ParamCommon { readonly kind: 'bool'; readonly default: boolean }
export interface EnumParam extends ParamCommon {
  readonly kind: 'enum';
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}
export interface SeedParam extends ParamCommon { readonly kind: 'seed'; readonly name: 'seed'; readonly default: number }
export interface Vec2Param extends ParamCommon {
  readonly kind: 'vec2';
  readonly unit: 'length' | 'ratio' | 'none';
  readonly default: readonly [number, number];
  readonly min: number;
  readonly max: number;
  readonly soft?: boolean;
}
export interface ColorParam extends ParamCommon { readonly kind: 'color'; readonly default: readonly [number, number, number] }
export interface CurveParam extends ParamCommon { readonly kind: 'curve'; readonly default: readonly CurvePoint[] }
export interface GradientParam extends ParamCommon { readonly kind: 'gradient'; readonly default: readonly GradientStop[] }
export interface FileParam extends ParamCommon { readonly kind: 'file'; readonly default: ''; readonly filters: readonly string[] }
export interface TextParam extends ParamCommon { readonly kind: 'text'; readonly default: string; readonly maxLength?: number }

export type ParamDef =
  | FloatParam | IntParam | BoolParam | EnumParam | SeedParam | Vec2Param
  | ColorParam | CurveParam | GradientParam | FileParam | TextParam;

export type Named<T extends ParamDef, N extends string> = Omit<T, 'name'> & { readonly name: NoInfer<N> };
export type Over<T> = Partial<Omit<T, 'kind' | 'name' | 'unit'>>;

export type ValueOf<D> =
  D extends { kind: 'float' | 'int' | 'seed' } ? number
  : D extends { kind: 'bool' } ? boolean
  : D extends { kind: 'enum'; options: readonly { value: infer V }[] } ? V
  : D extends { kind: 'vec2' } ? readonly [number, number]
  : D extends { kind: 'color' } ? readonly [number, number, number]
  : D extends { kind: 'curve' } ? readonly CurvePoint[]
  : D extends { kind: 'gradient' } ? readonly GradientStop[]
  : D extends { kind: 'file' | 'text' } ? string
  : never;
/** With literal names: one member per param. For the untyped default (names are `string`): a plain record. */
export type ParamsOf<P extends readonly ParamDef[]> =
  string extends P[number]['name']
    ? Readonly<Record<string, ParamValue>>
    : { readonly [D in P[number] as D['name']]: ValueOf<D> };

export type EnumNames<P extends readonly ParamDef[]> = Extract<P[number], { kind: 'enum' }>['name'];
