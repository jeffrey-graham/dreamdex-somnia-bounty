# `perp-guard` crashes with unhandled `ContractRevertError` when any market has a stale oracle mark, defeating its `includeHalted: true` safety design

Severity: Critical
Area: SDK

## Severity
Critical (The emergency risk-reduction bot crashes at the exact moment an oracle mark goes stale, and cannot reduce positions on halted/un-priceable markets)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `strategies/perp-guard/src/index.ts` and `packages/perp-core/src/orders.ts`)

## Steps to reproduce
1. Inspect `strategies/perp-guard/src/index.ts`:
   - Lines 64–70 (`watchList`):
     ```ts
     /**
      * Read every tradeable market. Includes halted/un-priceable ones so a
      * position on a market whose oracle just went stale still gets checked.
      */
     async function watchList(): Promise<PerpMarket[]> {
       const all = await perpMarkets(ctx.exchange, false);
       if (WATCH_SYMBOLS.length === 0) return all;
       return all.filter((m) => WATCH_SYMBOLS.includes(m.symbol.toUpperCase()));
     }
     ```
   - Lines 133–153 (`checkMarket`):
     ```ts
     async function checkMarket(market: PerpMarket, now: number): Promise<void> {
       const pos = await getPosition(ctx.exchange, market, me);
       if (!pos) return;

       const snap = await marginSnapshot(ctx.exchange, market, me);
       ...
     ```
2. Trace `marginSnapshot(ctx.exchange, market, me)` in `packages/perp-core/src/positions.ts:132` -> `exchange.client.getMarginAccount(market.pool, user)` in `@somnia-chain/markets-sdk/dist/perp/margin.js:349-388`:
   - `getMarginAccount` calls `MarginBank.getAccountHealth(account)` on-chain (`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`).
   - As documented in `@somnia-chain/markets-sdk/dist/perp/margin.js:344-347`:
     > *"MarginBank.getAccountHealth walks every active pool through the reverting `getHealthSnapshot`, so a single stale mark anywhere in the account reverts the whole call."*
3. Furthermore, inspect what happens even if `marginSnapshot` did not revert and `perp-guard` attempted to reduce/close the position on a stale-mark market (`!preview.priceable`) via `closePosition()` in `packages/perp-core/src/orders.ts:242-248`:
   ```ts
   const preview = await previewClose(exchange, market, user);
   if (!preview || preview.contracts === 0n) { ... }
   if (!preview.priceable) {
     log.warn(`${market.symbol}: mark is stale/unavailable — refusing to size a market close`);
     return { placed: false, contracts: 0n, fillPrice: 0, estimatedPnlUsd: 0, reason: "stale mark" };
   }
   ```
4. Finally, note that `watchList()` calls `perpMarkets(ctx.exchange, false)` without passing `reload = true`, so `exchange.perpMarkets()` returns the cached startup `market.info` forever and never refreshes `oraclePrice` or `lastFundingRate` across polling cycles.

## Expected
1. `perp-guard` is specifically designed to protect accounts when an oracle mark goes stale or margin health degrades (`includeHalted: true`).
2. `marginSnapshot` (or `perp-guard`) should catch `ContractRevertError` from `getMarginAccount` and fall back to the non-reverting `MarginBank.tryGetAccountEquity(account)` + `PerpPool.tryGetHealthSnapshot(account)` (both of which exist on-chain and in `@somnia-chain/markets-sdk`), rather than crashing the entire `perp-guard` process outside the `try/catch` block.
3. When closing/reducing a position during a stale mark, `closePosition` should fall back to `getPosition()`'s `contracts` and the orderbook best bid/ask (`topOfBook`) when `preview.priceable` is `false`.
4. `watchList()` should refresh market metadata or read live on-chain mark prices rather than reusing a permanently cached startup snapshot.

## Actual
1. `await marginSnapshot(ctx.exchange, market, me)` at line 137 of `strategies/perp-guard/src/index.ts` is **outside** any `try/catch` block (the only `try/catch` is around `closePosition` at line 153), and `loop()` in `main()` (lines 206–215) has **no `try/catch` around `await checkMarket(m, now)`**:
   ```ts
   const loop = async () => {
     const markets = await watchList();
     const now = Date.now();
     for (const m of markets) {
       await checkMarket(m, now);
     }
   };
   ```
   When any market in the trader's portfolio experiences a stale oracle mark, `MarginBank.getAccountHealth` reverts with `StalePrice` (`0x19abf40e`), throwing an unhandled promise rejection in `setInterval(loop, POLL_MS)` and crashing `perp-guard`.
2. Even if `marginSnapshot` succeeds (e.g., before the oracle staleness threshold expires, while `previewClose` sees `!preview.priceable`), `closePosition()` immediately returns `{ placed: false, reason: "stale mark" }`, making `includeHalted: true` in `perp-guard` completely non-functional.

## Evidence
1. `@somnia-chain/markets-sdk/dist/perp/margin.js` (lines 343–356) confirming `getMarginAccount` reverts when any active pool has a stale mark:
```js
/**
 * Reads an account's cross-margin state via `MarginBank.getAccountHealth`,
 * enriched with the vault's `marginDecimals` and the pool's `initialMarginBps`.
 *
 * Note: `MarginBank.getAccountHealth` walks every active pool through the
 * reverting `getHealthSnapshot`, so a single stale mark anywhere in the
 * account reverts the whole call. Use `getPoolHealthSnapshot` per-pool if
 * you need to degrade gracefully on stale marks.
 */
```
2. `strategies/perp-guard/src/index.ts` (lines 133–160) showing `marginSnapshot` called unprotected at line 137 while `try/catch` only wraps `closePosition` at line 153.
3. `packages/perp-core/src/orders.ts` (lines 245–248) showing `closePosition` refusing to execute whenever `!preview.priceable`.

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Contract**: `MarginBank` (`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-guard@0.1.0`, `@dreamdex/perp-core@0.1.0`)
