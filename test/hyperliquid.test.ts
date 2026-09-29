import test from "node:test";
import assert from "node:assert/strict";
import { ForbiddenHlRequestError, HyperliquidClient, assertHlAllowed } from "../src/feed/hyperliquid.ts";
import { venueFor } from "../src/assets/venue.ts";
import { Engine } from "../src/engine.ts";
import type { HlLike, PantaLike, SolamiLike } from "../src/engine.ts";
import { closeAbove, realizedVol } from "../src/model/fair.ts";
import { runLiveCheck } from "../src/live-check.ts";
import { staticMint } from "../src/assets/resolve.ts";

const jsonRes = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
};

// ------------------------------------------------------------ (a) read-only allowlist

test("assertHlAllowed: only allMids, meta and candleSnapshot on /info", () => {
  for (const type of ["allMids", "meta", "candleSnapshot"]) assert.doesNotThrow(() => assertHlAllowed("/info", { type }), type);
  assert.doesNotThrow(() => assertHlAllowed("/info", { type: "candleSnapshot", req: { coin: "BTC" } }));
});

test("assertHlAllowed: rejects /exchange, other types, missing type and other paths", () => {
  assert.throws(() => assertHlAllowed("/exchange", { type: "allMids" }), ForbiddenHlRequestError);
  assert.throws(() => assertHlAllowed("/exchange", { action: { type: "order" } }), ForbiddenHlRequestError);
  for (const type of ["order", "cancel", "withdraw3", "usdSend", "metaAndAssetCtxs", "clearinghouseState", "ALLMIDS", ""]) {
    assert.throws(() => assertHlAllowed("/info", { type }), ForbiddenHlRequestError, type);
  }
  assert.throws(() => assertHlAllowed("/info", {}), ForbiddenHlRequestError);
  assert.throws(() => assertHlAllowed("/info", null), ForbiddenHlRequestError);
  assert.throws(() => assertHlAllowed("/info", undefined), ForbiddenHlRequestError);
  assert.throws(() => assertHlAllowed("/info", [{ type: "allMids" }]), ForbiddenHlRequestError);
  assert.throws(() => assertHlAllowed("/info", { type: 5 }), ForbiddenHlRequestError);
  for (const p of ["/info/", "info", "/INFO", "/info?x=1", "/ws", "/", ""]) {
    assert.throws(() => assertHlAllowed(p, { type: "allMids" }), ForbiddenHlRequestError, p);
  }
});

test("HyperliquidClient never calls fetch for a rejected request", async () => {
  let calls = 0;
  const spy = (async () => { calls++; return jsonRes({}); }) as unknown as typeof fetch;
  const c = new HyperliquidClient({ fetchImpl: spy });
  await assert.rejects(() => c.post("/exchange", { type: "allMids" }), ForbiddenHlRequestError);
  await assert.rejects(() => c.post("/info", { type: "order" }), ForbiddenHlRequestError);
  await assert.rejects(() => c.post("/info", { type: "withdraw3" }), ForbiddenHlRequestError);
  await assert.rejects(() => c.post("/info", {}), ForbiddenHlRequestError);
  assert.equal(calls, 0);
  await c.mids();
  assert.equal(calls, 1);
});

// ------------------------------------------------------------ (b) client parsing

test("mids(): POSTs allMids, parses price strings, drops junk", async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => {
    seen.push({ url, init });
    return jsonRes({ BTC: "83012.5", ETH: "2651.3", SOL: 150, BAD: "abc", NUL: null, EMP: "", INF: "Infinity", OBJ: {} });
  }) as unknown as typeof fetch;
  const mids = await new HyperliquidClient({ fetchImpl: f }).mids();
  assert.deepEqual(mids, { BTC: 83012.5, ETH: 2651.3, SOL: 150 });
  assert.equal(seen[0].url, "https://api.hyperliquid.xyz/info");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), { type: "allMids" });
  assert.equal(seen[0].init.headers["Content-Type"], "application/json");
  assert.equal(Object.keys(seen[0].init.headers).some((h) => /key|auth/i.test(h)), false, "no auth");
});

test("mids(): an unexpected shape gives {} and a warning, never a throw", async () => {
  for (const body of [[1, 2], "nope", null, 5]) {
    const f = (async () => jsonRes(body)) as unknown as typeof fetch;
    assert.deepEqual(await quiet(() => new HyperliquidClient({ fetchImpl: f }).mids()), {});
  }
  const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await quiet(() => new HyperliquidClient({ fetchImpl: html }).mids()), {});
});

