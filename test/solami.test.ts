import test from "node:test";
import assert from "node:assert/strict";
import {
  BlurStream, SolamiClient, backoffMs, extractCandles, extractCloses, extractPrice, extractSupply, median, toUnixSec,
} from "../src/feed/solami.ts";
import { pickMintFromSearch, resolveMint, staticMint } from "../src/assets/resolve.ts";

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const MINT_C = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

// ------------------------------------------------------------ price

test("extractPrice: several plausible shapes", () => {
  assert.deepEqual(extractPrice({ price_usd: 123.45 }), { priceUsd: 123.45, asOfSec: null });
  assert.deepEqual(extractPrice({ priceUsd: "123.45" }), { priceUsd: 123.45, asOfSec: null });
  assert.deepEqual(extractPrice({ price: 1.5 }), { priceUsd: 1.5, asOfSec: null });
  assert.deepEqual(extractPrice({ data: { price_usd: 2, block_time: 1_800_000_000 } }), { priceUsd: 2, asOfSec: 1_800_000_000 });
  assert.deepEqual(extractPrice({ data: { priceUsd: 2 }, timestamp: 1_800_000_000_000 }), { priceUsd: 2, asOfSec: 1_800_000_000 });
  assert.deepEqual(extractPrice({ result: { token: { price: { usd: 3.25 } }, updated_at: "2027-01-15T08:00:00Z" } }), {
    priceUsd: 3.25, asOfSec: Date.parse("2027-01-15T08:00:00Z") / 1000,
  });
  assert.deepEqual(extractPrice([{ price_usd: 7 }]), { priceUsd: 7, asOfSec: null });
  assert.deepEqual(extractPrice(42), { priceUsd: 42, asOfSec: null });
  assert.equal(extractPrice({ price_usd: 0 }), null);
  assert.equal(extractPrice({ price_usd: "abc" }), null);
  assert.equal(extractPrice({ hello: "world" }), null);
  assert.equal(extractPrice(null), null);
  assert.equal(extractPrice({ price_usd: -3 }), null);
});

test("toUnixSec: seconds, milliseconds, ISO strings", () => {
  assert.equal(toUnixSec(1_800_000_000), 1_800_000_000);
  assert.equal(toUnixSec(1_800_000_000_123), 1_800_000_000);
  assert.equal(toUnixSec("1800000000"), 1_800_000_000);
  assert.equal(toUnixSec("2027-01-15T08:00:00Z"), Date.parse("2027-01-15T08:00:00Z") / 1000);
  assert.equal(toUnixSec("nope"), null);
  assert.equal(toUnixSec(-1), null);
  assert.equal(toUnixSec(null), null);
});

// ------------------------------------------------------------ candles

test("extractCloses: array of objects with close / c", () => {
  assert.deepEqual(extractCloses([{ close: 1 }, { close: "2" }, { close: 3 }]), [1, 2, 3]);
  assert.deepEqual(extractCloses({ data: [{ c: 1.5, t: 100 }, { c: 2.5, t: 200 }] }), [1.5, 2.5]);
  assert.deepEqual(extractCloses({ candles: [{ o: 1, h: 3, l: 1, c: 2 }] }), [2]);
});

test("extractCloses: envelopes are found", () => {
  const rows = [{ close: 1 }, { close: 2 }];
  for (const env of [{ data: rows }, { candles: rows }, { ohlcv: rows }, { result: { candles: rows } }, { data: { items: rows } }]) {
    assert.deepEqual(extractCloses(env), [1, 2]);
  }
});

test("extractCloses: array of arrays [t,o,h,l,c,v]", () => {
  const t0 = 1_800_000_000;
  const rows = [
    [t0, 10, 12, 9, 11, 500],
    [t0 + 3600, 11, 13, 10, 12, 600],
  ];
  assert.deepEqual(extractCloses(rows), [11, 12]);
  assert.deepEqual(extractCloses({ data: rows.map((r) => r.slice(0, 5)) }), [11, 12]);
  // milliseconds timestamps
  assert.deepEqual(extractCloses(rows.map((r) => [r[0] * 1000, ...r.slice(1)])), [11, 12]);
});

test("extractCloses: array of arrays [o,h,l,c]; inconsistent OHLC is rejected", () => {
  assert.deepEqual(extractCloses([[10, 12, 9, 11], [11, 13, 10, 12]]), [11, 12]);
  assert.equal(extractCloses([[10, 9, 12, 11]]), null); // high < low: not OHLC, so do not guess
  assert.equal(extractCloses([[1, 2]]), null);
});

test("extractCandles: sorts newest-first responses into chronological order", () => {
  const rows = [{ close: 3, time: 300 }, { close: 1, time: 100 }, { close: 2, time: 200 }];
  assert.deepEqual(extractCloses(rows), [1, 2, 3]);
  assert.deepEqual(extractCandles(rows)?.map((c) => c.t), [100, 200, 300]);
  // No timestamps: order is preserved as given.
  assert.deepEqual(extractCloses([{ close: 3 }, { close: 1 }]), [3, 1]);
});

