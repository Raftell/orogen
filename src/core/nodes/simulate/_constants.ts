// The calibration register of simulation.md section 13: every tuning number of the category is a named constant
// of this module. It starts with the constants the refine module uses; the owners add the rows of their
// algorithms (nodes.md section 4).

/** Amplitude of the detail noise a refinement injects, as a fraction of the fine cell (2.4). To calibrate. */
export const DETAIL_SLOPE = 0.1;

/** Half-width of the refinement jitter, in coarse texels (2.4). Fixed; Tzathas24. */
export const JITTER_HALF_WIDTH = 0.25;
