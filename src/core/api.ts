// Everything a node file imports: every type, function and constant engine.md names, and the names of other
// documents that its "Imports" table lists. This module imports nothing from src/core/nodes/.

// engine.md 1: the data model
export type { Field, FieldKind, Kind1, Kind2, Kind4, Rgba, SameShape } from './gpu/field.ts';

// engine.md 3: kernels
export { MASK_INPUT, defineKernel } from './gpu/kernel.ts';
export type { AnyKernel, InputDecl, InputOptions, Kernel, KernelDef, UniformType } from './gpu/kernel.ts';
export { defineLib } from './gpu/lib.ts';
export type { WgslLib } from './gpu/lib.ts';
export { hash } from './wgsl/hash.ts';
export { noise } from './wgsl/noise.ts';
export { WGSL_LAYOUT, packLayout } from './gpu/uniforms.ts';
export type { InBindings, KindOfInput, Lut, OptionalInputs, RunBindings, Slot, UniformValue } from './gpu/bindings.ts';
export { FieldAccessError, KernelBindingError, KernelDefError, NodeDefError } from './gpu/errors.ts';

// engine.md 4.1 to 4.6: nodes, ports, parameters
export type { FieldOfPortType, InputField, KindOfPortType, PortDef, PortNamed, PortRole, PortType } from './graph/ports.ts';
export type {
  BoolParam, ColorParam, CurveParam, EnumNames, EnumParam, FileParam, FloatParam, GradientParam, IntParam, Named, Over,
  ParamCommon, ParamDef, ParamValue, ParamsOf, SeedParam, TextParam, Unit, ValueOf, Vec2Param,
} from './graph/param-types.ts';
export { param } from './graph/canonical.ts';
export { defineNode } from './graph/node.ts';
export type { Category, ExternalKeyContext, LiteralNames, LiteralNamesOf, NodeDef, SettingName } from './graph/node.ts';

// engine.md 4.7: the evaluation context
export type { AllocOptions, EvalContext, FieldStats, LoopOptions, OpContext } from './eval/context.ts';

// engine.md 4.8, 4.9: seeds, curves and gradients
export { hashCell, hashU32, hashUnit, mixSeed } from './gpu/hash.ts';
export { bakeCurve, bakeGradient, evalCurve } from './graph/curves.ts';
export type { CurvePoint, GradientStop } from './graph/curves.ts';

// engine.md 4.11, 4.12: CPU tasks and file inputs
export { defineCpuTask } from './cpu/tasks.ts';
export type { AnyCpuTask, CpuEnv, CpuTask } from './cpu/tasks.ts';
export { decodeImage } from './io/image.ts';
export type { DecodedImage } from './io/image.ts';

// engine.md 5: shared operations
export { ops } from './ops/index.ts';
export type { Img, LadderLevel, ResampleFilter } from './ops/types.ts';

// Defined in other documents; a node may name them (engine.md, Imports).
export type {
  ExportContext, ExportHook, ExportItem, ExportSource, HeightRange, ImageItem, LandscapeItem, LayerItem, TextureItem,
} from './export-decl.ts';
export { decodeRaw } from './io/raw.ts';
export { DeviceLostError } from './gpu/device.ts';
export { BudgetExceededError } from './gpu/pool.ts';
export { FileError } from './io/files.ts';
export { createRegistry } from './graph/registry.ts';
export type { NodeRegistry } from './graph/registry.ts';
