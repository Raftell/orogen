import { defineLib, type WgslLib } from '../gpu/lib.ts';

// The text of engine.md 3.9, which is normative: the two conversions of runtime.md 5.6. The evaluator converts a
// connection with these, and a node that reads an input of the other kind itself gives what a connection would.
const code = /* wgsl */ `// A color read as a field: the luma of its linear RGB. Alpha is ignored.
fn convert_luma(c: vec4f) -> f32 { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
// A field read as a color: grey and opaque.
fn convert_grey(v: f32) -> vec4f { return vec4f(v, v, v, 1.0); }`;

/** The conversions between a field and a colour. */
export const convert: WgslLib = defineLib({ name: 'convert', code });
