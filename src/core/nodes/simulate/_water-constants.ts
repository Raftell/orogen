// src/core/nodes/simulate/_water-constants.ts
// The rows of the calibration register (simulation.md section 13) that only the water nodes of sections 7 to 9
// use. ROUTE_EPS and the constants of the flats are in _route.ts, beside the router they belong to; SITE_SPACING,
// which is fixed, is in _water-course.ts.

/** Slopes gentler than this tangent count as this in the wetness index (7). Fixed; the index has no value on level ground. */
export const WETNESS_SLOPE_MIN = 0.001;
/** A texel that precipitation leaves without area counts as draining this part of one cell (7). To calibrate. */
export const WETNESS_AREA_MIN = 0.1;

/** Exponents of the drained fraction in a river's width and depth (8.5). Fixed; LM53 as commonly cited. */
export const RIVER_WIDTH_EXPONENT = 0.5;
export const RIVER_DEPTH_EXPONENT = 0.4;

/** The length over which a river's course and its width are smoothed, in widths of the river (8.5). To calibrate. */
export const COURSE_SMOOTHING = 1;
/** That length is never less than this many texels (8.5). To calibrate. */
export const COURSE_SMOOTHING_MIN = 4;
/** How far that takes a place from its river texel at the most, in widths of the river (8.5). To calibrate. */
export const COURSE_SLACK = 0.5;
/** A place may always lie this many texels from its river texel (8.5). To calibrate. */
export const COURSE_SLACK_MIN = 2;
/** Steps along a river by which a texel's nearest site is corrected after the jump flood (8.5). To calibrate. */
export const COURSE_REFINE = 8;
/** How much wider a river grows per length of its course at the most (8.5). To calibrate. */
export const RIVER_TAPER = 0.1;
/** The length over which a river's long profile is smoothed, in widths of the river (8.5). To calibrate. */
export const PROFILE_SMOOTHING = 3;
/** How far that smoothing lowers a river at the most, in widths of the river (8.5). To calibrate. */
export const PROFILE_DEPTH = 0.25;
/** How fast a valley deepens or shallows along its river at the most, as a part of the bank's slope (8.5). To calibrate. */
export const VALLEY_GRADE = 0.2;
/** How high above the water a valley's side is cut, beside the river's own depth: this many times as far as the river lies below the routing surface (8.5). To calibrate. */
export const BANK_RISE = 1;
/** How far a valley reaches beyond the bank of its river, in the widths a side at the bank's slope would have: its sides ease out over twice that width (8.5). To calibrate. */
export const VALLEY_REACH = 2;

/** The part of a shore band, from the waterline out, over which the ground is drawn to the beach and the shelf in full (9.2). To calibrate. */
export const COAST_FLAT = 0.3;
/** Relaxation sweeps over a reshaped coast (9.2). To calibrate. */
export const COAST_SWEEPS = 32;
/** The angle, in degrees, to which those sweeps relax the scarp behind a beach (9.2). To calibrate. */
export const COAST_TALUS = 35;
/** The share of an excess height a texel passes to a lower neighbour per sweep: TRANSFER of 5.3. Fixed; stability. */
export const COAST_TRANSFER = 0.1;
