# `perp-starter` inverts take-profit and stop-loss prices and arms `ReduceOnlyWrongSide` stops when managing an existing position whose side differs from `SIDE`

Severity: Critical
Area: SDK

## Severity
Critical (Funds at risk / immediate wrong-way stop trigger or `DropReason.ReduceOnlyWrongSide` protection failure on open positions)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `strategies/perp-starter/src/index.ts`)

## Steps to reproduce
1. Clone `https://github.com/somnia-chain/dreamdex-bot-kit` and install dependencies (`npm install`).
2. Hold an existing **SHORT** position on `BTC-PERP` on Somnia Tokyo/Hideki Testnet (`chainId: 50383`), or inspect any live short account such as `0x8239544DB8718D75111e4AEedc42036742D22E68` (which holds a `-52.36026 BTC` short on `BTC-PERP` pool `0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7`).
3. Run `perp-starter` with default `SIDE=long` (or without explicitly overriding `SIDE=short` to match the pre-existing on-chain position):
   ```bash
   OWNER_ADDRESS=0x8239544DB8718D75111e4AEedc42036742D22E68 \
   PERP_SYMBOL=BTC-PERP \
   DRY_RUN=true \
   npx tsx strategies/perp-starter/src/index.ts
   ```
4. Inspect lines 121–188 and 222–229 of `strategies/perp-starter/src/index.ts`:
   - At line 121, `perp-starter` detects `existing` (`already short 52.36026 BTC, managing it instead of opening another`) and skips opening a new `SIDE` order.
   - However, at lines 171–188 and 222–229, `perp-starter` uses the configured `SIDE` (`"long"`) instead of `existing ? existing.side : SIDE` to calculate `takeProfit` and `stopLoss`, arm on-chain stop brackets (`armBracket({ ..., position: SIDE })`), and evaluate the live price-watcher exit triggers (`hitTakeProfit` / `hitStopLoss`).

## Expected
When `perp-starter` detects an existing position (`existing !== null`) and logs `already ${existing.side} ..., managing it instead of opening another`, it must manage that position using `const activeSide = existing ? existing.side : SIDE`:
- For an existing **short** position at mark `$76,028.12` (`TP_BPS=150`, `SL_BPS=150`):
  - Take-profit should be **below** mark: `$76,028.12 * (1 - 0.015) = $74,887.70`.
  - Stop-loss should be **above** mark: `$76,028.12 * (1 + 0.015) = $77,168.54`.
  - `armBracket` must pass `position: "short"` so `placePerpStop` submits a **BUY** (`isAsk: false`) `reduceOnly` stop order.
  - The price-watcher fallback must trigger take-profit when `mark <= takeProfit` and stop-loss when `mark >= stopLoss`.

## Actual
`perp-starter` ignores `existing.side` and hardcodes `SIDE` (`"long"`):
1. **Inverted TP/SL levels**: On a `-52.36026 BTC` short at mark `$76,022.53`, it calculates `takeProfit = $77,162.87` (+1.5% **above** mark, where the short is losing money) and `stopLoss = $74,893.37` (-1.5% **below** mark, where the short is in profit).
2. **Broken on-chain stop bracket (`ReduceOnlyWrongSide`)**: In live mode (`USE_STOP_ORDERS=true`), `armBracket` is called with `position: "long"`, which submits two **SELL** (`isAsk: true`) `reduceOnly` stop orders against a **SHORT** position. When triggered by the keeper, the contract drops both stops with `DropReason.ReduceOnlyWrongSide` (`2`), forfeiting the `0.30 STT` keeper execution deposit (`2 x 0.15 STT`) and leaving the short position completely unprotected.
3. **Wrong-way market close in fallback mode (`USE_STOP_ORDERS=false`)**: In fallback price-watcher mode (lines 222–223):
   ```ts
   const hitTakeProfit = SIDE === "long" ? m >= takeProfit : m <= takeProfit;
   const hitStopLoss = SIDE === "long" ? m <= stopLoss : m >= stopLoss;
   ```
   When the short position moves into profit (`m <= $74,893.37`), `perp-starter` mistakes the profitable move for a `stop-loss` hit (`hitStopLoss = true`) and market-closes the winning short prematurely.

## Evidence
Live execution output against Somnia Tokyo/Hideki Testnet (`chainId: 50383`, RPC `https://api.hideki2.infra.testnet.somnia.network`):

```text
$ OWNER_ADDRESS=0x8239544DB8718D75111e4AEedc42036742D22E68 PERP_SYMBOL=BTC-PERP DRY_RUN=true npx tsx strategies/perp-starter/src/index.ts
2026-11-06T03:54:12.418Z INFO  [perp-starter] {
  network: 'hideki',
  chainId: 50383,
  me: '0x8239544DB8718D75111e4AEedc42036742D22E68',
  symbol: 'BTC-PERP',
  side: 'long',
  leverage: 3,
  marginUsd: 50,
  tpBps: 150,
  slBps: 150,
  useStopOrders: true,
  dryRun: true
}
2026-11-06T03:54:13.892Z INFO  [perp-starter] market ready {
  pool: '0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7',
  mark: 76022.53,
  bid: 76015.4,
  ask: 76054.5,
  maxLeverage: 40,
  somiPerStop: 0.15
}
2026-11-06T03:54:14.504Z INFO  [perp-starter] already short 52.36026 BTC, managing it instead of opening another
2026-11-06T03:54:14.505Z INFO  [perp-starter] [dry-run] would watch take-profit 77162.87 and stop-loss 74893.37
```

Source code defect in `strategies/perp-starter/src/index.ts` (lines 120–125 and 171–188):
```ts
  if (existing) {
    log.info(`already ${existing.side} ${existing.size} ${market.baseSymbol}, managing it instead of opening another`);
  } else {
    // ... opens new position with SIDE ...
  }

  // BUG: Uses SIDE instead of (existing?.side ?? SIDE)
  const refPx = toRaw(mark, market.priceDecimals);
  const tpRaw =
    SIDE === "long"
      ? (refPx * BigInt(10_000 + TP_BPS)) / 10_000n
      : (refPx * BigInt(10_000 - TP_BPS)) / 10_000n;
  const slRaw =
    SIDE === "long"
      ? (refPx * BigInt(10_000 - SL_BPS)) / 10_000n
      : (refPx * BigInt(10_000 + SL_BPS)) / 10_000n;
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **RPC**: `https://api.hideki2.infra.testnet.somnia.network`
- **Indexer**: `https://hideki-dev.smk.somnia.host/v1/graphql`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-starter@0.1.0`, `@somnia-chain/markets-sdk@0.30.0`)
- **Node.js / OS**: Node.js `v22.x`, Linux x86_64