test("extractCloses: junk returns null", () => {
  assert.equal(extractCloses({}), null);
  assert.equal(extractCloses([]), null);
  assert.equal(extractCloses([{ foo: 1 }]), null);
  assert.equal(extractCloses([{ close: 0 }]), null);
  assert.equal(extractCloses([{ close: 1 }, { nope: 1 }]), null);
  assert.equal(extractCloses("x"), null);
  assert.equal(extractCloses(null), null);
});

// ------------------------------------------------------------ supply

test("extractSupply: prefers circulating, records which kind was used", () => {
  assert.deepEqual(extractSupply({ circulating_supply: 1000, total_supply: 2000 }), { supply: 1000, kind: "circulating" });
  assert.deepEqual(extractSupply({ data: { circulatingSupply: "1e3" } }), { supply: 1000, kind: "circulating" });
  assert.deepEqual(extractSupply({ data: { totalSupply: 2000 } }), { supply: 2000, kind: "total" });
  assert.deepEqual(extractSupply({ total_supply: "2000" }), { supply: 2000, kind: "total" });
  assert.deepEqual(extractSupply({ supply: 3000 }), { supply: 3000, kind: "unknown" });
  assert.equal(extractSupply({ supply: 0 }), null);
  assert.equal(extractSupply({ supply: "n/a" }), null);
  assert.equal(extractSupply({}), null);
  assert.equal(extractSupply(null), null);
});

// ------------------------------------------------------------ REST client

test("SolamiClient builds URLs, attaches api_key and never puts it in errors", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.includes("/data/token/price")) return new Response(JSON.stringify({ price_usd: 150 }));
    if (url.includes("/data/token/ohlcv")) return new Response(JSON.stringify({ data: [{ close: 1 }, { close: 2 }, { close: 3 }] }));
    if (url.includes("/data/token/supply")) return new Response(JSON.stringify({ circulating_supply: 5 }));
    return new Response("no", { status: 500 });
  }) as unknown as typeof fetch;
  const c = new SolamiClient({ apiKey: "SUPERSECRET", fetchImpl: f, now: () => 1_800_000_000_000 });
  assert.deepEqual(await c.price(MINT_A), { priceUsd: 150, asOfSec: 1_800_000_000, asOfKnown: false });
  assert.deepEqual(await c.ohlcv(MINT_A, "1h", 168), [1, 2, 3]);
  assert.deepEqual(await c.supply(MINT_A), { supply: 5, kind: "circulating" });
  assert.equal(urls[0], `https://api.solami.dev/data/token/price?address=${MINT_A}&api_key=SUPERSECRET`);
  assert.equal(urls[1], `https://api.solami.dev/data/token/ohlcv?address=${MINT_A}&interval=1h&limit=168&api_key=SUPERSECRET`);
  assert.equal(urls[2], `https://api.solami.dev/data/token/supply?address=${MINT_A}&api_key=SUPERSECRET`);
  await assert.rejects(() => c.search("ETH"), (e: Error) => /500/.test(e.message) && !e.message.includes("SUPERSECRET"));
  const boom = (async (url: string) => { throw new Error(`connect failed for ${url}`); }) as unknown as typeof fetch;
  const c2 = new SolamiClient({ apiKey: "SUPERSECRET", fetchImpl: boom });
  await assert.rejects(() => c2.price(MINT_A), (e: Error) => !e.message.includes("SUPERSECRET"));
});

// ------------------------------------------------------------ resolve

test("staticMint: only SOL and USDC", () => {
  assert.equal(staticMint("SOL"), "So11111111111111111111111111111111111111112");
  assert.equal(staticMint("sol"), "So11111111111111111111111111111111111111112");
  assert.equal(staticMint("USDC"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  for (const s of ["BTC", "ETH", "ZEC", "HYPE", "ANSEM", "USDT", ""]) assert.equal(staticMint(s), null, s);
});

test("resolveMint: static first, never searches for SOL", async () => {
  let searched = 0;
  const s = { search: async () => { searched++; return {}; } };
  assert.deepEqual(await resolveMint("SOL", s), { mint: staticMint("SOL"), source: "static" });
  assert.equal(searched, 0);
});

test("pickMintFromSearch: exact symbol, highest liquidity then volume", () => {
  const json = {
    data: [
      { symbol: "ETH", address: MINT_B, liquidity: 100 },
      { symbol: "ETH", address: MINT_C, liquidity: 5000 },
      { symbol: "ETHX", address: MINT_A, liquidity: 1e9 },
      { symbol: "eth", address: "short", liquidity: 1e12 }, // not a plausible mint
    ],
  };
  assert.equal(pickMintFromSearch(json, "ETH"), MINT_C);
  assert.equal(pickMintFromSearch({ results: [{ symbol: "ETH", mint: MINT_B, volume_24h: 1 }, { symbol: "ETH", mint: MINT_C, volume_24h: 9 }] }, "eth"), MINT_C);
  assert.equal(pickMintFromSearch([{ symbol: "ETH", token_address: MINT_B }], "ETH"), MINT_B);
  assert.equal(pickMintFromSearch({ tokens: [{ symbol: "BTC", address: MINT_B }] }, "ETH"), null);
});

test("pickMintFromSearch: unknown shape warns and returns null", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  try {
    assert.equal(pickMintFromSearch({ weird: true }, "ETH"), null);
    assert.equal(pickMintFromSearch("nope", "ETH"), null);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 2);
  assert.ok(warns[0].includes("shape"));
});

test("resolveMint: search path and failures", async () => {
  const good = { search: async () => ({ data: [{ symbol: "ZEC", address: MINT_B, liquidity: 10 }] }) };
  assert.deepEqual(await resolveMint("ZEC", good), { mint: MINT_B, source: "solami-search" });
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await resolveMint("ZEC", { search: async () => { throw new Error("down"); } }), null);
    assert.equal(await resolveMint("ZEC", { search: async () => ({ what: 1 }) }), null);
  } finally {
    console.warn = orig;
  }
});

