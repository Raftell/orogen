// The resolution ladder of engine.md 1.5: level k of B is (B − 1) / 2^k + 1, defined while (B − 1) is
// divisible by 2^k and the level is at least 33.

const MIN_LEVEL = 33;
/** The bound of every loop over levels. A level above it would need a resolution beyond 2^35. */
export const MAX_LEVEL = 30;

/** The levels from `res` downwards: ladder(509) is [509, 255, 128]. This is ctx.ladder (engine.md 4.7). */
export function ladder(res: number): number[] {
  const levels: number[] = [];
  for (let k = 0; k <= MAX_LEVEL; k++) {
    const level = ladderLevel(res, k);
    if (level === null) break;
    levels.push(level);
  }
  return levels;
}

/** Level `k` of `res`, or null when it is not defined. Level 0 is `res` itself, whatever its size. */
export function ladderLevel(res: number, k: number): number | null {
  if (!Number.isInteger(res) || res < 1 || !Number.isInteger(k) || k < 0) return null;
  if (k === 0) return res;
  if (k > MAX_LEVEL) return null;
  const divisor = 2 ** k;
  if ((res - 1) % divisor !== 0) return null;
  const level = (res - 1) / divisor + 1;
  return level >= MIN_LEVEL ? level : null;
}

/** 1009, 2017, 4033, 8129, or an integer B with 129 <= B <= 8192 and (B − 1) divisible by 16. */
export function isBuildResolution(n: number): boolean {
  return Number.isInteger(n) && n >= 129 && n <= 8192 && (n - 1) % 16 === 0;
}
