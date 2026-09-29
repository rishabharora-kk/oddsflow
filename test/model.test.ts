import test from "node:test";
import assert from "node:assert/strict";
import { closeAbove, closeBelow, fairValue, normCdf, realizedVol, touchAbove, touchBelow } from "../src/model/fair.ts";
import type { Contract } from "../src/parse/market.ts";

const YEAR = 31_536_000;
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);

test("normCdf matches reference values to 1e-12", () => {
  // Reference values from Python's math.erfc: 0.5 * erfc(-x / sqrt(2)).
  const ref: Array<[number, number]> = [
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [2, 0.9772498680518208],
    [-1.96, 0.024997895148220435],
    [3, 0.9986501019683699],
    [-3, 0.0013498980316300957],
    [-5, 2.866515718791946e-7],
    [-0.125, 0.45026177516988714],
  ];
  for (const [x, want] of ref) near(normCdf(x), want, 1e-12, `N(${x})`);
  assert.equal(normCdf(40), 1);
  assert.equal(normCdf(-40), 0);
  assert.ok(Number.isNaN(normCdf(NaN)));
  // symmetry
  for (const x of [0.3, 1.7, 2.4, 4.1]) near(normCdf(x) + normCdf(-x), 1, 1e-15);
});

test("closeAbove(100,100,0.5,0.25) equals N(-0.125)", () => {
  near(closeAbove(100, 100, 0.5, 0.25), normCdf(-0.125), 1e-9);
});

test("closeAbove / closeBelow edge cases", () => {
  assert.equal(closeAbove(101, 100, 0.5, 0), 1);
  assert.equal(closeAbove(99, 100, 0.5, 0), 0);
  assert.equal(closeAbove(101, 100, 0, 0.5), 1);
  assert.equal(closeAbove(99, 100, 0, 0.5), 0);
  assert.equal(closeAbove(100, 100, 0.5, -1), 1);
  near(closeBelow(100, 110, 0.5, 0.25), 1 - closeAbove(100, 110, 0.5, 0.25), 1e-15);
  const p = closeAbove(100, 110, 0.6, 0.5);
  assert.ok(p > 0 && p < 1);
});

test("touchAbove: S >= K is 1; degenerate T or sigma is 0 below the barrier", () => {
  assert.equal(touchAbove(100, 100, 0.5, 0.25), 1);
  assert.equal(touchAbove(120, 100, 0.5, 0.25), 1);
  assert.equal(touchAbove(90, 100, 0.5, 0), 0);
  assert.equal(touchAbove(90, 100, 0, 0.25), 0);
});

test("touchAbove monotonicity: up in S and T, down in K", () => {
  const base = { S: 100, K: 130, sigma: 0.7, T: 0.25 };
  const p = touchAbove(base.S, base.K, base.sigma, base.T);
  assert.ok(p > 0 && p < 1);
  assert.ok(touchAbove(110, base.K, base.sigma, base.T) > p, "S up");
  assert.ok(touchAbove(90, base.K, base.sigma, base.T) < p, "S down");
  assert.ok(touchAbove(base.S, base.K, base.sigma, 0.5) > p, "T up");
  assert.ok(touchAbove(base.S, base.K, base.sigma, 0.1) < p, "T down");
  assert.ok(touchAbove(base.S, 140, base.sigma, base.T) < p, "K up");
  assert.ok(touchAbove(base.S, 120, base.sigma, base.T) > p, "K down");
  assert.ok(touchAbove(base.S, base.K, 0.9, base.T) > p, "sigma up");
});

test("touchAbove >= closeAbove for S < K", () => {
  for (const S of [50, 80, 99]) {
    for (const sigma of [0.2, 0.6, 1.5]) {
      for (const T of [0.01, 0.25, 1]) {
        assert.ok(touchAbove(S, 100, sigma, T) >= closeAbove(S, 100, sigma, T) - 1e-12, `S=${S} s=${sigma} T=${T}`);
      }
    }
  }
});

test("touchBelow mirrors touchAbove's properties", () => {
  assert.equal(touchBelow(100, 100, 0.5, 0.25), 1);
  assert.equal(touchBelow(90, 100, 0.5, 0.25), 1);
  assert.equal(touchBelow(110, 100, 0.5, 0), 0);
  assert.equal(touchBelow(110, 100, 0, 0.5), 0);
  const p = touchBelow(100, 80, 0.7, 0.25);
  assert.ok(p > 0 && p < 1);
  assert.ok(touchBelow(100, 80, 0.7, 0.5) > p, "T up");
  assert.ok(touchBelow(100, 90, 0.7, 0.25) > p, "K up (closer barrier)");
  assert.ok(touchBelow(90, 80, 0.7, 0.25) > p, "S down");
  assert.ok(touchBelow(100, 80, 0.7, 0.25) >= closeBelow(100, 80, 0.7, 0.25));
});