test("universe(): names from meta, skipping delisted and malformed entries", async () => {
  const f = (async (_u: string, init: any) => {
    assert.deepEqual(JSON.parse(init.body), { type: "meta" });
    return jsonRes({ universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH" }, { name: "OLD", isDelisted: true }, { nope: 1 }, null] });
  }) as unknown as typeof fetch;
  const u = await new HyperliquidClient({ fetchImpl: f }).universe();
  assert.deepEqual([...u].sort(), ["BTC", "ETH"]);
  const bad = (async () => jsonRes({ universe: "x" })) as unknown as typeof fetch;
  assert.equal((await quiet(() => new HyperliquidClient({ fetchImpl: bad }).universe())).size, 0);
});

test("closes(): request window from the injected clock; sorts by t; parses string c", async () => {
  const NOW = 1_800_000_000_000;
  let body: any;
  const candle = (t: number, c: string) => ({ t, T: t + 3_599_999, s: "ETH", i: "1h", o: "1", c, h: "9", l: "0.5", v: "10", n: 3 });
  const f = (async (_u: string, init: any) => {
    body = JSON.parse(init.body);
    return jsonRes([candle(NOW - 1 * 3_600_000, "2500.5"), candle(NOW - 3 * 3_600_000, "2400"), candle(NOW - 2 * 3_600_000, "2450.25")]);
  }) as unknown as typeof fetch;
  const c = new HyperliquidClient({ fetchImpl: f, now: () => NOW });
  const r = await c.closes("ETH", "1h", 168);
  assert.deepEqual(body, { type: "candleSnapshot", req: { coin: "ETH", interval: "1h", startTime: NOW - 168 * 3_600_000, endTime: NOW } });
  assert.deepEqual(r, { closes: [2400, 2450.25, 2500.5], lastT: NOW - 3_600_000 });
});

test("closes(): null for fewer than 3 usable candles or an unexpected shape", async () => {
  const mk = (b: unknown) => new HyperliquidClient({ fetchImpl: (async () => jsonRes(b)) as unknown as typeof fetch });
  const k = (t: number, c: unknown) => ({ t, c });
  assert.equal(await mk([k(1, "1"), k(2, "2")]).closes("X", "1h", 24), null);
  assert.equal(await mk([k(1, "1"), k(2, "2"), k(3, "abc"), k(4, null), k(5, "0")]).closes("X", "1h", 24), null);
  assert.equal(await mk([]).closes("X", "1h", 24), null);
  assert.equal(await quiet(() => mk({ error: "nope" }).closes("X", "1h", 24)), null);
  assert.deepEqual((await mk([k(3, "3"), k(1, "1"), k(2, "2")]).closes("X", "1h", 24))?.closes, [1, 2, 3]);
});

test("HyperliquidClient: 429 honours Retry-After; HTTP errors throw; 60/min bucket", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const f = (async () => {
    calls++;
    return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "3" } }) : jsonRes({ BTC: "1" });
  }) as unknown as typeof fetch;
  const c = new HyperliquidClient({ fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await c.mids(), { BTC: 1 });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 3000 && sleeps[0] < 4000);

  const boom = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => new HyperliquidClient({ fetchImpl: boom }).mids(), /500/);

  let t = 0;
  const waits: number[] = [];
  const c2 = new HyperliquidClient({ fetchImpl: (async () => jsonRes({})) as unknown as typeof fetch, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  for (let i = 0; i < 60; i++) await quiet(() => c2.mids());
  assert.equal(waits.length, 0);
  await quiet(() => c2.mids());
  assert.ok(waits.length >= 1 && t >= 59_999, "61st request waits for the window");
});

// ------------------------------------------------------------ (c) venue routing

