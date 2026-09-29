/**
 * Solami data API client + live swap stream.
 *
 * The exact response shapes are unverified, so every extractor is defensive:
 * it accepts several plausible shapes and returns null rather than guess.
 * Error messages never include URLs (they carry the api_key).
 */
import { redactSecrets } from "../util/redact.ts";

export const SOLAMI_BASE_URL = "https://api.solami.dev";
export const SOLAMI_WS_URL = "wss://ws.solami.dev/data/subscribe";

// ---------------------------------------------------------------- extractors

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Unix seconds from a seconds-or-milliseconds number, or an ISO string. */
export function toUnixSec(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "" && Number.isNaN(Number(v))) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const n = toNum(v);
  if (n === null || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Breadth-first search for the first of `keys` (in priority order per level) holding a usable value; depth <= 3. */
function findField<T>(json: unknown, keys: string[], pick: (v: unknown) => T | null, depth = 3): { key: string; value: T } | null {
  let level: unknown[] = [json];
  for (let d = 0; d <= depth; d++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const o = node as Record<string, unknown>;
      for (const k of keys) {
        if (k in o) {
          const v = pick(o[k]);
          if (v !== null) return { key: k, value: v };
        }
      }
      for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v)) next.push(v);
    }
    level = next;
  }
  return null;
}

const priceValue = (v: unknown): number | null => {
  if (v && typeof v === "object" && !Array.isArray(v)) return toNum((v as any).usd ?? (v as any).USD ?? (v as any).value);
  const n = toNum(v);
  return n !== null && n > 0 ? n : null;
};

export type PriceQuote = { priceUsd: number; asOfSec: number | null };

/** Extract a USD price and (if present) its timestamp from a price response. */
export function extractPrice(json: unknown): PriceQuote | null {
  // Bare number or numeric string.
  const bare = toNum(json);
  if (bare !== null && bare > 0) return { priceUsd: bare, asOfSec: null };
  // Array of one entry.
  if (Array.isArray(json) && json.length > 0) return extractPrice(json[0]);
  const hit = findField(json, ["price_usd", "priceUsd", "usd_price", "usdPrice", "price"], priceValue);
  if (!hit) return null;
  // Timestamp: look in the same neighbourhood.
  const t = findField(
    json,
    ["block_time", "blockTime", "updated_at", "updatedAt", "last_updated", "lastUpdated", "timestamp", "time", "ts"],
    toUnixSec,
  );
  return { priceUsd: hit.value, asOfSec: t ? t.value : null };
}

export type Candle = { t: number | null; c: number };

const TIME_KEYS = ["t", "time", "timestamp", "open_time", "openTime", "unix_time", "unixTime", "block_time", "blockTime", "start"];
const CLOSE_KEYS = ["close", "c", "close_price", "closePrice", "close_usd", "closeUsd"];

function candleFromRow(row: unknown): Candle | null {
  if (Array.isArray(row)) {
    const v = row.map(toNum);
    if (v.some((x) => x === null)) return null;
    const n = v as number[];
    // [t, o, h, l, c, (v)] with a leading unix timestamp.
    if (n.length >= 5 && n[0] > 1e8) {
      const [t, o, h, l, c] = n;
      if (h >= l && c > 0 && o > 0) return { t: toUnixSec(t), c };
      return null;
    }
    // [o, h, l, c] or [o, h, l, c, v]: accepted only if consistent as OHLC.
    if (n.length >= 4 && n.length <= 5) {
      const [o, h, l, c] = n;
      if (o > 0 && c > 0 && l > 0 && h >= Math.max(o, c) && l <= Math.min(o, c)) return { t: null, c };
    }
    return null;
  }
  if (row && typeof row === "object") {
    const o = row as Record<string, unknown>;
    for (const k of CLOSE_KEYS) {
      const c = toNum(o[k]);
      if (c !== null) {
        if (!(c > 0)) return null;
        let t: number | null = null;
        for (const tk of TIME_KEYS) {
          if (tk in o) {
            t = toUnixSec(o[tk]);
            if (t !== null) break;
          }
        }
        return { t, c };
      }
    }
  }
  return null;
}

function findCandleArray(json: unknown, depth = 3): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (depth < 0 || !json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  for (const k of ["candles", "ohlcv", "data", "items", "result", "results", "bars"]) {
    if (k in o) {
      const r = findCandleArray(o[k], depth - 1);
      if (r) return r;
    }
  }
  return null;
}

/** Candles in chronological order (sorted by timestamp when every candle has one). Null if any row is unrecognised. */
export function extractCandles(json: unknown): Candle[] | null {
  const arr = findCandleArray(json);
  if (!arr || arr.length === 0) return null;
  const out: Candle[] = [];
  for (const row of arr) {
    const c = candleFromRow(row);
    if (!c) return null;
    out.push(c);
  }
  if (out.every((c) => c.t !== null)) out.sort((a, b) => (a.t as number) - (b.t as number));
  return out;
}

export function extractCloses(json: unknown): number[] | null {
  const c = extractCandles(json);
  return c ? c.map((x) => x.c) : null;
}

