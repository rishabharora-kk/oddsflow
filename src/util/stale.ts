/** True when the data point is older than `maxAgeSec` (default 120 s). */
export function isStale(asOfSec: number, nowSec: number, maxAgeSec = 120): boolean {
  return nowSec - asOfSec > maxAgeSec;
}
