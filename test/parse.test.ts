import test from "node:test";
import assert from "node:assert/strict";
import { parseMarket } from "../src/parse/market.ts";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

test("parser: spec example 1, ETH close_above with BST", () => {
  assert.deepStrictEqual(
    parseMarket({ title: "Will Ethereum (ETH) close at or above $2,700.00 on Wednesday, September 30, 2026, at 11:59 PM BST?" }),
    { kind: "close_above", asset: "ETH", strike: 2700, expiry: Date.UTC(2026, 8, 30, 22, 59) / 1000 },
  );
});

test("parser: spec example 2, ZEC close_above", () => {
  assert.deepStrictEqual(
    parseMarket({ title: "Will Zcash (ZEC) close at or above $1,550.00 on Wednesday, September 23, 2026, at 11:59 PM BST?" }),
    { kind: "close_above", asset: "ZEC", strike: 1550, expiry: utc(2026, 9, 23, 22, 59) },
  );
});

test("parser: spec example 3, $ANSEM market cap touch", () => {
  assert.deepStrictEqual(parseMarket({ title: "Will $ANSEM reach a $1B market cap by December 31, 2026?" }), {
    kind: "mcap_touch_above", asset: "ANSEM", mcap: 1e9, expiry: utc(2026, 12, 31, 23, 59, 59),
  });
});

test("parser: spec example 4, bitcoin alias with 'by D Mon YYYY'", () => {
  assert.deepStrictEqual(parseMarket({ title: "Will bitcoin hit $100,000 by 31 Dec 2026" }), {
    kind: "touch_above", asset: "BTC", strike: 100000, expiry: utc(2026, 12, 31, 23, 59, 59),
  });
});

test("parser: spec example 5, comparing two assets is null", () => {
  assert.equal(
    parseMarket({ title: "Will Hyperliquid ($HYPE) surpass Solana ($SOL) in circulating market capitalization at any point before January 1, 2027?" }),
    null,
  );
});

test("parser: spec example 6, non-price market is null", () => {
  assert.equal(parseMarket({ title: "Will a female housemate win Big Brother Naija Season 11?" }), null);
});

test("parser: bare HYPE and ZEC aliases (orchestrator correction)", () => {
  assert.deepStrictEqual(parseMarket({ title: "Will HYPE reach $100 by December 31, 2026?" }), {
    kind: "touch_above", asset: "HYPE", strike: 100, expiry: utc(2026, 12, 31, 23, 59, 59),
  });
  assert.equal(parseMarket({ title: "Will zec hit $500 by Dec 31, 2026" })?.asset, "ZEC");
  assert.equal(parseMarket({ title: "Will hyperliquid hit $80 by Dec 31, 2026" })?.asset, "HYPE");
});

test("parser: falls back to question when title is blank", () => {
  const c = parseMarket({ title: "   ", question: "Will Solana hit $300 by 1 Jan 2027" });
  assert.equal(c?.kind, "touch_above");
  assert.equal(c?.asset, "SOL");
  assert.equal(parseMarket({ title: null, question: null }), null);
  assert.equal(parseMarket({}), null);
});

test("parser: money formats", () => {
  const strike = (t: string) => {
    const c = parseMarket({ title: t });
    return c && c.kind !== "mcap_touch_above" ? c.strike : c === null ? null : "mcap";
  };
  assert.equal(strike("Will BTC hit $58k by Dec 31, 2026"), 58000);
  assert.equal(strike("Will BTC drop below 58k by Dec 31, 2026"), 58000);
  assert.equal(strike("Will BTC hit $1,250.50 by Dec 31, 2026"), 1250.5);
  const mc = (t: string) => {
    const c = parseMarket({ title: t });
    return c && c.kind === "mcap_touch_above" ? c.mcap : null;
  };
  assert.equal(mc("Will $FOO reach a $1 billion market cap by Dec 31, 2026?"), 1e9);
  assert.equal(mc("Will $FOO reach a $1bn market cap by Dec 31, 2026?"), 1e9);
  assert.equal(mc("Will $FOO reach a $60 billion market cap by Dec 31, 2026?"), 6e10);
  assert.equal(mc("Will $FOO reach a $250m market cap by Dec 31, 2026?"), 2.5e8);
  assert.equal(mc("Will $FOO reach a $250 million market cap by Dec 31, 2026?"), 2.5e8);
  assert.equal(mc("Will $FOO reach a $1.5mn market cap by Dec 31, 2026?"), 1.5e6);
});

