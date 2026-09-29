/**
 * Hyperliquid public info API client (read-only reference prices for large-cap assets).
 *
 * Every request is a POST to /info with a JSON body and no authentication. Hyperliquid also has a signed
 * /exchange endpoint that moves funds; oddsflow must never touch it, so `assertHlAllowed` runs before any
 * network call and permits only three read-only request types.
 */
import { TokenBucket } from "../util/ratelimit.ts";

export class ForbiddenHlRequestError extends Error {}

const ALLOWED_TYPES: ReadonlySet<string> = new Set(["allMids", "meta", "candleSnapshot"]);

/** Throws unless this is a POST-able `/info` request with body.type in {allMids, meta, candleSnapshot}. */
export function assertHlAllowed(path: string, body: any): void {
  if (path !== "/info") throw new ForbiddenHlRequestError(`Hyperliquid path not allowed: ${String(path)}`);
  const type = body && typeof body === "object" && !Array.isArray(body) ? body.type : undefined;
  if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
    throw new ForbiddenHlRequestError(`Hyperliquid request type not allowed: ${String(type)}`);
  }
}

export const HL_BASE_URL = "https://api.hyperliquid.xyz";
const MAX_RETRIES_429 = 3;

export type HyperliquidClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const finiteNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export class HyperliquidClient {
  baseUrl: string;
  #fetch: typeof fetch;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  bucket: TokenBucket;

  constructor(opts: HyperliquidClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? HL_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }));
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.bucket = new TokenBucket(60, 60_000, this.#now);
  }

  async #acquire(): Promise<void> {
    while (!this.bucket.tryTake()) await this.#sleep(Math.max(1, this.bucket.msUntilNext()));
  }

  /** POST to an allowlisted path. Throws on HTTP errors; returns undefined for a body that is not JSON. */
  async post(path: string, body: any): Promise<any> {
    assertHlAllowed(path, body);
    for (let attempt = 0; ; attempt++) {
      await this.#acquire();
      const res = await this.#fetch(this.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const raw = res.headers?.get?.("retry-after");
        const ra = raw === null || raw === undefined || raw.trim() === "" ? NaN : Number(raw);
        const waitSec = Number.isFinite(ra) && ra >= 0 ? ra : 5;
        await this.#sleep(waitSec * 1000 + Math.floor(Math.random() * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Hyperliquid ${res.status} on ${body.type}`);
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : undefined;
      } catch {
        return undefined;
      }
    }
  }

  /** Mid prices by coin. Non-finite values are dropped; an unexpected shape gives {}. */
  async mids(): Promise<Record<string, number>> {
    const json = await this.post("/info", { type: "allMids" });
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      console.warn("[hyperliquid] unrecognised allMids response shape");
      return {};
    }
    const out: Record<string, number> = {};
    for (const [coin, v] of Object.entries(json)) {
      const n = finiteNum(v);
      if (n !== null) out[coin] = n;
    }
    return out;
  }

  /** Names of the listed perpetuals (delisted ones excluded). An unexpected shape gives an empty set. */
  async universe(): Promise<Set<string>> {
    const json = await this.post("/info", { type: "meta" });
    const uni = json?.universe;
    if (!Array.isArray(uni)) {
      console.warn("[hyperliquid] unrecognised meta response shape");
      return new Set();
    }
    const names = new Set<string>();
    for (const u of uni) {
      if (u && typeof u.name === "string" && u.name !== "" && u.isDelisted !== true) names.add(u.name);
    }
    return names;
  }

  /**
   * Closes of the last `hours` hourly candles, oldest first, and the open time (ms) of the newest candle.
   * Null when the response has fewer than 3 usable candles or an unexpected shape.
   */
  async closes(coin: string, interval: "1h", hours: number): Promise<{ closes: number[]; lastT: number } | null> {
    const endTime = this.#now();
    const json = await this.post("/info", {
      type: "candleSnapshot",
      req: { coin, interval, startTime: endTime - hours * 3_600_000, endTime },
    });
    if (!Array.isArray(json)) {
      console.warn("[hyperliquid] unrecognised candleSnapshot response shape");
      return null;
    }
    const candles: Array<{ t: number; c: number }> = [];
    for (const k of json) {
      const t = finiteNum(k?.t);
      const c = finiteNum(k?.c);
      if (t !== null && c !== null && c > 0) candles.push({ t, c });
    }
    if (candles.length < 3) return null;
    candles.sort((a, b) => a.t - b.t);
    return { closes: candles.map((x) => x.c), lastT: candles[candles.length - 1].t };
  }
}
