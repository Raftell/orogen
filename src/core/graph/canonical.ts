import type { FloatParam, IntParam, Named, Over, SeedParam } from './param-types.ts';

// `kind`, `unit` and `name` come last so that an override object cannot replace them.
function float<N extends string>(name: string, base: Omit<FloatParam, 'name' | 'kind'>, o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N> {
  return { ...base, ...o, kind: 'float', unit: base.unit, name: o?.name ?? name } as Named<FloatParam, N>;
}
function int<N extends string>(name: string, base: Omit<IntParam, 'name' | 'kind'>, o?: Over<IntParam> & { name?: N }): Named<IntParam, N> {
  return { ...base, ...o, kind: 'int', name: o?.name ?? name } as Named<IntParam, N>;
}

/** The canonical parameters of engine.md 4.4: names, units, labels and ranges as its table gives them. Each help text is defined here. */
export const param: {
  seed(o?: Over<SeedParam>): SeedParam;
  size<const N extends string = 'size'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  radius<const N extends string = 'radius'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  strength<const N extends string = 'strength'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  height<const N extends string = 'height'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  angle<const N extends string = 'angle'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  slope<const N extends string>(name: N, o?: Over<FloatParam>): Named<FloatParam, N>;
  octaves<const N extends string = 'octaves'>(o?: Over<IntParam> & { name?: N }): Named<IntParam, N>;
  gain<const N extends string = 'gain'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
} = {
  seed(o) {
    return { label: 'Seed', default: 0, help: 'Another value gives another random variation of the same kind.', ...o, kind: 'seed', name: 'seed' };
  },
  size(o) {
    return float('size', {
      unit: 'length', label: 'Feature size', default: 0.25, min: 0.001, max: 4, scale: 'log', soft: true,
      help: 'Larger values give broader features.',
    }, o);
  },
  radius(o) {
    return float('radius', {
      unit: 'length', label: 'Radius', default: 0.005, min: 0.0001, max: 0.25, scale: 'log', soft: true,
      help: 'Larger values spread the effect over a wider area.',
    }, o);
  },
  strength(o) {
    return float('strength', {
      unit: 'ratio', label: 'Strength', default: 1, min: 0, max: 1,
      help: 'Larger values apply more of the effect.',
    }, o);
  },
  height(o) {
    return float('height', {
      unit: 'height', label: 'Height', default: 1, min: 0, max: 1, soft: true,
      help: 'Larger values make the result taller.',
    }, o);
  },
  angle(o) {
    return float('angle', {
      unit: 'angle', label: 'Direction', default: 0, min: 0, max: 360,
      help: 'Larger values turn the direction clockwise in the top view.',
    }, o);
  },
  slope(name, o) {
    return float(name, {
      unit: 'angle', label: 'Slope', default: 30, min: 0, max: 90,
      help: 'Larger values mean steeper terrain.',
    }, o);
  },
  octaves(o) {
    return int('octaves', {
      label: 'Octaves', default: 8, min: 1, max: 16,
      help: 'Larger values add finer layers of detail.',
    }, o);
  },
  gain(o) {
    return float('gain', {
      unit: 'ratio', label: 'Roughness', default: 0.5, min: 0, max: 1,
      help: 'Larger values keep more of the fine detail and give a rougher surface.',
    }, o);
  },
};
