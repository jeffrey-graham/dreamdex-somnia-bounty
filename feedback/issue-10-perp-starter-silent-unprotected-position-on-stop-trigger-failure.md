# `perp-starter` never checks `TRIGGER_FAILED` stop orders (`isRealStopFailure` is unused dead code), leaving positions permanently unprotected when stops drop with `NoFill` or `PlacementFailed`

Severity: Major
Area: SDK / Smart Contracts

## Severity
Major (Positions remain open and completely unprotected with `0 stop(s) armed` after keeper-triggered stop orders fail on-chain with `DropReason.PlacementFailed` or `DropReason.NoFill`)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `strategies/perp-starter/src/index.ts`, `packages/perp-core/src/stops.ts`)

## Steps to reproduce
1. Query the Somnia Tokyo/Hideki Testnet GraphQL Indexer (`https://hideki-dev.smk.somnia.host/v1/graphql`) for `PerpStopOrder(where: { status: { _eq: "TRIGGER_FAILED" } })` to observe how frequently on-chain stop orders transition to `TRIGGER_FAILED`.
2. Inspect `packages/perp-core/src/stops.ts` (lines 147–156):
   ```ts
   export function isRealStopFailure(dropReason: number | null | undefined): boolean {
     if (dropReason === null || dropReason === undefined) return false;
     return (
       dropReason !== DropReason.None &&
       dropReason !== DropReason.PositionAlreadyFlat &&
       dropReason !== DropReason.OrderCancelled
     );
   }
   ```
   Search the entire `dreamdex-bot-kit` codebase for `isRealStopFailure`: it is exported in `packages/perp-core/src/stops.ts` and re-exported in `packages/perp-core/src/index.ts`, **but is never called anywhere in any strategy**.
3. Inspect the monitoring loop in `strategies/perp-starter/src/index.ts` (lines 198–218):
   ```ts
   const pos = await getPosition(ctx.exchange, market, me);
   const m = await markPrice(ctx.exchange, market);
   if (!pos) {
     log.info(`position is flat (mark=${m.toFixed(2)}) — canceling any leftover stops and exiting`);
     ...
   }
   if (USE_STOP_ORDERS) {
     const stops = await pendingStops(ctx.exchange, market, me);
     log.info(
       `holding ${pos.side} ${pos.size} ${market.baseSymbol} · mark=${m.toFixed(2)} · uPnL=${pos.unrealizedPnlUsd.toFixed(4)} USDso · ${stops.length} stop(s) armed`,
     );
     return;
   }
   ```
4. Trace what happens when the oracle mark touches `stopLoss` on a thin book or during volatility:
   - The keeper triggers the stop order on-chain.
   - If the book has insufficient depth within `maxSlippageBps` (`100 bps`) or the IOC placement fails (`DropReason.NoFill = 5`, `DropReason.PlacementFailed = 4`, or `DropReason.ReduceOnlyBelowMinQty = 3`), the contract transitions the stop order to `status: "TRIGGER_FAILED"` and consumes the `0.15 STT` execution deposit.
   - On the very next tick, `pendingStops(ctx.exchange, market, me)` (which filters `status: ["PENDING"]`) returns only the surviving TP stop (or `0` stops if both failed), and `perp-starter` logs `holding ... 1 stop(s) armed` (or `0 stop(s) armed`) forever without re-arming the stop or executing the price-watcher fallback market close!

## Expected
When `USE_STOP_ORDERS=true` in `perp-starter`:
- Each monitoring cycle should either check if any bracket stop transitioned to `TRIGGER_FAILED` (using `isRealStopFailure(stop.dropReason)`) or fall through to the price-watcher check (`hitTakeProfit` / `hitStopLoss`) whenever `stops.length < 2` (or when `mark` has already crossed `stopLoss` / `takeProfit` while `pos` is still open), immediately closing the position or re-arming the stop.

## Actual
`if (USE_STOP_ORDERS)` unconditionally `return`s at line 217 of `strategies/perp-starter/src/index.ts` without checking whether the stop-loss order failed (`TRIGGER_FAILED`) or disappeared (`stops.length === 0`). The position remains open with no stop-loss protection and no fallback price-watcher exit.

## Evidence
1. Live `TRIGGER_FAILED` stop orders captured from the Hideki GraphQL Indexer (`https://hideki-dev.smk.somnia.host/v1/graphql`):
```json
[
  {
    "stopId": 8,
    "poolAddress": "0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7",
    "trader": "0x07683fa32f28e729ddfa229d9eb5b4011ff8350b",
    "isAsk": true,
    "status": "TRIGGER_FAILED",
    "dropReason": 3,
    "triggerPrice": "74166400000000000000000",
    "limitPrice": "73424700000000000000000",
    "triggeredTxHash": "0x593a6968c808589d034a0f235c7d9e38c46f46f5ba1dadfc71e3050c0202fc8e"
  },
  {
    "stopId": 29,
    "poolAddress": "0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7",
    "trader": "0x27ebdf31b60eb1442442fe2993d7e92513292bc8",
    "isAsk": true,
    "status": "TRIGGER_FAILED",
    "dropReason": 4,
    "triggerPrice": "75313900000000000000000",
    "limitPrice": "67782600000000000000000",
    "triggeredTxHash": "0xf7398fa0de0fc1745d8bf6ee819de14460601980b4f20a86d78a7f14b4f05d4e"
  },
  {
    "stopId": 3,
    "poolAddress": "0x53a1d281f2ca20a9cfef1dc071f0f5fa4570c175",
    "trader": "0xb5f451c2d77b6f2fa7d93a172844ff33b8685c91",
    "isAsk": true,
    "status": "TRIGGER_FAILED",
    "dropReason": 5,
    "triggerPrice": "2310000000000000000000",
    "limitPrice": "2310000000000000000000",
    "triggeredTxHash": "0x5352fc1de0ab12801ba94cf581f5368d084a55f514f9039660dbcb0d4558d078"
  }
]
```

2. Source code in `strategies/perp-starter/src/index.ts` (lines 211–218):
```ts
    if (USE_STOP_ORDERS) {
      const stops = await pendingStops(ctx.exchange, market, me);
      log.info(
        `holding ${pos.side} ${pos.size} ${market.baseSymbol} · mark=${m.toFixed(2)} · uPnL=${pos.unrealizedPnlUsd.toFixed(4)} USDso · ${stops.length} stop(s) armed`,
      );
      return;
    }
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Indexer**: `https://hideki-dev.smk.somnia.host/v1/graphql`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-starter@0.1.0`, `@dreamdex/perp-core@0.1.0`)