test("parser: kinds", () => {
  const k = (t: string) => parseMarket({ title: t })?.kind ?? null;
  const tail = "on Wednesday, September 30, 2026, at 11:59 PM UTC";
  assert.equal(k(`Will ETH (ETH) close above $2,000 ${tail}?`), "close_above");
  assert.equal(k(`Will ETH (ETH) settle at or above $2,000 ${tail}?`), "close_above");
  assert.equal(k(`Will ETH (ETH) close at or below $2,000 ${tail}?`), "close_below");
  assert.equal(k(`Will ETH (ETH) close below $2,000 ${tail}?`), "close_below");
  assert.equal(k(`Will ETH (ETH) settle below $2,000 ${tail}?`), "close_below");
  assert.equal(k("Will ETH reach $5,000 by Dec 31, 2026?"), "touch_above");
  assert.equal(k("Will ETH exceed $5,000 by Dec 31, 2026?"), "touch_above");
  assert.equal(k("Will ETH break above $5,000 by Dec 31, 2026?"), "touch_above");
  assert.equal(k("Will ETH drop below $1,000 by Dec 31, 2026?"), "touch_below");
  assert.equal(k("Will ETH fall below $1,000 by Dec 31, 2026?"), "touch_below");
  assert.equal(k("Will ETH dip below $1,000 by Dec 31, 2026?"), "touch_below");
  assert.equal(k("Will ETH be worth $5,000 by Dec 31, 2026?"), null);
});

test("parser: dates and time zones", () => {
  const e = (t: string) => parseMarket({ title: t })?.expiry ?? null;
  assert.equal(e("Will BTC hit $1,000 in 2027?"), utc(2027, 12, 31, 23, 59, 59));
  assert.equal(e("Will BTC hit $1,000 before January 1, 2027?"), utc(2027, 1, 1, 0, 0, 0));
  assert.equal(e("Will BTC hit $1,000 by Sept 5, 2026?"), utc(2026, 9, 5, 23, 59, 59));
  assert.equal(e("Will BTC hit $1,000 by 5th of September 2026?"), utc(2026, 9, 5, 23, 59, 59));
  const close = (tail: string) => e(`Will SOL (SOL) close above $100 ${tail}`);
  assert.equal(close("on Friday, July 3, 2026, at 4:00 PM ET?"), utc(2026, 7, 3, 20, 0)); // EDT, UTC-4
  assert.equal(close("on Monday, January 4, 2027, at 4:00 PM ET?"), utc(2027, 1, 4, 21, 0)); // EST, UTC-5
  assert.equal(close("on Friday, July 3, 2026, at 9:00 AM PT?"), utc(2026, 7, 3, 16, 0)); // PDT, UTC-7
  assert.equal(close("on Monday, January 4, 2027, at 9:00 AM PT?"), utc(2027, 1, 4, 17, 0)); // PST, UTC-8
  assert.equal(close("on Friday, July 3, 2026, at 10:00 AM CT?"), utc(2026, 7, 3, 15, 0)); // CDT, UTC-5
  assert.equal(close("on Friday, July 3, 2026, at 12:00 AM GMT?"), utc(2026, 7, 3, 0, 0));
  assert.equal(close("on Friday, July 3, 2026, at 12:00 PM UTC?"), utc(2026, 7, 3, 12, 0));
  assert.equal(close("on Fri, Jul 3, 2026, at 11:30 PM BST?"), utc(2026, 7, 3, 22, 30));
  // Unknown time zone.
  assert.equal(close("on Friday, July 3, 2026, at 4:00 PM XYZ?"), null);
  assert.equal(close("on Friday, July 3, 2026, at 4:00 PM EST?"), null);
});

test("parser: refuses anything uncertain", () => {
  const n = (t: string) => parseMarket({ title: t });
  // relative time
  assert.equal(n("Will BTC hit $100,000 within the next 24 hours?"), null);
  assert.equal(n("Will BTC hit $100,000 in the next 1hr?"), null);
  assert.equal(n("Will BTC hit $100,000 next 1hr?"), null);
  // no date
  assert.equal(n("Will BTC hit $100,000?"), null);
  // weekday contradicts date (Sep 30, 2026 is a Wednesday)
  assert.equal(n("Will ETH (ETH) close above $2,000 on Thursday, September 30, 2026, at 11:59 PM UTC?"), null);
  // impossible calendar date
  assert.equal(n("Will BTC hit $100,000 by February 30, 2026"), null);
  // a close with only a date and no settlement time is ambiguous
  assert.equal(n("Will ETH close above $2,000 by December 31, 2026?"), null);
  // several different amounts
  assert.equal(n("Will ETH hit $5,000 or $6,000 by December 31, 2026?"), null);
  // negation
  assert.equal(n("Will ETH fail to reach $5,000 by December 31, 2026?"), null);
  // market cap is never mistaken for a price
  assert.equal(n("Will $FOO hit a $1B market cap by December 31, 2026?"), null);
  assert.equal(n("Will $FOO drop below a $1B market cap by December 31, 2026?"), null);
  // two assets
  assert.equal(n("Will Ethereum (ETH) surpass Bitcoin (BTC) by December 31, 2026?"), null);
  assert.equal(n("Will Ethereum surpass Bitcoin in market cap by December 31, 2026?"), null);
  // mixed verbs
  assert.equal(n("Will ETH hit $5,000 and close above $4,000 by December 31, 2026?"), null);
  // a time-zone abbreviation in parentheses is not an asset
  assert.equal(n("Will the price hit $5,000 by December 31, 2026 (UTC)?"), null);
  // no asset
  assert.equal(n("Will the S&P hit $5,000 by December 31, 2026?"), null);
});
