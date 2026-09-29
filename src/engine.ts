/**
 * The engine: Panta markets -> parsed contracts -> Solana mints -> spot/sigma/supply -> fair value rows.
 * All I/O goes through injected dependencies so it can be tested with fakes.
 * Read-only: nothing here trades, signs or broadcasts.
 */
import { parseMarket } from "./parse/market.ts";
import type { Contract } from "./parse/market.ts";
import { fairValue, realizedVol } from "./model/fair.ts";
import { resolveMint } from "./assets/resolve.ts";
import type { MintSearcher } from "./assets/resolve.ts";
import { categoryRank, extractMarketId, extractResolved, extractTitle, extractYesPrice } from "./panta/extract.ts";
import { isStale } from "./util/stale.ts";
import type { SpotQuote, SupplyInfo } from "./feed/solami.ts";

export type PantaLike = {
  listMarkets(opts: { status?: string; category?: string; limit?: number }): Promise<any[]>;
  getMarket(id: string): Promise<any>;
};

export type SolamiLike = MintSearcher & {
  price(mint: string): Promise<{ priceUsd: number; asOfSec: number; asOfKnown?: boolean } | null>;
  ohlcv(mint: string, interval: "1h", limit: number): Promise<number[] | null>;
  supply(mint: string): Promise<SupplyInfo | null>;
};

export type SpotSource = {
  latest(mint: string): SpotQuote | null;
  setMints?(mints: string[]): void;
  mode?: "stream" | "poll";
};

export type Row = {
  marketId: string;
  title: string;
  url: string;
  yes: number | null;
  fair: number | null;
  edge: number | null;
  spot: number | null;
  sigma: number | null;
  T: number | null;
  confidence: "high" | "low" | null;
  /** Unix seconds the spot price is as of. */
  asOf: number | null;
  reason?: string;
  // Extras used by the UI's "why" panel.
  kind: Contract["kind"] | null;
  asset: string | null;
  strike: number | null;
  mcap: number | null;
  K: number | null;
  expiry: number | null;
  mint: string | null;
  mintSource: "static" | "solami-search" | null;
  nCandles: number | null;
  supply: number | null;
  yesAsOf: number | null;
  stale: boolean;
  staleReasons: string[];
  notes: string[];
};

export type EngineOptions = {
  panta: PantaLike;
  solami: SolamiLike;
  stream?: SpotSource | null;
  now?: () => number;
  phases?: string[];
  maxDetailPerCycle?: number;
  maxTextPerCycle?: number;
  sigmaTtlSec?: number;
  supplyTtlSec?: number;
  retrySec?: number;
  restSpotMinIntervalSec?: number;
  pantaMaxAgeSec?: number;
};

type Entry = {
  id: string;
  /** Market text (title, else question). Empty until known. List rows usually have no title; the detail endpoint does. */
  title: string;
  /** True once `title` holds real text (from the list row or from a detail fetch). Cached for the life of the id. */
  hasText: boolean;
  contract: Contract | null;
  category: string | null;
  order: number;
  yes: number | null;
  yesAsOfSec: number | null;
  /** True once a detail response supplied the price; the list price then never overrides it. */
  yesFromDetail: boolean;
  resolved: boolean;
  /** Last detail fetch (text or price). */
  detailAtSec: number | null;
  /** Last attempt to obtain text via the detail endpoint, and how long to wait before the next one. */
  textTriedAtSec: number | null;
  textRetrySec: number;
};

/** A detail with no title and no question ("stripped" card) is retried at most this often. */
const STRIPPED_RETRY_SEC = 600;
/** A failed detail request (network/API error) is retried sooner. */
const ERROR_RETRY_SEC = 60;
/** Parseable markets get their detail re-read for prices this often. */
const PRICE_REFRESH_SEC = 60;

type AssetState = {
  mint: string | null;
  mintSource: "static" | "solami-search" | null;
  mintTriedAt: number | null;
  vol: { sigma: number | null; n: number; at: number; ok: boolean } | null;
  supply: { info: SupplyInfo | null; at: number; ok: boolean } | null;
  rest: { quote: SpotQuote; at: number } | null;
};

const HOUR_SEC = 3600;

