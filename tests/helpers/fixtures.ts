import fbmNode from '../../src/core/nodes/ref/fbm.ts';
import { TEST_SETTINGS } from './engine.ts';
import { colorOf, fieldOf, type FieldData } from './field-data.ts';
import { renderNode } from './render.ts';

export type FixtureName =
  | 'terrain' | 'rampX' | 'rampY' | 'cone' | 'basin' | 'bowl' | 'notch'
  | 'mask' | 'zero' | 'one' | 'impulse' | 'color' | 'fbm';

const TAU = 2 * Math.PI;
const saturate = (v: number): number => Math.min(1, Math.max(0, v));

// The table of testing.md 2.2, as functions of (u, v).
const terrainAt = (u: number, v: number): number =>
  0.5 + 0.22 * Math.sin(TAU * (u + 0.5 * v) + 0.3) + 0.10 * Math.sin(TAU * (-2 * u + 3 * v) + 1.7)
  + 0.05 * Math.sin(TAU * (5 * u + 4 * v) + 4.1) + 0.025 * Math.sin(TAU * (9 * u - 7 * v) + 2.9);
const coneAt = (u: number, v: number): number => Math.max(0, 1 - 4 * Math.hypot(u - 0.5, v - 0.5));
const basinAt = (u: number, v: number): number => 0.3 + 0.4 * u - 0.35 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.0288);
const bowlAt = (u: number, v: number): number => 0.3 + 0.6 * (2 * Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5))) ** 2;
const notchAt = (u: number, v: number): number => 0.75 - 0.5 * u - 0.05 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.1);
const maskAt = (u: number, v: number): number => saturate((0.35 - Math.hypot(u - 0.5, v - 0.5)) / 0.15);

/** 1 at the centre texel. A grid with an even number of texels has no centre vertex; the texel before it is taken. */
function impulse(res: number): FieldData {
  const field = fieldOf(res, () => 0);
  const centre = Math.floor((res - 1) / 2);
  field.data[centre * res + centre] = 1;
  return field;
}

/** The fixtures that are functions of (u, v) on the CPU: every one but `fbm`. */
const computed: Readonly<Record<Exclude<FixtureName, 'fbm'>, (res: number) => FieldData>> = {
  terrain: (res) => fieldOf(res, terrainAt),
  rampX: (res) => fieldOf(res, (u) => u),
  rampY: (res) => fieldOf(res, (_u, v) => v),
  cone: (res) => fieldOf(res, coneAt),
  basin: (res) => fieldOf(res, basinAt),
  bowl: (res) => fieldOf(res, bowlAt),
  notch: (res) => fieldOf(res, notchAt),
  mask: (res) => fieldOf(res, maskAt),
  zero: (res) => fieldOf(res, () => 0),
  one: (res) => fieldOf(res, () => 1),
  impulse,
  color: (res) => colorOf(res, (u, v) => [u, v, terrainAt(u, v), 1]),
};

export const FIXTURE_NAMES: readonly FixtureName[] = [...(Object.keys(computed) as FixtureName[]), 'fbm'];

export function isFixtureName(value: unknown): value is FixtureName {
  return typeof value === 'string' && (FIXTURE_NAMES as readonly string[]).includes(value);
}

/** 'field' or 'color': what a fixture is, without making it. */
export function fixtureKind(name: FixtureName): 'field' | 'color' {
  return name === 'color' ? 'color' : 'field';
}

export const fixtures: {
  terrain(res: number): FieldData;
  rampX(res: number): FieldData;
  rampY(res: number): FieldData;
  cone(res: number): FieldData;
  basin(res: number): FieldData;
  bowl(res: number): FieldData;
  notch(res: number): FieldData;
  mask(res: number): FieldData;
  zero(res: number): FieldData;
  one(res: number): FieldData;
  impulse(res: number): FieldData;
  color(res: number): FieldData;
  fbm(res: number, seed?: number): Promise<FieldData>;     // seed defaults to 0
  byName(name: FixtureName, res: number): Promise<FieldData>;
} = {
  ...computed,
  async fbm(res, seed = 0) {
    const { out } = await renderNode(fbmNode, { res, params: { seed }, settings: TEST_SETTINGS });
    return out!;
  },
  async byName(name, res) {
    if (!isFixtureName(name)) throw new TypeError(`"${String(name)}" is not a fixture; the fixtures are ${FIXTURE_NAMES.join(', ')}`);
    return name === 'fbm' ? fixtures.fbm(res) : computed[name](res);
  },
};
