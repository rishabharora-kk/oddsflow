/**
 * One-shot snapshot for the static GitHub Pages site (`npm run snapshot`).
 *
 * Runs the engine's full refresh once (Panta list and details, Hyperliquid, Solami if configured), then writes
 *   dist/rows.json   {generatedAt, generatedAtIso, launchBlindCount, rows, sources}
 *   dist/index.html  the same UI as the live server, in static mode
 *
 * Exit code 0 when Panta succeeded (other sources may have failed; that is recorded in `sources`).
 * Exit code 1 when Panta failed, and then NOTHING is written, so the previous deployment stays up.
 * Keys are read only from PANTA_API_KEY / SOLAMI_API_KEY and are never written anywhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Engine } from "./engine.ts";
import type { HlLike, PantaLike, SolamiLike } from "./engine.ts";
import { PantaClient } from "./panta/client.ts";
import { SolamiClient } from "./feed/solami.ts";
import { HyperliquidClient } from "./feed/hyperliquid.ts";
import { buildStaticPage } from "./page.ts";
import { redactSecrets } from "./util/redact.ts";

export type SnapshotDeps = {
  panta?: PantaLike;
  solami?: SolamiLike | null;
  /** Hyperliquid needs no key, so a real client is used, except when a fake Panta is injected (tests). */
  hyperliquid?: HlLike | null;
  outDir?: string;
  now?: () => number;
  log?: (line: string) => void;
};

const msgOf = (e: unknown) => String((e as Error)?.message ?? e);

export type Sources = { panta: string; hyperliquid: string; solami: string };

/**
 * Records the first failure of an upstream so it can be reported in `sources` without aborting the snapshot.
 * `redact` scrubs secrets from every message, including the ones the engine later logs.
 */
class Health {
  first: string | null = null;
  redact: (s: string) => string;
  constructor(redact: (s: string) => string) {
    this.redact = redact;
  }
  /** Record the failure and return a redacted copy of the error for rethrowing. */
  fail(e: unknown): Error {
    const msg = this.redact(String((e as Error)?.message ?? e));
    if (this.first === null) this.first = msg;
    return new Error(msg);
  }
  note(msg: string): void {
    if (this.first === null) this.first = msg;
  }
}

function trackHl(hl: HlLike, h: Health): HlLike {
  return {
    universe: async () => {
      try {
        const u = await hl.universe();
        if (u.size === 0) h.note("empty or unrecognised universe response");
        return u;
      } catch (e) {
        throw h.fail(e);
      }
    },
    mids: async () => {
      try {
        const m = await hl.mids();
        if (Object.keys(m).length === 0) h.note("empty or unrecognised mids response");
        return m;
      } catch (e) {
        throw h.fail(e);
      }
    },
    closes: async (coin, interval, hours) => {
      try {
        return await hl.closes(coin, interval, hours);
      } catch (e) {
        throw h.fail(e);
      }
    },
  };
}

function trackSolami(s: SolamiLike, h: Health): SolamiLike {
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      throw h.fail(e);
    }
  };
  return {
    search: wrap((q: string) => s.search(q)),
    price: wrap((m: string) => s.price(m)),
    ohlcv: wrap((m: string, i: "1h", l: number) => s.ohlcv(m, i, l)),
    supply: wrap((m: string) => s.supply(m)),
  };
}

export async function runSnapshot(env: Record<string, string | undefined>, deps: SnapshotDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const secrets = [env.PANTA_API_KEY, env.SOLAMI_API_KEY];
  const safe = (s: string) => redactSecrets(s, secrets).slice(0, 300);
  const now = deps.now ?? Date.now;

  const pantaBase = deps.panta ?? (env.PANTA_API_KEY ? new PantaClient({ apiKey: env.PANTA_API_KEY }) : null);
  if (!pantaBase) {
    log("snapshot failed: PANTA_API_KEY is not set");
    return 1;
  }
  const solamiBase = deps.solami !== undefined ? deps.solami : env.SOLAMI_API_KEY ? new SolamiClient({ apiKey: env.SOLAMI_API_KEY }) : null;
  const hlBase: HlLike | null =
    deps.hyperliquid !== undefined ? deps.hyperliquid : deps.panta === undefined ? new HyperliquidClient() : null;

  const hlHealth = new Health(safe);
  const solamiHealth = new Health(safe);
  const engine = new Engine({
    panta: pantaBase,
    solami: solamiBase ? trackSolami(solamiBase, solamiHealth) : null,
    hyperliquid: hlBase ? trackHl(hlBase, hlHealth) : null,
    stream: null,
    now,
  });

  // Panta is the one source that must work: without it there is nothing to publish.
  try {
    await engine.loadMarkets();
    if (engine.status().markets === 0) throw new Error("Panta returned no markets");
  } catch (e) {
    log(`snapshot failed: Panta: ${safe(msgOf(e))}`);
    return 1;
  }

  try {
    await engine.fetchDetails();
    await engine.refreshAssetData();
    await engine.refreshSpots();
  } catch (e) {
    // Per-source failures are swallowed inside the engine; anything reaching here is unexpected but not Panta-fatal.
    log(`snapshot: refresh error: ${safe(msgOf(e))}`);
  }

  const generatedAt = Math.floor(now() / 1000);
  const rows = engine.computeRows(now() / 1000);
  const sources: Sources = {
    panta: "ok",
    hyperliquid: !hlBase ? "not configured" : hlHealth.first ? `error: ${safe(hlHealth.first)}` : "ok",
    solami: !solamiBase ? "not configured" : solamiHealth.first ? `error: ${safe(solamiHealth.first)}` : "ok",
  };
  const snapshot = {
    generatedAt,
    generatedAtIso: new Date(generatedAt * 1000).toISOString(),
    launchBlindCount: engine.status().launchBlind,
    rows,
    sources,
  };

  const outDir = deps.outDir ?? "dist";
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "rows.json"), JSON.stringify(snapshot, null, 2) + "\n");
  await writeFile(join(outDir, "index.html"), buildStaticPage(generatedAt));

  const withFair = rows.filter((r) => r.fair !== null).length;
  log(`snapshot written to ${outDir}/: ${rows.length} markets, ${withFair} with a fair value, ${snapshot.launchBlindCount} launch-blind`);
  log(`sources: panta=${sources.panta} hyperliquid=${sources.hyperliquid} solami=${sources.solami}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Watchdog: a hung upstream must not hang the Action. Exiting 1 keeps the previous deployment.
  const timer = setTimeout(() => {
    console.error("snapshot failed: timed out after 8 minutes");
    process.exit(1);
  }, 8 * 60_000);
  timer.unref();
  runSnapshot(process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error("snapshot failed:", redactSecrets(msgOf(e), [process.env.PANTA_API_KEY, process.env.SOLAMI_API_KEY]));
      process.exit(1);
    },
  );
}
