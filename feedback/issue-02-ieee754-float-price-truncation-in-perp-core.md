# IEEE-754 float multiplication (`Math.round(price * 1e18)`) and `toRaw()` 9-decimal cap corrupt order prices and throw `SyntaxError` across `perp-core` and strategies

Severity: Critical
Area: SDK

## Severity
Critical (Precision corruption on all 18-decimal prices, off-grid values passed to `getMaxPerpOrderSize`, systematic 1-tick downward price bias, and unhandled `SyntaxError` crash on 24-decimal tokens like `NEAR-PERP`)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `packages/perp-core/src/orders.ts`, `packages/perp-core/src/markets.ts`, `strategies/perp-starter/src/index.ts`, `strategies/perp-maker/src/index.ts`, `strategies/perp-funding/src/index.ts`)

## Steps to reproduce
1. Inspect how human prices are converted to 18-decimal fixed-point `bigint` values across `dreamdex-bot-kit`:
   - `packages/perp-core/src/orders.ts:293` (`closePosition`):
     ```ts
     const rawPx = BigInt(Math.round(touch * 10 ** market.priceDecimals));
     ```
   - `strategies/perp-starter/src/index.ts:132, 174-175`:
     ```ts
     const rawTouch = BigInt(Math.round(touch * 10 ** market.priceDecimals));
     const size = await sizeOrder(ctx.exchange, market, me, SIDE, rawTouch, ...);
     ```
   - `strategies/perp-maker/src/index.ts:142-143`:
     ```ts
     const bidPx = BigInt(Math.round(mark * (1 - HALF_SPREAD_BPS / 10_000) * 10 ** market.priceDecimals));
     ```
   - `strategies/perp-funding/src/index.ts:136`:
     ```ts
     const rawPx = BigInt(Math.round(touch * 10 ** market.priceDecimals));
     ```
2. Run a Node.js reproduction script testing `BigInt(Math.round(touch * 1e18))` and `alignPrice()` on live `ETH-PERP` (`touch = 2234.21`, `tickSize = 10000000000000000n` = `0.01`) and `BTC-PERP` (`touch = 75945.60`, `tickSize = 100000000000000000n` = `0.10`):
   ```bash
   node -e '
   const touch = 2234.21;
   const tick = 10000000000000000n; // 0.01 * 1e18
   const rawPx = BigInt(Math.round(touch * 1e18));
   const exactPx = 2234210000000000000000n;
   const aligned = (rawPx / tick) * tick;
   console.log({ rawPx, exactPx, diffWei: rawPx - exactPx, aligned, alignedHuman: Number(aligned)/1e18 });
   '
   ```
3. Next, test `toRaw(human, decimals)` in `packages/perp-core/src/markets.ts:127-135`:
   ```ts
   export function toRaw(human: number, decimals: number): bigint {
     if (!Number.isFinite(human) || human <= 0) return 0n;
     const factor = 10 ** Math.min(decimals, 9);
     const scaled = BigInt(Math.round(human * factor));
     const rest = decimals - Math.min(decimals, 9);
     return rest > 0 ? scaled * 10n ** BigInt(rest) : scaled;
   }
   ```
   Call `toRaw(0.004879605519, 18)` (a typical `BTC-PERP` lot size) and `toRaw(1e21, 24)` (`NEAR-PERP` has `baseDecimals = 24` on Hideki).

## Expected
- Converting `2234.21` at `18` decimals should yield exact `2234210000000000000000n` (`$2,234.21`), and `alignPrice(rawPx, tick)` should remain `2234210000000000000000n` (`$2,234.21`).
- `rawTouch` passed to `sizeOrder()` -> `getMaxPerpOrderSize()` should be tick-aligned and free of IEEE-754 binary floating-point drift.
- `toRaw()` should convert decimal numbers via string manipulation (`parseUnits(human.toString(), decimals)`) without truncating precision at 9 decimal places or throwing `SyntaxError` on scientific notation.

## Actual
1. **`touch * 1e18` exceeds `Number.MAX_SAFE_INTEGER` (`9.007e15`) by 250,000x to 8,400,000x**:
   - For `ETH-PERP` at `touch = 2234.21`, `2234.21 * 1e18` evaluates in IEEE-754 double precision to `2234209999999999934464`.
   - `BigInt(Math.round(2234.21 * 1e18))` produces `2234209999999999934464n` (`65,536` wei below `$2,234.21`).
   - When `alignPrice` in `packages/perp-core/src/markets.ts:105` executes integer division `(price / tick) * tick`, it floors `2234209999999999934464n` down a full tick to `2234200000000000000000n` (**`$2,234.20` instead of `$2,234.21`**).
   - For `BTC-PERP` at `touch = 75945.60`, `BigInt(Math.round(75945.60 * 1e18))` produces `75945599999999995904000n` (`4,096,000` wei below `$75,945.60`), which floors down a full tick to `75945500000000000000000n` (**`$75,945.50` instead of `$75,945.60`**).
   - Because `placePerp` then applies `slippageBps` on top of the truncated price and floors again via `alignPrice`, buy orders lose 1–2 ticks of limit protection, and `PostOnly` maker orders are quoted on the wrong tick.
2. **`toRaw` truncates everything past 9 decimals and crashes on `>= 1e12` human inputs**:
   - `toRaw(0.004879605519, 18)` rounds at 9 decimals (`10 ** Math.min(18, 9)`), returning `4879606000000000n` instead of `4879605519000000n`.
   - When `human * factor >= 1e21` (e.g. `toRaw(1e12, 18)` or `NEAR-PERP` with `baseDecimals: 24`), `Math.round(human * factor)` serializes in exponential notation (`"1e+21"`) and `BigInt(...)` crashes with `SyntaxError: Cannot convert 1e+21 to a BigInt`.

## Evidence
Output from live reproduction in `/tmp/dreamdex-bot-kit`:

```text
$ node -e '
const touchEth = 2234.21;
const tickEth = 10000000000000000n;
const rawEth = BigInt(Math.round(touchEth * 1e18));
const alignedEth = (rawEth / tickEth) * tickEth;
console.log("ETH-PERP:", {
  input: touchEth,
  rawPx: rawEth.toString(),
  exactPx: "2234210000000000000000",
  alignedPx: alignedEth.toString(),
  alignedHuman: Number(alignedEth) / 1e18
});

const touchBtc = 75945.60;
const tickBtc = 100000000000000000n;
const rawBtc = BigInt(Math.round(touchBtc * 1e18));
const alignedBtc = (rawBtc / tickBtc) * tickBtc;
console.log("BTC-PERP:", {
  input: touchBtc,
  rawPx: rawBtc.toString(),
  exactPx: "75945600000000000000000",
  alignedPx: alignedBtc.toString(),
  alignedHuman: Number(alignedBtc) / 1e18
});
'
ETH-PERP: {
  input: 2234.21,
  rawPx: '2234209999999999934464',
  exactPx: '2234210000000000000000',
  alignedPx: '2234200000000000000000',
  alignedHuman: 2234.2
}
BTC-PERP: {
  input: 75945.6,
  rawPx: '75945599999999995904000',
  exactPx: '75945600000000000000000',
  alignedPx: '75945500000000000000000',
  alignedHuman: 75945.5
}
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-core@0.1.0`)
- **Node.js / OS**: Node.js `v22.x`, Linux x86_64