test("venueFor", () => {
  const uni = new Set(["BTC", "ETH", "SOL", "HYPE", "ZEC"]);
  assert.equal(venueFor("SOL", uni), "solami", "SOL stays on Solami even though Hyperliquid lists it");
  assert.equal(venueFor("SOL", new Set()), "solami");
  assert.equal(venueFor("BTC", uni), "hyperliquid");
  assert.equal(venueFor("eth", uni), "hyperliquid");
  assert.equal(venueFor("HYPE", uni), "hyperliquid");
  assert.equal(venueFor("ZEC", uni), "hyperliquid");
  assert.equal(venueFor("ANSEM", uni), "solami");
  assert.equal(venueFor("BRK.B", uni), "solami");
  assert.equal(venueFor("BRENT", uni), "solami");
  assert.equal(venueFor("BTC", new Set()), "solami", "no universe: nothing is routed to Hyperliquid");
  assert.equal(venueFor("", uni), null);
});

// ------------------------------------------------------------ (d) engine

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const ETH_TITLE = "Will Ethereum (ETH) close at or above $2,700.00 on Wednesday, September 30, 2026, at 11:59 PM BST?";
const BTC_TITLE = "Will bitcoin hit $100,000 by 31 Dec 2026";
const SOL_TITLE = "Will Solana (SOL) hit $300 by December 31, 2026?";

function walk(n: number, start: number): number[] {
  let x = start;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x *= 1 + 0.01 * Math.sin(i * 1.3) + 0.004 * Math.cos(i * 0.37);
    out.push(x);
  }
  return out;
}

function engineFixture(rows: any[]) {
  let t = T0;
  const calls = { hlCloses: [] as string[], hlMids: 0, search: [] as string[] };
  const closes = walk(168, 2500);
  const hl: HlLike = {
    universe: async () => new Set(["BTC", "ETH", "SOL", "HYPE"]),
    mids: async () => { calls.hlMids++; return { ETH: 2600, BTC: 83_000, SOL: 200 }; },
    closes: async (coin) => { calls.hlCloses.push(coin); return { closes, lastT: t }; },
  };
  const solami: SolamiLike = {
    search: async (q) => { calls.search.push(q); return { data: [] }; },
    price: async () => ({ priceUsd: 202, asOfSec: Math.floor(t / 1000) - 3 }),
    ohlcv: async () => closes,
    supply: async () => null,
  };
  const panta: PantaLike = { listMarkets: async () => rows, getMarket: async () => ({}) };
  const engine = new Engine({ panta, solami, hyperliquid: hl, now: () => t });
  return { engine, calls, closes, nowSec: () => Math.floor(t / 1000), advance: (ms: number) => { t += ms; } };
}

const ROWS = () => [
  { marketId: "eth", title: ETH_TITLE, phase: "primary", yesPrice: "0.500046922", category: "crypto" },
  { marketId: "btc", title: BTC_TITLE, phase: "primary", yesPrice: "0.6", category: "crypto" },
  { marketId: "sol", title: SOL_TITLE, phase: "secondary", yesPrice: "0.5", category: "crypto" },
  { marketId: "sol2", title: SOL_TITLE, phase: "primary", yesPrice: "0.5", category: "crypto", resolved: true },
];

test("engine: an ETH row is priced from Hyperliquid and equals closeAbove(S,K,sigma,T) exactly", async () => {
  const f = engineFixture(ROWS());
  await f.engine.loadMarkets();
  await f.engine.runOnce();
  const rows = f.engine.computeRows(f.nowSec());
  const eth = rows.find((r) => r.marketId === "eth")!;
  const sigma = realizedVol(f.closes, 3600)!;
  const T = (1790809140 - f.nowSec()) / 31_536_000;
  assert.equal(eth.venue, "hyperliquid");
  assert.equal(eth.spot, 2600);
  assert.equal(eth.asOf, f.nowSec(), "spot as-of is the mids fetch time");
  assert.equal(eth.sigma, sigma);
  assert.equal(eth.nCandles, 168);
  assert.equal(eth.mint, null);
  assert.equal(eth.fair, closeAbove(2600, 2700, sigma, T));
  assert.equal(eth.edge, closeAbove(2600, 2700, sigma, T) - 0.500046922);
  assert.equal(eth.confidence, "high");
  assert.equal(eth.basisPct, null);
  assert.ok(eth.notes.some((n) => n.includes("Hyperliquid")));
  assert.equal(rows.find((r) => r.marketId === "btc")!.venue, "hyperliquid");
  assert.deepEqual(f.calls.search, [], "Solami is never searched for an asset priced on Hyperliquid");
  assert.deepEqual([...f.calls.hlCloses].sort(), ["BTC", "ETH"]);
});