test("realizedVol: constant series is 0, fewer than 3 closes is null", () => {
  assert.equal(realizedVol([5, 5, 5, 5, 5], 3600), 0);
  assert.equal(realizedVol([5, 6], 3600), null);
  assert.equal(realizedVol([], 3600), null);
  assert.equal(realizedVol([5, 6, 0], 3600), null);
  assert.equal(realizedVol([5, -1, 6], 3600), null);
});

test("realizedVol: sample std of log returns, annualised", () => {
  const closes = [100, 101, 99, 102];
  const r = [Math.log(101 / 100), Math.log(99 / 101), Math.log(102 / 99)];
  const m = r.reduce((a, b) => a + b) / 3;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 2);
  near(realizedVol(closes, 3600)!, sd * Math.sqrt(YEAR / 3600), 1e-12);
  near(realizedVol(closes, 86_400)!, sd * Math.sqrt(YEAR / 86_400), 1e-12);
});

const NOW = 1_800_000_000;
const okInputs = { spot: 100, spotAsOfSec: NOW - 10, sigma: 0.8, nCandles: 168, nowSec: NOW };
const closeC: Contract = { kind: "close_above", asset: "X", strike: 110, expiry: NOW + 30 * 86_400 };

test("fairValue: high confidence and correct inputs", () => {
  const f = fairValue(closeC, okInputs)!;
  assert.equal(f.confidence, "high");
  near(f.inputs.T, (30 * 86_400) / YEAR, 1e-15);
  assert.equal(f.inputs.S, 100);
  assert.equal(f.inputs.K, 110);
  assert.equal(f.inputs.sigma, 0.8);
  near(f.p, closeAbove(100, 110, 0.8, f.inputs.T), 1e-15);
});

test("fairValue: each kind uses its own formula", () => {
  const T = (30 * 86_400) / YEAR;
  const mk = (kind: "close_above" | "close_below" | "touch_above" | "touch_below"): Contract => ({ kind, asset: "X", strike: 110, expiry: NOW + 30 * 86_400 });
  near(fairValue(mk("close_below"), okInputs)!.p, closeBelow(100, 110, 0.8, T), 1e-15);
  near(fairValue(mk("touch_above"), okInputs)!.p, touchAbove(100, 110, 0.8, T), 1e-15);
  near(fairValue(mk("touch_below"), okInputs)!.p, touchBelow(100, 110, 0.8, T), 1e-15);
});

test("fairValue: null when sigma is null", () => {
  assert.equal(fairValue(closeC, { ...okInputs, sigma: null }), null);
});

test("fairValue: each low-confidence trigger", () => {
  assert.equal(fairValue(closeC, { ...okInputs, nCandles: 47 })!.confidence, "low");
  assert.equal(fairValue(closeC, { ...okInputs, nCandles: 48 })!.confidence, "high");
  assert.equal(fairValue(closeC, { ...okInputs, spotAsOfSec: NOW - 121 })!.confidence, "low");
  assert.equal(fairValue(closeC, { ...okInputs, spotAsOfSec: NOW - 120 })!.confidence, "high");
  const soon: Contract = { ...closeC, expiry: NOW + 3599 }; // under one hour
  assert.equal(fairValue(soon, okInputs)!.confidence, "low");
  const hour: Contract = { ...closeC, expiry: NOW + 3601 };
  assert.equal(fairValue(hour, okInputs)!.confidence, "high");
});

test("fairValue: expired contract resolves deterministically and is low confidence", () => {
  const past: Contract = { ...closeC, expiry: NOW - 5 };
  const f = fairValue(past, { ...okInputs, spot: 120 })!;
  assert.equal(f.p, 1);
  assert.equal(f.confidence, "low");
});

test("fairValue: mcap contract converts market cap to a per-token strike", () => {
  const c: Contract = { kind: "mcap_touch_above", asset: "X", mcap: 1e9, expiry: NOW + 30 * 86_400 };
  const f = fairValue(c, { ...okInputs, spot: 0.5, supply: 4e9 })!;
  assert.equal(f.inputs.K, 0.25); // 1e9 / 4e9, already below spot
  assert.equal(f.p, 1);
  const g = fairValue(c, { ...okInputs, spot: 0.5, supply: 1e9 })!;
  assert.equal(g.inputs.K, 1);
  near(g.p, touchAbove(0.5, 1, 0.8, g.inputs.T), 1e-15);
  assert.ok(g.p > 0 && g.p < 1);
  assert.equal(fairValue(c, { ...okInputs, supply: null }), null);
  assert.equal(fairValue(c, { ...okInputs }), null);
  assert.equal(fairValue(c, { ...okInputs, supply: 0 }), null);
  assert.equal(fairValue(c, { ...okInputs, supply: -5 }), null);
});

test("fairValue: p is clamped to [0, 1]", () => {
  for (const spot of [1, 100, 10_000]) {
    const f = fairValue(closeC, { ...okInputs, spot })!;
    assert.ok(f.p >= 0 && f.p <= 1);
  }
});
