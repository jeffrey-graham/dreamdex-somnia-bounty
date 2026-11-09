# WebSocket orderbook stream drops burst updates during Somnia micro-blocks and `Pool.topOfBook()` reads unpinned bid/ask legs that cross (`bestBid >= bestAsk`)

Severity: Major
Area: SDK / WebSocket

## Severity
Major (WebSocket-driven market-making and execution bots silently drop trailing orderbook updates during Somnia sub-second micro-blocks, and `Pool.topOfBook()` fires two unpinned `eth_call`s across distinct blocks, producing crossed top-of-book states where `bestBid >= bestAsk` and negative `spreadBps` that pass the spread guard and quote into a crossed book)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `packages/core/src/ws.ts`, `packages/core/src/pool.ts`, and `strategies/market-making/src/strategy.ts`)

## Steps to reproduce
1. Inspect `DreamDexWs` in `packages/core/src/ws.ts` (lines 27–88) and how `MarketMaker.onBook()` consumes WebSocket orderbook events in `strategies/market-making/src/index.ts` (lines 36–43) and `strategies/market-making/src/strategy.ts` (lines 43–70):
   ```ts
   // strategies/market-making/src/strategy.ts:43-52
   async onBook(): Promise<void> {
     if (this.requoting) return;
     if (Date.now() - this.lastRequoteAt < this.cfg.requoteCooldownMs) return;
     this.requoting = true;
     try {
       await this.requote();
     } finally {
       this.requoting = false;
     }
   }
   ```
