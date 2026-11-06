# `perp-maker` stops quoting after fills or `PostOnlyWouldCross` skips whenever oracle mark drift stays below `REQUOTE_BPS`

Severity: Major
Area: SDK

## Severity
Major (Market-making bot remains completely absent from the orderbook after its quote is filled or skipped until the oracle price drifts by >= 8 bps, and systematically rounds ask quotes down toward the bid)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `strategies/perp-maker/src/index.ts` and `packages/perp-core/src/orders.ts`)

## Steps to reproduce
1. Inspect the main quoting loop in `strategies/perp-maker/src/index.ts` (lines 118–190):
   ```ts
   if (resting && !DRY_RUN) {
     const drift = Math.abs((mark - resting.atMark) / resting.atMark) * 10_000;
     if (drift < REQUOTE_BPS) {
       log.debug(`drift ${drift.toFixed(1)}bps < ${REQUOTE_BPS}bps — keeping resting quotes`);
       return;
     }
   }
   ```
2. Observe how `resting` is populated at lines 180–186:
   ```ts
   const next: QuoteState = { atMark: mark };
   if (wantBid) {
     const r = await placeLeg("long", bidPx, size);
     next.bid = r.orderId;
   }
   if (wantAsk) {
     const r = await placeLeg("short", askPx, size);
     next.ask = r.orderId;
   }
   resting = next;
   ```
3. Trace two common live scenarios:
   - **Scenario A (PostOnly skip on placement)**: On cycle 1, `placeLeg` catches `PostOnlyWouldCross` (lines 95–102) and returns `{}`. Both `next.bid` and `next.ask` are `undefined`, yet `resting` is set to `{ atMark: mark, bid: undefined, ask: undefined }`. On cycle 2 (and every subsequent cycle while `drift < 8 bps`), `if (resting && !DRY_RUN)` triggers and logs `keeping resting quotes` even though **zero orders were ever placed on the book**.
   - **Scenario B (Resting order filled by a taker)**: On cycle 1, `perp-maker` places a bid and an ask. Two seconds later, a taker fills the bid (or both legs), while the oracle mark price remains stable (`drift < 8 bps`). Because `cycle()` never checks `openOrders(ctx.exchange, market, me)` to verify whether `resting.bid` or `resting.ask` are still resting on the LOB before returning at line 125, `perp-maker` refuses to replenish its filled quote until the oracle mark drifts by `8 bps`.
4. Additionally, inspect how `askPx` is tick-aligned inside `placePerp` (`packages/perp-core/src/orders.ts:152` -> `alignPrice` in `packages/perp-core/src/markets.ts:105`):
   ```ts
   export function alignPrice(price: bigint, market: PerpMarket): bigint {
     const tick = market.info.tickSize;
     if (tick <= 0n) return price;
     return (price / tick) * tick;
   }
   ```
   Because `alignPrice` uses floor division `(price / tick) * tick` for **both** bids and asks, `askPx` is truncated **downward** toward the mid/bid price, narrowing the maker's ask spread by up to 1 full tick and increasing `PostOnlyWouldCross` rejections on the ask side.

## Expected
1. `perp-maker` should only set `resting` if at least one leg was actually placed (`next.bid !== undefined || next.ask !== undefined`), and should verify against `openOrders(ctx.exchange, market, me)` whether the resting bid/ask orders are still active on the book before short-circuiting on `drift < REQUOTE_BPS`.
2. Maker quotes should round bids **down** (`(price / tick) * tick`) and asks **up** (`((price + tick - 1n) / tick) * tick`) so neither side crosses inside the configured `HALF_SPREAD_BPS`.

## Actual
- Whenever `PostOnlyWouldCross` skips leg placement or a taker fills the resting order(s) while oracle mark drift is `< REQUOTE_BPS` (`8 bps`), `perp-maker` enters a silent idle state (`keeping resting quotes`) with no liquidity on the orderbook.
- Ask prices are floored down by `alignPrice` instead of ceiled up.

## Evidence
Source code in `strategies/perp-maker/src/index.ts` (lines 90–106 and 121–127):
```ts
async function placeLeg(
  side: "long" | "short",
  price: bigint,
  contracts: bigint,
): Promise<{ orderId?: number; txHash?: `0x${string}` }> {
  try {
    const res = await placePerp(ctx.exchange, {
      market,
      side,
      size: contracts,
      price,
      tif: "PostOnly",
      slippageBps: 0,
    });
    return { orderId: res.orderId, txHash: res.txHash };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("PostOnlyWouldCross") || msg.includes("post-only")) {
      log.warn(`${side} leg at ${fromRaw(price, market.priceDecimals)} would cross — skipped this cycle`);
      return {};
    }
    throw err;
  }
}
```
Followed immediately by lines 121–126 and 180–186:
```ts
    if (resting && !DRY_RUN) {
      const drift = Math.abs((mark - resting.atMark) / resting.atMark) * 10_000;
      if (drift < REQUOTE_BPS) {
        log.debug(`drift ${drift.toFixed(1)}bps < ${REQUOTE_BPS}bps — keeping resting quotes`);
        return;
      }
    }
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-maker@0.1.0`, `@dreamdex/perp-core@0.1.0`)
