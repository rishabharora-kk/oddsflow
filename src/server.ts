import http from "node:http";
import { pathToFileURL } from "node:url";
import type { Engine, Row } from "./engine.ts";
import { PAGE } from "./page.ts";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_SSE_CLIENTS = 200;
const SSE_MIN_INTERVAL_MS = 4_000;

export type ServerExtras = { hasPanta: boolean; hasSolami: boolean };

function visible(rows: Row[], all: boolean): Row[] {
  return all ? rows : rows.filter((r) => r.reason !== "unparsed");
}

/** Build the HTTP server around an engine. Does not listen; the caller does. */
export function createAppServer(engine: Engine, extras: ServerExtras = { hasPanta: true, hasSolami: true }): http.Server {
  const clients = new Set<http.ServerResponse>();
  let lastSent = 0;

  const statusJson = () => JSON.stringify({ ...engine.status(), ...extras });

  engine.onUpdate((rows) => {
    if (clients.size === 0) return;
    const now = Date.now();
    if (now - lastSent < SSE_MIN_INTERVAL_MS) return;
    lastSent = now;
    const payload = `event: rows\ndata: ${JSON.stringify(visible(rows, false))}\n\nevent: status\ndata: ${statusJson()}\n\n`;
    for (const res of clients) res.write(payload);
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": keep-alive\n\n");
  }, 25_000);
  heartbeat.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
      return;
    }
    const common = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

    if (url.pathname === "/") {
      res.writeHead(200, { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : PAGE);
      return;
    }
    if (url.pathname === "/api/rows") {
      const rows = engine.rows.length ? engine.rows : engine.computeRows();
      res.writeHead(200, { ...common, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(visible(rows, url.searchParams.get("all") === "1")));
      return;
    }
    if (url.pathname === "/api/status") {
      res.writeHead(200, { ...common, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(statusJson());
      return;
    }
    if (url.pathname === "/events") {
      if (clients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503).end("Too many clients");
        return;
      }
      res.writeHead(200, { ...common, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      res.write("retry: 5000\n\n");
      const rows = engine.rows.length ? engine.rows : engine.computeRows();
      res.write(`event: rows\ndata: ${JSON.stringify(visible(rows, false))}\n\nevent: status\ndata: ${statusJson()}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, common).end("Not Found");
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });
  return server;
}

async function main(): Promise<void> {
  const { PantaClient } = await import("./panta/client.ts");
  const { SolamiClient, BlurStream } = await import("./feed/solami.ts");
  const { Engine } = await import("./engine.ts");
  const { HyperliquidClient } = await import("./feed/hyperliquid.ts");

  const pantaKey = process.env.PANTA_API_KEY;
  const solamiKey = process.env.SOLAMI_API_KEY;
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  const failing = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not set`);
  };
  const panta = pantaKey
    ? new PantaClient({ apiKey: pantaKey })
    : { listMarkets: failing("PANTA_API_KEY"), getMarket: failing("PANTA_API_KEY") };
  const solami = solamiKey
    ? new SolamiClient({ apiKey: solamiKey })
    : { search: failing("SOLAMI_API_KEY"), price: failing("SOLAMI_API_KEY"), ohlcv: failing("SOLAMI_API_KEY"), supply: failing("SOLAMI_API_KEY") };
  const stream = solamiKey && solami instanceof SolamiClient ? new BlurStream({ apiKey: solamiKey, rest: solami }) : null;

  // Hyperliquid's public info API needs no key and is read-only (see assertHlAllowed).
  const engine = new Engine({ panta, solami, hyperliquid: new HyperliquidClient(), stream });
  const server = createAppServer(engine, { hasPanta: !!pantaKey, hasSolami: !!solamiKey });
  server.listen(port, host, () => {
    console.log(`oddsflow listening on http://${host}:${port} (read-only)`);
    if (!pantaKey) console.warn("PANTA_API_KEY is not set: no markets will load.");
    if (!solamiKey) console.warn("SOLAMI_API_KEY is not set: no prices will load.");
  });
  stream?.start();
  engine.start();

  const shutdown = () => {
    engine.stop();
    stream?.stop();
    server.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("fatal:", (e as Error)?.message ?? "error");
    process.exit(1);
  });
}
