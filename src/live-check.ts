/**
 * Live smoke check against the real APIs (run from GitHub Actions via workflow_dispatch).
 * Prints counts and a few example rows only. Never prints keys.
 * Exit code: 1 if the Panta list call fails (or PANTA_API_KEY is missing), 0 otherwise.
 */
import { pathToFileURL } from "node:url";
import { PantaClient } from "./panta/client.ts";
import { parseMarket } from "./parse/market.ts";
import type { Contract } from "./parse/market.ts";
import { SolamiClient } from "./feed/solami.ts";
import { Engine } from "./engine.ts";
import type { HlLike, PantaLike, SolamiLike } from "./engine.ts";
import { HyperliquidClient } from "./feed/hyperliquid.ts";
import { venueFor } from "./assets/venue.ts";
import { categoryRank, extractCategory, extractMarketId, extractTitle } from "./panta/extract.ts";
import { redactSecrets } from "./util/redact.ts";

/** Default maximum detail requests used to learn market text for list rows that have no title. */
const MAX_DETAILS = 60;

export type LiveCheckDeps = {
  panta?: PantaLike;
  solami?: SolamiLike;
  /** Hyperliquid needs no key, so a real client is always tried, except when a fake Panta is injected (tests). */
  hyperliquid?: HlLike | null;
  log?: (line: string) => void;
};

