# `NonceManager` backpressure & `resync()` race outside the mutex queue, and `perp-maker` non-atomic cancel-replace leaks duplicate resting orders when `cancelQuietly` swallows RPC/nonce errors

Severity: Major
Area: SDK

## Severity
Major (Concurrent callers bypass `NonceManager.maxInFlight` and collide with unserialized `resync()` calls to produce duplicate nonces; additionally, `perp-maker` and `perp-core` swallow all errors in `cancelQuietly`, causing failed cancels to leave orphan resting orders on the book while new quotes are placed on top, doubling margin lock and exposure)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `packages/core/src/nonce.ts`, `packages/perp-core/src/orders.ts`, and `strategies/perp-maker/src/index.ts`)

## Steps to reproduce
1. Inspect `NonceManager` in `packages/core/src/nonce.ts` (lines 46–83):
   ```ts
   async acquire(): Promise<number> {
     // Backpressure: don't hand out a nonce while the mempool is backed up.
     while (this.inFlight >= this.maxInFlight) {
       await sleep(200);
     }
     // Chain the allocation onto the queue so concurrent callers serialize.
     let release!: () => void;
     const gate = new Promise<void>((r) => (release = r));
     const prev = this.queue;
     this.queue = prev.then(() => gate);
     await prev;
     try {
       if (this.next === null) await this.initialize();
       const n = this.next as number;
       this.next = n + 1;
       this.inFlight += 1;
       return n;
     } finally {
       release();
     }
   }
   ```
   And `resync()` at lines 78–82:
   ```ts
   async resync(): Promise<number> {
     this.next = await this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
     this.inFlight = 0;
     return this.next;
   }
   ```
2. Observe two concurrency races in `NonceManager`:
   - **Race 1 (`maxInFlight` check runs outside the serialized mutex `this.queue`)**: Suppose `maxInFlight = 2` and `inFlight = 1`. When 5 concurrent order tasks call `acquire()` in the same tick, **all 5 evaluate `while (this.inFlight >= this.maxInFlight)` (`1 >= 2 === false`) before any of them enters the `await prev` critical section**. All 5 proceed to allocate nonces, driving `this.inFlight` to `6` (`3x` the configured `maxInFlight = 2` limit).
   - **Race 2 (`resync()` is not serialized on `this.queue` and resets `inFlight = 0` mid-flight)**: When tx A fails with `nonce too low` and calls `resync()`, `resync()` performs an async `getTransactionCount({ blockTag: "pending" })` **without waiting on `this.queue`**. If tx B calls `acquire()` while `resync()`'s RPC call is in flight, tx B increments `this.next` (say from `10` to `11`), and moments later `resync()` resolves with `10` and overwrites `this.next = 10` and `this.inFlight = 0`! The very next `acquire()` hands out nonce `10` again while tx B is already broadcasting nonce `10`, causing a cascade of `nonce too low` / `already known` rejections.
3. Next, inspect how `perp-maker` (`strategies/perp-maker/src/index.ts:129–134`) and `cancelQuietly` (`packages/perp-core/src/orders.ts:203–219`) perform cancel-and-replace:
   ```ts
   // packages/perp-core/src/orders.ts:203-219
   export async function cancelQuietly(ctx: WriteCtx, market: PerpMarket, orderId: bigint): Promise<void> {
     ...
     try {
       if (ctx.tradingKey) {
         await cancelFor(ctx.tradingKey, market.info.poolAddress, orderId);
       } else {
         await ctx.exchange.trader.cancelOrder({ pool: market.info.poolAddress, orderId });
       }
     } catch (err) {
       // An order that filled or expired between the read and the cancel is not a
       // failure of the cancel; a cascade of these means the quote is too slow.
       console.log(`cancel ${orderId} skipped: ${(err as Error).message.slice(0, 120)}`);
     }
   }
   ```
   And in `strategies/perp-maker/src/index.ts` (lines 129–134):
   ```ts
   if (resting.bid || resting.ask) {
     for (const id of [resting.bid, resting.ask]) {
       if (id !== undefined) await cancelQuietly(ctx, market, id);
     }
     resting = { atMark: 0 };
   }
   ```
   Because `cancelQuietly` catches **every** error indiscriminately (including RPC timeouts, HTTP 429 rate limits, or nonce collisions — not just `OrderNotFound` / `OrderNotOpen`) and returns `void` before `perp-maker` wipes `resting = { atMark: 0 }`, any transient RPC or nonce failure during `cancelQuietly` causes `perp-maker` to **forget the still-open `resting.bid` / `resting.ask` order IDs and place two brand-new orders on top**. Those orphan orders remain resting on the `PerpPool` orderbook forever (even after Ctrl-C shutdown, which only cancels the latest `resting.bid` and `resting.ask`), locking collateral in `MarginBank` and exposing the account to unintended fills.

## Expected
1. `NonceManager.acquire()` must perform the `while (this.inFlight >= this.maxInFlight)` check **inside** the serialized critical section (after `await prev`), and `resync()` must also serialize on `this.queue` so it cannot overwrite `this.next` concurrently with an active `acquire()`.
2. `cancelQuietly` should only ignore contract reverts indicating the order is no longer open (e.g., `OrderNotFound`, `OrderAlreadyClosed`), and must rethrow transport/RPC/nonce errors (or verify via `openOrders` that old orders are gone) before `perp-maker` overwrites `resting` and places replacement quotes.

## Actual
1. Concurrent callers bypass `NonceManager.maxInFlight` completely when `inFlight < maxInFlight` at call entry, and concurrent `resync()` + `acquire()` calls overwrite `this.next` and emit duplicate nonces.
2. `cancelQuietly` swallows transient RPC/nonce errors, causing `perp-maker` to overwrite `resting` and stack duplicate open quotes on the orderbook.

## Evidence
Reproduction output running directly against `/tmp/dreamdex-bot-kit/packages/core/src/nonce.ts`:

```text
$ npx tsx -e '
import { NonceManager } from "/tmp/dreamdex-bot-kit/packages/core/src/nonce.ts";
let chainNonce = 10;
const mockClient: any = {
  getTransactionCount: async () => {
    await new Promise((r) => setTimeout(r, 30));
    return chainNonce;
  },
};
const nm = new NonceManager(mockClient, "0x0000000000000000000000000000000000000001", 2);
await nm.initialize();
// 1. Acquire 1 nonce so inFlight = 1 (< maxInFlight = 2)
const first = await nm.acquire();
// 2. Fire 4 concurrent acquires: all 4 bypass maxInFlight=2!
const batch = await Promise.all([nm.acquire(), nm.acquire(), nm.acquire(), nm.acquire()]);
console.log("First nonce:", first, "Concurrent batch:", batch, "inFlight (max=2):", (nm as any).inFlight);
// 3. Demonstrate resync() race handing out duplicate nonce 10:
const resyncPromise = nm.resync();
const racedNonce = await nm.acquire();
await resyncPromise;
const duplicateNonce = await nm.acquire();
console.log("Raced nonce vs post-resync nonce:", { racedNonce, duplicateNonce });
'
First nonce: 10 Concurrent batch: [ 11, 12, 13, 14 ] inFlight (max=2): 5
Raced nonce vs post-resync nonce: { racedNonce: 15, duplicateNonce: 10 }
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex-bot-kit/core@0.1.0`, `@dreamdex-bot-kit/perp-core@0.1.0`, `@dreamdex-bot-kit/perp-maker@0.1.0`)
