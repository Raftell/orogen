// tests/nodes/select/terrains.ts
import { fieldOf, type FieldData } from '../../helpers/index.ts';

/**
 * A rough terrain for comparing two levels of the ladder: six octaves of two crossed waves each, with half the
 * amplitude at twice the frequency, from one cycle across the terrain down to 32, which is 8 cells at 257. It
 * is as steep as ref/fbm (a root mean square slope of 45 degrees with the test settings), and being made on
 * the CPU from `uv` it is at one resolution exactly the decimation of itself at a finer one, as the fbm
 * fixture, which the GPU computes, is not held to be.
 */
export function rough(res: number): FieldData {
  return fieldOf(res, (u, v) => {
    let h = 0.5;
    for (let octave = 0; octave < 6; octave++) {
      const cycles = 2 ** octave;
      for (const turn of [0, 1.9]) {
        const angle = 1.1 * octave + turn;
        h += (0.125 / cycles) * Math.sin(2 * Math.PI * cycles * (u * Math.cos(angle) + v * Math.sin(angle)) + 2.3 * octave + turn);
      }
    }
    return h;
  });
}