test("engine: SOL is priced on Solami and gets an informational basis against the Hyperliquid mid", async () => {
  const f = engineFixture(ROWS());
  await f.engine.loadMarkets();
  await f.engine.runOnce();
  const sol = f.engine.computeRows(f.nowSec()).find((r) => r.marketId === "sol")!;
  assert.equal(sol.venue, "solami");
  assert.equal(sol.mint, staticMint("SOL"));
  assert.equal(sol.spot, 202);
  assert.ok(sol.fair !== null);
  assert.ok(Math.abs(sol.basisPct! - 1) < 1e-9, `basis ${sol.basisPct}`); // (202 / 200 - 1) * 100
  assert.equal(sol.edge, sol.fair! - 0.5, "edge stays fair - yes; basis does not change it");
});

test("engine: launchBlind is true for a primary market within 0.01 of 0.5, false otherwise", async () => {
  const f = engineFixture(ROWS());
  await f.engine.loadMarkets();
  await f.engine.runOnce();
  const rows = f.engine.computeRows(f.nowSec());
  const by = (id: string) => rows.find((r) => r.marketId === id)!;
  assert.equal(by("eth").launchBlind, true, "primary at 0.500046922");
  assert.equal(by("eth").phase, "primary");
  assert.equal(by("sol").launchBlind, false, "secondary at 0.5");
  assert.equal(by("sol").phase, "secondary");
  assert.equal(by("btc").launchBlind, false, "primary but at 0.6");
  assert.equal(f.engine.status().launchBlind, 2, "eth and sol2 (resolved rows still count as primary-phase at 0.5)");
  assert.equal(by("sol2").reason, "resolved");
});

test("engine: without a Hyperliquid client everything is priced on Solami", async () => {
  const f = engineFixture(ROWS());
  f.engine.hyperliquid = null;
  await f.engine.loadMarkets();
  await f.engine.runOnce();
  const eth = f.engine.computeRows(f.nowSec()).find((r) => r.marketId === "eth")!;
  assert.equal(eth.venue, "solami");
  assert.equal(eth.reason, "no mint");
});

test("engine: a failing Hyperliquid falls back to Solami routing and reports no spot rather than throwing", async () => {
  const f = engineFixture(ROWS());
  f.engine.hyperliquid = { universe: async () => { throw new Error("HL down"); }, mids: async () => ({}), closes: async () => null };
  await f.engine.loadMarkets();
  await quiet(() => f.engine.runOnce());
  const eth = f.engine.computeRows(f.nowSec()).find((r) => r.marketId === "eth")!;
  assert.equal(eth.fair, null);
  assert.ok(typeof eth.reason === "string");
});

test("engine: stale Hyperliquid mids make the row stale and low confidence", async () => {
  const f = engineFixture(ROWS());
  await f.engine.loadMarkets();
  await f.engine.runOnce();
  const later = f.engine.computeRows(f.nowSec() + 300).find((r) => r.marketId === "eth")!;
  assert.equal(later.stale, true);
  assert.equal(later.confidence, "low");
});

// ------------------------------------------------------------ (e) live-check

const FAR = "December 31, 2099";
const listRow = (marketId: string, extra: Record<string, unknown> = {}) => ({ marketId, category: "crypto", title: "", phase: "primary", resolved: false, yesPrice: "0.500046922", ...extra });
const DETAILS: Record<string, any> = {
  btc: { marketId: "btc", title: `Will bitcoin hit $100,000 by ${FAR}?`, yesPrice: "0.5", programId: "P1" },
  eth: { marketId: "eth", title: `Will Ethereum (ETH) hit $5,000 by ${FAR}?`, yesPrice: "0.5", programId: "P1" },
  sol: { marketId: "sol", title: `Will Solana (SOL) hit $300 by ${FAR}?`, yesPrice: "0.5" },
  old: { marketId: "old", title: "Will bitcoin hit $10 by 1 Jan 2026", yesPrice: "0.5" },
};

function liveFixture(closes: number[] = walk(168, 83_000)) {
  const panta: PantaLike = {
    listMarkets: async () => ["btc", "eth", "sol", "old"].map((id) => listRow(id)),
    getMarket: async (id) => DETAILS[id] ?? { marketId: id },
  };
  const hl: HlLike = {
    universe: async () => new Set(["BTC", "ETH", "SOL"]),
    mids: async () => ({ BTC: 83012.5, ETH: 2651.3, SOL: 150 }),
    closes: async (coin) => ({ closes: closes.map((c) => (coin === "ETH" ? c / 30 : c)), lastT: Date.now() }),
  };
  return { panta, hl };
}

