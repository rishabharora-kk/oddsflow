import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import type { PantaLike, SolamiLike } from "../src/engine.ts";
import { categoryRank, extractResolved, extractYesPrice } from "../src/panta/extract.ts";
import { runLiveCheck } from "../src/live-check.ts";
import { fairValue, realizedVol } from "../src/model/fair.ts";

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const ETH_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";

const ETH_TITLE = "Will Ethereum (ETH) close at or above $2,700.00 on Wednesday, September 30, 2026, at 11:59 PM BST?";
const BRK_TITLE = "Will Berkshire Hathaway (BRK.B) close at or above $510.00 on Wednesday, September 30, 2026, at 4:00 PM ET?";
const SOL_TITLE = "Will Solana (SOL) hit $300 by December 31, 2026?";
const RAIN_TITLE = "Will a female housemate win Big Brother Naija Season 11?";

// List rows as the live API returns them: no title (and no question), a stale-looking list price.
const listRow = (marketId: string, category: string, extra: Record<string, unknown> = {}) => ({
  marketId, category, title: "", description: "", phase: "primary", resolved: false, yesPrice: "0.9", ...extra,
});

function walk(n: number, start: number): number[] {
  let x = start;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x *= 1 + 0.01 * Math.sin(i * 1.3) + 0.004 * Math.cos(i * 0.37);
    out.push(x);
  }
  return out;
}

type Details = Record<string, any>;

function setup(details: Details, rows: any[]) {
  let t = T0;
  const detailCalls: string[] = [];
  const panta: PantaLike = {
    listMarkets: async ({ status }) => (status === "primary" ? rows : []),
    getMarket: async (id) => {
      detailCalls.push(id);
      const d = details[id];
      if (d instanceof Error) throw d;
      return typeof d === "function" ? d() : d;
    },
  };
  const closes = walk(168, 2500);
  const solami: SolamiLike = {
    search: async (q) => (q === "ETH" ? { data: [{ symbol: "ETH", address: ETH_MINT, liquidity: 1e6 }] } : { data: [] }),
    price: async (mint) => ({ priceUsd: mint === ETH_MINT ? 2600 : 200, asOfSec: Math.floor(t / 1000) - 5 }),
    ohlcv: async () => closes,
    supply: async () => ({ supply: 1e9, kind: "circulating" as const }),
  };
  const engine = new Engine({ panta, solami, now: () => t });
  const count = (id: string) => detailCalls.filter((x) => x === id).length;
  return {
    engine, detailCalls, count, closes,
    advance: (ms: number) => { t += ms; },
    nowSec: () => Math.floor(t / 1000),
    cycle: async () => { await engine.loadMarkets(); await engine.runOnce(); },
  };
}

const DETAILS: Details = {
  eth: { marketId: "eth", title: ETH_TITLE, question: ETH_TITLE, yesPrice: "0.516484551", lastYesPrice: "0.3", resolved: false, isResolved: false, programId: "ProgA" },
  brk: { marketId: "brk", title: BRK_TITLE, yesPrice: "0.5", programId: "ProgB" },
  sol: { marketId: "sol", title: SOL_TITLE, yesPrice: "1", resolved: true, isResolved: true, programId: "ProgA" },
  rain: { marketId: "rain", title: RAIN_TITLE, yesPrice: "0", programId: "ProgB" },
  stripped: { marketId: "stripped", title: "", yesPrice: null },
};
const ROWS = () => [
  listRow("rain", "entertainment"),
  listRow("stripped", "crypto"),
  listRow("brk", "stocks"),
  listRow("sol", "crypto"),
  listRow("eth", "crypto"),
];

test("empty list titles: the detail supplies the title, so the market parses and gets a fair value", async () => {
  const s = setup(structuredClone(DETAILS), ROWS());
  await s.cycle();
  const rows = s.engine.computeRows(s.nowSec());
  const eth = rows.find((r) => r.marketId === "eth")!;
  assert.equal(eth.title, ETH_TITLE);
  assert.equal(eth.kind, "close_above");
  assert.equal(eth.strike, 2700);
  assert.equal(eth.expiry, 1790809140);
  const sigma = realizedVol(s.closes, 3600)!;
  const want = fairValue({ kind: "close_above", asset: "ETH", strike: 2700, expiry: 1790809140 }, {
    spot: 2600, spotAsOfSec: s.nowSec() - 5, sigma, nCandles: 168, nowSec: s.nowSec(),
  })!;
  assert.equal(eth.fair, want.p);
  assert.equal(eth.yes, 0.516484551, "the detail price replaces the list price");
  assert.equal(eth.edge, want.p - 0.516484551);
  assert.equal(eth.reason, undefined);
  assert.equal(eth.mint, ETH_MINT);

  const brk = rows.find((r) => r.marketId === "brk")!;
  assert.equal(brk.kind, "close_above");
  assert.equal(brk.asset, "BRK.B");
  assert.equal(brk.strike, 510);
  assert.equal(brk.reason, "no mint");

  assert.equal(rows.find((r) => r.marketId === "rain")!.reason, "unparsed");
  assert.equal(rows.find((r) => r.marketId === "rain")!.title, RAIN_TITLE, "the text is kept even when unparsed");
});

