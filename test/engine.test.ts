import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Engine } from "../src/engine.ts";
import type { PantaLike, SolamiLike } from "../src/engine.ts";
import { createAppServer } from "../src/server.ts";
import { runLiveCheck } from "../src/live-check.ts";
import { staticMint } from "../src/assets/resolve.ts";
import { fairValue, realizedVol } from "../src/model/fair.ts";

const NOW_SEC = Date.UTC(2026, 8, 29, 12, 0, 0) / 1000;
const ID = (n: number) => `${n}`.repeat(44).slice(0, 44).replace(/0/g, "1");
const ETH_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const ANSEM_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

function walk(n: number, start: number): number[] {
  let x = start;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x *= 1 + 0.01 * Math.sin(i * 1.3) + 0.004 * Math.cos(i * 0.37);
    out.push(x);
  }
  return out;
}

const ETH_TITLE = "Will Ethereum (ETH) close at or above $2,700.00 on Wednesday, September 30, 2026, at 11:59 PM BST?";
const SOL_TITLE = "Will Solana (SOL) hit $300 by December 31, 2026?";
const MCAP_TITLE = "Will $ANSEM reach a $1B market cap by December 31, 2026?";
const NOMINT_TITLE = "Will Zcash (ZEC) hit $900 by December 31, 2026?";
const PAST_TITLE = "Will bitcoin hit $10 by 1 Jan 2026";

function fakes(over: { ethAsOf?: number } = {}) {
  const calls = { detail: [] as string[], search: [] as string[], price: [] as string[] };
  const items = {
    primary: [
      { id: ID(2), title: ETH_TITLE, yesPrice: "600000000" },
      { id: ID(3), title: SOL_TITLE }, // no price in the list: must come from the detail call
      { id: ID(4), title: MCAP_TITLE, yesPrice: 0.25 },
      { id: ID(5), title: "Will a female housemate win Big Brother Naija Season 11?", yesPrice: 0.5 },
    ],
    secondary: [
      { id: ID(6), title: NOMINT_TITLE, yesPrice: 0.1 },
      { id: ID(7), title: PAST_TITLE, yesPrice: 0.9 },
      { id: ID(2), title: ETH_TITLE, yesPrice: "600000000" }, // duplicate across phases
    ],
  };
  const panta: PantaLike = {
    listMarkets: async ({ status }) => (items as any)[status as string],
    getMarket: async (id) => {
      calls.detail.push(id);
      return id === ID(3) ? { id, yes_price: "0.35" } : { id };
    },
  };
  const closes = walk(168, 2500);
  const solami: SolamiLike = {
    search: async (q) => {
      calls.search.push(q);
      if (q === "ETH") return { data: [{ symbol: "ETH", address: ETH_MINT, liquidity: 1e6 }] };
      if (q === "ANSEM") return { data: [{ symbol: "ANSEM", address: ANSEM_MINT, liquidity: 1e5 }] };
      return { data: [] };
    },
    price: async (mint) => {
      calls.price.push(mint);
      if (mint === ETH_MINT) return { priceUsd: 2600, asOfSec: over.ethAsOf ?? NOW_SEC - 5 };
      if (mint === ANSEM_MINT) return { priceUsd: 0.6, asOfSec: NOW_SEC - 5 };
      return { priceUsd: 200, asOfSec: NOW_SEC - 5 };
    },
    ohlcv: async () => closes,
    supply: async () => ({ supply: 1_000_000_000, kind: "circulating" as const }),
  };
  return { panta, solami, calls, closes };
}

async function build(over: { ethAsOf?: number } = {}) {
  const f = fakes(over);
  const engine = new Engine({ panta: f.panta, solami: f.solami, now: () => NOW_SEC * 1000 });
  await engine.loadMarkets();
  await engine.runOnce();
  return { engine, ...f };
}

