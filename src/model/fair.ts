import type { Contract } from "../parse/market.ts";
import { isStale } from "../util/stale.ts";

export const SECONDS_PER_YEAR = 31_536_000;
const SQRT2 = Math.SQRT2;
const SQRT_PI = Math.sqrt(Math.PI);

/** erf(x) for 0 <= x < 2 via the all-positive-terms series (no cancellation). */
function erfSmall(x: number): number {
  if (x === 0) return 0;
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 500; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return ((2 / SQRT_PI) * Math.exp(-x2) * sum);
}

/** erfc(x) for x >= 0. Series below 2, continued fraction above (relative accuracy ~1e-15). */
function erfcNonNeg(x: number): number {
  if (x < 2) return 1 - erfSmall(x);
  if (x > 27) return 0; // exp(-x^2) underflows
  // erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...))))
  let f = x;
  for (let k = 400; k >= 1; k--) f = x + k / 2 / f;
  return Math.exp(-x * x) / (SQRT_PI * f);
}

/** Standard normal CDF, accurate to well below 1e-12. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = x / SQRT2;
  return z >= 0 ? 1 - 0.5 * erfcNonNeg(z) : 0.5 * erfcNonNeg(-z);
}

/** P(S_T >= K) under driftless (martingale) lognormal: N(d2). */
export function closeAbove(S: number, K: number, sigma: number, T: number): number {
  if (T <= 0 || sigma <= 0) return S >= K ? 1 : 0;
  const v = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) - (sigma * sigma * T) / 2) / v;
  return normCdf(d2);
}

export function closeBelow(S: number, K: number, sigma: number, T: number): number {
  return 1 - closeAbove(S, K, sigma, T);
}

/** P(max over [0,T] of S >= K), driftless lognormal, continuous monitoring. */
export function touchAbove(S: number, K: number, sigma: number, T: number): number {
  if (S >= K) return 1;
  if (T <= 0 || sigma <= 0) return 0;
  const b = Math.log(K / S);
  const v = sigma * Math.sqrt(T);
  const h = (sigma * sigma * T) / 2;
  return normCdf((-b - h) / v) + (S / K) * normCdf((-b + h) / v);
}

/** P(min over [0,T] of S <= K), driftless lognormal, continuous monitoring. */
export function touchBelow(S: number, K: number, sigma: number, T: number): number {
  if (S <= K) return 1;
  if (T <= 0 || sigma <= 0) return 0;
  const b = Math.log(S / K);
  const v = sigma * Math.sqrt(T);
  const h = (sigma * sigma * T) / 2;
  return normCdf((-b + h) / v) + (S / K) * normCdf((-b - h) / v);
}

/** Annualised sample standard deviation of log returns; null with < 3 closes or any non-positive close. */
export function realizedVol(closes: number[], periodSec: number): number | null {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  for (const c of closes) if (!(c > 0) || !Number.isFinite(c)) return null;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const ss = r.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const sd = Math.sqrt(ss / (r.length - 1));
  return sd * Math.sqrt(SECONDS_PER_YEAR / periodSec);
}

export type FairInputs = {
  spot: number;
  spotAsOfSec: number;
  sigma: number | null;
  nCandles: number;
  supply?: number | null;
  nowSec: number;
};

export type FairResult = {
  p: number;
  inputs: { S: number; K: number; sigma: number; T: number };
  confidence: "high" | "low";
};

export function fairValue(c: Contract, x: FairInputs): FairResult | null {
  if (x.sigma === null || x.sigma === undefined || !Number.isFinite(x.sigma)) return null;
  if (!(x.spot > 0) || !Number.isFinite(x.spot)) return null;
  const T = (c.expiry - x.nowSec) / SECONDS_PER_YEAR;
  const S = x.spot;
  const sigma = x.sigma;

  let K: number;
  let p: number;
  if (c.kind === "mcap_touch_above") {
    if (x.supply === null || x.supply === undefined || !(x.supply > 0) || !Number.isFinite(x.supply)) return null;
    K = c.mcap / x.supply;
    p = touchAbove(S, K, sigma, T);
  } else {
    K = c.strike;
    switch (c.kind) {
      case "close_above": p = closeAbove(S, K, sigma, T); break;
      case "close_below": p = closeBelow(S, K, sigma, T); break;
      case "touch_above": p = touchAbove(S, K, sigma, T); break;
      case "touch_below": p = touchBelow(S, K, sigma, T); break;
      default: return null;
    }
  }
  if (!Number.isFinite(p)) return null;
  p = Math.min(1, Math.max(0, p));

  const low = x.nCandles < 48 || isStale(x.spotAsOfSec, x.nowSec) || T < 1 / 8760;
  return { p, inputs: { S, K, sigma, T }, confidence: low ? "low" : "high" };
}
