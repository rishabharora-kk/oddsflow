import { normalizePrice } from "./client.ts";

/** Panta market id from a list/detail item (field name unverified, so several are accepted). */
export function extractMarketId(m: any): string | null {
  if (!m || typeof m !== "object") return null;
  for (const k of ["id", "marketId", "market_id", "address", "publicKey", "pubkey"]) {
    const v = m[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * The YES price as a 0..1 probability, or null. Only fields explicitly named
 * for YES are read; a generic `price` is never assumed to be the YES side.
 */
export function extractYesPrice(m: any): number | null {
  if (!m || typeof m !== "object") return null;
  const direct = ["yesPrice", "yes_price", "priceYes", "price_yes", "lastYesPrice", "last_yes_price"];
  for (const k of direct) {
    const p = normalizePrice(m[k]);
    if (p !== null) return p;
  }
  for (const holder of ["prices", "price", "outcomePrices", "outcome_prices"]) {
    const h = m[holder];
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const k of ["yes", "YES", "Yes"]) {
        const p = normalizePrice(h[k]);
        if (p !== null) return p;
      }
    }
  }
  const outs = m.outcomes;
  if (Array.isArray(outs)) {
    for (const o of outs) {
      const name = String(o?.name ?? o?.label ?? o?.outcome ?? "").trim().toLowerCase();
      if (name === "yes") {
        for (const k of ["price", "lastPrice", "last_price", "probability"]) {
          const p = normalizePrice(o[k]);
          if (p !== null) return p;
        }
      }
    }
  }
  return null;
}

export function extractTitle(m: any): string {
  for (const k of ["title", "question"]) {
    const v = m?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}