test("text is fetched once per market; only parseable, unresolved markets get price refreshes", async () => {
  const s = setup(structuredClone(DETAILS), ROWS());
  await s.cycle();
  for (const id of ["eth", "brk", "sol", "rain", "stripped"]) assert.equal(s.count(id), 1, `${id} after cycle 1`);

  s.advance(30_000);
  await s.cycle();
  for (const id of ["eth", "brk", "sol", "rain", "stripped"]) assert.equal(s.count(id), 1, `${id}: nothing is due after 30 s`);

  s.advance(31_000); // 61 s since the first pass
  await s.cycle();
  assert.equal(s.count("eth"), 2, "parseable: price refresh");
  assert.equal(s.count("brk"), 2, "parseable: price refresh");
  assert.equal(s.count("rain"), 1, "unparseable: text is cached, no refresh");
  assert.equal(s.count("sol"), 1, "resolved: no refresh");
  assert.equal(s.count("stripped"), 1, "stripped: not retried inside 10 minutes");

  s.advance(61_000);
  await s.cycle();
  assert.equal(s.count("eth"), 3);
  assert.equal(s.count("rain"), 1);
});

test("text fetches go crypto, stocks, commodities, finance, then the rest", async () => {
  const details: Details = {};
  const rows: any[] = [];
  for (const [id, cat] of [["o1", "entertainment"], ["f1", "finance"], ["c1", "commodities"], ["s1", "stocks"], ["k1", "crypto"], ["o2", "sports"], ["k2", "Crypto"]]) {
    details[id] = { marketId: id, title: RAIN_TITLE };
    rows.push(listRow(id, cat));
  }
  const s = setup(details, rows);
  await s.engine.loadMarkets();
  await s.engine.fetchDetails();
  assert.deepEqual(s.detailCalls, ["k1", "k2", "s1", "c1", "f1", "o1", "o2"]);
  assert.deepEqual(["crypto", "Stocks", "commodities", "Finance", "sports", null].map(categoryRank), [0, 1, 2, 3, 4, 4]);
});

test("a stripped detail is 'unparsed' and retried at most once per 10 minutes", async () => {
  let calls = 0;
  const d: Details = { stripped: () => { calls++; return calls < 3 ? { marketId: "stripped", title: "", yesPrice: null } : { marketId: "stripped", title: SOL_TITLE, yesPrice: "0.4" }; } };
  const s = setup(d, [listRow("stripped", "crypto")]);
  await s.cycle();
  assert.equal(calls, 1);
  const row = () => s.engine.computeRows(s.nowSec())[0];
  assert.equal(row().reason, "unparsed");
  assert.equal(row().fair, null);
  for (const dt of [30_000, 120_000, 300_000, 100_000]) { // up to +550 s
    s.advance(dt);
    await s.cycle();
  }
  assert.equal(calls, 1, "no retry inside 10 minutes");
  s.advance(60_000); // +610 s
  await s.cycle();
  assert.equal(calls, 2, "retried once after 10 minutes");
  assert.equal(row().reason, "unparsed");
  s.advance(599_000);
  await s.cycle();
  assert.equal(calls, 2);
  s.advance(2_000);
  await s.cycle();
  assert.equal(calls, 3);
  assert.equal(row().title, SOL_TITLE, "a later, filled-in detail parses");
  assert.equal(row().kind, "touch_above");
});

test("a failed detail request is retried after a minute, not ten", async () => {
  let fail = true;
  const d: Details = { m: () => { if (fail) throw new Error("Panta API 500 on GET /markets/m/: BOOM"); return { marketId: "m", title: SOL_TITLE, yesPrice: "0.4" }; } };
  const s = setup(d, [listRow("m", "crypto")]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await s.cycle();
    assert.equal(s.count("m"), 1);
    fail = false;
    s.advance(30_000);
    await s.cycle();
    assert.equal(s.count("m"), 1);
    s.advance(31_000);
    await s.cycle();
  } finally {
    console.warn = warn;
  }
  assert.equal(s.count("m"), 2);
  assert.equal(s.engine.computeRows(s.nowSec())[0].kind, "touch_above");
});

test("resolved and expired markets get a reason and no fair value", async () => {
  const d: Details = structuredClone(DETAILS);
  d.past = { marketId: "past", title: "Will bitcoin hit $10 by 1 Jan 2026", yesPrice: "0.5" };
  d.done = { marketId: "done", title: SOL_TITLE, yesPrice: "1", isResolved: true };
  const s = setup(d, [listRow("past", "crypto"), listRow("done", "crypto"), listRow("sol", "crypto")]);
  await s.cycle();
  const rows = s.engine.computeRows(s.nowSec());
  assert.equal(rows.find((r) => r.marketId === "past")!.reason, "expired");
  assert.equal(rows.find((r) => r.marketId === "done")!.reason, "resolved");
  assert.equal(rows.find((r) => r.marketId === "sol")!.reason, "resolved");
  for (const r of rows) assert.equal(r.fair, null);
  assert.equal(extractResolved({ resolved: false, isResolved: true }), true);
  assert.equal(extractResolved({ resolved: false }), false);
  assert.equal(extractResolved({}), null);
});