export async function runLiveCheck(env: Record<string, string | undefined>, deps: LiveCheckDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const secrets = [env.PANTA_API_KEY, env.SOLAMI_API_KEY];
  const safe = (e: unknown) => redactSecrets(String((e as Error)?.message ?? e), secrets);

  const panta = deps.panta ?? (env.PANTA_API_KEY ? new PantaClient({ apiKey: env.PANTA_API_KEY }) : null);
  if (!panta) {
    log("PANTA_API_KEY is not set; cannot list markets.");
    return 1;
  }

  let items: any[];
  try {
    items = [];
    const seenIds = new Set<string>();
    for (const status of ["primary", "secondary"]) {
      for (const item of await panta.listMarkets({ status })) {
        const id = extractMarketId(item);
        if (id !== null) {
          if (seenIds.has(id)) continue; // a market can be listed in more than one phase
          seenIds.add(id);
        }
        items.push(item);
      }
    }
  } catch (e) {
    log(`Panta list call failed: ${safe(e)}`);
    return 1;
  }

  // List rows usually have no title; the detail endpoint does. Fetch details for empty-title rows (crypto, stocks,
  // commodities and finance first, at most MAX_DETAILS) and parse the detail text.
  const programIds = new Set<string>();
  const detailByIndex = new Map<number, any>();
  const cap = Number.parseInt(env.ODDSFLOW_MAX_DETAILS ?? "", 10);
  const maxDetails = Number.isFinite(cap) && cap > 0 ? Math.min(cap, 500) : MAX_DETAILS;
  const needText = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => extractTitle(item) === "" && extractMarketId(item) !== null)
    .sort((a, b) => categoryRank(extractCategory(a.item)) - categoryRank(extractCategory(b.item)) || a.index - b.index)
    .slice(0, maxDetails);
  let detailFailures = 0;
  for (const { item, index } of needText) {
    try {
      const d = await panta.getMarket(extractMarketId(item) as string);
      detailByIndex.set(index, d);
      if (typeof d?.programId === "string" && d.programId !== "") programIds.add(d.programId);
    } catch {
      detailFailures++;
    }
  }
  // Items as the engine will see them: the list row, with the detail's text filled in where the list had none.
  const merged = items.map((item, index) => {
    const d = detailByIndex.get(index);
    return d ? { ...item, title: d.title ?? item?.title, question: d.question ?? item?.question } : item;
  });

  const parsed: Array<{ item: any; title: string; contract: Contract }> = [];
  const byKind: Record<string, number> = {};
  let unsupported = 0;
  for (const item of merged) {
    const contract = parseMarket({ title: item?.title, question: item?.question });
    if (!contract) {
      unsupported++;
      continue;
    }
    parsed.push({ item, title: extractTitle(item), contract });
    byKind[contract.kind] = (byKind[contract.kind] ?? 0) + 1;
  }

  if (env.ODDSFLOW_DIAG === "1") {
    // Inventory by phase: how many markets exist outside primary/secondary (e.g. P2P, resolved)?
    for (const status of [undefined, "resolved", "cancelled"]) {
      try {
        const rows = await panta.listMarkets(status ? { status } : {});
        const phases: Record<string, number> = {};
        for (const r of rows) phases[String(r?.phase)] = (phases[String(r?.phase)] ?? 0) + 1;
        const titled = rows.filter((r: any) => extractTitle(r) !== "");
        const priceLike = titled.filter((r: any) => parseMarket({ title: r?.title }) !== null).length;
        log(`diag: inventory status=${status ?? "(none)"} rows=${rows.length} phases=${JSON.stringify(phases)} titled=${titled.length} parseable-by-list-title=${priceLike}`);
      } catch (e) {
        log(`diag: inventory status=${status ?? "(none)"} failed: ${safe(e)}`);
      }
    }
    // Shape diagnostics for the live API. Market text is public; no key material is printed.
    const keys = new Set<string>();
    for (const it of items) for (const k of Object.keys(it ?? {})) keys.add(k);
    const nonEmpty = (f: string) => items.filter((it) => typeof it?.[f] === "string" && it[f].trim() !== "").length;
    log(`diag: list row keys: ${[...keys].sort().join(",")}`);
    log(`diag: non-empty title=${nonEmpty("title")} question=${nonEmpty("question")} description=${nonEmpty("description")}`);
    for (const it of items.slice(0, 8)) log(`diag: list title=${JSON.stringify(it?.title)} category=${JSON.stringify(it?.category)}`);
    for (const it of items.slice(0, 10)) {
      const id = extractMarketId(it);
      if (!id) continue;
      try {
        const d = await panta.getMarket(id);
        const text = String(d?.title || d?.question || "");
        if (typeof d?.programId === "string" && d.programId !== "") programIds.add(d.programId);
        log(`diag: detail keys=${Object.keys(d ?? {}).sort().join(",")}`);
        log(`diag: detail text=${JSON.stringify(text.slice(0, 160))} yes=${JSON.stringify(d?.yesPrice)} -> ${JSON.stringify(parseMarket({ title: d?.title, question: d?.question }))}`);
      } catch (e) {
        log(`diag: detail failed: ${safe(e)}`);
      }
    }
  }

  if (env.ODDSFLOW_DIAG === "1") {
    log(`diag: details fetched for text=${needText.length - detailFailures} failed=${detailFailures} (list rows with empty title: ${items.filter((it) => extractTitle(it) === "").length})`);
    log(`diag: programIds seen: ${programIds.size ? [...programIds].sort().join(",") : "(none)"}`);
  }

  log(`total markets: ${items.length}`);
  log("parsed contracts by kind:");
  for (const [k, n] of Object.entries(byKind).sort()) log(`  ${k}: ${n}`);
  if (Object.keys(byKind).length === 0) log("  (none)");
  log(`unsupported: ${unsupported}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const live = parsed.filter((p) => p.contract.expiry > nowSec);
  log(`unexpired parsed: ${live.length}`);
  for (const p of live) log(`  live: ${JSON.stringify(p.title)} -> ${JSON.stringify(p.contract)}`);
  log("example parsed markets:");
  for (const p of parsed.slice(0, 5)) log(`  ${JSON.stringify(p.title)} -> ${JSON.stringify(p.contract)}`);

  // Hyperliquid: public, no key. A failure here is logged and never fails the run.
  const hl: HlLike | null = deps.hyperliquid !== undefined ? deps.hyperliquid : deps.panta === undefined ? new HyperliquidClient() : null;
  let universe = new Set<string>();
  if (hl) {
    try {
      universe = await hl.universe();
    } catch (e) {
      log(`Hyperliquid universe call failed: ${safe(e)}`);
    }
  }
  if (env.ODDSFLOW_DIAG === "1") {
    const assets = [...new Set(parsed.map((p) => p.contract.asset))].sort();
    log(`diag: hl universe has ${universe.size} coins; routed: ${assets.map((a) => `${a}=${venueFor(a, universe)}`).join(", ") || "(none)"}`);
  }

  const solami = deps.solami ?? (env.SOLAMI_API_KEY ? new SolamiClient({ apiKey: env.SOLAMI_API_KEY }) : null);
  if (!solami) log("SOLAMI_API_KEY is not set; skipping fair-value check.");

  // Hyperliquid-venue contracts: up to 5 unexpired ones. Solami-venue contracts: up to 5, preferring distinct assets.
  const hlPicked = hl ? live.filter((p) => venueFor(p.contract.asset, universe) === "hyperliquid").slice(0, 5) : [];
  const solamiCandidates = parsed.filter((p) => venueFor(p.contract.asset, universe) === "solami");
  const solamiPicked: typeof parsed = [];
  if (solami) {
    const seenAssets = new Set<string>();
    for (const p of solamiCandidates) {
      if (solamiPicked.length >= 5) break;
      if (!seenAssets.has(p.contract.asset)) {
        seenAssets.add(p.contract.asset);
        solamiPicked.push(p);
      }
    }
    for (const p of solamiCandidates) {
      if (solamiPicked.length >= 5) break;
      if (!solamiPicked.includes(p)) solamiPicked.push(p);
    }
  }
  if (hlPicked.length === 0 && solamiPicked.length === 0) return 0;

  try {
    const engine = new Engine({ panta, solami: solami ?? null, hyperliquid: hl, stream: null });
    engine.ingestMarkets([...hlPicked, ...solamiPicked].map((p) => p.item));
    const rows = await engine.runOnce();

    const f4 = (x: number | null) => (x === null ? "n/a" : x.toFixed(4));
    for (const r of rows.filter((x) => x.venue === "hyperliquid")) {
      const spot = r.spot === null ? "n/a" : String(Number(r.spot.toPrecision(8)));
      const sigma = r.sigma === null ? "n/a" : r.sigma.toFixed(3);
      const days = r.T === null ? "n/a" : ((r.T * 31_536_000) / 86_400).toFixed(2);
      const edge = r.edge === null ? "n/a" : (r.edge >= 0 ? "+" : "") + r.edge.toFixed(4);
      log(
        `fair: ${r.title} | venue=hyperliquid spot=${spot} sigma=${sigma} T=${days}d | panta_yes=${f4(r.yes)} fair=${f4(r.fair)} edge=${edge} launchBlind=${r.launchBlind}` +
          (r.reason ? ` reason=${r.reason}` : ""),
      );
    }
    if (solami) {
      log("fair-value rows:");
      const solRows = rows.filter((x) => x.venue !== "hyperliquid");
      for (const r of solRows) {
        log(
          "  " +
            JSON.stringify({
              title: r.title, asset: r.asset, kind: r.kind, yes: r.yes, fair: r.fair, edge: r.edge,
              spot: r.spot, sigma: r.sigma, T: r.T, confidence: r.confidence, reason: r.reason ?? null,
            }),
        );
      }
      if (solRows.length === 0) log("  (no rows)");
    }
  } catch (e) {
    log(`fair-value check failed: ${safe(e)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveCheck(process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error("fatal:", redactSecrets(String((e as Error)?.message ?? e), [process.env.PANTA_API_KEY, process.env.SOLAMI_API_KEY]));
      process.exit(1);
    },
  );
}
