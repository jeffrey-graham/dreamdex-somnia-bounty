# `getPerpState().nextFundingAt` reports timestamps in the past on lazily-settled pools, and `liveFunding()` silently falls back to stale indexer rates on RPC errors while ignoring `isFundingStale`

Severity: Major
Area: SDK

## Severity
Major (`getPerpState().nextFundingAt` in `@somnia-chain/markets-sdk` returns timestamps hours in the past whenever lazy on-chain funding settlement skips an interval; meanwhile `liveFunding()` in `@dreamdex-bot-kit/perp-core` silently falls back to the stale GraphQL indexer `market.info.fundingRate` on any transient RPC/reconnect error and ignores `isFundingStale`, causing `perp-funding` to enter or close carry positions on stale or forgiven funding rates)

## Area
SDK (`@somnia-chain/markets-sdk@0.32.1` — `dist/perp/state.js` & `dist/funding.js`, and `somnia-chain/dreamdex-bot-kit` — `packages/perp-core/src/funding.ts` & `strategies/perp-funding/src/index.ts`)

## Steps to reproduce
1. Inspect `getPerpState` in `@somnia-chain/markets-sdk/dist/perp/state.js` (lines 128–145):
   ```js
   const fundingWindowSec = Number(params.fundingCalculationWindowSec);
   const fundingIntervalSec = Number(params.fundingSettlementIntervalSec);
   const lastFundingUpdateAt = BigInt(lastFundingNs) / 1000000000n;
   return {
       ...
       lastFundingUpdateAt,
       nextFundingAt: lastFundingUpdateAt + BigInt(fundingIntervalSec),
       emaPremium,
       oracle,
   };
   ```
2. Compare this with the protocol's lazy settlement model documented in `@somnia-chain/markets-sdk/dist/funding.js` (lines 120–125 and 156–169):
   - Funding settlement on `PerpPool` is permissionless and **lazy**: it only executes when a trade occurs or a keeper calls `updateFunding()`.
   - When a market is quiet for more than one interval (`nowSec > lastFundingUpdateAt + BigInt(fundingIntervalSec)`), `lastFundingUpdateAt + BigInt(fundingIntervalSec)` is **strictly in the past** (`nextFundingAt < nowSec`), and the contract's catch-up horizon is capped at **one single interval** (`intervalsAccrued <= 1`, with any older intervals forgiven).
   - Because `getPerpState()` computes `nextFundingAt = lastFundingUpdateAt + BigInt(fundingIntervalSec)` without snapping forward to the next interval boundary or flagging overdue lazy settlement, `nextFundingAt` is behind wall-clock time on quiet Hideki pools.
3. Next, inspect `liveFunding` in `packages/perp-core/src/funding.ts` (lines 72–79) and `perp-funding` in `strategies/perp-funding/src/index.ts` (lines 95–126):
   ```ts
   // packages/perp-core/src/funding.ts:72-79
   export async function liveFunding(exchange: SomniaMarkets, market: PerpMarket): Promise<FundingView> {
     try {
       const state = await exchange.client.getPerpState(market.info.poolAddress);
       return viewOf(state.fundingRate, Number(state.fundingWindowSec), Number(state.fundingIntervalSec));
     } catch {
       return fundingApr(market.info);
     }
   }
   ```
   Observe three critical flaws in how `liveFunding` and `perp-funding` interact across reconnects and lazy settlement windows:
   - **Flaw A (Silent fallback to hours-old GraphQL indexer `market.info.fundingRate` on transient RPC errors)**: As the comment right above `liveFunding` admits (`lines 68–70`), *"The row only moves on a settlement, and a newly listed market has none yet... The pool's own numbers are the ones a position settles against."* Yet if `exchange.client.getPerpState` throws a transient RPC timeout or WebSocket disconnect error during a poll cycle, `catch` silently returns `fundingApr(market.info)` — the stale GraphQL indexer rate from the last on-chain settlement (which can have the **opposite sign** or an APR below `EXIT_APR`). In `strategies/perp-funding/src/index.ts` (line 119: `if (position && (!worthKeeping || position.side !== funding.paidSide))`), a single transient RPC hiccup causes `perp-funding` to read the stale indexer rate and **immediately market-close a live profitable carry position**!
   - **Flaw B (`liveFunding` ignores `isFundingStale` and zero-OI forgiveness)**: `liveFunding` never checks `isFundingStale(state.lastFundingUpdateAt, state.fundingIntervalSec, nowSec)` or `state.openInterest`. On a pool with zero open interest on one side or stalled funding updates, `state.fundingRate` can read high while actual funding accrual is forgiven (`0` settled), luring `perp-funding` into paying taker entry fees + spread for carry that never accrues.
   - **Flaw C (60-second unhedged gap on carry flip)**: In `strategies/perp-funding/src/index.ts` (lines 119–153), `if (position && ...) { await closePosition(...); } else if (!position && worthHolding && me) { ... }` uses an `else if`. When funding flips strongly from `+APR` to `-APR`, cycle $N$ only closes the old position and sleeps a full `POLL_MS` (`60,000 ms`) before entering the new side in cycle $N+1$.

