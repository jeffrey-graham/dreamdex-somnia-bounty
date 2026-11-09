# `perpLiquidationPrice` returns `0n` instead of `null` on over-collateralized longs, `getMaxPerpOrderSize` misreports `limitedBy: "initialMargin"` on over-cap reductions, and `adl.classify` drops sub-unit positive PnL

Severity: Major
Area: SDK

## Severity
Major (`perpLiquidationPrice` in `@somnia-chain/markets-sdk` returns `0n` instead of `null` when a long position cannot be liquidated at any positive price, `getMaxPerpOrderSize` caps opposite-side orders on over-cap positions at `maxPositionSize + |pos|` while misreporting `limitedBy: "initialMargin"`, and `adl.classify` truncates sub-unit positive unrealized PnL to `0n` before testing `<= 0n`, misclassifying profitable accounts as `"notInProfit"`)

## Area
SDK (`@somnia-chain/markets-sdk@0.32.1` — `dist/perp/margin.js`, `dist/perp/adl.js`, and `somnia-chain/dreamdex-bot-kit` — `packages/perp-core/src/margin.ts`)

## Steps to reproduce
1. **Defect A (`perpLiquidationPrice` returns `0n` sentinel instead of `null` on over-collateralized longs)**:
   Inspect `perpLiquidationPrice` in `@somnia-chain/markets-sdk/dist/perp/margin.js` (lines 318–335):
   ```js
   export function perpLiquidationPrice(p) {
       if (p.size === 0n)
           return null;
       const long = p.size > 0n;
       const perUnit = long ? BPS_DENOMINATOR - p.maintenanceMarginBps : BPS_DENOMINATOR + p.maintenanceMarginBps;
       if (perUnit === 0n)
           return null;
       const delta = divFloor((p.equity - p.mmReq) * p.oneBase * BPS_DENOMINATOR, abs(p.size) * perUnit);
       const liq = long ? p.markPrice - delta : p.markPrice + delta;
       return liq > 0n ? liq : 0n;
   }
   ```
   When a trader holds a 1x (or `< 1x`) long position backed by cross-margin collateral such that `delta >= p.markPrice` (for example, `1 BTC` long at `$75,000` with `$80,000` equity in `MarginBank`), no positive price can ever trigger maintenance liquidation (`liq <= 0n`). Instead of returning `null` (to indicate no liquidation price exists), line 334 returns `0n` (`$0.00`). Downstream consumers and risk dashboards checking `if (liqPrice !== null)` treat `$0.00` as a numeric liquidation trigger, computing a `100.00%` distance-to-liquidation instead of `unliquidatable (null)`.
   Furthermore, when `p.equity < p.mmReq` (an account already in `PartialLiquidation` or `CloseOut`), `(p.equity - p.mmReq)` is negative and `divFloor` rounds `delta` down toward $-\infty$ by 1 extra wei on inexact division, shifting the computed threshold 1 wei past the true boundary.

2. **Defect B (`getMaxPerpOrderSize` truncates opposite-side orders on over-cap positions and falsely reports `limitedBy: "initialMargin"`)**:
   Inspect `getMaxPerpOrderSize` in `@somnia-chain/markets-sdk/dist/perp/margin.js` (lines 1446–1517):
   ```js
   const withinPositionCap = (q) => {
       const newAbs = abs(positionSize + (p.isBid ? q : -q));
       return newAbs <= params.maxPositionSize || newAbs <= absPosition;
   };
   const ceiling = params.maxPositionSize + absPosition + 1n;
   ```
   Followed by the `limitedBy` classification at lines 1502–1516:
   ```js
   const next = maxQuantity + lotSize;
   const nextQuote = quoteAt(next);
   let limitedBy = "initialMargin";
   if (nextQuote.isolationBlocked)
       limitedBy = "isolated";
   ...
   else if (!withinPositionCap(next))
       limitedBy = "maxPositionSize";
   ```
   When an account holds a position `absPosition > params.maxPositionSize` (which happens after an admin lowers `maxPositionSize` or after a Stage-4 takeover) and submits an **opposite-side** order to close or flip the position:
   - On-chain (`PerpPool._enforceMaxPositionSize`), `withinPositionCap(q)` remains `true` up to `q = 2n * absPosition` (because `newAbs <= absPosition`).
   - However, the binary search upper bound `ceiling` is hardcoded to `params.maxPositionSize + absPosition + 1n`, which is `< 2n * absPosition` whenever `absPosition > params.maxPositionSize + 1n`.
   - The binary search stops at `lo = ceiling - 1n = params.maxPositionSize + absPosition`. Then at line 1502, `next = maxQuantity + lotSize` is tested against `withinPositionCap(next)`, which returns **`true`** (since `abs(positionSize - next) < absPosition`), and `nextQuote` has sufficient margin and collateral! Because every `if / else if` branch evaluates to `false`, `limitedBy` falls through to the default `"initialMargin"` even though the account has ample initial margin and was only stopped by the artificial `ceiling`!