export type SupplyInfo = { supply: number; kind: "circulating" | "total" | "unknown" };

/** Prefers circulating supply. `kind` records which field was used so callers can flag weaker data. */
export function extractSupply(json: unknown): SupplyInfo | null {
  const pos = (v: unknown) => {
    const n = toNum(v);
    return n !== null && n > 0 ? n : null;
  };
  let hit = findField(json, ["circulating_supply", "circulatingSupply", "circulating"], pos);
  if (hit) return { supply: hit.value, kind: "circulating" };
  hit = findField(json, ["total_supply", "totalSupply"], pos);
  if (hit) return { supply: hit.value, kind: "total" };
  hit = findField(json, ["supply", "ui_supply", "uiSupply"], pos);
  if (hit) return { supply: hit.value, kind: "unknown" };
  return null;
}

// ---------------------------------------------------------------- REST client

export type SolamiClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class SolamiClient {
  #apiKey: string;
  baseUrl: string;
  #fetch: typeof fetch;
  now: () => number;

  constructor(opts: SolamiClientOptions) {
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? SOLAMI_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }));
    this.now = opts.now ?? Date.now;
  }

  async #getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    qs.set("api_key", this.#apiKey);
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}?${qs.toString()}`, { headers: { Accept: "application/json" } });
    } catch (e) {
      throw new Error(`Solami request to ${path} failed: ${redactSecrets(String((e as Error)?.message ?? e), [this.#apiKey])}`);
    }
    if (!res.ok) throw new Error(`Solami ${res.status} on ${path}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`Solami returned a non-JSON body on ${path}`);
    }
  }

  /** Raw token-search response (shape unverified; see resolveMint). */
  search(q: string): Promise<unknown> {
    return this.#getJson("/data/token/search", { q });
  }

  /** Latest USD price. When the response has no timestamp, the fetch time is used and `asOfKnown` is false. */
  async price(mint: string): Promise<{ priceUsd: number; asOfSec: number; asOfKnown: boolean } | null> {
    const q = extractPrice(await this.#getJson("/data/token/price", { address: mint }));
    if (!q) {
      console.warn("[solami] unrecognised price response shape");
      return null;
    }
    return q.asOfSec !== null
      ? { priceUsd: q.priceUsd, asOfSec: q.asOfSec, asOfKnown: true }
      : { priceUsd: q.priceUsd, asOfSec: Math.floor(this.now() / 1000), asOfKnown: false };
  }

  /** Closes of the requested candles, oldest first. */
  async ohlcv(mint: string, interval: "1h" = "1h", limit = 168): Promise<number[] | null> {
    const closes = extractCloses(await this.#getJson("/data/token/ohlcv", { address: mint, interval, limit }));
    if (!closes) console.warn("[solami] unrecognised ohlcv response shape");
    return closes;
  }

  async supply(mint: string): Promise<SupplyInfo | null> {
    const s = extractSupply(await this.#getJson("/data/token/supply", { address: mint }));
    if (!s) console.warn("[solami] unrecognised supply response shape");
    return s;
  }
}

// ---------------------------------------------------------------- live stream

export type SwapEvent = { mint: string; priceUsd: number; volumeUsd: number; blockTime: number };
export type SpotQuote = { priceUsd: number; asOfSec: number };

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const MIN_SWAP_VOLUME_USD = 50;
const MEDIAN_WINDOW = 15;

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

export type BlurStreamOptions = {
  apiKey: string;
  mints?: string[];
  /** Used for the REST fallback when the socket is down. */
  rest?: { price(mint: string): Promise<{ priceUsd: number; asOfSec: number } | null> };
  wsBase?: string;
  WebSocketImpl?: any;
  pollMs?: number;
  now?: () => number;
};

/** Live swap prices with a rolling median per mint, reconnect backoff and a REST polling fallback. */
export class BlurStream {
  #apiKey: string;
  #mints: string[];
  #rest: BlurStreamOptions["rest"];
  #wsBase: string;
  #WS: any;
  #pollMs: number;
  #now: () => number;
  #ws: any = null;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #listeners = new Set<(e: SwapEvent) => void>();
  #recent = new Map<string, number[]>();
  #lastBlockTime = new Map<string, number>();
  #polled = new Map<string, SpotQuote>();
  mode: "stream" | "poll" = "poll";

  constructor(opts: BlurStreamOptions) {
    this.#apiKey = opts.apiKey;
    this.#mints = [...new Set(opts.mints ?? [])];
    this.#rest = opts.rest;
    this.#wsBase = opts.wsBase ?? SOLAMI_WS_URL;
    this.#WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    this.#pollMs = opts.pollMs ?? 15_000;
    this.#now = opts.now ?? Date.now;
  }

  onSwap(cb: (e: SwapEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  get mints(): string[] {
    return [...this.#mints];
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#startPolling();
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopPolling();
    const ws = this.#ws;
    this.#ws = null;
    try { ws?.close?.(); } catch { /* ignore */ }
    this.mode = "poll";
  }

  /** Change the watched mints. Reconnects the socket if the set changed and polls new mints immediately. */
  setMints(mints: string[]): void {
    const next = [...new Set(mints)].sort();
    const cur = [...this.#mints].sort();
    if (next.length === cur.length && next.every((m, i) => m === cur[i])) return;
    const added = next.filter((m) => !cur.includes(m));
    this.#mints = next;
    if (!this.#running) return;
    void this.#pollOnce(added);
    const ws = this.#ws;
    this.#ws = null;
    try { ws?.close?.(); } catch { /* ignore */ }
    this.mode = "poll";
    this.#startPolling();
    this.#connect();
  }

  /**
   * Best current quote: the rolling median of the last 15 swaps (>= $50 each, as of the newest swap's block
   * time) or the latest REST poll, whichever is newer. Null if neither exists.
   */
  latest(mint: string): SpotQuote | null {
    const prices = this.#recent.get(mint);
    const t = this.#lastBlockTime.get(mint);
    const swap: SpotQuote | null = prices && prices.length > 0 && t !== undefined ? { priceUsd: median(prices), asOfSec: t } : null;
    const polled = this.#polled.get(mint) ?? null;
    if (swap && polled) return polled.asOfSec > swap.asOfSec ? polled : swap;
    return swap ?? polled;
  }

  /** Feed one raw frame (string or parsed JSON). Exposed so the frame handling is unit-testable. */
  handleFrame(raw: unknown): SwapEvent[] {
    let data: unknown = raw;
    if (typeof raw === "string") {
      try { data = JSON.parse(raw); } catch { return []; }
    }
    const frames = Array.isArray(data) ? data : [data];
    const out: SwapEvent[] = [];
    for (const f0 of frames) {
      let f: any = f0;
      if (f && typeof f === "object" && f.type !== "swap" && f.data && typeof f.data === "object" && f.data.type === "swap") f = f.data;
      if (!f || typeof f !== "object" || f.type !== "swap") continue;
      const mint = typeof f.mint === "string" ? f.mint : null;
      const priceUsd = toNum(f.price_usd);
      const volumeUsd = toNum(f.volume_usd);
      const blockTime = toUnixSec(f.block_time);
      if (!mint || priceUsd === null || priceUsd <= 0 || volumeUsd === null || blockTime === null) continue;
      if (volumeUsd < MIN_SWAP_VOLUME_USD) continue;
      this.#record(mint, priceUsd, blockTime);
      const ev = { mint, priceUsd, volumeUsd, blockTime };
      out.push(ev);
      for (const cb of this.#listeners) {
        try { cb(ev); } catch { /* listener errors must not break the stream */ }
      }
    }
    return out;
  }

  #record(mint: string, priceUsd: number, blockTime: number): void {
    const arr = this.#recent.get(mint) ?? [];
    arr.push(priceUsd);
    if (arr.length > MEDIAN_WINDOW) arr.shift();
    this.#recent.set(mint, arr);
    const prev = this.#lastBlockTime.get(mint) ?? 0;
    if (blockTime > prev) this.#lastBlockTime.set(mint, blockTime);
  }

  #connect(): void {
    if (!this.#running || this.#mints.length === 0 || !this.#WS) return;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    const url = `${this.#wsBase}?chain=solana&type=swap&address=${this.#mints.join(",")}&api_key=${encodeURIComponent(this.#apiKey)}`;
    let ws: any;
    try {
      ws = new this.#WS(url);
    } catch {
      console.warn("[stream] could not open websocket");
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      this.mode = "stream";
      this.#stopPolling();
    };
    ws.onmessage = (ev: any) => {
      if (this.#ws !== ws) return;
      this.handleFrame(typeof ev?.data === "string" ? ev.data : String(ev?.data ?? ""));
    };
    ws.onerror = () => { /* onclose follows; details may include the URL, so never print them */ };
    ws.onclose = () => {
      if (this.#ws !== ws) return; // superseded by setMints/stop
      this.#ws = null;
      this.mode = "poll";
      if (!this.#running) return;
      this.#startPolling();
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return;
    const delay = backoffMs(this.#attempt++);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    (this.#reconnectTimer as any)?.unref?.();
  }

  #startPolling(): void {
    if (this.#pollTimer || !this.#rest) return;
    void this.#pollOnce(this.#mints);
    this.#pollTimer = setInterval(() => void this.#pollOnce(this.#mints), this.#pollMs);
    (this.#pollTimer as any)?.unref?.();
  }

  #stopPolling(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #pollOnce(mints: string[]): Promise<void> {
    const rest = this.#rest;
    if (!rest) return;
    for (const mint of mints) {
      try {
        const q = await rest.price(mint);
        if (q && q.priceUsd > 0) {
          const prev = this.#polled.get(mint);
          if (!prev || q.asOfSec >= prev.asOfSec) this.#polled.set(mint, { priceUsd: q.priceUsd, asOfSec: q.asOfSec });
        }
      } catch (e) {
        console.warn(`[stream] poll failed: ${redactSecrets(String((e as Error)?.message ?? e), [this.#apiKey])}`);
      }
    }
  }
}
