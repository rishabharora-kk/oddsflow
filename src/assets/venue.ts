/**
 * Which data path prices an asset.
 *  - SOL is always priced on the Solana-native path (Solami), even though Hyperliquid also lists it.
 *  - Any other asset Hyperliquid lists (BTC, ETH, HYPE, ZEC, ...) is priced from Hyperliquid mids and candles.
 *  - Everything else (long-tail Solana tokens, tokenised stocks and commodities) goes to Solami, where an
 *    asset with no mint honestly ends up as "no mint".
 */
export type Venue = "hyperliquid" | "solami";

export function venueFor(asset: string, hlUniverse: Set<string>): Venue | null {
  if (typeof asset !== "string" || asset.trim() === "") return null;
  const a = asset.trim().toUpperCase();
  if (a === "SOL") return "solami";
  return hlUniverse.has(a) ? "hyperliquid" : "solami";
}

export const VENUE_LABEL: Record<Venue, string> = { hyperliquid: "Hyperliquid mid", solami: "Solami DEX" };
