// How the build panel writes sizes, times and lengths. No DOM and no React.

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** At most three figures: 5.7, 16, 132. */
function short(value: number): string {
  return value < 9.95 ? value.toFixed(1) : String(Math.round(value));
}

/**
 * A byte count in the units the status bar and Windows Explorer use: 1 MB is 2^20 bytes. A file of a few bytes
 * is written in bytes, so that the manifest is not "0 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < KIB) return `${Math.round(bytes)} B`;
  if (bytes < MIB - KIB / 2) return `${short(bytes / KIB)} KB`;
  if (bytes < GIB - MIB / 2) return `${short(bytes / MIB)} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** A duration that was measured: '0.4 s', '12 s', '3 min 20 s', '1 h 05 min'. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`;
}

/**
 * A duration that is estimated, written no finer than it is known: to 5 seconds below a minute, to half a
 * minute below ten, to the minute above.
 */
export function formatEstimate(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = ms / 1000;
  if (seconds < 5) return 'a few seconds';
  if (seconds < 57.5) return `${Math.round(seconds / 5) * 5} s`;
  if (seconds < 585) {
    const halves = Math.round(seconds / 30);
    return halves % 2 === 0 ? `${halves / 2} min` : `${(halves - 1) / 2} min 30 s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Three significant figures without trailing zeros: 1.98, 49.6, 1, 0.123. */
function figures(value: number): string {
  if (value === 0) return '0';
  const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value))));
  return String(Number(value.toFixed(Math.min(6, digits))));
}

/** A length on the ground: '2.5 km', '1.98 m', '49.6 cm', '0.488 mm'. */
export function formatLength(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres >= 1000) return `${figures(metres / 1000)} km`;
  if (metres >= 1 || metres === 0) return `${figures(metres)} m`;
  if (metres >= 0.01) return `${figures(metres * 100)} cm`;
  return `${figures(metres * 1000)} mm`;
}

/** A whole number with its thousands apart: 66,080,641. */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return '';
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '';
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)} %`;
}

/** 'one file' is not '1 files'. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
