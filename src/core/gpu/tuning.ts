// The time constants of the runtime. Those the contract marks "to calibrate" are starting values and are
// defined here and nowhere else; they change only with a measurement on the target machine (runtime.md, Conventions).

/** GPU milliseconds per unit of work of a kernel that has not run on this device (runtime.md 3.3 rule 1). To calibrate. */
export const RATE_INITIAL = 1e-7;
/** A learned rate never exceeds this multiple of RATE_INITIAL, except through 3.3 rule 3 (3.3 rule 6). To calibrate. */
export const RATE_CAP_FACTOR = 100;
/** A learned rate never falls below this multiple of RATE_INITIAL (3.3 rule 7). To calibrate. */
export const RATE_FLOOR_FACTOR = 0.01;
/** Slice targets in milliseconds (runtime.md 3.5). To calibrate. */
export const SLICE_TARGET_PREVIEW_MS = 8;
export const SLICE_TARGET_BUILD_MS = 75;
/** No dispatch is encoded whose estimate exceeds this (runtime.md 3.5). */
export const HARD_CEILING_MS = 500;
/** No tile and no slice holds more texels of a kernel the device has not measured (runtime.md 3.4 rule 5). To calibrate. */
export const UNMEASURED_SLICE_TEXELS = 1048576;
/** A slice is closed when it holds this many runs (runtime.md 3.1). To calibrate. */
export const SLICE_MAX_RUNS = 256;
/** A thread that has not returned to the event loop for this long has stalled: what it sees next it sees late (runtime.md 3.5 rule 3). To calibrate. */
export const THREAD_STALL_MS = 12;
/** The completion latency is measured again after this much idle time (runtime.md 3.5 rule 1). To calibrate. */
export const LATENCY_REMEASURE_MS = 250;
/** A draft that took longer moves to the coarser level, one four times shorter to the finer (runtime.md 7.3 rule 4). To calibrate. */
export const DRAFT_LEVEL_THRESHOLD_MS = 50;
