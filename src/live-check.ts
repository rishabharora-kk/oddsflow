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
import type { PantaLike, SolamiLike } from "./engine.ts";
import { categoryRank, extractCategory, extractMarketId, extractTitle } from "./panta/extract.ts";
import { redactSecrets } from "./util/redact.ts";

/** Maximum detail requests used to learn market text for list rows that have no title. */
const MAX_DETAILS = 60;

export type LiveCheckDeps = {
  panta?: PantaLike;
  solami?: SolamiLike;
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
  const needText = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => extractTitle(item) === "" && extractMarketId(item) !== null)
    .sort((a, b) => categoryRank(extractCategory(a.item)) - categoryRank(extractCategory(b.item)) || a.index - b.index)
    .slice(0, MAX_DETAILS);
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
  log("example parsed markets:");
  for (const p of parsed.slice(0, 5)) log(`  ${JSON.stringify(p.title)} -> ${JSON.stringify(p.contract)}`);

  const solami = deps.solami ?? (env.SOLAMI_API_KEY ? new SolamiClient({ apiKey: env.SOLAMI_API_KEY }) : null);
  if (!solami) {
    log("SOLAMI_API_KEY is not set; skipping fair-value check.");
    return 0;
  }

  // Up to 5 contracts, preferring distinct assets so the check exercises more than one mint.
  const picked: typeof parsed = [];
  const seenAssets = new Set<string>();
  for (const p of parsed) {
    if (picked.length >= 5) break;
    if (!seenAssets.has(p.contract.asset)) {
      seenAssets.add(p.contract.asset);
      picked.push(p);
    }
  }
  for (const p of parsed) {
    if (picked.length >= 5) break;
    if (!picked.includes(p)) picked.push(p);
  }

  try {
    const engine = new Engine({ panta, solami, stream: null });
    engine.ingestMarkets(picked.map((p) => p.item));
    const rows = await engine.runOnce();
    log("fair-value rows:");
    for (const r of rows) {
      log(
        "  " +
          JSON.stringify({
            title: r.title, asset: r.asset, kind: r.kind, yes: r.yes, fair: r.fair, edge: r.edge,
            spot: r.spot, sigma: r.sigma, T: r.T, confidence: r.confidence, reason: r.reason ?? null,
          }),
      );
    }
    if (rows.length === 0) log("  (no rows)");
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
