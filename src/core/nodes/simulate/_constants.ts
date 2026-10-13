// The calibration register of simulation.md section 13: every tuning number of the category is a named constant
// of this module. It starts with the constants the refine module uses; the owners add the rows of their
// algorithms (nodes.md section 4).

/** Amplitude of the detail noise a refinement injects, as a fraction of the fine cell (2.4). To calibrate. */
export const DETAIL_SLOPE = 0.1;

/** Half-width of the refinement jitter, in coarse texels (2.4). Fixed; Tzathas24. */
export const JITTER_HALF_WIDTH = 0.25;

/** A constant as a WGSL float literal: a whole number gets its decimal point, so that it is no integer there. */
export const wgsl = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

// ---- the base level (2.1) ---------------------------------------------------------------------------------------

/** Texels of the base level across a feature of fluvial and hydraulic erosion (3.8, 4.8). To calibrate; was 32. */
export const FEATURE_CELLS = 64;
/** Texels of the base level across the reach of a relaxation: thermal erosion and the mobile layers (5.7, 5.9, 10). To calibrate. */
export const FEATURE_CELLS_RELAX = 8;

// ---- stream-power fluvial erosion (3) ---------------------------------------------------------------------------

/** Texels the incision front moves per iteration at the capped speed (3.6). Fixed; stability. */
export const COURANT = 0.5;
/** The largest erosion speed, in units of a reference catchment's (3.3). To calibrate. */
export const CELERITY_CAP = 4;
/** Speed at which a slope above the talus angle is worn back, in the same units (3.3). To calibrate. */
export const TALUS_RATE = 0.1;
/** Iterations a level finer than the base takes at the most (3.7). To calibrate. */
export const DETAIL_ITERATIONS_FLUVIAL = 256;
/** The exponent of the fall, per unit of run, by which a texel shares its water among its lower N8 neighbours (3.6). To calibrate. */
export const FLOW_SPREAD = 1.5;
/** How far the share a texel gives one neighbour lies above or below what the fall alone gives, at random: what lets a stream on even ground turn (3.6). To calibrate. */
export const FLOW_JITTER = 0.5;
/** Catchments up to this many texels of the coarser level across are new to a finer level and cut faster there (3.6). Calibrated by eye. */
export const FRESH_CELLS = 3;
/** The share of the full speed-up those catchments get: 1 would give them the whole run on their level (3.6). Calibrated by eye. */
export const FRESH_BOOST = 0.5;
/** Sweeps of the routing surface after each erosion step (3.5). To calibrate. */
export const FILL_SWEEPS = 4;

// ---- virtual-pipe hydraulic erosion (4) -------------------------------------------------------------------------

/** Gravity, m/s². Fixed. */
export const G = 9.81;
/** Height of a pipe's cross-section, in metres: the wave speed of the model is sqrt(G * H_REF) on every grid (4.3). To calibrate. */
export const H_REF = 20;
/** The time step as a share of the gravity-wave bound (4.7). Fixed; stability. */
export const PIPE_SAFETY = 0.5;
/** Speed of water in a channel as a share of the wave speed: how many iterations a `duration` takes (4.7). To calibrate. */
export const NOMINAL_SPEED = 0.25;
/** The longest run, as the terrain widths water at the nominal speed covers in it: `duration` times `size` counts up to this (4.7). To calibrate. */
export const TRAVEL_MAX = 1;
/** Rainfall at `rain` = 1, m/s (4.6). To calibrate. */
export const RAIN_MAX = 0.005;
/** Evaporation rate, 1/s (4.6). To calibrate. */
export const KE = 0.015;
/** Rainfall whose runoff down a slope one feature size long is the water of a channel head, m/s: less water carves nothing (4.6). Calibrated. */
export const HEAD_RAIN = 0.0006;
/** The water, in channel heads beyond the first, from which the capacity and the depth of a gully are full (4.6). To calibrate. */
export const GATHER_MAX = 32;
/** The power of the gathered water by which the capacity grows: above 1, so that water that runs together cuts faster than the same water spread out (4.6). To calibrate. */
export const CARRY_POWER = 1.5;
/** The power of the gathered water, as a share of GATHER_MAX, by which the depth of a gully grows (4.6). To calibrate. */
export const CUT_POWER = 0.5;
/** Metres of sediment that fast water on a vertical face holds at `capacity` 1 for each channel head of water beyond the first (4.6). To calibrate. */
export const CARRY = 250;
/** The share of the pick-up rate that acts: a gully is cut over the whole run, not in its first moments (4.6). To calibrate. */
export const PICKUP = 0.05;
/** The share of the settling rate that acts: at `deposition` 1 sediment travels some hundred metres before most of it has settled (4.6). To calibrate. */
export const SETTLE = 1;
/** Water lays down only what it holds beyond this many times its capacity: a capacity that wavers along a channel leaves no row of heaps (4.6). To calibrate. */
export const SETTLE_BAND = 2;
/** The power of the share that stays (1 - removal) by which sediment still in running water when the run ends is laid down where it is: at `removal` 0 all of it, at the default none to speak of (4.6). To calibrate. */
export const FLUSH_POWER = 8;
/** The depth of the deepest gully below the ground the run found, as a share of the feature size (4.6). Calibrated by eye. */
export const CUT_SHARE = 0.3;
/** The sine of the slope from which a gully may cut to its full depth; on gentler ground in proportion (4.6). To calibrate. */
export const CUT_SLOPE = 0.25;
/** The steepest slope what the water laid down rests on, in degrees: steeper, it slides (4.6). To calibrate. */
export const FAN_ANGLE = 6;
/** The share of a height difference between neighbours that what the water laid down evens out per iteration on any slope: its bars and levees are no texel-sized heaps (4.6). To calibrate. */
export const CREEP = 0.5;
/** The least sine of the slope the capacity counts with: level ground still erodes (4.6). To calibrate. */
export const SIN_MIN = 0.005;
/** Water shallower than this, in metres, neither moves sediment nor has a speed (4.6). To calibrate. */
export const D_MIN = 1e-4;
/** How far a texel's erodibility lies below 1 at the most (4.6). To calibrate. */
export const ERODIBILITY_JITTER = 0.25;
/** Iterations a level finer than the base takes at the most (4.7). To calibrate. */
export const DETAIL_ITERATIONS_HYDRAULIC = 384;

// ---- thermal erosion and the mobile layers (5, 10) --------------------------------------------------------------

/** The share of the excess height a texel passes to one lower neighbour per iteration (5.3). Fixed; the bound is 1/9. */
export const TRANSFER = 0.1;
/** Iterations per square of the reach in texels: a slope relaxes by diffusion (5.7). Calibrated on the cone fixture (5.8 item 6); was 2. */
export const RELAX = 4;
/** Iterations a level finer than the base takes at the most (5.7). To calibrate. */
export const DETAIL_ITERATIONS_RELAX = 96;

// ---- snow (10) --------------------------------------------------------------------------------------------------

/** Height of the sun that melts snow, in degrees above the horizon (10.3). To calibrate. */
export const SUN_ELEVATION = 45;
/** The share of the snowfall at which ground counts as covered: thinner snow, as on a face it is sliding off, covers in part (10.2). To calibrate. */
export const SNOW_COVER = 0.25;
/** The share of a height difference between neighbours that snow evens out per iteration on a slope it does not slide off: it drifts off the crests into the hollows and rounds the ground under it (10.3). To calibrate. */
export const SNOW_CREEP = 0.5;