3. **Defect C (`adl.classify` truncates sub-unit positive unrealized PnL to `0n` before testing `<= 0n`)**:
   Inspect `classify` in `@somnia-chain/markets-sdk/dist/perp/adl.js` (lines 143–149):
   ```js
   // `PerpMath.unrealizedPnl` floors toward −∞, and bigint `/` truncates toward
   // zero. The two agree on whether the result is above zero, which is all the
   // engine asks of it here.
   if (((markPrice - avgEntryPrice) * size) / oneBase <= 0n) {
       const positionLeverageBps = equity > 0n ? (positionNotional * BPS_DENOMINATOR) / equity : null;
       return { eligibility: "notInProfit", account, size, avgEntryPrice, equity, positionNotional, positionLeverageBps };
   }
   ```
   Note that first, the comment in `adl.js:143` contradicts `margin.js:238` (which states `PerpMath.unrealizedPnl` truncates toward zero while `MarginBank._realizedPnlForClose` floors toward $-\infty$). Second, when `0n < (markPrice - avgEntryPrice) * size < oneBase` (for instance, a small lot on a 24-decimal market like `NEAR-PERP` where `oneBase = 10^24` and the position has a positive price delta whose product is `< 10^24`), integer division `/ oneBase` truncates the positive product to `0n`, triggering `<= 0n` and classifying a strictly profitable position as `"notInProfit"`.

## Expected
1. `perpLiquidationPrice` should return `null` (or a dedicated sentinel) when `long && delta >= p.markPrice` (where liquidation is unreachable at any positive price `p > 0`), rather than returning `0n`.
2. In `getMaxPerpOrderSize`, `ceiling` should be `maxBig(params.maxPositionSize, absPosition) + absPosition + 1n` so opposite-side orders on over-cap positions can reach the contract's true `2 * absPosition` escape bound and never fall through to a false `limitedBy: "initialMargin"`.
3. `adl.classify` should reconcile its rounding comment with `margin.js` and ensure consistent profit classification across high-decimal (`10^24`) base tokens.

## Actual
1. `perpLiquidationPrice` returns `0n` on over-collateralized longs.
2. `getMaxPerpOrderSize` caps opposite-side orders on over-cap positions at `maxPositionSize + absPosition` and mislabels the cap as `limitedBy: "initialMargin"`.

## Evidence
Reproduction output running directly against `@somnia-chain/markets-sdk@0.32.1`:

```text
$ npx tsx -e '
import { perpLiquidationPrice } from "/home/jeff/.gemini/antigravity/scratch/freelancework/dreamdex-somnia-bounty/node_modules/@somnia-chain/markets-sdk/dist/perp/margin.js";

// Over-collateralized long: 1 BTC @ $75,000 mark, $80,000 equity, $937.50 mmReq
const liq = perpLiquidationPrice({
  equity: 80_000n * 10n ** 18n,
  mmReq: 937_500_000_000_000_000_000n,
  size: 10n ** 8n, // 1 BTC (8 decimals)
  markPrice: 75_000n * 10n ** 18n,
  maintenanceMarginBps: 125n,
  oneBase: 10n ** 8n,
});
console.log("Over-collateralized 1 BTC long liquidation price:", liq, "(expected null, got 0n)");
'
Over-collateralized 1 BTC long liquidation price: 0n (expected null, got 0n)
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **SDK**: `@somnia-chain/markets-sdk@0.32.1` (`dist/perp/margin.js`, `dist/perp/adl.js`)