test("lastYesPrice is the fallback when yesPrice is absent", async () => {
  assert.equal(extractYesPrice({ lastYesPrice: "0.42" }), 0.42);
  assert.equal(extractYesPrice({ yesPrice: null, lastYesPrice: "0.42" }), 0.42);
  assert.equal(extractYesPrice({ yesPrice: "", lastYesPrice: "0.42" }), 0.42);
  assert.equal(extractYesPrice({ yesPrice: "0.516484551", lastYesPrice: "0.3" }), 0.516484551);
  assert.equal(extractYesPrice({ yesPrice: "0", lastYesPrice: "0.3" }), 0);
  assert.equal(extractYesPrice({ yesPrice: "1" }), 1);

  const d: Details = { eth: { marketId: "eth", title: ETH_TITLE, lastYesPrice: "0.25" } }; // no yesPrice
  const s = setup(d, [listRow("eth", "crypto", { yesPrice: undefined })]);
  await s.cycle();
  assert.equal(s.engine.computeRows(s.nowSec())[0].yes, 0.25);
});

test("the detail price is not overwritten by later list prices", async () => {
  const s = setup(structuredClone(DETAILS), ROWS());
  await s.cycle();
  await s.engine.loadMarkets(); // list still says 0.9
  assert.equal(s.engine.computeRows(s.nowSec()).find((r) => r.marketId === "eth")!.yes, 0.516484551);
});

// ------------------------------------------------------------ live-check

function fakePanta(details: Details, rows: any[]) {
  const calls: string[] = [];
  const panta: PantaLike = {
    listMarkets: async ({ status }) => (status === "primary" ? rows : []),
    getMarket: async (id) => {
      calls.push(id);
      return details[id] ?? { marketId: id };
    },
  };
  return { panta, calls };
}

test("live-check: empty list titles are resolved through details, giving non-zero parsed counts", async () => {
  const { panta, calls } = fakePanta(structuredClone(DETAILS), ROWS());
  const lines: string[] = [];
  const code = await runLiveCheck({ PANTA_API_KEY: "K1234" }, { panta, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /total markets: 5/);
  assert.match(out, /close_above: 2/);
  assert.match(out, /touch_above: 1/);
  assert.match(out, /unsupported: 2/); // the non-price market and the stripped detail
  assert.ok(out.includes(ETH_TITLE));
  assert.ok(!out.includes("diag:"), "no diagnostics unless ODDSFLOW_DIAG=1");
  // Crypto first: eth/sol/stripped before brk before rain.
  assert.ok(calls.indexOf("brk") > calls.indexOf("eth") && calls.indexOf("brk") < calls.indexOf("rain"));
});

test("live-check: ODDSFLOW_DIAG=1 prints the distinct programIds seen in details", async () => {
  const { panta } = fakePanta(structuredClone(DETAILS), ROWS());
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "K1234", ODDSFLOW_DIAG: "1" }, { panta, log: (l) => lines.push(l) });
  assert.ok(lines.includes("diag: programIds seen: ProgA,ProgB"), lines.filter((l) => l.startsWith("diag: programIds")).join("|"));
  assert.ok(lines.some((l) => l.startsWith("diag: list row keys:")), "the existing diagnostics block is intact");
});

test("live-check: at most 60 detail requests for text", async () => {
  const rows: any[] = [];
  const details: Details = {};
  for (let i = 0; i < 75; i++) {
    rows.push(listRow(`m${i}`, "crypto"));
    details[`m${i}`] = { marketId: `m${i}`, title: SOL_TITLE };
  }
  const { panta, calls } = fakePanta(details, rows);
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "K1234" }, { panta, log: (l) => lines.push(l) });
  assert.equal(calls.length, 60);
  assert.match(lines.join("\n"), /touch_above: 60/);
  assert.match(lines.join("\n"), /unsupported: 15/);
});

test("live-check: fair values for detail-parsed markets (Solami faked)", async () => {
  const { panta } = fakePanta(structuredClone(DETAILS), ROWS());
  const closes = walk(168, 2500);
  const solami: SolamiLike = {
    search: async () => ({ data: [{ symbol: "ETH", address: ETH_MINT, liquidity: 1 }] }),
    price: async () => ({ priceUsd: 2600, asOfSec: Math.floor(Date.now() / 1000) }),
    ohlcv: async () => closes,
    supply: async () => ({ supply: 1e9, kind: "circulating" as const }),
  };
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "K1234", SOLAMI_API_KEY: "S1234" }, { panta, solami, log: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.match(out, /fair-value rows:/);
  assert.ok(out.includes(`"title":${JSON.stringify(ETH_TITLE)}`));
  assert.ok(!out.includes("K1234") && !out.includes("S1234"));
});
