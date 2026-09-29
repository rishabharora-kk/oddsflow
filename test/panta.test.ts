import test from "node:test";
import assert from "node:assert/strict";
import { ForbiddenPathError, PantaClient, assertAllowed, normalizePrice } from "../src/panta/client.ts";
import { extractMarketId, extractTitle, extractYesPrice } from "../src/panta/extract.ts";
import { TokenBucket } from "../src/util/ratelimit.ts";
import { isStale } from "../src/util/stale.ts";
import { redactSecrets } from "../src/util/redact.ts";

const ID = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // 44 base58 chars
const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // 44 base58 chars

function jsonRes(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

test("assertAllowed accepts the six allowlisted GET patterns", () => {
  for (const p of ["/markets/", `/markets/${ID}/`, `/markets/${ID}/trades/`, `/wallets/${W}/trades/`, "/positions/", "/categories/", "/markets/?limit=5"]) {
    assert.doesNotThrow(() => assertAllowed("GET", p), p);
  }
  assert.doesNotThrow(() => assertAllowed("get", "/markets/"));
});

test("assertAllowed rejects everything else", () => {
  assert.throws(() => assertAllowed("POST", "/markets/"), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", "/primaryorderbuild/"), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", "/markets/abc/"), ForbiddenPathError); // not base58-length
  assert.throws(() => assertAllowed("GET", "/markets"), ForbiddenPathError); // no trailing slash
  assert.throws(() => assertAllowed("GET", `/markets/${ID}`), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", `/markets/${ID}/trades`), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", `/markets/${ID}/orders/`), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", `/markets/${"0".repeat(44)}/`), ForbiddenPathError); // 0 is not base58
  assert.throws(() => assertAllowed("GET", `/markets/${"1".repeat(45)}/`), ForbiddenPathError); // too long
  assert.throws(() => assertAllowed("GET", "/markets/../positions/x/"), ForbiddenPathError);
  assert.throws(() => assertAllowed("GET", "/markets/\n"), ForbiddenPathError);
  for (const m of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) assert.throws(() => assertAllowed(m, "/markets/"), ForbiddenPathError);
});

test("PantaClient never calls fetch for a forbidden path", async () => {
  let calls = 0;
  const spy = (async () => { calls++; return jsonRes({}); }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: spy });
  for (const p of ["/primaryorderbuild/", "/markets", "/markets/abc/", "/orders/", "/wallets/x/"]) {
    await assert.rejects(() => c.get(p), ForbiddenPathError);
  }
  await assert.rejects(() => c.getMarket("abc"), ForbiddenPathError);
  await assert.rejects(() => c.getMarketTrades("../x"), ForbiddenPathError);
  assert.equal(calls, 0);
  await c.get("/markets/");
  assert.equal(calls, 1);
});

test("PantaClient sends X-Api-Key, builds the URL and returns JSON", async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => { seen.push({ url, init }); return jsonRes({ ok: true }); }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "secret-key-123", fetchImpl: f });
  assert.deepEqual(await c.get("/markets/", { status: "primary", limit: 5 }), { ok: true });
  assert.equal(seen[0].url, "https://live-api.panta.market/api/v1/markets/?status=primary&limit=5");
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.headers["X-Api-Key"], "secret-key-123");
  assert.equal(JSON.stringify(c).includes("secret-key-123"), false, "key must not be serialisable from the client object");
});

test("PantaClient error message includes the response JSON code", async () => {
  const f = (async () => jsonRes({ code: "MARKET_NOT_FOUND", message: "nope" }, { status: 404 })) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f });
  await assert.rejects(() => c.get("/markets/"), (e: Error) => e.message.includes("MARKET_NOT_FOUND") && e.message.includes("404"));
});

test("PantaClient retries 429 after Retry-After plus jitter, max 3 retries", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const f = (async () => {
    calls++;
    return calls <= 2 ? jsonRes({ code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "2" } }) : jsonRes({ ok: 1 });
  }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await c.get("/markets/"), { ok: 1 });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  for (const s of sleeps) assert.ok(s >= 2000 && s < 3000, `sleep ${s}`);

  // Always 429: 1 try + 3 retries, then throws with the code. Default wait is 5 s.
  calls = 0;
  sleeps.length = 0;
  const always = (async () => { calls++; return jsonRes({ code: "RATE_LIMITED" }, { status: 429 }); }) as unknown as typeof fetch;
  const c2 = new PantaClient({ apiKey: "k", fetchImpl: always, sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(() => c2.get("/markets/"), /RATE_LIMITED/);
  assert.equal(calls, 4);
  assert.equal(sleeps.length, 3);
  for (const s of sleeps) assert.ok(s >= 5000 && s < 6000, `sleep ${s}`);
});

test("PantaClient rate limits itself to 120 requests per 60 s", async () => {
  let t = 0;
  const sleeps: number[] = [];
  const f = (async () => jsonRes({})) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  for (let i = 0; i < 120; i++) await c.get("/markets/");
  assert.equal(sleeps.length, 0);
  await c.get("/markets/");
  assert.ok(sleeps.length >= 1, "121st request must wait");
  assert.ok(t >= 60_000 - 1);
});