export class Engine {
  panta: PantaLike;
  solami: SolamiLike;
  stream: SpotSource | null;
  now: () => number;
  phases: string[];
  maxDetailPerCycle: number;
  maxTextPerCycle: number;
  sigmaTtlSec: number;
  supplyTtlSec: number;
  retrySec: number;
  restSpotMinIntervalSec: number;
  pantaMaxAgeSec: number;

  #entries = new Map<string, Entry>();
  #order = 0;
  #assets = new Map<string, AssetState>();
  #listeners = new Set<(rows: Row[]) => void>();
  #timers: Array<ReturnType<typeof setInterval>> = [];
  #busy = { markets: false, data: false };
  #running = false;
  lastMarketsAtSec: number | null = null;
  lastError: string | null = null;
  rows: Row[] = [];

  constructor(o: EngineOptions) {
    this.panta = o.panta;
    this.solami = o.solami;
    this.stream = o.stream ?? null;
    this.now = o.now ?? Date.now;
    this.phases = o.phases ?? ["primary", "secondary"];
    this.maxDetailPerCycle = o.maxDetailPerCycle ?? 90;
    this.maxTextPerCycle = o.maxTextPerCycle ?? 200;
    this.sigmaTtlSec = o.sigmaTtlSec ?? 600;
    this.supplyTtlSec = o.supplyTtlSec ?? 3600;
    this.retrySec = o.retrySec ?? 120;
    this.restSpotMinIntervalSec = o.restSpotMinIntervalSec ?? 15;
    this.pantaMaxAgeSec = o.pantaMaxAgeSec ?? 180;
  }