// ------------------------------------------------------------ stream

test("median and backoff", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("BlurStream.handleFrame: swaps only, ignores volume < 50, rolling median of 15", () => {
  const s = new BlurStream({ apiKey: "k", mints: [MINT_A] });
  const got: number[] = [];
  s.onSwap((e) => got.push(e.priceUsd));
  const frame = (price: number, vol: number, t: number, type = "swap") =>
    JSON.stringify({ type, mint: MINT_A, price_usd: price, volume_usd: vol, block_time: t });
  assert.equal(s.latest(MINT_A), null);
  assert.deepEqual(s.handleFrame(frame(100, 49.99, 1000)), []);
  assert.deepEqual(s.handleFrame(frame(100, 50, 1000)), [{ mint: MINT_A, priceUsd: 100, volumeUsd: 50, blockTime: 1000 }]);
  assert.deepEqual(s.handleFrame(frame(100, 500, 1001, "transfer")), []);
  assert.deepEqual(s.handleFrame("not json"), []);
  assert.deepEqual(s.handleFrame({ type: "swap", mint: MINT_A }), []);
  assert.deepEqual(s.latest(MINT_A), { priceUsd: 100, asOfSec: 1000 });
  // 15 more swaps: prices 1..15; the first (100) must have rolled out, median of 1..15 is 8.
  for (let i = 1; i <= 15; i++) s.handleFrame(frame(i, 100, 1000 + i));
  assert.deepEqual(s.latest(MINT_A), { priceUsd: 8, asOfSec: 1015 });
  assert.equal(got.length, 16);
  // One wild print does not move a median of 15 much.
  s.handleFrame(frame(1_000_000, 100, 1016));
  assert.equal(s.latest(MINT_A)!.priceUsd, 9);
  // Frames wrapped in {data: ...} and arrays are accepted; string numbers coerce.
  assert.equal(s.handleFrame({ data: { type: "swap", mint: MINT_B, price_usd: "2", volume_usd: "60", block_time: "1500" } }).length, 1);
  assert.equal(s.handleFrame([{ type: "swap", mint: MINT_B, price_usd: 4, volume_usd: 60, block_time: 1501 }]).length, 1);
  assert.equal(s.latest(MINT_B)!.priceUsd, 3);
});

class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  close() { this.closed = true; }
}

test("BlurStream: mode is 'poll' until the socket opens, falls back to polling on close, uses the documented URL", async () => {
  FakeWS.instances = [];
  const polls: string[] = [];
  const s = new BlurStream({
    apiKey: "KEY123",
    mints: [MINT_A, MINT_B],
    WebSocketImpl: FakeWS,
    pollMs: 1_000_000,
    rest: { price: async (m) => { polls.push(m); return { priceUsd: 10, asOfSec: 2000 }; } },
  });
  s.start();
  assert.equal(s.mode, "poll");
  const ws = FakeWS.instances[0];
  assert.ok(ws.url.startsWith("wss://ws.solami.dev/data/subscribe?chain=solana&type=swap&address="));
  assert.ok(ws.url.includes(`address=${MINT_A},${MINT_B}&`));
  assert.ok(ws.url.endsWith("&api_key=KEY123"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(polls.sort(), [MINT_A, MINT_B].sort(), "immediate REST poll while the socket is not up");
  assert.deepEqual(s.latest(MINT_A), { priceUsd: 10, asOfSec: 2000 });
  ws.onopen!();
  assert.equal(s.mode, "stream");
  ws.onmessage!({ data: JSON.stringify({ type: "swap", mint: MINT_A, price_usd: 11, volume_usd: 100, block_time: 2100 }) });
  assert.deepEqual(s.latest(MINT_A), { priceUsd: 11, asOfSec: 2100 }, "newer swap beats older poll");
  ws.onclose!();
  assert.equal(s.mode, "poll");
  s.stop();
  assert.equal(s.mode, "poll");
  assert.equal(FakeWS.instances.length, 1, "no reconnect after stop()");
});
