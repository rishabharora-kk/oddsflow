/**
 * Symbol -> Solana mint resolution.
 *
 * Only SOL and USDC are hardcoded (well-known mints). Everything else goes
 * through Solami's token search and is therefore best-effort: a symbol search
 * can return a wrapped/bridged token that is not the underlying asset.
 */

const STATIC: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export function staticMint(symbol: string): string | null {
  if (typeof symbol !== "string") return null;
  return STATIC[symbol.trim().toUpperCase()] ?? null;
}

export type ResolvedMint = { mint: string; source: "static" | "solami-search" };

/** Anything with a token-search method; the real SolamiClient satisfies this. */
export type MintSearcher = { search(q: string): Promise<unknown> };

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const firstNum = (o: any, keys: string[]): number | null => {
  for (const k of keys) {
    const n = num(o?.[k]);
    if (n !== null) return n;
  }
  return null;
};

const firstStr = (o: any, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
};

function findResultArray(json: any): any[] | null {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of ["data", "results", "tokens", "items", "pairs", "result"]) {
      const v = json[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const inner = findResultArray(v);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** Pure part of resolveMint: choose the best exact-symbol match from a search response. */
export function pickMintFromSearch(json: unknown, symbol: string): string | null {
  const arr = findResultArray(json);
  if (!arr) {
    console.warn(`[resolve] unrecognised token-search response shape for ${symbol}`);
    return null;
  }
  const want = symbol.trim().toUpperCase();
  const matches: Array<{ mint: string; liq: number | null; vol: number | null }> = [];
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const sym = firstStr(t, ["symbol", "ticker"]);
    if (sym === null || sym.toUpperCase() !== want) continue;
    const mint = firstStr(t, ["address", "mint", "token_address", "tokenAddress"]);
    if (mint === null || !BASE58_MINT.test(mint)) continue;
    matches.push({
      mint,
      liq: firstNum(t, ["liquidity", "liquidity_usd", "liquidityUsd", "liquidityUSD"]),
      vol: firstNum(t, ["volume", "volume_usd", "volumeUsd", "volume_24h", "volume24h", "volume_24h_usd"]),
    });
  }
  if (matches.length === 0) return null;
  const score = (m: { liq: number | null; vol: number | null }) => [m.liq ?? -1, m.vol ?? -1];
  matches.sort((a, b) => {
    const [al, av] = score(a);
    const [bl, bv] = score(b);
    return bl - al || bv - av;
  });
  return matches[0].mint;
}

export async function resolveMint(symbol: string, solami: MintSearcher): Promise<ResolvedMint | null> {
  const st = staticMint(symbol);
  if (st) return { mint: st, source: "static" };
  let json: unknown;
  try {
    json = await solami.search(symbol);
  } catch (e) {
    console.warn(`[resolve] token search failed for ${symbol}: ${(e as Error)?.message ?? "error"}`);
    return null;
  }
  const mint = pickMintFromSearch(json, symbol);
  return mint ? { mint, source: "solami-search" } : null;
}
