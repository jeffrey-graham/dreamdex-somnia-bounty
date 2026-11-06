# `docs.dreamdex.io` returns `HTTP 308` to `https://app.dreamdex.io/docs` and strips the entire URL path, breaking all deep documentation links in `dreamdex-bot-kit`

Severity: Normal
Area: Docs / Web App

## Severity
Normal (Every deep documentation link in `dreamdex-bot-kit` READMEs, source comments, and error hints redirects users to the generic mainnet docs landing page instead of the target Perps Testnet page)

## Area
Docs / Web App (`https://docs.dreamdex.io/*` redirect configuration and `somnia-chain/dreamdex-bot-kit` documentation links)

## Steps to reproduce
1. Open or `curl -i` any of the documentation links referenced across `somnia-chain/dreamdex-bot-kit` (`README.md`, `packages/perp-core/src/exchange.ts`, `scripts/perp-doctor.ts`, `strategies/perp-*/README.md`):
   - `https://docs.dreamdex.io/developers/perps-testnet`
   - `https://docs.dreamdex.io/trading/perps-testnet`
   - `https://docs.dreamdex.io/trading/common/link-a-bot`
   - `https://docs.dreamdex.io/developers/bot-kit`
2. Run:
   ```bash
   curl -i -s "https://docs.dreamdex.io/developers/perps-testnet" | head -n 15
   ```

## Expected
1. `https://docs.dreamdex.io/<path>` should preserve the path on redirect (`Location: https://app.dreamdex.io/docs/<path>` or `https://app.testnet.dreamdex.io/docs/<path>`).
2. On `https://app.dreamdex.io/docs`, the Perps Testnet routes (`/docs/developers/perps-testnet` and `/docs/trading/perps-testnet`) should either exist or redirect to `https://app.testnet.dreamdex.io/docs/developers/perps-testnet` (currently `https://app.dreamdex.io/docs/developers/perps-testnet` returns `HTTP 404`, while the actual page lives at `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`).

## Actual
1. `https://docs.dreamdex.io/<any-path>` returns `HTTP/2 308 Permanent Redirect` with `Location: https://app.dreamdex.io/docs`, discarding the entire path segment.
2. Even if a developer manually appends `/developers/perps-testnet` to `https://app.dreamdex.io/docs`, `https://app.dreamdex.io/docs/developers/perps-testnet` returns `HTTP 404` because the Perps Testnet docs are only hosted on the testnet origin (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet`).

## Evidence
Live HTTP response headers from `docs.dreamdex.io` and `app.dreamdex.io`:

```text
$ curl -i -s "https://docs.dreamdex.io/developers/perps-testnet" | head -n 10
HTTP/2 308 
content-type: text/plain
location: https://app.dreamdex.io/docs
refresh: 0;url=https://app.dreamdex.io/docs
server: Vercel

$ curl -i -s "https://docs.dreamdex.io/trading/common/link-a-bot" | head -n 10
HTTP/2 308 
content-type: text/plain
location: https://app.dreamdex.io/docs
refresh: 0;url=https://app.dreamdex.io/docs
server: Vercel

$ curl -i -s "https://app.dreamdex.io/docs/developers/perps-testnet" | head -n 10
HTTP/2 404 
content-type: text/html; charset=utf-8
server: Vercel
```

Whereas the working testnet documentation URL is:
```text
$ curl -i -s "https://app.testnet.dreamdex.io/docs/developers/perps-testnet" | head -n 5
HTTP/2 200 
content-type: text/html; charset=utf-8
```

## Environment
- **URLs Tested**:
  - `https://docs.dreamdex.io/developers/perps-testnet`
  - `https://docs.dreamdex.io/trading/common/link-a-bot`
  - `https://app.dreamdex.io/docs/developers/perps-testnet`
  - `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit`
