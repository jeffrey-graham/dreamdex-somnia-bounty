# `viewOf()` and `fundingSide()` in `@dreamdex/perp-core` report `paidSide: "long"` when `rate === 0n` or `windowSec <= 0`, and ignore `liveFunding`

Severity: Normal
Area: SDK

## Severity
Normal (Misleading `"long"` funding payment signal when funding rate is zero or window metadata is missing, and stale indexer reads in `fundingSide()`)

## Area
SDK (`somnia-chain/dreamdex-bot-kit` — `packages/perp-core/src/funding.ts`)

## Steps to reproduce
1. Inspect `packages/perp-core/src/funding.ts` (lines 40–58 and 88–92):
   ```ts
   function viewOf(rate: bigint, windowSec: number): FundingView {
     const ratePerWindow = Number(rate) / 1e18;
     const paidSide: "long" | "short" = rate > 0n ? "short" : "long";
     if (!Number.isFinite(windowSec) || windowSec <= 0) {
       return {
         rateX18: rate,
         ratePerWindow,
         windowSeconds: 0,
         aprPercent: 0,
         paidSide,
         known: false,
       };
     }
     ...
   }

   export function fundingSide(info: PerpInfo, minApr = 5): "long" | "short" | null {
     const view = fundingApr(info);
     if (Math.abs(view.aprPercent) < minApr) return null;
     return view.paidSide;
   }
   ```
2. Call `fundingApr` / `liveFunding` / `fundingSide` when `rate === 0n` (e.g., a balanced or newly initialized market) or when `minApr = 0`, or when `fundingWindowSeconds === 0`:
   ```bash
   npx tsx -e '
   import { fundingApr, fundingSide } from "./packages/perp-core/src/index.js";
   const zeroRateInfo: any = { lastFundingRate: 0n, fundingWindowSeconds: 3600 };
   console.log("fundingApr(0n):", fundingApr(zeroRateInfo));
   console.log("fundingSide(0n, 0):", fundingSide(zeroRateInfo, 0));
   const unknownWindowInfo: any = { lastFundingRate: 0n, fundingWindowSeconds: 0 };
   console.log("fundingSide(unknown, 0):", fundingSide(unknownWindowInfo, 0));
   '
   ```

## Expected
1. When `rate === 0n` (or `!known`), `paidSide` should be `"none"` / `null` (neither longs nor shorts are paid when funding rate is zero).
2. `fundingSide(info, minApr)` should return `null` whenever `!view.known` or `view.rateX18 === 0n` (even if the caller passes `minApr = 0`).
3. `perp-doctor.ts` (line 138) formats `f.paidSide` as `(pays ${f.paidSide}s)`, so a `0.000%` funding market should not display `funding 0.000% (pays longs)`.

## Actual
1. Because `paidSide` is computed via `rate > 0n ? "short" : "long"`, `rate === 0n` always reports `paidSide: "long"`.
2. `fundingSide(info, 0)` returns `"long"` when `lastFundingRate === 0n` or when `fundingWindowSeconds === 0` (`known: false`), because `Math.abs(0) < 0` is `false` and `fundingSide` does not check `if (!view.known || view.rateX18 === 0n) return null;`.

## Evidence
Output from running the reproduction in `/tmp/dreamdex-bot-kit`:

```text
$ npx tsx -e '
import { fundingApr, fundingSide } from "./packages/perp-core/src/index.js";
const zeroRateInfo: any = { lastFundingRate: 0n, fundingWindowSeconds: 3600 };
console.log("fundingApr(0n):", fundingApr(zeroRateInfo));
console.log("fundingSide(0n, 0):", fundingSide(zeroRateInfo, 0));
const unknownWindowInfo: any = { lastFundingRate: 0n, fundingWindowSeconds: 0 };
console.log("fundingSide(unknown, 0):", fundingSide(unknownWindowInfo, 0));
'
fundingApr(0n): {
  rateX18: 0n,
  ratePerWindow: 0,
  windowSeconds: 3600,
  aprPercent: 0,
  paidSide: 'long',
  known: true
}
fundingSide(0n, 0): long
fundingSide(unknown, 0): long
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-core@0.1.0` — `packages/perp-core/src/funding.ts`)