## Expected
1. `getPerpState()` should expose `fundingOverdue: nowSec >= lastFundingUpdateAt + BigInt(fundingIntervalSec)` (or compute `nextFundingAt` relative to the current interval grid when overdue) so callers know whether the next trade/poke will trigger an immediate lazy settlement.
2. `liveFunding()` must **not** silently fall back to the stale indexer row `fundingApr(market.info)` when `getPerpState()` throws a transient RPC error; instead, it should return `known: false` (which `perp-funding` already handles at line 103 by holding off for the cycle without closing open positions) and should expose `stale: isFundingStale(...)` and `unaccruedDelta: state.projectedCumulativeFundingPerUnit - state.cumulativeFundingPerUnit`.

## Actual
1. `getPerpState().nextFundingAt` returns timestamps in the past whenever a pool has gone $> 1$ interval (`3600s`) without a trade or `updateFunding` poke.
2. On any transient RPC error in `getPerpState()`, `liveFunding()` silently returns the stale GraphQL indexer `market.info.fundingRate` with `known: true`, triggering false carry exits (`closePosition`) in `perp-funding`.

## Evidence
Live query against Somnia Tokyo / Hideki Testnet (`chainId: 50383`) showing `getPerpState` vs stale indexer `market.info` and overdue `nextFundingAt`:

```text
$ npx tsx -e '
import { createPublicClient, http } from "viem";
import { isFundingStale } from "@somnia-chain/markets-sdk";
import { getPerpState } from "./node_modules/@somnia-chain/markets-sdk/dist/perp/state.js";

(async () => {
  const client = createPublicClient({ transport: http("https://api.hideki2.infra.testnet.somnia.network") });
  const state = await getPerpState("0xe3f6dcda98595764970e5a6ffd167af1d1b35123", client as any);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  console.log({
    lastFundingUpdateAt: state.lastFundingUpdateAt.toString(),
    nextFundingAt: state.nextFundingAt.toString(),
    nowSec: nowSec.toString(),
    secondsUntilNextFunding: Number(state.nextFundingAt - nowSec),
    isStale: isFundingStale(state.lastFundingUpdateAt, state.fundingIntervalSec, nowSec),
  });
})();
'
{
  lastFundingUpdateAt: '1794222477',
  nextFundingAt: '1794226077',
  nowSec: '1794243324',
  secondsUntilNextFunding: -17247,
  isStale: true
}
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **SDK / Repository**: `@somnia-chain/markets-sdk@0.32.1` (`dist/perp/state.js`) & `https://github.com/somnia-chain/dreamdex-bot-kit` (`packages/perp-core/src/funding.ts`, `strategies/perp-funding/src/index.ts`)