test("engine: builds rows with fair value, edge, url, and a reason for every row without one", async () => {
  const { engine, closes } = await build();
  const rows = engine.computeRows(NOW_SEC);
  const byTitle = (t: string) => rows.find((r) => r.title === t)!;

  assert.equal(rows.length, 6, "duplicate market across phases is deduped");

  const eth = byTitle(ETH_TITLE);
  assert.equal(eth.marketId, ID(2));
  assert.equal(eth.url, `https://www.panta.market/market/${ID(2)}`);
  assert.equal(eth.yes, 0.6);
  assert.equal(eth.spot, 2600);
  assert.equal(eth.mint, ETH_MINT);
  assert.equal(eth.mintSource, "solami-search");
  const sigma = realizedVol(closes, 3600)!;
  assert.equal(eth.sigma, sigma);
  const expected = fairValue({ kind: "close_above", asset: "ETH", strike: 2700, expiry: Date.UTC(2026, 8, 30, 22, 59) / 1000 }, {
    spot: 2600, spotAsOfSec: NOW_SEC - 5, sigma, nCandles: 168, nowSec: NOW_SEC,
  })!;
  assert.equal(eth.fair, expected.p);
  assert.equal(eth.edge, expected.p - 0.6);
  assert.equal(eth.confidence, "high");
  assert.equal(eth.stale, false);
  assert.equal(eth.reason, undefined);
  assert.ok(eth.notes.some((n) => n.includes("symbol search")));

  const sol = byTitle(SOL_TITLE);
  assert.equal(sol.mint, staticMint("SOL"));
  assert.equal(sol.yes, 0.35, "yes price came from the detail endpoint");
  assert.ok(sol.fair !== null && sol.fair > 0 && sol.fair <= 1);

  const mcap = byTitle(MCAP_TITLE);
  assert.equal(mcap.K, 1, "1e9 market cap / 1e9 supply");
  assert.ok(mcap.fair !== null && mcap.fair > 0 && mcap.fair < 1);
  assert.equal(mcap.confidence, "high");

  assert.equal(byTitle("Will a female housemate win Big Brother Naija Season 11?").reason, "unparsed");
  assert.equal(byTitle(NOMINT_TITLE).reason, "no mint");
  assert.equal(byTitle(NOMINT_TITLE).fair, null);
  assert.equal(byTitle(PAST_TITLE).reason, "expired");

  for (const r of rows) assert.ok(r.fair !== null || typeof r.reason === "string", r.title);
  // Rows with fair values sort first.
  assert.ok(rows.slice(0, 3).every((r) => r.fair !== null));
});

test("engine: fetches detail only for parseable markets", async () => {
  const { calls } = await build();
  assert.ok(!calls.detail.includes(ID(5)), "unparsed market gets no detail call");
  assert.ok(calls.detail.includes(ID(2)) && calls.detail.includes(ID(3)) && calls.detail.includes(ID(4)));
});

test("engine: stale spot is labelled stale and confidence low, never presented as live", async () => {
  const { engine } = await build({ ethAsOf: NOW_SEC - 600 });
  const eth = engine.computeRows(NOW_SEC).find((r) => r.title === ETH_TITLE)!;
  assert.equal(eth.stale, true);
  assert.equal(eth.confidence, "low");
  assert.ok(eth.staleReasons.some((s) => s.includes("spot")));
  // Panta price ages out too.
  const { engine: e2 } = await build();
  const later = e2.computeRows(NOW_SEC + 500).find((r) => r.title === ETH_TITLE)!;
  assert.equal(later.stale, true);
  assert.equal(later.confidence, "low");
});

test("engine: a failed Panta list keeps the old rows and reports the error", async () => {
  const f = fakes();
  let fail = false;
  const panta: PantaLike = {
    listMarkets: async (o) => { if (fail) throw new Error("Panta API 500 on GET /markets/: BOOM"); return f.panta.listMarkets(o); },
    getMarket: f.panta.getMarket,
  };
  const engine = new Engine({ panta, solami: f.solami, now: () => NOW_SEC * 1000 });
  await engine.loadMarkets();
  await engine.runOnce();
  const before = engine.computeRows(NOW_SEC).length;
  fail = true;
  await assert.rejects(() => engine.loadMarkets(), /BOOM/);
  assert.equal(engine.computeRows(NOW_SEC).length, before);
  assert.match(engine.status().error ?? "", /BOOM/);
});

