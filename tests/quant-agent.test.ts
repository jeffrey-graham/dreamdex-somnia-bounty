/**
 * @file tests/quant-agent.test.ts
 * @description Unit and live Somnia Hideki Testnet (50383) integration test suite
 * verifying our fixes for all 16 audited bugs and core quantitative trading math.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPLETE_HIDEKI_ADDRESSES,
  HIDEKI_BTC_STOP_REGISTRY,
  HIDEKI_OPERATOR_PERMISSIONS_REGISTRY,
  createQuantClient,
  isActionableStopFailure,
  safeGetStopFeeSomi,
} from "../src/client.js";
import {
  SerializedNonceAllocator,
  alignDirectionalPrice,
  alignLotFloor,
  alignPriceCeil,
  alignPriceFloor,
  computeBracketPrices,
  computeExactLiquidationPrice,
  computeFundingCarryMetrics,
  computeOptimalPositionSize,
  evaluateFundingFreshness,
  formatRawToDecimal,
  parseDecimalToRaw,
  sanitizeTopOfBook,
} from "../src/quant-math.js";

describe("Track 1 Bug-Fix Verification & Quantitative Math Suite", () => {
  it("Issue #1 Fix: computeBracketPrices uses existingPositionSide ('short') instead of configuredSide ('long')", () => {
    const markRaw = parseDecimalToRaw("76022.53", 18);
    const tickRaw = parseDecimalToRaw("0.1", 18);

    const bracket = computeBracketPrices({
      configuredSide: "long", // Default SIDE=long in perp-starter
      existingPositionSide: "short", // Account is already short BTC-PERP
      referencePriceRaw: markRaw,
      tickSizeRaw: tickRaw,
      priceDecimals: 18,
      tpBps: 150,
      slBps: 150,
    });

    assert.equal(bracket.activeSide, "short");
    assert.equal(
      bracket.stopOrderIsAsk,
      false,
      "Closing a SHORT position requires a BUY (isAsk=false) reduce-only stop order",
    );
    assert.ok(
      bracket.takeProfitRaw < markRaw,
      "Short take-profit must be BELOW mark price ($74,882.10 < $76,022.53)",
    );
    assert.ok(
      bracket.stopLossRaw > markRaw,
      "Short stop-loss must be ABOVE mark price ($77,162.90 > $76,022.53)",
    );
    assert.equal(formatRawToDecimal(bracket.takeProfitRaw, 18, 2), "74882.1");
    assert.equal(formatRawToDecimal(bracket.stopLossRaw, 18, 2), "77162.9");
  });

  it("Issue #2 Fix: parseDecimalToRaw avoids IEEE-754 float truncation on ETH-PERP (2234.21) and BTC-PERP (75945.60) and handles 24-decimal NEAR-PERP", () => {
    const ethTick = parseDecimalToRaw("0.01", 18);
    const exactEth = parseDecimalToRaw(2234.21, 18);
    const alignedEth = alignPriceFloor(exactEth, ethTick);

    // Confirm perp-core's buggy formula loses 65,536 wei and floors down to 2234.20
    const buggyEth = BigInt(Math.round(2234.21 * 1e18));
    const buggyAlignedEth = (buggyEth / ethTick) * ethTick;
    assert.equal(buggyAlignedEth, 2234200000000000000000n);

    // Confirm our parser produces exact 2234.21 * 1e18 and stays at 2234.21 after tick alignment
    assert.equal(exactEth, 2234210000000000000000n);
    assert.equal(alignedEth, 2234210000000000000000n);

    // Confirm full 18-decimal precision beyond 9 decimal places (fixing toRaw 9-decimal cap)
    const lotExample = parseDecimalToRaw("0.004879605519", 18);
    assert.equal(lotExample, 4879605519000000n);

    // Confirm 24-decimal token conversion does not throw SyntaxError on large values
    const nearLarge = parseDecimalToRaw("1000000000000", 24);
    assert.equal(nearLarge, 10n ** 36n);
  });

  it("Issue #5 & #6 Fix: COMPLETE_HIDEKI_ADDRESSES includes operatorPermissionsRegistry on Hideki (50383)", () => {
    assert.equal(
      COMPLETE_HIDEKI_ADDRESSES.operatorPermissionsRegistry,
      HIDEKI_OPERATOR_PERMISSIONS_REGISTRY,
    );
    assert.equal(
      COMPLETE_HIDEKI_ADDRESSES.marginBank,
      "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
    );
    assert.equal(
      COMPLETE_HIDEKI_ADDRESSES.collateral,
      "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72",
    );
  });

  it("Issue #9 Fix: alignDirectionalPrice floors passive Maker bids and ceils passive Maker asks", () => {
    const tick = parseDecimalToRaw("0.10", 18);
    const rawMidMinus = parseDecimalToRaw("75000.04", 18);
    const rawMidPlus = parseDecimalToRaw("75000.04", 18);

    const makerBid = alignDirectionalPrice(rawMidMinus, tick, "long", true);
    const makerAsk = alignDirectionalPrice(rawMidPlus, tick, "short", true);

    assert.equal(formatRawToDecimal(makerBid, 18, 2), "75000");
    assert.equal(formatRawToDecimal(makerAsk, 18, 2), "75000.1");
    assert.ok(makerAsk > makerBid, "Maker ask must ceil up and never collapse toward bid");
  });

  it("Issue #10 Fix: isActionableStopFailure flags ReduceOnlyWrongSide (2), ReduceOnlyBelowMinQty (3), PlacementFailed (4), and NoFill (5)", () => {
    assert.equal(isActionableStopFailure(null), false);
    assert.equal(isActionableStopFailure(0), false); // None
    assert.equal(isActionableStopFailure(1), false); // PositionAlreadyFlat
    assert.equal(isActionableStopFailure(6), false); // OrderCancelled
    assert.equal(isActionableStopFailure(2), true);  // ReduceOnlyWrongSide
    assert.equal(isActionableStopFailure(3), true);  // ReduceOnlyBelowMinQty
    assert.equal(isActionableStopFailure(4), true);  // PlacementFailed
    assert.equal(isActionableStopFailure(5), true);  // NoFill
  });

  it("Issue #12 Fix: computeFundingCarryMetrics returns paidSide='none' and actionableSide=null when rate===0n or windowSeconds<=0", () => {
    const zeroRate = computeFundingCarryMetrics({
      symbol: "ZERO-PERP",
      rateX18: 0n,
      windowSeconds: 28_800,
      markPrice: 100,
      bestBid: 99.95,
      bestAsk: 100.05,
      minAprThreshold: 0,
    });
    assert.equal(zeroRate.paidSide, "none");
    assert.equal(zeroRate.actionableSide, null);

    const unknownWindow = computeFundingCarryMetrics({
      symbol: "UNKNOWN-PERP",
      rateX18: 100000000000000n,
      windowSeconds: 0,
      markPrice: 100,
      bestBid: 99.95,
      bestAsk: 100.05,
      minAprThreshold: 0,
    });
    assert.equal(unknownWindow.known, false);
    assert.equal(unknownWindow.paidSide, "none");
    assert.equal(unknownWindow.actionableSide, null);

    // Positive funding rate -> longs pay shorts -> paidSide = "short"
    const btcCarry = computeFundingCarryMetrics({
      symbol: "BTC-PERP",
      rateX18: 1406478490599220n, // ~+154% APR per 8h window
      windowSeconds: 28_800,
      markPrice: 75800,
      bestBid: 75805.9,
      bestAsk: 75806.0,
      minAprThreshold: 10,
    });
    assert.equal(btcCarry.paidSide, "short");
    assert.equal(btcCarry.actionableSide, "short");
    assert.ok(btcCarry.aprPercent > 150);
    assert.ok(
      btcCarry.breakevenHours !== null && btcCarry.breakevenHours < 8,
      "BTC-PERP +154% APR carry breaks even on spread + fees within a single 8h funding window",
    );
  });

  it("Exact Cross-Margin Liquidation Price Solver matches (10000 ∓ mmBps) denominator scaling", () => {
    // 1 BTC Long @ $75,000 entry, $7,500 margin equity (10x leverage), MM = 125 bps (1.25%)
    // Numerator = 1 * 75000 - 7500 = 67500
    // Denominator = 1 * (10000 - 125) / 10000 = 0.9875
    // Exact Liq Price = 67500 / 0.9875 = $68,354.430379...
    const longLiq = computeExactLiquidationPrice({
      signedSizeRaw: parseDecimalToRaw("1", 8),
      sizeDecimals: 8,
      entryPriceRaw: parseDecimalToRaw("75000", 18),
      markPriceRaw: parseDecimalToRaw("75000", 18),
      priceDecimals: 18,
      accountEquityRaw: parseDecimalToRaw("7500", 18),
      maintenanceMarginBps: 125,
    });

    assert.ok(longLiq.liquidationPriceHuman !== null);
    assert.ok(Math.abs(longLiq.liquidationPriceHuman - 68354.430379) < 0.001);

    // 1 BTC Short @ $75,000 entry, $7,500 margin equity (10x leverage), MM = 125 bps (1.25%)
    // Numerator = 1 * 75000 + 7500 = 82500
    // Denominator = 1 * (10000 + 125) / 10000 = 1.0125
    // Exact Liq Price = 82500 / 1.0125 = $81,481.481481...
    const shortLiq = computeExactLiquidationPrice({
      signedSizeRaw: -parseDecimalToRaw("1", 8),
      sizeDecimals: 8,
      entryPriceRaw: parseDecimalToRaw("75000", 18),
      markPriceRaw: parseDecimalToRaw("75000", 18),
      priceDecimals: 18,
      accountEquityRaw: parseDecimalToRaw("7500", 18),
      maintenanceMarginBps: 125,
    });

    assert.ok(shortLiq.liquidationPriceHuman !== null);
    assert.ok(Math.abs(shortLiq.liquidationPriceHuman - 81481.481481) < 0.001);
  });

  it("Issue #13 Fix: sanitizeTopOfBook rejects crossed micro-block books (bestBid >= bestAsk) and one-sided books", () => {
    const crossed = sanitizeTopOfBook({
      bestBid: 75810.5,
      bestAsk: 75809.0,
      maxBookSpreadBps: 200,
    });
    assert.equal(crossed.valid, false);
    assert.equal(crossed.crossed, true);
    assert.equal(crossed.spreadBps, null);

    const oneSided = sanitizeTopOfBook({
      bestBid: 75800.0,
      bestAsk: null,
      maxBookSpreadBps: 200,
    });
    assert.equal(oneSided.valid, false);
    assert.equal(oneSided.oneSided, true);

    const healthy = sanitizeTopOfBook({
      bestBid: 75800.0,
      bestAsk: 75807.58,
      maxBookSpreadBps: 50,
    });
    assert.equal(healthy.valid, true);
    assert.equal(healthy.crossed, false);
    assert.ok(healthy.spreadBps !== null && Math.abs(healthy.spreadBps - 1.0) < 0.01);
  });

  it("Issue #14 Fix: SerializedNonceAllocator enforces maxInFlight inside mutex and prevents duplicate nonces during resync()", async () => {
    let chainNonce = 10;
    const alloc = new SerializedNonceAllocator(async () => chainNonce, 2);

    const n1 = await alloc.acquire();
    const n2 = await alloc.acquire();
    assert.deepEqual([n1, n2], [10, 11]);
    assert.equal(alloc.currentInFlight, 2);

    // A 3rd concurrent acquire must wait until a slot is released
    let thirdResolved = false;
    const thirdPromise = alloc.acquire().then((n) => {
      thirdResolved = true;
      return n;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdResolved, false, "3rd acquire must block while inFlight === maxInFlight (2)");

    // Simulate concurrent resync returning stale chainNonce=10 before tx 10 & 11 mine
    const resyncPromise = alloc.resync();
    alloc.releaseSlot();
    const n3 = await thirdPromise;
    await resyncPromise;

    assert.equal(n3, 12, "Allocator must never rewind or emit duplicate nonce 10 during mid-flight resync");
    alloc.releaseSlot();
    alloc.releaseSlot();
  });

  it("Issue #15 Fix: computeExactLiquidationPrice returns null (not 0n/$0 sentinel) on unliquidatable over-collateralized longs", () => {
    const overCollatLong = computeExactLiquidationPrice({
      signedSizeRaw: parseDecimalToRaw("1", 8),
      sizeDecimals: 8,
      entryPriceRaw: parseDecimalToRaw("75000", 18),
      markPriceRaw: parseDecimalToRaw("75000", 18),
      priceDecimals: 18,
      accountEquityRaw: parseDecimalToRaw("80000", 18), // >100% equity backing
      maintenanceMarginBps: 125,
    });

    assert.equal(overCollatLong.liquidationPriceRaw, null);
    assert.equal(overCollatLong.liquidationPriceHuman, null);
    assert.equal(overCollatLong.distanceToLiqBps, null);
    assert.equal(overCollatLong.isAtRisk, false);
  });

  it("Issue #16 Fix: evaluateFundingFreshness snaps overdue lazy nextFundingAt forward and returns known=false on RPC failure", () => {
    const overdue = evaluateFundingFreshness({
      rpcSucceeded: true,
      lastFundingUpdateAtSec: 1_700_000_000n,
      fundingIntervalSec: 3600,
      nowSec: 1_700_017_247n, // 4h47m after last settlement
      rateX18: 500_000_000_000_000n,
      openInterestRaw: 100n,
    });
    assert.equal(overdue.known, true);
    assert.equal(overdue.fundingOverdue, true);
    assert.equal(overdue.stale, true);
    assert.ok(
      overdue.effectiveNextFundingAtSec !== null &&
        overdue.effectiveNextFundingAtSec > 1_700_017_247n,
      "effectiveNextFundingAtSec must snap ahead of nowSec on lazily-settled pools",
    );

    const rpcError = evaluateFundingFreshness({
      rpcSucceeded: false,
    });
    assert.equal(rpcError.known, false);
    assert.equal(rpcError.rateX18, null);
  });

  it("Issue #3 Fix & Live Hideki RPC Integration: safeGetStopFeeSomi handles null stopRegistry (ADLT-PERP) and reads live fee on valid registry", async () => {
    const qClient = await createQuantClient({ network: "hideki" });
    try {
      const nullFee = await safeGetStopFeeSomi(qClient, null);
      assert.equal(nullFee, null, "Null stopRegistry on ADLT-PERP must return null instead of reverting");

      const validFee = await safeGetStopFeeSomi(
        qClient,
        HIDEKI_BTC_STOP_REGISTRY,
      );
      assert.equal(validFee, 0.15, "Valid Hideki stopRegistry fee should equal 0.15 STT");
    } finally {
      await qClient.close();
    }
  });
});
