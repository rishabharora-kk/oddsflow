/**
 * Small pure functions shared by the browser page and the tests.
 *
 * page.ts embeds these into the served HTML via Function.prototype.toString(), so they are the single source
 * of truth. Keep them self-contained: no imports, no closures over module state, and no TypeScript syntax
 * (JSDoc only), so the embedded source is plain JavaScript however the module was loaded.
 */

/**
 * Whether a row must be shown as STALE.
 *  - A row the engine already flagged is stale.
 *  - Live mode: everything is stale while the browser is disconnected from the server.
 *  - Static mode: everything is stale once the snapshot is more than 20 minutes older than the viewer's clock.
 * @param {{ stale?: boolean }} row
 * @param {{ mode: string, connected?: boolean, generatedAt?: number | null, nowSec: number }} ctx
 * @returns {boolean}
 */
export function rowIsStale(row, ctx) {
  if (row && row.stale) return true;
  if (ctx.mode === "static") {
    return typeof ctx.generatedAt !== "number" || ctx.nowSec - ctx.generatedAt > 1200;
  }
  return !ctx.connected;
}

/**
 * Whole minutes since the snapshot was generated (never negative).
 * @param {number} generatedAt unix seconds
 * @param {number} nowSec unix seconds
 * @returns {number}
 */
export function snapshotAgeMin(generatedAt, nowSec) {
  return Math.max(0, Math.floor((nowSec - generatedAt) / 60));
}