test("engine: flat candles are 'no sigma', never a deterministic 0 or 1", async () => {
  const f = fakes();
  f.solami.ohlcv = async () => new Array(168).fill(2500);
  const engine = new Engine({ panta: f.panta, solami: f.solami, now: () => NOW_SEC * 1000 });
  await engine.loadMarkets();
  await engine.runOnce();
  const eth = engine.computeRows(NOW_SEC).find((r) => r.title === ETH_TITLE)!;
  assert.equal(eth.fair, null);
  assert.match(eth.reason ?? "", /no sigma/);
});

test("engine: mcap without supply is 'no supply'", async () => {
  const f = fakes();
  f.solami.supply = async () => null;
  const engine = new Engine({ panta: f.panta, solami: f.solami, now: () => NOW_SEC * 1000 });
  await engine.loadMarkets();
  await engine.runOnce();
  assert.equal(engine.computeRows(NOW_SEC).find((r) => r.title === MCAP_TITLE)!.reason, "no supply");
});

test("server: page, API, SSE and read-only method handling", async () => {
  const { engine } = await build();
  engine.computeRows(NOW_SEC);
  const server = createAppServer(engine);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.ok(page.headers.get("content-security-policy"));
    const html = await page.text();
    assert.ok(html.includes("Read-only analytics. Not financial advice."));
    assert.ok(html.includes("Powered by Panta"));
    assert.ok(html.includes("Data: Solami"));

    const rows = (await (await fetch(`${base}/api/rows`)).json()) as any[];
    assert.ok(Array.isArray(rows));
    assert.ok(rows.every((r) => r.reason !== "unparsed"), "unsupported markets are hidden by default");
    assert.equal(rows.length, 5);
    const all = (await (await fetch(`${base}/api/rows?all=1`)).json()) as any[];
    assert.equal(all.length, 6);

    const status = (await (await fetch(`${base}/api/status`)).json()) as any;
    assert.equal(status.markets, 6);
    assert.equal(status.supported, 5);

    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/rows`, { method: "POST" })).status, 405);

    const ac = new AbortController();
    const sse = await fetch(`${base}/events`, { signal: ac.signal });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.ok(first.includes("event: rows"));
    ac.abort();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("live-check: prints counts and rows, exits 0, never prints keys", async () => {
  const f = fakes();
  const lines: string[] = [];
  const code = await runLiveCheck({ PANTA_API_KEY: "PKEY-SECRET", SOLAMI_API_KEY: "SKEY-SECRET" }, { panta: f.panta, solami: f.solami, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /total markets: 6/);
  assert.match(out, /close_above: 1/);
  assert.match(out, /touch_above: 3/);
  assert.match(out, /mcap_touch_above: 1/);
  assert.match(out, /unsupported: 1/);
  assert.match(out, /fair-value rows:/);
  assert.ok(!out.includes("PKEY-SECRET") && !out.includes("SKEY-SECRET"));
});

test("live-check: exits 1 when the Panta list fails, with the key redacted from the message", async () => {
  const lines: string[] = [];
  const panta: PantaLike = { listMarkets: async () => { throw new Error("upstream said PKEY-SECRET is invalid"); }, getMarket: async () => ({}) };
  const code = await runLiveCheck({ PANTA_API_KEY: "PKEY-SECRET" }, { panta, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(!lines.join("\n").includes("PKEY-SECRET"));
});

test("live-check: exits 1 without PANTA_API_KEY; skips fair values without SOLAMI_API_KEY", async () => {
  assert.equal(await runLiveCheck({}, { log: () => {} }), 1);
  const f = fakes();
  const lines: string[] = [];
  assert.equal(await runLiveCheck({ PANTA_API_KEY: "K1234" }, { panta: f.panta, log: (l) => lines.push(l) }), 0);
  assert.ok(lines.some((l) => l.includes("skipping fair-value")));
});
