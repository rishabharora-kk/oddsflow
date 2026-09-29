# oddsflow

Fair probabilities for [Panta](https://www.panta.market) price markets, priced against the underlying asset on Solana DEXs.

oddsflow is an entry to the Colosseum Crypto World's Fair (Panta and Solami sidetracks). It is **strictly read-only**: it never trades, signs, creates markets or broadcasts anything.

## What it does and why

Many Panta markets are templated price questions, for example:

> Will Ethereum (ETH) close at or above $2,700.00 on Wednesday, September 30, 2026, at 11:59 PM BST?

The answer to such a question is a function of the asset's current price, how volatile it is, and how long is left. oddsflow:

1. lists Panta's markets and parses the templated ones into a typed contract (`close_above`, `close_below`, `touch_above`, `touch_below`, `mcap_touch_above`);
2. resolves the asset to a Solana mint and reads its live price, 1h candles and supply from [Solami](https://solami.dev);
3. computes a **fair probability** from a lognormal model using realised volatility;
4. shows it next to Panta's YES price, with the **edge** (`fair - YES`).

If a market cannot be parsed with certainty it is unsupported (`null`), never guessed. Correctness and honesty come before coverage.

## Architecture

```
  Panta REST (GET only, allowlisted)         Solami REST + WebSocket
  /markets/ /markets/{id}/ ...               price / ohlcv / supply / search, swap stream
            |                                            |
      PantaClient                                  SolamiClient / BlurStream
   (allowlist, 120/min                        (rolling median of 15 swaps,
    token bucket, 429 retry)                   REST poll fallback, backoff)
            |                                            |
            v                                            v
      parseMarket() --> Contract --+--> resolveMint() --> spot, sigma, supply
                                   |
                                   v
                              fairValue()   (pure maths, src/model/fair.ts)
                                   |
                                   v
                                Engine  --> rows { yes, fair, edge, confidence, stale, reason }
                                   |
                     +-------------+--------------+
                     v                            v
              GET /api/rows                 GET /events (SSE)  ->  GET /  (sortable table)
```

## The model

Notation: `S` spot price, `K` strike, `sigma` annualised volatility, `T` years to expiry (`(expiry - now) / 31,536,000 s`), `N` the standard normal CDF. The price follows a driftless lognormal process (`ln S` has drift `-sigma^2/2`, so `S` is a martingale).

```
close above K:   P = N(d2),    d2 = (ln(S/K) - sigma^2 T / 2) / (sigma sqrt(T))
close below K:   P = 1 - N(d2)

touch above K (S < K):  b = ln(K/S),  v = sigma sqrt(T)
  P = N((-b - sigma^2 T/2) / v) + (S/K) * N((-b + sigma^2 T/2) / v)      (P = 1 if S >= K)

touch below K (S > K):  b = ln(S/K)
  P = N((-b + sigma^2 T/2) / v) + (S/K) * N((-b - sigma^2 T/2) / v)      (P = 1 if S <= K)

market-cap target M:    K = M / supply, then touch above K
```

If `T <= 0` or `sigma <= 0`, close contracts resolve to 1 or 0 by comparing `S` with `K`, and touch contracts to 0 (if not already touched).

Volatility is the sample standard deviation of log returns of the last 168 hourly closes, annualised by `sqrt(31,536,000 / 3600)`. `normCdf` uses a series for `|x|` below 2 and a continued fraction above, and matches Python's `math.erfc` to about 1e-15.

Confidence is `low` when there are fewer than 48 candles, the spot is more than 120 s old, or less than 1 hour remains; otherwise `high`. The UI additionally forces `low` when the Panta price is stale.

## Setup

Requires Node 22. No dependencies to install.

```
export PANTA_API_KEY=...     # Panta REST API key
export SOLAMI_API_KEY=...    # Solami data API key

npm test                     # unit tests (node:test), no network
npm start                    # serves http://localhost:3000  (PORT and HOST env vars are honoured)
npm run live-check           # smoke test against the real APIs; prints counts only
```

Keys are read only from those two environment variables and are never logged, printed or served. The `live-check` GitHub Actions workflow (`workflow_dispatch` only) runs the tests and the live check with the keys from repository secrets.

## Read-only guarantees

- `PantaClient.get` calls `assertAllowed` before any network call. Only `GET` is permitted, and only these paths (trailing slash required, `{id}` and `{w}` are base58 of 32 to 44 characters):
  - `/markets/`
  - `/markets/{id}/`
  - `/markets/{id}/trades/`
  - `/wallets/{w}/trades/`
  - `/positions/`
  - `/categories/`
- Anything else throws `ForbiddenPathError` without touching the network (tested with a fetch spy).
- There is no wallet, key-pair or transaction code anywhere in the project.
- Zero runtime dependencies: only global `fetch`, global `WebSocket` and `node:http`.
- The UI never presents stale data as live: rows with a spot older than 120 s or a Panta price older than 180 s carry a "stale" badge, are dimmed and are forced to low confidence; if the browser loses its connection to the server, every row is marked as not live.

## Limitations

- **Driftless lognormal.** No drift, no jumps, no volatility smile or clustering. Crypto returns are fat-tailed, so tail probabilities are likely understated. Volatility is backward-looking (7 days of hourly candles).
- **Touch probabilities assume continuous monitoring.** Real resolution may use discrete prices, which makes the model slightly high.
- **Wrapped or tokenised assets can deviate from the underlying.** Only SOL and USDC are hardcoded. Every other symbol is resolved by a Solami symbol search (exact symbol match, highest liquidity), which can return a bridged token or a different token with the same ticker. Such rows carry a note. Panta may resolve against a different price source than a Solana DEX.
- **Solami response shapes are unverified.** Extractors accept several plausible shapes and return null rather than guess, but a shape change means "no data", not wrong data. Panta response shapes (`nextCursor`, YES price field names, the `status` list filter) are likewise handled defensively and are unverified; run `npm run live-check` with real keys to confirm.
- **Market-cap contracts** need a supply figure. Circulating supply is preferred; if only total supply is available the row is marked low confidence.
- **Parser scope.** Only the templated question shapes are supported (see `src/parse/market.ts`). A `close` question needs an exact settlement time; ambiguous, relational or relative-time questions are unsupported.
- **Not financial advice.** This is a research tool. Fair values are model output, not predictions or recommendations.

## Built with AI assistance

The code was written with an AI coding assistant, and reviewed and tested by the author.

## Licence

MIT, see [LICENSE](LICENSE).

Powered by Panta. Data: Solami.