  #nowSec(): number {
    return this.now() / 1000;
  }

  onUpdate(cb: (rows: Row[]) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  // ------------------------------------------------------------ markets

  /** Merge market list items into state. Returns the number of distinct markets ingested. */
  ingestMarkets(items: any[], atSec: number = this.#nowSec(), prune = false): number {
    const seenIds = new Set<string>();
    for (const item of items) {
      const id = extractMarketId(item);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const listText = extractTitle(item);
      let e = this.#entries.get(id);
      if (!e) {
        e = {
          id, title: "", hasText: false, contract: null, category: null, order: this.#order++,
          yes: null, yesAsOfSec: null, yesFromDetail: false, resolved: false,
          detailAtSec: null, textTriedAtSec: null, textRetrySec: STRIPPED_RETRY_SEC,
        };
        this.#entries.set(id, e);
      }
      e.category = typeof item?.category === "string" ? item.category : (item?.category?.name ?? item?.category?.slug ?? null);
      // A list row with real text wins. An empty list title keeps any text cached from a detail fetch.
      if (listText !== "" && listText !== e.title) {
        e.title = listText;
        e.hasText = true;
        e.contract = parseMarket({ title: item?.title, question: item?.question });
      }
      const yes = extractYesPrice(item);
      if (yes !== null && !e.yesFromDetail) {
        e.yes = yes;
        e.yesAsOfSec = atSec;
      }
      if (!e.detailAtSec && extractResolved(item)) e.resolved = true;
    }
    if (prune) for (const id of [...this.#entries.keys()]) if (!seenIds.has(id)) this.#entries.delete(id);
    return seenIds.size;
  }

  /** List all configured phases. Prunes markets that disappeared only if every phase succeeded. */
  async loadMarkets(): Promise<void> {
    const all: any[] = [];
    const errors: string[] = [];
    for (const phase of this.phases) {
      try {
        all.push(...(await this.panta.listMarkets({ status: phase })));
      } catch (e) {
        errors.push(`${phase}: ${(e as Error)?.message ?? "error"}`);
      }
    }
    if (errors.length === this.phases.length) {
      this.lastError = `Panta list failed (${errors.join("; ")})`;
      throw new Error(this.lastError);
    }
    const at = this.#nowSec();
    this.ingestMarkets(all, at, errors.length === 0);
    this.lastMarketsAtSec = at;
    this.lastError = errors.length ? `Panta list partially failed (${errors.join("; ")})` : null;
  }

  /** Apply a detail response: price (yesPrice, else lastYesPrice), resolved flag, and text if the market has none yet. */
  #applyDetail(e: Entry, d: any): void {
    const at = this.#nowSec();
    e.detailAtSec = at;
    const yes = extractYesPrice(d);
    if (yes !== null) {
      e.yes = yes;
      e.yesAsOfSec = at;
      e.yesFromDetail = true;
    }
    const resolved = extractResolved(d);
    if (resolved !== null) e.resolved = resolved;
    if (!e.hasText) {
      const text = extractTitle(d);
      e.textTriedAtSec = at;
      if (text !== "") {
        e.title = text;
        e.hasText = true;
        e.contract = parseMarket({ title: d?.title, question: d?.question });
      } else {
        e.textRetrySec = STRIPPED_RETRY_SEC; // stripped card: no title, no question
      }
    }
  }

  /**
   * Detail fetches, in two phases per call.
   *  1. Text: markets whose list row had no title get ONE detail fetch to learn their title/question (cached
   *     for the life of the id). Crypto, stocks, commodities and finance go first. A stripped detail (no title, no
   *     question) is retried at most once per 10 minutes.
   *  2. Prices: parseable, unresolved markets have their detail re-read every 60 s, oldest first, budgeted.
   * Both phases go through the client's rate limiter. Returns the number of detail requests made.
   */
  async fetchDetails(budget: number = this.maxDetailPerCycle): Promise<number> {
    let n = 0;
    const now = this.#nowSec();
    const needText = [...this.#entries.values()]
      .filter((e) => !e.hasText && (e.textTriedAtSec === null || now - e.textTriedAtSec >= e.textRetrySec))
      .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.order - b.order)
      .slice(0, this.maxTextPerCycle);
    for (const e of needText) {
      try {
        this.#applyDetail(e, await this.panta.getMarket(e.id));
      } catch (err) {
        console.warn(`[engine] detail fetch failed for ${e.id}: ${(err as Error)?.message ?? "error"}`);
        e.textTriedAtSec = this.#nowSec();
        e.textRetrySec = ERROR_RETRY_SEC;
      }
      n++;
    }

    const now2 = this.#nowSec();
    const due = [...this.#entries.values()]
      .filter((e) => e.contract !== null && !e.resolved && (e.detailAtSec === null || now2 - e.detailAtSec >= PRICE_REFRESH_SEC))
      .sort((a, b) => (a.detailAtSec ?? -1) - (b.detailAtSec ?? -1))
      .slice(0, budget);
    for (const e of due) {
      try {
        this.#applyDetail(e, await this.panta.getMarket(e.id));
      } catch (err) {
        console.warn(`[engine] detail fetch failed for ${e.id}: ${(err as Error)?.message ?? "error"}`);
        e.detailAtSec = this.#nowSec(); // do not hammer a failing market; the price ages and shows as stale
      }
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------ asset data

  #asset(symbol: string): AssetState {
    let a = this.#assets.get(symbol);
    if (!a) {
      a = { mint: null, mintSource: null, mintTriedAt: null, vol: null, supply: null, rest: null };
      this.#assets.set(symbol, a);
    }
    return a;
  }

  #activeAssets(): Map<string, { needsSupply: boolean }> {
    const now = this.#nowSec();
    const out = new Map<string, { needsSupply: boolean }>();
    for (const e of this.#entries.values()) {
      const c = e.contract;
      if (!c || e.resolved || c.expiry <= now) continue;
      const cur = out.get(c.asset) ?? { needsSupply: false };
      if (c.kind === "mcap_touch_above") cur.needsSupply = true;
      out.set(c.asset, cur);
    }
    return out;
  }

  /** Resolve mints, sigma and supply for every asset that has a live contract, honouring TTLs. */
  async refreshAssetData(): Promise<void> {
    const now = this.#nowSec();
    for (const [symbol, need] of this.#activeAssets()) {
      const a = this.#asset(symbol);
      if (!a.mint && (a.mintTriedAt === null || now - a.mintTriedAt >= this.retrySec)) {
        a.mintTriedAt = now;
        try {
          const r = await resolveMint(symbol, this.solami);
          if (r) {
            a.mint = r.mint;
            a.mintSource = r.source;
          }
        } catch (e) {
          console.warn(`[engine] mint resolution failed for ${symbol}: ${(e as Error)?.message ?? "error"}`);
        }
      }
      if (!a.mint) continue;

      const volTtl = a.vol?.ok ? this.sigmaTtlSec : this.retrySec;
      if (!a.vol || now - a.vol.at >= volTtl) {
        try {
          const closes = await this.solami.ohlcv(a.mint, "1h", 168);
          const sigma = closes ? realizedVol(closes, HOUR_SEC) : null;
          a.vol = { sigma, n: closes?.length ?? 0, at: this.#nowSec(), ok: sigma !== null };
        } catch (e) {
          console.warn(`[engine] ohlcv failed for ${symbol}: ${(e as Error)?.message ?? "error"}`);
          a.vol = { sigma: a.vol?.sigma ?? null, n: a.vol?.n ?? 0, at: this.#nowSec(), ok: false };
        }
      }

      if (need.needsSupply) {
        const supTtl = a.supply?.ok ? this.supplyTtlSec : this.retrySec;
        if (!a.supply || now - a.supply.at >= supTtl) {
          try {
            const info = await this.solami.supply(a.mint);
            a.supply = { info, at: this.#nowSec(), ok: info !== null };
          } catch (e) {
            console.warn(`[engine] supply failed for ${symbol}: ${(e as Error)?.message ?? "error"}`);
            a.supply = { info: a.supply?.info ?? null, at: this.#nowSec(), ok: false };
          }
        }
      }
    }
    const mints = [...this.#assets.values()].map((a) => a.mint).filter((m): m is string => !!m);
    this.stream?.setMints?.(mints);
  }

  /** Best spot for an asset: the fresher of the stream and a REST quote. */
  #spot(a: AssetState): SpotQuote | null {
    const s = a.mint ? (this.stream?.latest(a.mint) ?? null) : null;
    const r = a.rest?.quote ?? null;
    if (s && r) return r.asOfSec > s.asOfSec ? r : s;
    return s ?? r;
  }

  /** Top up spot with REST quotes for any asset whose stream data is missing or stale. */
  async refreshSpots(): Promise<void> {
    const now = this.#nowSec();
    for (const symbol of this.#activeAssets().keys()) {
      const a = this.#asset(symbol);
      if (!a.mint) continue;
      const cur = this.#spot(a);
      if (cur && !isStale(cur.asOfSec, now)) continue;
      if (a.rest && now - a.rest.at < this.restSpotMinIntervalSec) continue;
      try {
        const q = await this.solami.price(a.mint);
        if (q) a.rest = { quote: { priceUsd: q.priceUsd, asOfSec: q.asOfSec }, at: this.#nowSec() };
        else a.rest = { quote: a.rest?.quote ?? { priceUsd: NaN, asOfSec: 0 }, at: this.#nowSec() };
      } catch (e) {
        console.warn(`[engine] spot fetch failed for ${symbol}: ${(e as Error)?.message ?? "error"}`);
        a.rest = a.rest ? { quote: a.rest.quote, at: this.#nowSec() } : null;
      }
      if (a.rest && !(a.rest.quote.priceUsd > 0)) a.rest = null;
    }
  }

  // ------------------------------------------------------------ rows

  computeRows(nowSec: number = this.#nowSec()): Row[] {
    const rows: Row[] = [];
    for (const e of this.#entries.values()) rows.push(this.#row(e, nowSec));
    const rank = (r: Row) => (r.fair !== null ? 0 : r.reason === "unparsed" ? 2 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0) || a.title.localeCompare(b.title));
    this.rows = rows;
    return rows;
  }

  #row(e: Entry, nowSec: number): Row {
    const c = e.contract;
    const base: Row = {
      marketId: e.id,
      title: e.title,
      url: `https://www.panta.market/market/${encodeURIComponent(e.id)}`,
      yes: e.yes,
      fair: null,
      edge: null,
      spot: null,
      sigma: null,
      T: null,
      confidence: null,
      asOf: null,
      kind: c?.kind ?? null,
      asset: c?.asset ?? null,
      strike: c && c.kind !== "mcap_touch_above" ? c.strike : null,
      mcap: c && c.kind === "mcap_touch_above" ? c.mcap : null,
      K: null,
      expiry: c?.expiry ?? null,
      mint: null,
      mintSource: null,
      nCandles: null,
      supply: null,
      yesAsOf: e.yesAsOfSec,
      stale: false,
      staleReasons: [],
      notes: [],
    };
    if (!c) return { ...base, reason: "unparsed" };
    if (e.resolved) return { ...base, reason: "resolved" };
    if (c.expiry <= nowSec) return { ...base, reason: "expired" };

    const a = this.#assets.get(c.asset);
    if (!a || !a.mint) return { ...base, reason: "no mint" };
    base.mint = a.mint;
    base.mintSource = a.mintSource;
    base.nCandles = a.vol?.n ?? null;
    base.supply = a.supply?.info?.supply ?? null;

    const spot = this.#spot(a);
    if (!spot) return { ...base, reason: "no spot" };
    base.spot = spot.priceUsd;
    base.asOf = spot.asOfSec;

    const sigma = a.vol?.sigma ?? null;
    if (sigma === null || !(sigma > 0)) {
      return { ...base, sigma, reason: sigma === 0 ? "no sigma (flat candles)" : "no sigma" };
    }
    base.sigma = sigma;
    const isMcap = c.kind === "mcap_touch_above";
    if (isMcap && !(a.supply?.info && a.supply.info.supply > 0)) return { ...base, reason: "no supply" };

    const f = fairValue(c, {
      spot: spot.priceUsd,
      spotAsOfSec: spot.asOfSec,
      sigma,
      nCandles: a.vol?.n ?? 0,
      supply: a.supply?.info?.supply ?? null,
      nowSec,
    });
    if (!f) return { ...base, reason: "no fair value" };

    const staleReasons: string[] = [];
    if (isStale(spot.asOfSec, nowSec)) staleReasons.push("spot price older than 120 s");
    if (e.yesAsOfSec === null) staleReasons.push("no Panta price");
    else if (nowSec - e.yesAsOfSec > this.pantaMaxAgeSec) staleReasons.push(`Panta price older than ${this.pantaMaxAgeSec} s`);

    let confidence = f.confidence;
    const notes: string[] = [];
    if (staleReasons.length) confidence = "low";
    if (isMcap && a.supply?.info && a.supply.info.kind !== "circulating") {
      confidence = "low";
      notes.push(`supply is the ${a.supply.info.kind} supply, not circulating supply`);
    }
    if (a.mintSource === "solami-search") notes.push("mint chosen by symbol search; may be a wrapped/bridged token, not the underlying");

    return {
      ...base,
      fair: f.p,
      edge: e.yes !== null ? f.p - e.yes : null,
      T: f.inputs.T,
      K: f.inputs.K,
      confidence,
      stale: staleReasons.length > 0,
      staleReasons,
      notes,
    };
  }

  // ------------------------------------------------------------ orchestration

  /** Detail fetch + asset data + spots + rows, awaited. Markets must already be ingested (loadMarkets or ingestMarkets). */
  async runOnce(): Promise<Row[]> {
    await this.fetchDetails();
    await this.refreshAssetData();
    await this.refreshSpots();
    return this.computeRows();
  }

  #emit(): void {
    const rows = this.computeRows();
    for (const cb of this.#listeners) {
      try { cb(rows); } catch { /* ignore */ }
    }
  }

  async #marketCycle(): Promise<void> {
    if (this.#busy.markets) return;
    this.#busy.markets = true;
    try {
      await this.loadMarkets();
      this.#emit();
      await this.fetchDetails();
    } catch (e) {
      this.lastError = (e as Error)?.message ?? "error";
      console.warn(`[engine] market cycle failed: ${this.lastError}`);
    } finally {
      this.#busy.markets = false;
      this.#emit();
    }
  }

  async #dataCycle(): Promise<void> {
    if (this.#busy.data) return;
    this.#busy.data = true;
    try {
      await this.refreshAssetData();
      await this.refreshSpots();
    } catch (e) {
      console.warn(`[engine] data cycle failed: ${(e as Error)?.message ?? "error"}`);
    } finally {
      this.#busy.data = false;
      this.#emit();
    }
  }

  /** Start background refresh: Panta every 60 s, spot top-ups every 15 s, rows recomputed every 2 s. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#marketCycle().then(() => this.#dataCycle());
    const mk = (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      (t as any)?.unref?.();
      this.#timers.push(t);
    };
    mk(() => void this.#marketCycle(), 60_000);
    mk(() => void this.#dataCycle(), 15_000);
    mk(() => this.#emit(), 2_000);
  }

  stop(): void {
    this.#running = false;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  status(): { running: boolean; markets: number; supported: number; lastMarketsAt: number | null; error: string | null; streamMode: string | null } {
    let supported = 0;
    for (const e of this.#entries.values()) if (e.contract) supported++;
    return {
      running: this.#running,
      markets: this.#entries.size,
      supported,
      lastMarketsAt: this.lastMarketsAtSec,
      error: this.lastError,
      streamMode: this.stream?.mode ?? null,
    };
  }
}