test("live-check: prints 'fair:' lines from Hyperliquid with no Solami key", async () => {
  const { panta, hl } = liveFixture();
  const lines: string[] = [];
  const code = await runLiveCheck({ PANTA_API_KEY: "PK-1234" }, { panta, hyperliquid: hl, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  const fair = lines.filter((l) => l.startsWith("fair: "));
  assert.equal(fair.length, 2, "btc and eth; sol is a Solami-venue market and old is expired");
  const re = /^fair: (.+) \| venue=hyperliquid spot=([\d.]+) sigma=\d+\.\d{3} T=\d+\.\d{2}d \| panta_yes=0\.5000 fair=[01]\.\d{4} edge=[+-]\d\.\d{4} launchBlind=true$/;
  for (const l of fair) assert.match(l, re, l);
  assert.match(fair.find((l) => l.includes("bitcoin"))!, /spot=83012\.5 /);
  assert.match(fair.find((l) => l.includes("Ethereum"))!, /spot=2651\.3 /);
  assert.ok(lines.some((l) => l.includes("skipping fair-value")));
  assert.ok(lines.some((l) => l.startsWith("unexpired parsed: 3")), lines.filter((l) => l.startsWith("unexpired")).join("|"));
  assert.ok(!lines.join("\n").includes("PK-1234"));
});

test("live-check: DIAG prints the routing decisions", async () => {
  const { panta, hl } = liveFixture();
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "PK-1234", ODDSFLOW_DIAG: "1" }, { panta, hyperliquid: hl, log: (l) => lines.push(l) });
  assert.ok(lines.includes("diag: hl universe has 3 coins; routed: BTC=hyperliquid, ETH=hyperliquid, SOL=solami"), lines.filter((l) => l.includes("routed")).join("|"));
});

test("live-check: at most 5 Hyperliquid contracts", async () => {
  const rows: any[] = [];
  const details: Record<string, any> = {};
  for (let i = 0; i < 8; i++) {
    rows.push(listRow(`b${i}`));
    details[`b${i}`] = { marketId: `b${i}`, title: `Will bitcoin hit $${100_000 + i},000 by ${FAR}?`, yesPrice: "0.5" };
  }
  const { hl } = liveFixture();
  const panta: PantaLike = { listMarkets: async () => rows, getMarket: async (id) => details[id] };
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "PK-1234" }, { panta, hyperliquid: hl, log: (l) => lines.push(l) });
  assert.equal(lines.filter((l) => l.startsWith("fair: ")).length, 5);
});

test("live-check: a Hyperliquid failure is logged and does not fail the run", async () => {
  const { panta } = liveFixture();
  const hl: HlLike = { universe: async () => { throw new Error("HL down"); }, mids: async () => ({}), closes: async () => null };
  const lines: string[] = [];
  const code = await runLiveCheck({ PANTA_API_KEY: "PK-1234" }, { panta, hyperliquid: hl, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("Hyperliquid universe call failed")));
  assert.equal(lines.filter((l) => l.startsWith("fair: ")).length, 0);
});

test("live-check: Solami rows are still produced for Solami-venue markets when a Solami key is set", async () => {
  const { panta, hl } = liveFixture();
  const solami: SolamiLike = {
    search: async () => ({ data: [] }),
    price: async () => ({ priceUsd: 151, asOfSec: Math.floor(Date.now() / 1000) }),
    ohlcv: async () => walk(168, 150),
    supply: async () => null,
  };
  const lines: string[] = [];
  await runLiveCheck({ PANTA_API_KEY: "PK-1234", SOLAMI_API_KEY: "SK-1234" }, { panta, solami, hyperliquid: hl, log: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.equal(lines.filter((l) => l.startsWith("fair: ")).length, 2);
  assert.match(out, /fair-value rows:/);
  const solLine = lines.find((l) => l.startsWith("  {") && l.includes("Solana"))!;
  assert.ok(solLine, "SOL row printed in the Solami block");
  assert.ok(!out.includes("SK-1234") && !out.includes("PK-1234"));
});
