/**
 * @file src/quant-math.ts
 * @description Precision-safe fixed-point arithmetic, asymmetric tick/lot quantization,
 * exact on-chain cross-margin liquidation solver, TP/SL bracket computer, and
 * funding-rate carry & breakeven analytics for Somnia dreamDEX Perps.
 *
 * Directly fixes:
 * - Issue #1: Inverted TP/SL & ReduceOnlyWrongSide when managing an existing position
 * - Issue #2: IEEE-754 float multiplication (`Math.round(touch * 1e18)`) & `toRaw()` 9-decimal cap
 * - Issue #9: Symmetric floor tick rounding on maker ask quotes
 * - Issue #12: False `"long"` funding payment signal when `rateX18 === 0n` or `windowSeconds <= 0`
 * - Issue #13: Crossed/one-sided top-of-book micro-block drift (`sanitizeTopOfBook`)
 * - Issue #14: Mutex-serialized `maxInFlight` & `resync()` nonce allocator (`SerializedNonceAllocator`)
 * - Issue #15: `null` sentinel (instead of `0n` / `$0.00`) on unliquidatable over-collateralized longs
 * - Issue #16: Lazy-settlement `nextFundingAt` grid alignment & RPC-error `known: false` guard (`evaluateFundingFreshness`)
 */

export type PositionSide = "long" | "short";
export type PaidSide = "long" | "short" | "none";

export interface BracketPrices {
  activeSide: PositionSide;
  stopOrderIsAsk: boolean;
  entryOrMarkRaw: bigint;
  takeProfitRaw: bigint;
  stopLossRaw: bigint;
  takeProfitLimitRaw: bigint;
  stopLossLimitRaw: bigint;
  takeProfitHuman: number;
  stopLossHuman: number;
}

export interface FundingCarryAnalysis {
  symbol: string;
  rateX18: bigint;
  ratePerWindowPct: number;
  windowSeconds: number;
  aprPercent: number;
  paidSide: PaidSide;
  actionableSide: PositionSide | null;
  known: boolean;
  spreadBps: number | null;
  roundTripCostBps: number;
  hourlyCarryBps: number;
  breakevenHours: number | null;
  net24hCarryBps: number;
  net7dCarryPct: number;
  markVsMidBasisBps: number | null;
}

export interface LiquidationAnalysis {
  side: PositionSide;
  sizeRaw: bigint;
  entryPriceRaw: bigint;
  markPriceRaw: bigint;
  equityRaw: bigint;
  maintenanceMarginBps: number;
  liquidationPriceRaw: bigint | null;
  liquidationPriceHuman: number | null;
  distanceToLiqBps: number | null;
  distanceToLiqPct: number | null;
  isAtRisk: boolean;
}

/**
 * Converts a decimal number or string into an exact fixed-point `bigint` scaled by `10^decimals`
 * using string parsing rather than `Math.round(val * 10**decimals)`.
 *
 * Fixes Issue #2:
 * - Avoids IEEE-754 precision loss when `val * 1e18 > Number.MAX_SAFE_INTEGER` (e.g. ETH at 2234.21 or BTC at 75945.60).
 * - Preserves full decimal precision beyond 9 fractional digits.
 * - Handles arbitrary token decimals (including 24-decimal tokens like NEAR-PERP) without `SyntaxError`.
 */
