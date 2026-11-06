# `DreamDexRest.fetchOrderbooks` URL-encodes commas (`%2C`) causing `HTTP 400 invalid_param`, and HTTP API docs falsely state unknown symbols are silently skipped

Severity: Major
Area: API / SDK / Docs

## Severity
Major (Multi-market orderbook fetching via `@dreamdex/core` fails with `HTTP 400`, and official HTTP API documentation misstates the error-handling contract of `/v0/orderbooks` and `/v0/tickers`)

## Area
API / SDK / Docs (`somnia-chain/dreamdex-bot-kit` — `packages/core/src/rest.ts`, `packages/core/src/networks.ts`, and `https://app.testnet.dreamdex.io/docs/developers/http-api/market-data`)

## Steps to reproduce
1. Inspect `packages/core/src/rest.ts` (lines 70–75) in `somnia-chain/dreamdex-bot-kit`:
   ```ts
   async fetchOrderbooks(symbols: string[], depth = 10): Promise<OrderbookSnapshot[]> {
     const qs = `symbols=${encodeURIComponent(symbols.join(","))}&depth=${depth}`;
     return this.get<OrderbookSnapshot[]>(`/orderbooks?${qs}`);
   }
   ```
2. Call `fetchOrderbooks(["SOMI:USDso", "WETH:USDso"])` or execute the equivalent `curl` against the default `apiBaseUrl` (`https://stg.api.dreamdex.io/v0` from `packages/core/src/networks.ts`) or `https://api.dreamdex.io/v0`:
   ```bash
   curl -i "https://stg.api.dreamdex.io/v0/orderbooks?symbols=SOMI%3AUSDso%2CWETH%3AUSDso&depth=5"
   curl -i "https://api.dreamdex.io/v0/orderbooks?symbols=SOMI%3AUSDso%2CWETH%3AUSDso&depth=5"
   ```
3. Next, compare the HTTP API behavior for unknown symbols on `/v0/orderbooks` and `/v0/tickers` against the official documentation at `https://app.testnet.dreamdex.io/docs/developers/http-api/market-data`:
   > *"Unknown symbols on `/v0/orderbooks` and `/v0/tickers` are silently skipped rather than erroring, so a serialization mismatch shows up as an empty `[]` rather than a 4xx."*
   Run:
   ```bash
   curl -i "https://api.testnet.dreamdex.io/v0/orderbooks?symbols=BTC-PERP"
   curl -i "https://api.testnet.dreamdex.io/v0/tickers?symbols=UNKNOWN_SYMBOL"
   ```

## Expected
1. `DreamDexRest.fetchOrderbooks(symbols, depth)` should format multi-symbol query parameters in the format the DreamDEX REST API accepts, or query per-symbol when the server treats comma-joined strings as a single literal symbol name `"SOMI:USDso,WETH:USDso"`.
2. Either `/v0/orderbooks` and `/v0/tickers` should silently skip unknown symbols and return `200 OK []` as documented, or `https://app.testnet.dreamdex.io/docs/developers/http-api/market-data` must be updated to warn developers that unknown symbols return `HTTP 400 {"name":"invalid_param","description":"unknown market symbols: ..."}`.
3. `packages/core/src/networks.ts` should use `https://api.testnet.dreamdex.io/v0` for `testnet` instead of `https://stg.api.dreamdex.io/v0` (which only indexes 1 market `ETH:USDC` rather than the 8 Shannon testnet markets on `api.testnet.dreamdex.io`).

## Actual
1. Both `https://stg.api.dreamdex.io/v0/orderbooks` and `https://api.dreamdex.io/v0/orderbooks` treat `symbols=SOMI%3AUSDso%2CWETH%3AUSDso` (and even unencoded `symbols=SOMI:USDso,WETH:USDso` on `stg.api`) as a single unknown symbol and return `HTTP 400 Bad Request`:
   ```json
   {"name":"invalid_param","description":"unknown market symbols: SOMI:USDso,WETH:USDso"}
   ```
2. All three REST endpoints (`stg.api.dreamdex.io`, `api.testnet.dreamdex.io`, `api.dreamdex.io`) return `HTTP 400 invalid_param` instead of `[]` whenever an unknown symbol (or a Perps symbol like `BTC-PERP`) is passed to `/v0/orderbooks` or `/v0/tickers`, directly contradicting the HTTP API docs.

## Evidence
Live `curl` responses captured against `api.testnet.dreamdex.io`, `stg.api.dreamdex.io`, and `api.dreamdex.io`:

```text
$ curl -i -s "https://api.testnet.dreamdex.io/v0/orderbooks?symbols=BTC-PERP"
HTTP/2 400 
content-type: application/json
date: Fri, 06 Nov 2026 03:56:10 GMT

{"name":"invalid_param","description":"unknown market symbols: BTC-PERP"}

$ curl -i -s "https://api.testnet.dreamdex.io/v0/tickers?symbols=UNKNOWN_SYMBOL"
HTTP/2 400 
content-type: application/json
date: Fri, 06 Nov 2026 03:56:12 GMT

{"name":"invalid_param","description":"unknown market symbols: UNKNOWN_SYMBOL"}

$ curl -i -s "https://stg.api.dreamdex.io/v0/orderbooks?symbols=SOMI%3AUSDso%2CWETH%3AUSDso&depth=5"
HTTP/2 400 
content-type: application/json
date: Fri, 06 Nov 2026 03:56:15 GMT

{"name":"invalid_param","description":"unknown market symbols: SOMI:USDso,WETH:USDso"}
```

## Environment
- **Endpoints Tested**:
  - `https://stg.api.dreamdex.io/v0`
  - `https://api.testnet.dreamdex.io/v0`
  - `https://api.dreamdex.io/v0`
- **Docs URL**: `https://app.testnet.dreamdex.io/docs/developers/http-api/market-data`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`packages/core/src/rest.ts`, `packages/core/src/networks.ts`)
