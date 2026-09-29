import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnapshot } from "../src/snapshot.ts";
import type { HlLike, PantaLike, SolamiLike } from "../src/engine.ts";
import { PAGE, buildStaticPage } from "../src/page.ts";
import { rowIsStale, snapshotAgeMin } from "../src/page-logic.ts";
import { closeAbove } from "../src/model/fair.ts";

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const PK = "PK-SECRET-123456";
const SK = "SK-SECRET-654321";
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

const listRows = () => [
  { marketId: "eth", title: "", category: "crypto", phase: "primary", yesPrice: "0.500046922" },
  { marketId: "btc", title: "", category: "crypto", phase: "primary", yesPrice: "0.5" },
  { marketId: "sol", title: "", category: "crypto", phase: "secondary", yesPrice: "0.4" },
  { marketId: "nfl", title: "", category: "sports", phase: "primary", yesPrice: "0.500086" },
  { marketId: "old", title: "", category: "crypto", phase: "resolved", resolved: true, yesPrice: "1" },
];
const DETAILS: Record<string, any> = {
  eth: { marketId: "eth", title: ETH_TITLE, yesPrice: "0.500046922" },
  btc: { marketId: "btc", title: BTC_TITLE, yesPrice: "0.5" },
  sol: { marketId: "sol", title: SOL_TITLE, yesPrice: "0.4" },
  nfl: { marketId: "nfl", title: "Will the Chiefs win the Super Bowl?", yesPrice: "0.500086" },
  old: { marketId: "old", title: "Will bitcoin hit $10 by 1 Jan 2026", yesPrice: "1", resolved: true },
};