export function parseDecimalToRaw(value: string | number, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  let str: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number cannot be converted to raw bigint: ${value}`);
    }
    // Avoid scientific notation for large or tiny floats
    str = value.toLocaleString("en-US", {
      useGrouping: false,
      maximumFractionDigits: Math.min(decimals, 20),
    });
  } else {
    str = value.trim();
  }

  if (str === "" || str === "0" || str === "-0" || str === "+0") {
    return 0n;
  }

  // Handle scientific notation in string inputs (e.g. "1.5e-7" or "1e+21")
  if (/[eE]/.test(str)) {
    const sign = str.startsWith("-") ? "-" : "";
    const clean = str.replace(/^[+-]/, "");
    const [mantissa, expStr] = clean.split(/[eE]/);
    const exp = parseInt(expStr, 10);
    const [intPart = "0", fracPart = ""] = mantissa.split(".");
    const digits = intPart + fracPart;
    const shiftedDecimals = decimals + exp - fracPart.length;
    if (shiftedDecimals >= 0) {
      return BigInt(sign + digits) * 10n ** BigInt(shiftedDecimals);
    } else {
      const divisor = 10n ** BigInt(-shiftedDecimals);
      const raw = BigInt(sign + digits);
      return raw / divisor;
    }
  }

  const negative = str.startsWith("-");
  const unsigned = str.replace(/^[+-]/, "");
  const parts = unsigned.split(".");
  if (parts.length > 2) {
    throw new Error(`Invalid decimal string: "${value}"`);
  }

  const intPart = parts[0] || "0";
  const fracPart = parts[1] || "";

  let combined: string;
  if (fracPart.length > decimals) {
    // Round half-up at the (decimals + 1)-th fractional digit
    const kept = fracPart.slice(0, decimals);
    const nextDigit = parseInt(fracPart[decimals], 10);
    let base = BigInt(intPart + kept);
    if (nextDigit >= 5) {
      base += 1n;
    }
    return negative ? -base : base;
  } else {
    const paddedFrac = fracPart.padEnd(decimals, "0");
    combined = intPart + paddedFrac;
    const res = BigInt(combined);
    return negative ? -res : res;
  }
}

/**
 * Formats a fixed-point `bigint` into a human-readable decimal string without float overflow.
 */
export function formatRawToDecimal(
  raw: bigint,
  decimals: number,
  maxFractionDigits = decimals,
): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const intPart = abs / scale;
  const fracPart = abs % scale;

  if (maxFractionDigits <= 0 || fracPart === 0n) {
    return `${negative ? "-" : ""}${intPart.toString()}`;
  }

  const fullFrac = fracPart.toString().padStart(decimals, "0");
  const trimmedFrac = fullFrac.slice(0, maxFractionDigits).replace(/0+$/, "");
  if (trimmedFrac.length === 0) {
    return `${negative ? "-" : ""}${intPart.toString()}`;
  }
  return `${negative ? "-" : ""}${intPart.toString()}.${trimmedFrac}`;
}

/**
 * Converts a fixed-point `bigint` to a JS `number` for display / telemetry.
 */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(formatRawToDecimal(raw, decimals, Math.min(decimals, 12)));
}

/**
 * Floors price down to the nearest valid tick multiple (`(price / tick) * tick`).
 * Use for passive BUY (bid) quotes and SELL stop-loss limit prices.
 */
export function alignPriceFloor(priceRaw: bigint, tickSizeRaw: bigint): bigint {
  if (tickSizeRaw <= 0n || priceRaw <= 0n) return priceRaw;
  return (priceRaw / tickSizeRaw) * tickSizeRaw;
}

/**
 * Ceils price up to the nearest valid tick multiple (`((price + tick - 1) / tick) * tick`).
 * Fixes Issue #9: Maker ASK quotes must round UP, not down toward the bid.
 */
export function alignPriceCeil(priceRaw: bigint, tickSizeRaw: bigint): bigint {
  if (tickSizeRaw <= 0n || priceRaw <= 0n) return priceRaw;
  return ((priceRaw + tickSizeRaw - 1n) / tickSizeRaw) * tickSizeRaw;
}

/**
 * Aligns a price according to order direction and aggressiveness:
 * - Passive Maker (`postOnly = true`): Bids floor down, Asks ceil up (never narrows spread).
 * - Aggressive Taker (`postOnly = false`): Buys ceil up (within slippage cap), Sells floor down.
 */
export function alignDirectionalPrice(
  priceRaw: bigint,
  tickSizeRaw: bigint,
  side: PositionSide,
  postOnly: boolean,
): bigint {
  if (postOnly) {
    return side === "long"
      ? alignPriceFloor(priceRaw, tickSizeRaw)
      : alignPriceCeil(priceRaw, tickSizeRaw);
  }
  return side === "long"
    ? alignPriceCeil(priceRaw, tickSizeRaw)
    : alignPriceFloor(priceRaw, tickSizeRaw);
}

/**
 * Floors a contract quantity down to the nearest valid `lotSize` multiple.
 * Returns `0n` if the aligned quantity is below `minOrderSize`.
 */
export function alignLotFloor(
  qtyRaw: bigint,
  lotSizeRaw: bigint,
  minOrderSizeRaw = 0n,
): bigint {
  if (qtyRaw <= 0n) return 0n;
  const aligned = lotSizeRaw > 0n ? (qtyRaw / lotSizeRaw) * lotSizeRaw : qtyRaw;
  return aligned < minOrderSizeRaw ? 0n : aligned;
}

/**
 * Computes Take-Profit and Stop-Loss trigger and limit prices for either a newly opened
 * position or a pre-existing on-chain position.
 *
 * Fixes Issue #1:
 * - Always resolves `activeSide = existingPositionSide ?? configuredSide` so an existing
 *   SHORT position is never managed with LONG TP/SL levels or `ReduceOnlyWrongSide` stops.
 */
export function computeBracketPrices(params: {
  configuredSide: PositionSide;
  existingPositionSide?: PositionSide | null;
  referencePriceRaw: bigint;
  tickSizeRaw: bigint;
  priceDecimals: number;
  tpBps: number;
  slBps: number;
  limitSlippageBps?: number;
}): BracketPrices {
  const activeSide: PositionSide = params.existingPositionSide ?? params.configuredSide;
  // A reduce-only stop that closes a LONG must SELL (isAsk = true).
  // A reduce-only stop that closes a SHORT must BUY (isAsk = false).
  const stopOrderIsAsk = activeSide === "long";
  const slipBps = BigInt(params.limitSlippageBps ?? 100);
  const tpBps = BigInt(params.tpBps);
  const slBps = BigInt(params.slBps);
  const ref = params.referencePriceRaw;

  const rawTp =
    activeSide === "long"
      ? (ref * (10_000n + tpBps)) / 10_000n
      : (ref * (10_000n - tpBps)) / 10_000n;

  const rawSl =
    activeSide === "long"
      ? (ref * (10_000n - slBps)) / 10_000n
      : (ref * (10_000n + slBps)) / 10_000n;

  const takeProfitRaw =
    activeSide === "long"
      ? alignPriceCeil(rawTp, params.tickSizeRaw)
      : alignPriceFloor(rawTp, params.tickSizeRaw);

  const stopLossRaw =
    activeSide === "long"
      ? alignPriceFloor(rawSl, params.tickSizeRaw)
      : alignPriceCeil(rawSl, params.tickSizeRaw);

  // Stop order limit price must allow `slipBps` execution room beyond the trigger price
  const rawTpLimit = stopOrderIsAsk
    ? (takeProfitRaw * (10_000n - slipBps)) / 10_000n
    : (takeProfitRaw * (10_000n + slipBps)) / 10_000n;

  const rawSlLimit = stopOrderIsAsk
    ? (stopLossRaw * (10_000n - slipBps)) / 10_000n
    : (stopLossRaw * (10_000n + slipBps)) / 10_000n;

  const takeProfitLimitRaw = stopOrderIsAsk
    ? alignPriceFloor(rawTpLimit, params.tickSizeRaw)
    : alignPriceCeil(rawTpLimit, params.tickSizeRaw);

  const stopLossLimitRaw = stopOrderIsAsk
    ? alignPriceFloor(rawSlLimit, params.tickSizeRaw)
    : alignPriceCeil(rawSlLimit, params.tickSizeRaw);

  return {
    activeSide,
    stopOrderIsAsk,
    entryOrMarkRaw: ref,
    takeProfitRaw,
    stopLossRaw,
    takeProfitLimitRaw,
    stopLossLimitRaw,
    takeProfitHuman: rawToNumber(takeProfitRaw, params.priceDecimals),
    stopLossHuman: rawToNumber(stopLossRaw, params.priceDecimals),
  };
}

/**
 * Computes the exact cross-margin liquidation price matching `@somnia-chain/markets-sdk`
 * (`perpLiquidationPrice`) and `MarginBank` maintenance margin equations:
 *
 * - Long (`signedSize > 0`):
 *     numerator   = size * entryPrice - equity * 10^sizeDecimals
 *     denominator = (size * (10000 - mmBps)) / 10000
 * - Short (`signedSize < 0`):
 *     numerator   = |size| * entryPrice + equity * 10^sizeDecimals
 *     denominator = (|size| * (10000 + mmBps)) / 10000
 *
 * Notice the `(10000 ∓ mmBps)` denominator scaling factor because maintenance margin
 * scales dynamically with the mark price at liquidation!
 */
export function computeExactLiquidationPrice(params: {
  signedSizeRaw: bigint;
  sizeDecimals: number;
  entryPriceRaw: bigint;
  markPriceRaw: bigint;
  priceDecimals: number;
  accountEquityRaw: bigint;
  maintenanceMarginBps: number;
}): LiquidationAnalysis {
  const {
    signedSizeRaw,
    sizeDecimals,
    entryPriceRaw,
    markPriceRaw,
    priceDecimals,
    accountEquityRaw,
    maintenanceMarginBps,
  } = params;

  const side: PositionSide = signedSizeRaw >= 0n ? "long" : "short";
  const absSize = signedSizeRaw >= 0n ? signedSizeRaw : -signedSizeRaw;

  if (absSize === 0n || entryPriceRaw <= 0n) {
    return {
      side,
      sizeRaw: absSize,
      entryPriceRaw,
      markPriceRaw,
      equityRaw: accountEquityRaw,
      maintenanceMarginBps,
      liquidationPriceRaw: null,
      liquidationPriceHuman: null,
      distanceToLiqBps: null,
      distanceToLiqPct: null,
      isAtRisk: false,
    };
  }

  const sizeScale = 10n ** BigInt(sizeDecimals);
  const mmBps = BigInt(maintenanceMarginBps);

  // Convert accountEquityRaw to priceDecimals * sizeDecimals scale
  // In Somnia Perps, both USDso margin and priceDecimals are 18 decimals (1e18).
  const equityScaled = accountEquityRaw * sizeScale;
  const entryNotionalScaled = absSize * entryPriceRaw;

  let numerator: bigint;
  let denominator: bigint;

  if (side === "long") {
    numerator = entryNotionalScaled - equityScaled;
    denominator = (absSize * (10_000n - mmBps)) / 10_000n;
  } else {
    numerator = entryNotionalScaled + equityScaled;
    denominator = (absSize * (10_000n + mmBps)) / 10_000n;
  }

  if (numerator <= 0n || denominator <= 0n) {
    // Fixes Issue #15: Over-collateralized long (>100% equity backing) has no positive liquidation
    // price — return `null` rather than a false `0n` ($0.00) numeric trigger sentinel.
    return {
      side,
      sizeRaw: absSize,
      entryPriceRaw,
      markPriceRaw,
      equityRaw: accountEquityRaw,
      maintenanceMarginBps,
      liquidationPriceRaw: null,
      liquidationPriceHuman: null,
      distanceToLiqBps: null,
      distanceToLiqPct: null,
      isAtRisk: false,
    };
  }

  const liqPriceRaw = numerator / denominator;
  const liqPriceHuman = rawToNumber(liqPriceRaw, priceDecimals);

  let distanceBps: number | null = null;
  let distancePct: number | null = null;
  let isAtRisk = false;

  if (markPriceRaw > 0n) {
    const diffRaw =
      side === "long" ? markPriceRaw - liqPriceRaw : liqPriceRaw - markPriceRaw;
    distanceBps = Number((diffRaw * 10_000n) / markPriceRaw);
    distancePct = distanceBps / 100;
    isAtRisk = distanceBps <= maintenanceMarginBps * 2;
  }

  return {
    side,
    sizeRaw: absSize,
    entryPriceRaw,
    markPriceRaw,
    equityRaw: accountEquityRaw,
    maintenanceMarginBps,
    liquidationPriceRaw: liqPriceRaw,
    liquidationPriceHuman: liqPriceHuman,
    distanceToLiqBps: distanceBps,
    distanceToLiqPct: distancePct,
    isAtRisk,
  };
}

/**
 * Analyzes a market's live funding rate, spread, mark-vs-mid basis, and net carry breakeven.
 *
 * Fixes Issue #12:
 * - Reports `paidSide: "none"` and `actionableSide: null` when `rateX18 === 0n` or `windowSeconds <= 0`
 *   instead of falsely reporting `paidSide: "long"`.
 */
export function computeFundingCarryMetrics(params: {
  symbol: string;
  rateX18: bigint;
  windowSeconds: number;
  markPrice: number;
  bestBid: number | null;
  bestAsk: number | null;
  minAprThreshold?: number;
  takerFeeBps?: number;
}): FundingCarryAnalysis {
  const {
    symbol,
    rateX18,
    windowSeconds,
    markPrice,
    bestBid,
    bestAsk,
    minAprThreshold = 5,
    takerFeeBps = 5,
  } = params;

  const known = Number.isFinite(windowSeconds) && windowSeconds > 0;
  const ratePerWindow = Number(rateX18) / 1e18;
  const ratePerWindowPct = ratePerWindow * 100;

  let paidSide: PaidSide = "none";
  if (known && rateX18 !== 0n) {
    paidSide = rateX18 > 0n ? "short" : "long";
  }

  const windowsPerYear = known ? (365 * 86_400) / windowSeconds : 0;
  const aprPercent = known ? ratePerWindow * windowsPerYear * 100 : 0;

  const actionableSide: PositionSide | null =
    known && rateX18 !== 0n && Math.abs(aprPercent) >= minAprThreshold && paidSide !== "none"
      ? paidSide
      : null;

  let spreadBps: number | null = null;
  let markVsMidBasisBps: number | null = null;

  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk >= bestBid) {
    const mid = (bestBid + bestAsk) / 2;
    spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
    if (markPrice > 0) {
      markVsMidBasisBps = ((markPrice - mid) / mid) * 10_000;
    }
  }

  // Round-trip execution cost = 1x bid-ask spread + 2x taker fee (entry + exit)
  const effectiveSpreadBps = spreadBps ?? 10;
  const roundTripCostBps = effectiveSpreadBps + 2 * takerFeeBps;

  // Hourly funding yield in bps
  const hourlyCarryBps =
    known && windowSeconds > 0
      ? Math.abs(ratePerWindow) * (3600 / windowSeconds) * 10_000
      : 0;

  const breakevenHours =
    hourlyCarryBps > 0 ? roundTripCostBps / hourlyCarryBps : null;

  const net24hCarryBps = hourlyCarryBps * 24 - roundTripCostBps;
  const net7dCarryPct = (hourlyCarryBps * 24 * 7 - roundTripCostBps) / 100;

  return {
    symbol,
    rateX18,
    ratePerWindowPct,
    windowSeconds: known ? windowSeconds : 0,
    aprPercent,
    paidSide,
    actionableSide,
    known,
    spreadBps,
    roundTripCostBps,
    hourlyCarryBps,
    breakevenHours,
    net24hCarryBps,
    net7dCarryPct,
    markVsMidBasisBps,
  };
}

/**
 * Computes optimal risk-constrained contract size given collateral budget, target leverage,
 * on-chain `initialMarginBps`, `lotSize`, and `minOrderSize`.
 */
export function computeOptimalPositionSize(params: {
  marginBudgetUsd: number;
  targetLeverage: number;
  initialMarginBps: number;
  executionPriceRaw: bigint;
  priceDecimals: number;
  sizeDecimals: number;
  lotSizeRaw: bigint;
  minOrderSizeRaw: bigint;
  maxChainSizeRaw?: bigint;
}): {
  effectiveLeverage: number;
  maxAllowedLeverage: number;
  targetNotionalUsd: number;
  rawUnalignedSize: bigint;
  alignedSizeRaw: bigint;
  alignedSizeHuman: number;
} {
  const maxAllowedLeverage =
    params.initialMarginBps > 0 ? Math.floor(10_000 / params.initialMarginBps) : 1;
  const effectiveLeverage = Math.max(
    1,
    Math.min(params.targetLeverage, maxAllowedLeverage),
  );
  const targetNotionalUsd = params.marginBudgetUsd * effectiveLeverage;

  if (params.executionPriceRaw <= 0n || targetNotionalUsd <= 0) {
    return {
      effectiveLeverage,
      maxAllowedLeverage,
      targetNotionalUsd: 0,
      rawUnalignedSize: 0n,
      alignedSizeRaw: 0n,
      alignedSizeHuman: 0,
    };
  }

  const notionalRaw = parseDecimalToRaw(targetNotionalUsd, params.priceDecimals);
  const sizeScale = 10n ** BigInt(params.sizeDecimals);
  let rawUnalignedSize = (notionalRaw * sizeScale) / params.executionPriceRaw;

  if (
    params.maxChainSizeRaw !== undefined &&
    params.maxChainSizeRaw > 0n &&
    rawUnalignedSize > params.maxChainSizeRaw
  ) {
    rawUnalignedSize = params.maxChainSizeRaw;
  }

  const alignedSizeRaw = alignLotFloor(
    rawUnalignedSize,
    params.lotSizeRaw,
    params.minOrderSizeRaw,
  );

  return {
    effectiveLeverage,
    maxAllowedLeverage,
    targetNotionalUsd,
    rawUnalignedSize,
    alignedSizeRaw,
    alignedSizeHuman: rawToNumber(alignedSizeRaw, params.sizeDecimals),
  };
}

/**
 * Validates top-of-book bid/ask quotes against Somnia sub-second micro-block drift.
 *
 * Fixes Issue #13:
 * - Rejects crossed books (`bestBid >= bestAsk`) produced by unpinned two-leg RPC reads
 *   that would otherwise yield a negative `spreadBps` and bypass `maxBookSpreadBps`.
 * - Rejects one-sided books (`bestBid === null || bestAsk === null`) from two-sided quoting.
 */
export function sanitizeTopOfBook(params: {
  bestBid: number | null | undefined;
  bestAsk: number | null | undefined;
  maxBookSpreadBps?: number;
}): {
  valid: boolean;
  crossed: boolean;
  oneSided: boolean;
  mid: number | null;
  spreadBps: number | null;
} {
  const bid = params.bestBid ?? null;
  const ask = params.bestAsk ?? null;
  const maxSpread = params.maxBookSpreadBps ?? 200;

  if (bid === null || ask === null || bid <= 0 || ask <= 0) {
    return {
      valid: false,
      crossed: false,
      oneSided: bid !== ask,
      mid: null,
      spreadBps: null,
    };
  }

  if (bid >= ask) {
    return {
      valid: false,
      crossed: true,
      oneSided: false,
      mid: null,
      spreadBps: null,
    };
  }

  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  return {
    valid: spreadBps <= maxSpread,
    crossed: false,
    oneSided: false,
    mid,
    spreadBps,
  };
}

/**
 * Mutex-serialized nonce allocator with bounded in-flight backpressure and safe `resync()`.
 *
 * Fixes Issue #14:
 * - Evaluates `inFlight >= maxInFlight` *inside* the serialized mutex queue so concurrent
 *   callers never burst past `maxInFlight`.
 * - Serializes `resync()` on the same mutex queue and preserves live `inFlight` tracking so
 *   concurrent `acquire()` + `resync()` calls never emit duplicate nonces.
 */
export class SerializedNonceAllocator {
  private next: number | null = null;
  private inFlight = 0;
  private queue: Promise<void> = Promise.resolve();
  private slotWaiters: Array<() => void> = [];

  constructor(
    private readonly fetchPendingNonce: () => Promise<number>,
    private readonly maxInFlight = 4,
  ) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.queue;
    this.queue = prev.then(() => gate);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  get currentInFlight(): number {
    return this.inFlight;
  }

  async acquire(): Promise<number> {
    return this.runExclusive(async () => {
      while (this.inFlight >= this.maxInFlight) {
        await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
      }
      if (this.next === null) {
        this.next = await this.fetchPendingNonce();
      }
      const allocated = this.next;
      this.next += 1;
      this.inFlight += 1;
      return allocated;
    });
  }

  releaseSlot(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
    const waiter = this.slotWaiters.shift();
    if (waiter) waiter();
  }

  async resync(): Promise<number> {
    return this.runExclusive(async () => {
      const chainPending = await this.fetchPendingNonce();
      this.next =
        this.next !== null ? Math.max(chainPending, this.next - this.inFlight + this.inFlight) : chainPending;
      // Ensure `next` never rewinds below `chainPending`
      if (chainPending > this.next) {
        this.next = chainPending;
      }
      return this.next;
    });
  }
}

/**
 * Evaluates on-chain lazy funding freshness and refuses silent fallback to stale indexer rows.
 *
 * Fixes Issue #16:
 * - Flags `fundingOverdue` when `nowSec >= lastFundingUpdateAt + fundingIntervalSec` and snaps
 *   `effectiveNextFundingAt` forward onto the live interval grid instead of returning a past timestamp.
 * - Returns `known: false` on transient RPC failure rather than silently falling back to stale
 *   GraphQL indexer `fundingRate` values that could trigger false carry exits.
 */
export function evaluateFundingFreshness(params: {
  rpcSucceeded: boolean;
  lastFundingUpdateAtSec?: bigint;
  fundingIntervalSec?: number;
  nowSec?: bigint;
  rateX18?: bigint;
  openInterestRaw?: bigint;
}): {
  known: boolean;
  stale: boolean;
  fundingOverdue: boolean;
  forgivenZeroOi: boolean;
  effectiveNextFundingAtSec: bigint | null;
  rateX18: bigint | null;
} {
  if (!params.rpcSucceeded) {
    return {
      known: false,
      stale: true,
      fundingOverdue: false,
      forgivenZeroOi: false,
      effectiveNextFundingAtSec: null,
      rateX18: null,
    };
  }

  const interval = BigInt(Math.max(0, params.fundingIntervalSec ?? 0));
  const lastUpdate = params.lastFundingUpdateAtSec ?? 0n;
  const now = params.nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  const oi = params.openInterestRaw ?? 1n;

  if (interval <= 0n) {
    return {
      known: false,
      stale: true,
      fundingOverdue: false,
      forgivenZeroOi: oi === 0n,
      effectiveNextFundingAtSec: null,
      rateX18: params.rateX18 ?? 0n,
    };
  }

  const rawNext = lastUpdate + interval;
  const fundingOverdue = now >= rawNext;
  const intervalsElapsed = now > lastUpdate ? (now - lastUpdate) / interval : 0n;
  const stale = intervalsElapsed >= 2n;
  const effectiveNext = fundingOverdue
    ? lastUpdate + (intervalsElapsed + 1n) * interval
    : rawNext;

  return {
    known: true,
    stale,
    fundingOverdue,
    forgivenZeroOi: oi === 0n,
    effectiveNextFundingAtSec: effectiveNext,
    rateX18: params.rateX18 ?? 0n,
  };
}