test("listMarkets follows nextCursor and next_cursor, and stops on null", async () => {
  const cursors: Array<string | null> = [];
  const pages: Record<string, any> = {
    "": { items: [{ id: 1 }], nextCursor: "a" },
    a: { markets: [{ id: 2 }], next_cursor: "b" },
    b: { data: [{ id: 3 }], nextCursor: null },
  };
  const f = (async (url: string) => {
    const cur = new URL(url).searchParams.get("cursor");
    cursors.push(cur);
    return jsonRes(pages[cur ?? ""]);
  }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f });
  assert.deepEqual(await c.listMarkets({ status: "primary" }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(cursors, [null, "a", "b"]);
});

test("listMarkets stops on a repeated cursor", async () => {
  let calls = 0;
  const f = (async () => { calls++; return jsonRes({ items: [{ id: calls }], nextCursor: "same" }); }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f });
  const items = await c.listMarkets();
  assert.equal(calls, 2, "second page returns the cursor we already used, so we stop");
  assert.equal(items.length, 2);
});

test("listMarkets stops after 20 pages and on missing cursor", async () => {
  let calls = 0;
  const f = (async () => { calls++; return jsonRes({ items: [{ id: calls }], nextCursor: `c${calls}` }); }) as unknown as typeof fetch;
  const c = new PantaClient({ apiKey: "k", fetchImpl: f });
  assert.equal((await c.listMarkets()).length, 20);
  assert.equal(calls, 20);
  const g = (async () => jsonRes([{ id: 1 }, { id: 2 }])) as unknown as typeof fetch;
  assert.equal((await new PantaClient({ apiKey: "k", fetchImpl: g }).listMarkets()).length, 2);
});

test("normalizePrice", () => {
  assert.equal(normalizePrice("0.43"), 0.43);
  assert.equal(normalizePrice("430000000"), 0.43);
  assert.equal(normalizePrice(430000000), 0.43);
  assert.equal(normalizePrice(0.43), 0.43);
  assert.equal(normalizePrice(1), 1);
  assert.equal(normalizePrice(0), 0);
  assert.equal(normalizePrice(null), null);
  assert.equal(normalizePrice(undefined), null);
  assert.equal(normalizePrice(""), null);
  assert.equal(normalizePrice("abc"), null);
  assert.equal(normalizePrice("-0.2"), null);
  assert.equal(normalizePrice(Infinity), null);
});

test("TokenBucket: 120 succeed, 121st fails, succeeds again after the window", () => {
  let t = 1_000;
  const b = new TokenBucket(120, 60_000, () => t);
  for (let i = 0; i < 120; i++) assert.equal(b.tryTake(), true, `take ${i}`);
  assert.equal(b.msUntilNext(), 60_000);
  assert.equal(b.tryTake(), false);
  t += 59_999;
  assert.equal(b.tryTake(), false);
  assert.equal(b.msUntilNext(), 1);
  t += 1;
  assert.equal(b.msUntilNext(), 0);
  assert.equal(b.tryTake(), true);
});

test("TokenBucket: msUntilNext is 0 with capacity free; window slides", () => {
  let t = 0;
  const b = new TokenBucket(2, 100, () => t);
  assert.equal(b.msUntilNext(), 0);
  assert.equal(b.tryTake(), true);
  t = 50;
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  assert.equal(b.msUntilNext(), 50);
  t = 100; // first take falls out of the window, second has not
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
});

test("isStale", () => {
  assert.equal(isStale(1000, 1120), false);
  assert.equal(isStale(1000, 1121), true);
  assert.equal(isStale(1000, 1050, 30), true);
});

test("redactSecrets", () => {
  assert.equal(redactSecrets("bad key abcd1234 here", ["abcd1234"]), "bad key [redacted] here");
  assert.equal(redactSecrets("GET /x?api_key=zzz&q=1", []), "GET /x?api_key=[redacted]&q=1");
});

test("panta extractors", () => {
  assert.equal(extractMarketId({ id: ID }), ID);
  assert.equal(extractMarketId({ marketId: ID }), ID);
  assert.equal(extractMarketId({}), null);
  assert.equal(extractTitle({ title: " ", question: "Q?" }), "Q?");
  assert.equal(extractYesPrice({ yesPrice: "430000000" }), 0.43);
  assert.equal(extractYesPrice({ yes_price: 0.61 }), 0.61);
  assert.equal(extractYesPrice({ prices: { yes: "0.2", no: "0.8" } }), 0.2);
  assert.equal(extractYesPrice({ outcomes: [{ name: "No", price: 0.7 }, { name: "Yes", price: 0.3 }] }), 0.3);
  assert.equal(extractYesPrice({ price: 0.5 }), null, "a bare price is never assumed to be the YES side");
  assert.equal(extractYesPrice({}), null);
});
