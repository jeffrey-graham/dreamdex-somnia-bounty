# `ADLT-PERP` is returned as active/tradeable by Hideki Indexer with `stopRegistry: null`, crashing `somiPerStop()`, `placePerpStop()`, and `perp-starter`

Severity: Critical
Area: SDK / API

## Severity
Critical (Unhandled `ContractRevertError` crash when querying stop fees or arming stops on an active market returned first by `perpMarkets()`)

## Area
API (Hideki GraphQL Indexer `PerpPool.stopRegistry`) & SDK (`@somnia-chain/markets-sdk` & `@dreamdex/perp-core`)

## Steps to reproduce
1. Query the Somnia Tokyo/Hideki Testnet GraphQL Indexer (`https://hideki-dev.smk.somnia.host/v1/graphql`) for `PerpPool` rows, or call `perpMarkets(ctx.exchange)` from `@dreamdex/perp-core`.
2. Observe that `ADLT-PERP` (`poolAddress: "0xe3f6dcda98595764970e5a6ffd167af1d1b35123"`) is returned as the very first market alphabetically and passes every tradeability filter in `packages/perp-core/src/markets.ts:69-70`:
   - `restricted: false`
   - `registered: true`
   - `tradeable: true`
   - `active: true`
   - `priceable: true` (Oracle mark `$0.21`)
3. However, `ADLT-PERP` has `stopRegistry: null` in the GraphQL Indexer response (whereas all other 21 markets have `stopRegistry: "0xfe4f765a44d73cc55a608dc7531390fb9c3d41c3"`).
4. Run `perp-starter` on `ADLT-PERP` or call `await somiPerStop(ctx.exchange, adltMarket)`:
   ```bash
   PERP_SYMBOL=ADLT-PERP DRY_RUN=true npx tsx strategies/perp-starter/src/index.ts
   ```

## Expected
- Either the Hideki GraphQL Indexer should populate `stopRegistry: "0xfe4f765a44d73cc55a608dc7531390fb9c3d41c3"` on `ADLT-PERP` (matching the developer docs statement at `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`: *"The registry address is on the market row as `market.stopRegistry`"* and the TypeScript type `PerpInfo.stopRegistry: 0x${string}`), **or**
- `@somnia-chain/markets-sdk` (`getSomiPaymentPerOrder`) and `@dreamdex/perp-core` (`somiPerStop` / `perpMarkets`) must validate `if (!market.info.stopRegistry)` before passing `address: null` to `viem`'s `readContract`.

## Actual
- `somiPerStop(ctx.exchange, market)` in `packages/perp-core/src/stops.ts:62` passes `market.info.stopRegistry` (`null`) directly into `exchange.client.getSomiPaymentPerOrder(market.info.stopRegistry)`.
- Inside `@somnia-chain/markets-sdk`, `readContract` sends an `eth_call` to the RPC with `"to": null` (which the EVM interprets as a contract-creation call with selector `0x75ff882c` as initcode), and throws an unhandled `ContractRevertError: @somnia-chain/markets-sdk: somiPaymentPerOrder reverted`, crashing `perp-starter` at startup (`strategies/perp-starter/src/index.ts:95`) even when `DRY_RUN=true` or `USE_STOP_ORDERS=false`.

## Evidence
1. Live GraphQL Indexer response from `https://hideki-dev.smk.somnia.host/v1/graphql`:
```json
{
  "data": {
    "PerpPool": [
      {
        "poolAddress": "0xe3f6dcda98595764970e5a6ffd167af1d1b35123",
        "symbol": "ADLT-PERP",
        "baseSymbol": "ADLT",
        "stopRegistry": null,
        "restricted": false,
        "registered": true
      }
    ]
  }
}
```

2. Live crash output when running `perp-starter` or `somiPerStop` on `ADLT-PERP`:
```text
$ PERP_SYMBOL=ADLT-PERP DRY_RUN=true npx tsx strategies/perp-starter/src/index.ts
ContractRevertError: @somnia-chain/markets-sdk: somiPaymentPerOrder reverted
    at mapContractError (/tmp/dreamdex-bot-kit/node_modules/@somnia-chain/markets-sdk/dist/errors.js:95:16)
    at MarketsClient.getSomiPaymentPerOrder (/tmp/dreamdex-bot-kit/node_modules/@somnia-chain/markets-sdk/dist/perp/stops.js:244:31)
    at async somiPerStop (/tmp/dreamdex-bot-kit/packages/perp-core/src/stops.ts:62:15)
    at async main (/tmp/dreamdex-bot-kit/strategies/perp-starter/src/index.ts:95:22) {
  code: 'CONTRACT_REVERT',
  context: { action: 'somiPaymentPerOrder' }
}
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Pool Address**: `0xe3f6dcda98595764970e5a6ffd167af1d1b35123` (`ADLT-PERP`)
- **Indexer**: `https://hideki-dev.smk.somnia.host/v1/graphql`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-core@0.1.0`, `@somnia-chain/markets-sdk@0.30.0` & `0.32.1`)