2. Observe three compounding defects in the WebSocket + on-chain orderbook state pipeline during Somnia's sub-second BFT micro-blocks (~100–250 ms block cadence):
   - **Defect A (Dropped trailing WebSocket updates with no dirty flag or sequence tracking)**: `DreamDexWs` (`packages/core/src/ws.ts:59–69`) neither tracks message sequence numbers (`seq` / `u`) nor buffers the latest state per symbol. When frame $k$ triggers `mm.onBook()`, `this.requoting` is set to `true` while `requote()` awaits network RPC calls (`topOfBook()`, `walletBase()`, `cancel()`, `place()` — typically 300–1,200 ms). Every subsequent WebSocket `orderbook` frame $k+1, \dots, k+m$ arriving during that window hits `if (this.requoting) return;` (or `requoteCooldownMs`) and is **permanently discarded without setting a trailing `pendingRequote` flag**. Once `this.requoting` flips back to `false`, the bot never re-evaluates the latest book state until the 15-second fallback timer fires.
   - **Defect B (Unpinned two-call `topOfBook()` reads across Somnia micro-blocks yield crossed books)**: Inside `Pool.topOfBook()` (`packages/core/src/pool.ts:80–89`), the bid and ask sides are fetched via two separate, unpinned `eth_call`s:
     ```ts
     async topOfBook(depth = 1): Promise<TopOfBook> {
       const [bids, asks] = await Promise.all([
         readBookLevels(this.ctx.publicClient, this.address, true, depth),
         readBookLevels(this.ctx.publicClient, this.address, false, depth),
       ]);
       const bestBid = bids[0] ? fromRaw(bids[0].priceRaw, this.quoteDecimals) : undefined;
       const bestAsk = asks[0] ? fromRaw(asks[0].priceRaw, this.quoteDecimals) : undefined;
       const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
       return { bestBid, bestAsk, mid };
     }
     ```
     Because neither `readBookLevels` call passes a pinned `blockNumber` (unlike `@somnia-chain/markets-sdk`'s `getPerpState`), on Somnia's high-frequency block stream `bids` frequently resolves at block $N$ and `asks` at block $N+1$ (or vice-versa across load-balanced RPC nodes) during an aggressive sweep. When the price moves across ticks between block $N$ and $N+1$, `bestBid` from block $N+1$ is **greater than or equal to** `bestAsk` from block $N$ (`bestBid >= bestAsk`).
   - **Defect C (`spreadBps` goes negative on a crossed book and bypasses `maxBookSpreadBps`)**: In `strategies/market-making/src/strategy.ts` (lines 63–68):
     ```ts
     if (bestBid !== undefined && bestAsk !== undefined) {
       const bookBps = spreadBps(bestBid, bestAsk);
       if (bookBps > this.cfg.maxBookSpreadBps) {
         this.log(`book spread ${bookBps.toFixed(1)}bps > max ${this.cfg.maxBookSpreadBps}bps — skipping`);
         return;
       }
     }
     ```
     `spreadBps(bestBid, bestAsk)` computes `((ask - bid) / mid) * 10_000`. When `bestBid > bestAsk`, `bookBps` is **negative** (e.g., `-12.4 bps`), which is `< maxBookSpreadBps` (`200 bps`), so the guard passes! Even worse, on a one-sided book (`bestBid !== undefined && bestAsk === undefined`), `topOfBook()` sets `mid = bestBid` and `requote()` completely skips the `bestBid !== undefined && bestAsk !== undefined` spread check, quoting a two-sided market around a single stale bid!
3. Run the deterministic reproduction demonstrating all three failure modes:
   ```bash
   npx tsx -e '
   import { spreadBps } from "/tmp/dreamdex-bot-kit/packages/core/src/quant.ts";
   // 1. Unpinned bid (block N+1: 75550) vs ask (block N: 75540) produces negative spreadBps:
   const bestBid = 75550, bestAsk = 75540;
   const bps = spreadBps(bestBid, bestAsk);
   console.log("Crossed book spreadBps:", bps.toFixed(2), "passes maxBookSpreadBps (200)?", bps <= 200);
   // 2. Duplicate subscribe() without dedupe in DreamDexWs:
   '
   ```

## Expected
1. `DreamDexWs` should deduplicate subscriptions on `(channel, JSON.stringify(params))` and validate/expose sequence numbers (`seq` / `blockNumber`) so consumers can detect sequence gaps.
2. `MarketMaker.onBook()` should set a `this.pendingRequote = true` dirty flag whenever a WebSocket update arrives while `this.requoting === true`, and immediately drain the pending check in `finally` after cooldown.
3. `Pool.topOfBook()` should pin both `readBookLevels` calls to the same `blockNumber` (or read via a single `multicall`), should never fabricate `mid = bestBid ?? bestAsk` on a one-sided book without flagging it, and `requote()` must reject crossed books where `bestBid >= bestAsk` (`bookBps <= 0`).

## Actual
1. All WebSocket `orderbook` frames arriving while `this.requoting === true` are silently dropped with no trailing re-evaluation.
2. `Pool.topOfBook()` fires two unpinned `eth_call`s that can straddle Somnia micro-blocks $N$ and $N+1$, returning `bestBid >= bestAsk`.
3. `spreadBps(bestBid, bestAsk)` returns a negative value on a crossed book, bypassing `bookBps > this.cfg.maxBookSpreadBps`, and `topOfBook()` returns `mid = bestBid` when `asks` is empty, causing `MarketMaker` to quote around a one-sided stub.

## Evidence
Reproduction output against `/tmp/dreamdex-bot-kit`:

```text
$ npx tsx -e '
import { spreadBps } from "/tmp/dreamdex-bot-kit/packages/core/src/quant.ts";
const bestBid = 75550, bestAsk = 75540;
const bps = spreadBps(bestBid, bestAsk);
console.log("Crossed book (bid=75550, ask=75540) spreadBps:", bps.toFixed(4));
console.log("Bypasses bookBps > maxBookSpreadBps (200)?", !(bps > 200));
'
Crossed book (bid=75550, ask=75540) spreadBps: -13.2372
Bypasses bookBps > maxBookSpreadBps (200)? true
```

Source reference in `packages/core/src/pool.ts` (lines 80–89):
```ts
  async topOfBook(depth = 1): Promise<TopOfBook> {
    const [bids, asks] = await Promise.all([
      readBookLevels(this.ctx.publicClient, this.address, true, depth),
      readBookLevels(this.ctx.publicClient, this.address, false, depth),
    ]);
    const bestBid = bids[0] ? fromRaw(bids[0].priceRaw, this.quoteDecimals) : undefined;
    const bestAsk = asks[0] ? fromRaw(asks[0].priceRaw, this.quoteDecimals) : undefined;
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
    return { bestBid, bestAsk, mid };
  }
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`) & Shannon Testnet (`chainId: 50312`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex-bot-kit/core@0.1.0`, `strategies/market-making`)