function fakes(over: { panta?: Partial<PantaLike>; hl?: Partial<HlLike>; solami?: Partial<SolamiLike> } = {}) {
  const closes = walk(168, 2500);
  const panta: PantaLike = {
    listMarkets: async () => listRows(),
    getMarket: async (id) => DETAILS[id],
    ...over.panta,
  };
  const hyperliquid: HlLike = {
    universe: async () => new Set(["BTC", "ETH", "SOL"]),
    mids: async () => ({ ETH: 2600, BTC: 83_000, SOL: 200 }),
    closes: async () => ({ closes, lastT: T0 }),
    ...over.hl,
  };
  const solami: SolamiLike = {
    search: async () => ({ data: [] }),
    price: async () => ({ priceUsd: 202, asOfSec: T0 / 1000 - 3 }),
    ohlcv: async () => closes,
    supply: async () => null,
    ...over.solami,
  };
  return { panta, hyperliquid, solami, closes };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "oddsflow-snap-"));
  try {
    return await fn(join(root, "dist"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const quietWarn = async <T>(fn: () => Promise<T>, sink: string[] = []): Promise<T> => {
  const w = console.warn;
  console.warn = (...a: unknown[]) => { sink.push(a.join(" ")); };
  try { return await fn(); } finally { console.warn = w; }
};

// ------------------------------------------------------------ (a)

test("snapshot: writes rows.json with the documented keys and a static index.html", async () => {
  await withDir(async (outDir) => {
    const f = fakes();
    const lines: string[] = [];
    const code = await runSnapshot({ PANTA_API_KEY: PK, SOLAMI_API_KEY: SK }, { ...f, outDir, now: () => T0, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.deepEqual((await readdir(outDir)).sort(), ["index.html", "rows.json"]);

    const snap = JSON.parse(await readFile(join(outDir, "rows.json"), "utf8"));
    assert.deepEqual(Object.keys(snap).sort(), ["generatedAt", "generatedAtIso", "launchBlindCount", "rows", "sources"]);
    assert.equal(snap.generatedAt, T0 / 1000);
    assert.equal(snap.generatedAtIso, "2026-09-29T12:00:00.000Z");
    assert.deepEqual(snap.sources, { panta: "ok", hyperliquid: "ok", solami: "ok" });
    assert.equal(snap.launchBlindCount, 3, "eth, btc and nfl are primary and at ~0.5");

    const byId = (id: string) => snap.rows.find((r: any) => r.marketId === id);
    assert.equal(snap.rows.length, 5, "all rows, including unsupported and resolved ones (like /api/rows?all=1)");
    assert.equal(byId("nfl").reason, "unparsed");
    assert.equal(byId("old").reason, "resolved");
    const eth = byId("eth");
    assert.equal(eth.venue, "hyperliquid");
    assert.equal(eth.launchBlind, true);
    assert.equal(eth.title, ETH_TITLE);
    const want = closeAbove(2600, 2700, eth.sigma, (1790809140 - T0 / 1000) / 31_536_000);
    assert.equal(eth.fair, want);
    assert.equal(byId("sol").venue, "solami");
    assert.ok(byId("btc").fair !== null);

    const html = await readFile(join(outDir, "index.html"), "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes("Snapshot generated"));
    assert.ok(html.includes("Snapshot generated 2026-09-29T12:00:00.000Z. Updated every ~10 minutes by GitHub Actions. Not live streaming."));
    assert.ok(html.includes("Powered by Panta"));
    assert.ok(html.includes("Data: Solami"));
    assert.ok(html.includes("Reference prices: Hyperliquid"));
    assert.ok(html.includes("Launch radar"));
    assert.ok(html.includes('href="https://github.com/rishabharora-kk/oddsflow"'));
    assert.ok(html.includes('var MODE = "static"'));
    assert.ok(html.includes("./rows.json"));
    assert.ok(html.includes('if (MODE === "static") {\n    loadSnapshot();'), "static mode loads the snapshot instead of connecting");
    assert.ok(lines.some((l) => l.startsWith("sources: panta=ok")));
  });
});

// ------------------------------------------------------------ (b)

test("snapshot: Panta failing gives exit 1 and writes nothing", async () => {
  await withDir(async (outDir) => {
    const f = fakes({ panta: { listMarkets: async () => { throw new Error("Panta API 500 on GET /markets/: BOOM"); } } });
    const lines: string[] = [];
    const code = await runSnapshot({ PANTA_API_KEY: PK }, { ...f, outDir, now: () => T0, log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false, "no dist directory at all");
    assert.ok(lines.some((l) => l.includes("BOOM")));
  });
});

test("snapshot: an empty Panta catalogue or a missing key is also exit 1 with nothing written", async () => {
  await withDir(async (outDir) => {
    const f = fakes({ panta: { listMarkets: async () => [] } });
    assert.equal(await runSnapshot({ PANTA_API_KEY: PK }, { ...f, outDir, log: () => {} }), 1);
    assert.equal(existsSync(outDir), false);
    assert.equal(await runSnapshot({}, { outDir, log: () => {} }), 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("snapshot: Hyperliquid failing is exit 0 with sources.hyperliquid starting 'error'", async () => {
  await withDir(async (outDir) => {
    const f = fakes({ hl: { universe: async () => { throw new Error("HL 403 on meta"); } } });
    const code = await quietWarn(() => runSnapshot({ PANTA_API_KEY: PK }, { ...f, outDir, now: () => T0, log: () => {} }));
    assert.equal(code, 0);
    const snap = JSON.parse(await readFile(join(outDir, "rows.json"), "utf8"));
    assert.match(snap.sources.hyperliquid, /^error: /);
    assert.ok(snap.sources.hyperliquid.includes("HL 403 on meta"));
    assert.equal(snap.sources.panta, "ok");
    assert.equal(snap.rows.length, 5, "rows are still written");
    assert.ok(existsSync(join(outDir, "index.html")));
  });
});

test("snapshot: sources reports Solami as 'not configured' or 'error: ...'", async () => {
  await withDir(async (outDir) => {
    const f = fakes();
    await runSnapshot({ PANTA_API_KEY: PK }, { panta: f.panta, hyperliquid: f.hyperliquid, solami: null, outDir, now: () => T0, log: () => {} });
    assert.equal(JSON.parse(await readFile(join(outDir, "rows.json"), "utf8")).sources.solami, "not configured");
  });
  await withDir(async (outDir) => {
    const f = fakes({ solami: { price: async () => { throw new Error("Solami 500 on /data/token/price"); } } });
    await quietWarn(() => runSnapshot({ PANTA_API_KEY: PK, SOLAMI_API_KEY: SK }, { ...f, outDir, now: () => T0, log: () => {} }));
    const snap = JSON.parse(await readFile(join(outDir, "rows.json"), "utf8"));
    assert.match(snap.sources.solami, /^error: Solami 500/);
    assert.equal(snap.sources.hyperliquid, "ok");
  });
});

// ------------------------------------------------------------ (c)

test("snapshot: keys never appear in rows.json, index.html, logs or warnings", async () => {
  await withDir(async (outDir) => {
    const f = fakes({
      hl: { mids: async () => { throw new Error(`upstream rejected key ${SK} and ${PK}`); } },
      solami: { price: async () => { throw new Error(`bad api_key=${SK}`); } },
    });
    const lines: string[] = [];
    const warnings: string[] = [];
    const code = await quietWarn(() => runSnapshot({ PANTA_API_KEY: PK, SOLAMI_API_KEY: SK }, { ...f, outDir, now: () => T0, log: (l) => lines.push(l) }), warnings);
    assert.equal(code, 0);
    const json = await readFile(join(outDir, "rows.json"), "utf8");
    const html = await readFile(join(outDir, "index.html"), "utf8");
    for (const secret of [PK, SK]) {
      assert.ok(!json.includes(secret), "rows.json");
      assert.ok(!html.includes(secret), "index.html");
      assert.ok(!lines.join("\n").includes(secret), "log lines");
      assert.ok(!warnings.join("\n").includes(secret), "console warnings");
    }
    const snap = JSON.parse(json);
    assert.ok(snap.sources.hyperliquid.includes("[redacted]"), snap.sources.hyperliquid);
    assert.ok(snap.sources.solami.includes("[redacted]"), snap.sources.solami);
  });
});

test("snapshot: a Panta error message containing the key is redacted in the log", async () => {
  await withDir(async (outDir) => {
    const f = fakes({ panta: { listMarkets: async () => { throw new Error(`denied for ${PK}`); } } });
    const lines: string[] = [];
    assert.equal(await runSnapshot({ PANTA_API_KEY: PK }, { ...f, outDir, log: (l) => lines.push(l) }), 1);
    assert.ok(!lines.join("\n").includes(PK));
    assert.ok(lines.join("\n").includes("[redacted]"));
  });
});

// ------------------------------------------------------------ (d)

test("rowIsStale: static mode marks rows STALE once the snapshot is over 20 minutes behind the viewer's clock", () => {
  const now = 1_800_000_000;
  const ctx = (age: number) => ({ mode: "static", generatedAt: now - age, nowSec: now, connected: false });
  assert.equal(rowIsStale({ stale: false }, ctx(0)), false);
  assert.equal(rowIsStale({ stale: false }, ctx(19 * 60)), false);
  assert.equal(rowIsStale({ stale: false }, ctx(20 * 60)), false, "exactly 20 minutes is not yet stale");
  assert.equal(rowIsStale({ stale: false }, ctx(20 * 60 + 1)), true);
  assert.equal(rowIsStale({ stale: false }, ctx(3 * 3600)), true);
  assert.equal(rowIsStale({ stale: true }, ctx(0)), true, "a row the engine flagged stays stale");
  assert.equal(rowIsStale({ stale: false }, { mode: "static", generatedAt: null, nowSec: now }), true, "no snapshot loaded: never live");
  // Live mode is unchanged: stale only while disconnected or engine-flagged.
  assert.equal(rowIsStale({ stale: false }, { mode: "live", connected: true, nowSec: now }), false);
  assert.equal(rowIsStale({ stale: false }, { mode: "live", connected: false, nowSec: now }), true);
  assert.equal(rowIsStale({ stale: true }, { mode: "live", connected: true, nowSec: now }), true);
  assert.equal(snapshotAgeMin(now - 5 * 60 - 30, now), 5);
  assert.equal(snapshotAgeMin(now + 100, now), 0);
});

// Minimal DOM: enough to run the page script and read back what it rendered.
class FakeEl {
  tag: string;
  children: FakeEl[] = [];
  listeners: Record<string, Array<(e?: any) => void>> = {};
  className = "";
  #text = "";
  hidden = false;
  attrs: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  set textContent(v: string) { this.#text = String(v); this.children = []; }
  get textContent(): string { return this.#text + this.children.map((c) => c.textContent).join(""); }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(e: string, f: (e?: any) => void) { (this.listeners[e] ??= []).push(f); }
}

async function runStaticPage(generatedAt: number, nowSec: number, rows: any[], fetchOk = true) {
  const html = buildStaticPage(generatedAt);
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, FakeEl> = {};
  const document = {
    createElement: (t: string) => new FakeEl(t),
    createTextNode: (t: string) => { const e = new FakeEl("#text"); e.textContent = t; return e; },
    getElementById: (id: string) => (els[id] ??= new FakeEl(id)),
  };
  els.snapshot = new FakeEl("div"); // present in the static page
  const nowMs = nowSec * 1000;
  class FakeDate extends Date {
    constructor(...a: any[]) { if (a.length === 0) super(nowMs); else super(...(a as [any])); }
    static now() { return nowMs; }
  }
  const fetched: string[] = [];
  const fetchStub = async (u: string) => {
    fetched.push(u);
    if (!fetchOk) throw new Error("network");
    return { json: async () => ({ generatedAt, generatedAtIso: "x", launchBlindCount: 1, rows, sources: { panta: "ok", hyperliquid: "error: HL down", solami: "not configured" } }) };
  };
  new Function("document", "fetch", "setInterval", "Date", "EventSource", script)(document, fetchStub, () => 0, FakeDate, undefined);
  await new Promise((r) => setTimeout(r, 10));
  return { els, fetched };
}

const pageRow = (over: Record<string, unknown> = {}) => ({
  marketId: "eth", title: "Will ETH close above 2700", url: "https://www.panta.market/market/eth", yes: 0.5, fair: 0.61, edge: 0.11,
  spot: 2600, sigma: 0.7, T: 0.01, confidence: "high", asOf: 1_800_000_000 - 100, kind: "close_above", asset: "ETH", K: 2700,
  expiry: 1_800_000_000 + 86_400, venue: "hyperliquid", phase: "primary", launchBlind: true, basisPct: null,
  notes: [], staleReasons: [], stale: false, mint: null, mintSource: null, supply: null, yesAsOf: 1_800_000_000 - 100, mcap: null, strike: 2700,
  ...over,
});

test("static page script: fetches only ./rows.json, shows the banner with age, and no STALE badge when fresh", async () => {
  const now = 1_800_000_000;
  const { els, fetched } = await runStaticPage(now - 5 * 60, now, [pageRow()]);
  assert.deepEqual(fetched, ["./rows.json"]);
  const banner = els.snapshot.textContent;
  assert.match(banner, /^Snapshot generated .+ \(5 min ago\)\. Updated every ~10 minutes by GitHub Actions\. Not live streaming\.$/);
  assert.equal(els.snapshot.className, "banner snapshot");
  assert.ok(!els.body.textContent.includes("STALE"));
  assert.ok(els.body.textContent.includes("Will ETH close above 2700"));
  assert.ok(els.body.textContent.includes("Hyperliquid mid"));
  assert.ok(els.body.textContent.includes("LAUNCH @50/50"));
  assert.ok(els.radar.textContent.includes("Launch radar: 1 primary market opened at 50/50"));
  assert.ok(els.radar.textContent.includes("Panta 0.50 vs fair 0.61"));
  assert.ok(els.status.textContent.includes("hyperliquid: error: HL down"));
  assert.ok(els.status.textContent.includes("solami: not configured"));
});

test("static page script: rows and radar are STALE when the snapshot is over 20 minutes old", async () => {
  const now = 1_800_000_000;
  const { els } = await runStaticPage(now - 25 * 60, now, [pageRow()]);
  assert.match(els.snapshot.textContent, /\(25 min ago\)/);
  assert.match(els.snapshot.textContent, /every row is STALE/);
  assert.match(els.snapshot.className, /old/);
  assert.ok(els.body.textContent.includes("STALE"));
  assert.ok(els.radar.textContent.includes("STALE"));
});

test("static page script: a missing rows.json is reported, never shown as live", async () => {
  const now = 1_800_000_000;
  const { els } = await runStaticPage(now, now, [], false);
  assert.match(els.snapshot.textContent, /Could not load the snapshot/);
  assert.equal(els.body.children.length, 0);
});

// ------------------------------------------------------------ (e)

test("live page is unchanged in shape: live mode, no snapshot banner, still has the credits and repo link", () => {
  assert.ok(PAGE.includes('var MODE = "live"'));
  assert.ok(!PAGE.includes('id="snapshot"'));
  assert.ok(!PAGE.includes("Content-Security-Policy"), "the live server sends CSP as a header");
  for (const t of ["Read-only analytics. Not financial advice.", "Powered by Panta", "Data: Solami", "Reference prices: Hyperliquid", "Launch radar", "https://github.com/rishabharora-kk/oddsflow"]) {
    assert.ok(PAGE.includes(t), t);
  }
  assert.ok(PAGE.includes('new EventSource("/events")'));
  assert.ok(buildStaticPage(1).includes("Content-Security-Policy"));
});
