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
import { extractMarketId, extractTitle } from "./panta/extract.ts";
import { redactSecrets } from "./util/redact.ts";

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

  const parsed: Array<{ item: any; title: string; contract: Contract }> = [];
  const byKind: Record<string, number> = {};
  let unsupported = 0;
  for (const item of items) {
    const contract = parseMarket({ title: item?.title, question: item?.question });
    if (!contract) {
      unsupported++;
      continue;
    }
    parsed.push({ item, title: extractTitle(item), contract });
    byKind[contract.kind] = (byKind[contract.kind] ?? 0) + 1;
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
