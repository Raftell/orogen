import type { FieldData } from './field-data.ts';

export type FixtureName =
  | 'terrain' | 'rampX' | 'rampY' | 'cone' | 'basin' | 'bowl' | 'notch'
  | 'mask' | 'zero' | 'one' | 'impulse' | 'color' | 'fbm';

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
  terrain() { throw new Error('not implemented: fixtures.terrain'); },
  rampX() { throw new Error('not implemented: fixtures.rampX'); },
  rampY() { throw new Error('not implemented: fixtures.rampY'); },
  cone() { throw new Error('not implemented: fixtures.cone'); },
  basin() { throw new Error('not implemented: fixtures.basin'); },
  bowl() { throw new Error('not implemented: fixtures.bowl'); },
  notch() { throw new Error('not implemented: fixtures.notch'); },
  mask() { throw new Error('not implemented: fixtures.mask'); },
  zero() { throw new Error('not implemented: fixtures.zero'); },
  one() { throw new Error('not implemented: fixtures.one'); },
  impulse() { throw new Error('not implemented: fixtures.impulse'); },
  color() { throw new Error('not implemented: fixtures.color'); },
  fbm() { throw new Error('not implemented: fixtures.fbm'); },
  byName() { throw new Error('not implemented: fixtures.byName'); },
};
