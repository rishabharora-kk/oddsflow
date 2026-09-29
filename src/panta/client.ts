import { TokenBucket } from "../util/ratelimit.ts";

/**
 * Thrown whenever code tries to reach a Panta endpoint that is not on the
 * read-only allowlist. oddsflow never trades, signs, creates markets or
 * broadcasts anything.
 */
export class ForbiddenPathError extends Error {}

const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const ALLOWED: RegExp[] = [
  /^\/markets\/$/,
  new RegExp(`^/markets/${B58}/$`),
  new RegExp(`^/markets/${B58}/trades/$`),
  new RegExp(`^/wallets/${B58}/trades/$`),
  /^\/positions\/$/,
  /^\/categories\/$/,
];

/** Throws ForbiddenPathError unless this is a GET on one of the six allowlisted read endpoints. */
export function assertAllowed(method: string, path: string): void {
  if (typeof method !== "string" || method.toUpperCase() !== "GET") {
    throw new ForbiddenPathError(`Method not allowed: ${String(method)}`);
  }
  if (typeof path !== "string") throw new ForbiddenPathError("Path must be a string");
  const q = path.search(/[?#]/);
  const bare = q === -1 ? path : path.slice(0, q);
  if (!ALLOWED.some((re) => re.test(bare))) {
    throw new ForbiddenPathError(`Path not on the read-only allowlist: ${bare}`);
  }
}

/**
 * Panta prices arrive either as a 0..1 decimal or as a 1e9-scaled integer.
 * Anything > 1.0001 is treated as 1e9-scaled. Unparseable, negative or
 * non-finite values give null.
 */
export function normalizePrice(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else {
    const s = String(v).trim();
    if (s === "") return null;
    n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1.0001) return n / 1e9;
  return n;
}

export const DEFAULT_PANTA_BASE_URL = "https://live-api.panta.market/api/v1";
const MAX_RETRIES_429 = 3;
const MAX_PAGES = 20;

export type PantaClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PantaClient {
  #apiKey: string;
  baseUrl: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  bucket: TokenBucket;

  constructor(opts: PantaClientOptions) {
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_PANTA_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.bucket = new TokenBucket(120, 60_000, opts.now ?? Date.now);
  }

  async #acquire(): Promise<void> {
    while (!this.bucket.tryTake()) {
      await this.#sleep(Math.max(1, this.bucket.msUntilNext()));
    }
  }

  /** GET an allowlisted path. The allowlist is checked before anything touches the network. */
  async get(path: string, query?: Record<string, string | number>): Promise<any> {
    assertAllowed("GET", path);
    let url = this.baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }

    for (let attempt = 0; ; attempt++) {
      await this.#acquire();
      const res = await this.#fetch(url, {
        method: "GET",
        headers: { "X-Api-Key": this.#apiKey, Accept: "application/json" },
      });

      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const raw = res.headers?.get?.("retry-after");
        const ra = raw === null || raw === undefined || raw.trim() === "" ? NaN : Number(raw);
        const waitSec = Number.isFinite(ra) && ra >= 0 ? ra : 5;
        const jitterMs = Math.floor(Math.random() * 1000);
        await this.#sleep(waitSec * 1000 + jitterMs);
        continue;
      }

      const text = await res.text();
      let json: any = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        const code = json?.code ?? json?.error?.code ?? (typeof json?.error === "string" ? json.error : undefined) ?? "unknown";
        throw new Error(`Panta API ${res.status} on GET ${path}: ${String(code)}`);
      }
      if (json === undefined) throw new Error(`Panta API returned a non-JSON body on GET ${path}`);
      return json;
    }
  }

  /** All markets, following nextCursor / next_cursor. Stops on a null, missing or repeated cursor, or after 20 pages. */
  async listMarkets(opts: { status?: string; category?: string; limit?: number } = {}): Promise<any[]> {
    const items: any[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: Record<string, string | number> = {};
      if (opts.status !== undefined) q.status = opts.status;
      if (opts.category !== undefined) q.category = opts.category;
      if (opts.limit !== undefined) q.limit = opts.limit;
      if (cursor !== undefined) q.cursor = cursor;
      const data = await this.get("/markets/", q);
      items.push(...extractItems(data));
      const next = data?.nextCursor ?? data?.next_cursor;
      if (next === null || next === undefined || next === "") break;
      const key = String(next);
      if (seen.has(key)) break; // loop guard
      seen.add(key);
      cursor = key;
    }
    return items;
  }

  getMarket(id: string): Promise<any> {
    return this.get(`/markets/${id}/`);
  }

  getMarketTrades(id: string, limit?: number): Promise<any> {
    return this.get(`/markets/${id}/trades/`, limit === undefined ? undefined : { limit });
  }
}

/** Pull the array of items out of a paginated response of unknown envelope. */
export function extractItems(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["items", "markets", "data", "results"]) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}
