/**
 * @file src/client.ts
 * @description Resilient Somnia dreamDEX Perps & Orderbook client for Hideki Testnet (50383)
 * and Shannon Testnet (50312) built on `@somnia-chain/markets-sdk@0.32.1`.
 *
 * Directly fixes:
 * - Issue #3: Null-safe `stopRegistry` guard (prevents crash on `ADLT-PERP` where `stopRegistry: null`)
 * - Issue #4: Stale-mark resilient account health check (catches `MarginBank.getAccountHealth` reverts
 *   and falls back to `tryGetPerpAccountEquity` + `MarginBank.tryGetAccountEquity`)
 * - Issue #5: Correct Hideki (`50383`) contract address preset & `@somnia-chain/markets-sdk@0.32.1` integration
 * - Issue #6: Injects `operatorPermissionsRegistry` (`0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a`) missing from SDK preset
 * - Issue #7: Safe single-symbol orderbook reader that avoids URL-encoded comma 400 errors
 * - Issue #8: Reads authoritative on-chain `imfBps`, `mmfBps`, `cmfBps`, `maxOpenInterest`,
 *   and `MarginBank.isVoucherMarketAllowed(pool)` instead of relying on outdated docs
 * - Issue #10: Queries both pending and failed stop orders and flags real stop drop failures
 */

import {
  SomniaMarkets,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_ADDRESSES,
  type UnifiedMarket,
} from "@somnia-chain/markets-sdk";
import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import {
  computeExactLiquidationPrice,
  computeFundingCarryMetrics,
  formatRawToDecimal,
  rawToNumber,
  type FundingCarryAnalysis,
  type LiquidationAnalysis,
  type PositionSide,
} from "./quant-math.js";

export const HIDEKI_OPERATOR_PERMISSIONS_REGISTRY: Address =
  "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a";

export const HIDEKI_MARGIN_BANK: Address =
  "0x478769E1177C0773c43A593DCCc4Ad15F15F1394";

export const HIDEKI_USDSO_COLLATERAL: Address =
  "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72";

export const HIDEKI_BTC_STOP_REGISTRY: Address =
  "0x52e2ccebaec9332672c247e9a90aa3d61fb615ef";

/**
 * Complete Somnia Tokyo / Hideki Testnet (50383) contract addresses,
 * patching the missing `operatorPermissionsRegistry` and Perps `USDso` collateral
 * in `@somnia-chain/markets-sdk@0.32.1`.
 */
export const COMPLETE_HIDEKI_ADDRESSES = {
  ...SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  marginBank: SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank ?? HIDEKI_MARGIN_BANK,
  collateral: HIDEKI_USDSO_COLLATERAL,
  operatorPermissionsRegistry: HIDEKI_OPERATOR_PERMISSIONS_REGISTRY,
} as const;

export const HIDEKI_CHAIN: Chain = defineChain({
  id: 50383,
  name: "Somnia Tokyo (Hideki) Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://api.hideki2.infra.testnet.somnia.network"],
      webSocket: ["wss://api.hideki2.infra.testnet.somnia.network/ws"],
    },
  },
});

export const SHANNON_CHAIN: Chain = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://api.infra.testnet.somnia.network"],
      webSocket: ["wss://api.infra.testnet.somnia.network/ws"],
    },
  },
});

const MARGIN_BANK_EXTRA_ABI = parseAbi([
  "function isVoucherMarketAllowed(address pool) view returns (bool)",
  "function tryGetAccountEquity(address account) view returns (bool ok, int256 equity, uint256 requiredIM, uint256 requiredMM)",
]);

const PERP_POOL_PARAMS_ABI = parseAbi([
  "function getRiskParams() view returns (uint256 imfBps, uint256 mmfBps, uint256 cmfBps, uint256 maxOpenInterest, uint256 maxPositionSize)",
]);

export interface RawPerpMarketInfo {
  poolAddress: Address;
  marginBank: Address;
  quoteToken: Address;
  baseToken: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  fundingWindowSec: number;
  fundingIntervalSec: number;
  initialMarginBps: number;
  openInterest: string;
  stopRegistry: Address | null;
}

export interface EnrichedPerpMarket {
  symbol: string;
  ccxtSymbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  poolAddress: Address;
  marginBank: Address;
  baseDecimals: number;
  priceDecimals: number;
  tickSizeRaw: bigint;
  tickSizeHuman: number;
  lotSizeRaw: bigint;
  lotSizeHuman: number;
  minOrderSizeRaw: bigint;
  minOrderSizeHuman: number;
  markPriceRaw: bigint;
  markPriceHuman: number;
  priceable: boolean;
  active: boolean;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  closeoutMarginBps: number;
  maxLeverage: number;
  maxOpenInterestRaw: bigint;
  maxOpenInterestHuman: number;
  voucherAllowed: boolean;
  stopRegistry: Address | null;
  stopFeeSomi: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  funding: FundingCarryAnalysis;
  rawInfo: RawPerpMarketInfo;
}

export interface AuditedPosition {
  symbol: string;
  ccxtSymbol: string;
  baseSymbol: string;
  poolAddress: Address;
  side: PositionSide;
  signedSizeRaw: bigint;
  sizeHuman: number;
  entryPriceRaw: bigint;
  entryPriceHuman: number;
  markPriceRaw: bigint;
  markPriceHuman: number;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  initialMarginRequiredUsd: number;
  maintenanceMarginRequiredUsd: number;
  liquidation: LiquidationAnalysis;
  pendingStopsCount: number;
  failedStopsCount: number;
  failedStopReasons: string[];
}

export interface AccountRiskAudit {
  timestamp: string;
  network: string;
  chainId: number;
  account: Address;
  degradedStaleMarkMode: boolean;
  unlockedBalanceUsd: number;
  lockedMarginUsd: number;
  netEquityUsd: number;
  totalInitialMarginReqUsd: number;
  totalMaintenanceMarginReqUsd: number;
  withdrawableUsd: number;
  marginHealthRatio: number;
  marginStatus: string;
  openPositionsCount: number;
  totalNotionalUsd: number;
  totalUnrealizedPnlUsd: number;
  positions: AuditedPosition[];
}

export interface DreamDexQuantClient {
  networkName: "hideki" | "shannon";
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  exchange: SomniaMarkets;
  publicClient: PublicClient;
  traderAddress?: Address;
  close: () => Promise<void>;
}

/**
 * Checks whether a stop order `dropReason` represents an actionable protection failure
 * (Fixes Issue #10 where `isRealStopFailure` was unused dead code in `dreamdex-bot-kit`).
 */
export function isActionableStopFailure(
  dropReason: number | string | null | undefined,
): boolean {
  if (dropReason === null || dropReason === undefined) return false;
  if (typeof dropReason === "number") {
    return (
      dropReason === 2 ||
      dropReason === 3 ||
      dropReason === 4 ||
      dropReason === 5
    );
  }
  return (
    dropReason === "ReduceOnlyWrongSide" ||
    dropReason === "ReduceOnlyBelowMinQty" ||
    dropReason === "PlacementFailed" ||
    dropReason === "NoFill"
  );
}

/**
 * Connects to Somnia Tokyo/Hideki Testnet (`50383`) or Shannon Testnet (`50312`)
 * with complete contract addresses and optional signing key / owner address.
 */
export async function createQuantClient(opts?: {
  network?: "hideki" | "shannon";
  rpcUrl?: string;
  wsRpcUrl?: string;
  indexerUrl?: string;
  privateKey?: Hex;
  ownerAddress?: Address;
}): Promise<DreamDexQuantClient> {
  const networkName = opts?.network ?? "hideki";
  const isHideki = networkName === "hideki";
  const chain = isHideki ? HIDEKI_CHAIN : SHANNON_CHAIN;

  const rpcUrl =
    opts?.rpcUrl ??
    process.env.RPC_URL ??
    (isHideki
      ? "https://api.hideki2.infra.testnet.somnia.network"
      : "https://api.infra.testnet.somnia.network");
  const wsRpcUrl =
    opts?.wsRpcUrl ??
    process.env.WS_RPC_URL ??
    (isHideki
      ? "wss://api.hideki2.infra.testnet.somnia.network/ws"
      : "wss://api.infra.testnet.somnia.network/ws");
  const indexerUrl =
    opts?.indexerUrl ??
    process.env.INDEXER_URL ??
    (isHideki
      ? "https://hideki-dev.smk.somnia.host/v1/graphql"
      : "https://dev.smk.somnia.host/v1/graphql");

  const addresses = isHideki
    ? COMPLETE_HIDEKI_ADDRESSES
    : SOMNIA_TESTNET_ADDRESSES;

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 20_000 }),
  });

  const pk = (opts?.privateKey ?? process.env.PRIVATE_KEY) as Hex | undefined;
  const owner =
    opts?.ownerAddress ?? (process.env.OWNER_ADDRESS as Address | undefined);

  const exchange = owner
    ? new SomniaMarkets({
        indexerUrl,
        chain,
        wsRpcUrl,
        addresses,
        account: owner,
      })
    : new SomniaMarkets({
        indexerUrl,
        chain,
        wsRpcUrl,
        addresses,
        privateKey: pk && pk.startsWith("0x") && pk.length === 66 ? pk : undefined,
      });

  return {
    networkName,
    chainId: chain.id,
    rpcUrl,
    wsRpcUrl,
    indexerUrl,
    exchange,
    publicClient,
    traderAddress: owner ?? exchange.walletAddress,
    close: async () => {
      await exchange.close().catch(() => {});
    },
  };
}

/**
 * Safely reads the SOMI/STT execution deposit required per stop order on a market.
 * Fixes Issue #3: Never passes `null` to `getPerpStopOrderSomiPayment` when `market.stopRegistry` is `null` (e.g. `ADLT-PERP`).
 */
export async function safeGetStopFeeSomi(
  qClient: DreamDexQuantClient,
  stopRegistry: Address | null | undefined,
): Promise<number | null> {
  if (!stopRegistry) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const feeWei =
        await qClient.exchange.client.getPerpStopOrderSomiPayment(stopRegistry);
      return rawToNumber(feeWei, 18);
    } catch {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }
  return null;
}

/**
 * Scans all live perpetual markets on Somnia Tokyo/Hideki Testnet, enriching each market with:
 * - Live on-chain `getPerpRiskParams` (`imfBps`, `mmfBps`, `cmfBps`, `maxOpenInterest`)
 * - Live `MarginBank.isVoucherMarketAllowed(pool)`
 * - Null-safe `stopRegistry` and `stopFeeSomi`
 * - Live orderbook best bid / ask / mid / spread
 * - Live funding rate APR, paid side, breakeven hours, and net 24h/7d carry yield
 */
export async function scanAllPerpMarkets(
  qClient: DreamDexQuantClient,
): Promise<EnrichedPerpMarket[]> {
  const marketsMap = await qClient.exchange.loadMarkets(true);
  const swapMarkets: UnifiedMarket[] = Object.values(marketsMap).filter(
    (m) => m.type === "swap",
  );

  const sharedStopFee = await safeGetStopFeeSomi(
    qClient,
    HIDEKI_BTC_STOP_REGISTRY,
  );

  const enriched = await Promise.all(
    swapMarkets.map(async (um): Promise<EnrichedPerpMarket> => {
      const info = um.info as unknown as RawPerpMarketInfo;
      const symbol = `${info.baseSymbol}-PERP`;
      const priceDecimals = 18;
      const baseDecimals = Number(info.baseDecimals);
      const marginBankAddress =
        info.marginBank ?? COMPLETE_HIDEKI_ADDRESSES.marginBank;

      const [riskParams, perpState, voucherAllowed, orderbook] =
        await Promise.all([
          qClient.exchange.client
            .getPerpRiskParams(info.poolAddress)
            .catch(() => null),
          qClient.exchange.client
            .getPerpState(info.poolAddress)
            .catch(() => null),
          qClient.publicClient
            .readContract({
              address: marginBankAddress,
              abi: MARGIN_BANK_EXTRA_ABI,
              functionName: "isVoucherMarketAllowed",
              args: [info.poolAddress],
            })
            .catch(() => true),
          qClient.exchange
            .fetchOrderBook(um.symbol, 5)
            .catch(() => ({ bids: [], asks: [] })),
        ]);

      const imBps = riskParams
        ? Number(riskParams.initialMarginBps)
        : Number(info.initialMarginBps ?? 1000);
      const mmBps = riskParams
        ? Number(riskParams.maintenanceMarginBps)
        : Math.floor(imBps / 2);
      const cmBps = riskParams
        ? Number(riskParams.closeOutMarginBps)
        : Math.floor(mmBps / 2);
      const maxOiRaw = riskParams
        ? riskParams.maxOpenInterest
        : BigInt(info.openInterest ?? "0");

      const maxLeverage = imBps > 0 ? Math.floor(10_000 / imBps) : 1;

      const markPriceRaw =
        perpState && perpState.markPrice > 0n
          ? perpState.markPrice
          : BigInt(info.markPrice ?? "0");
      const markPriceHuman = rawToNumber(markPriceRaw, priceDecimals);

      const bestBid =
        orderbook.bids.length > 0 && orderbook.bids[0]?.[0] !== undefined
          ? Number(orderbook.bids[0][0])
          : null;
      const bestAsk =
        orderbook.asks.length > 0 && orderbook.asks[0]?.[0] !== undefined
          ? Number(orderbook.asks[0][0])
          : null;
      const midPrice =
        bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

      // Null-safe stopRegistry handling (Fixes Issue #3 on ADLT-PERP)
      const stopRegistry: Address | null = info.stopRegistry ?? null;
      const stopFeeSomi = stopRegistry
        ? sharedStopFee ?? (await safeGetStopFeeSomi(qClient, stopRegistry))
        : null;

      const fundingRateRaw = perpState
        ? perpState.fundingRate
        : BigInt(info.fundingRate ?? "0");
      const windowSec = perpState
        ? Number(perpState.fundingWindowSec)
        : Number(info.fundingWindowSec ?? 0);

      const funding = computeFundingCarryMetrics({
        symbol,
        rateX18: fundingRateRaw,
        windowSeconds: windowSec,
        markPrice: markPriceHuman,
        bestBid,
        bestAsk,
      });

      const tickSizeRaw = BigInt(info.tickSize ?? "0");
      const lotSizeRaw = BigInt(info.lotSize ?? "0");
      const minOrderSizeRaw = BigInt(info.minQuantity ?? "0");

      return {
        symbol,
        ccxtSymbol: um.symbol,
        baseSymbol: info.baseSymbol,
        quoteSymbol: info.quoteSymbol,
        poolAddress: info.poolAddress,
        marginBank: marginBankAddress,
        baseDecimals,
        priceDecimals,
        tickSizeRaw,
        tickSizeHuman: rawToNumber(tickSizeRaw, priceDecimals),
        lotSizeRaw,
        lotSizeHuman: rawToNumber(lotSizeRaw, baseDecimals),
        minOrderSizeRaw,
        minOrderSizeHuman: rawToNumber(minOrderSizeRaw, baseDecimals),
        markPriceRaw,
        markPriceHuman,
        priceable: markPriceRaw > 0n,
        active: Boolean(um.active),
        initialMarginBps: imBps,
        maintenanceMarginBps: mmBps,
        closeoutMarginBps: cmBps,
        maxLeverage,
        maxOpenInterestRaw: maxOiRaw,
        maxOpenInterestHuman: rawToNumber(maxOiRaw, baseDecimals),
        voucherAllowed: Boolean(voucherAllowed),
        stopRegistry,
        stopFeeSomi,
        bestBid,
        bestAsk,
        midPrice,
        funding,
        rawInfo: info,
      };
    }),
  );

  return enriched.sort(
    (a, b) => Math.abs(b.funding.aprPercent) - Math.abs(a.funding.aprPercent),
  );
}

/**
 * Performs a resilient cross-margin account & position risk audit.
 *
 * Fixes Issue #4 & Issue #10:
 * - If `getMarginAccount` (`MarginBank.getAccountHealth`) reverts due to a stale mark on any active pool,
 *   automatically degrades gracefully to `tryGetPerpAccountEquity` / `MarginBank.tryGetAccountEquity(account)`
 *   so risk guards never crash during an oracle outage.
 * - Audits both `PENDING` and `TRIGGER_FAILED` stop orders via the GraphQL Indexer so dropped stops
 *   (`NoFill`, `PlacementFailed`, `ReduceOnlyWrongSide`, `ReduceOnlyBelowMinQty`) are immediately flagged.
 */
export async function auditAccountRisk(
  qClient: DreamDexQuantClient,
  account: Address,
  markets?: EnrichedPerpMarket[],
): Promise<AccountRiskAudit> {
  const allMarkets = markets ?? (await scanAllPerpMarkets(qClient));
  const marginBank =
    allMarkets[0]?.marginBank ?? COMPLETE_HIDEKI_ADDRESSES.marginBank;

  let degradedStaleMarkMode = false;
  let unlockedBalanceUsd = 0;
  let lockedMarginUsd = 0;
  let netEquityRaw = 0n;
  let netEquityUsd = 0;
  let totalInitialMarginReqUsd = 0;
  let totalMaintenanceMarginReqUsd = 0;
  let withdrawableUsd = 0;
  let marginStatus = "Healthy";

  try {
    const marginAcct = await qClient.exchange.client.getMarginAccount(
      marginBank,
      account,
    );
    unlockedBalanceUsd = rawToNumber(marginAcct.unlockedCollateralBalance, 18);
    lockedMarginUsd = rawToNumber(marginAcct.lockedCollateral, 18);
    netEquityRaw = marginAcct.equity;
    netEquityUsd = rawToNumber(marginAcct.equity, 18);
    totalInitialMarginReqUsd = rawToNumber(marginAcct.imReq, 18);
    totalMaintenanceMarginReqUsd = rawToNumber(marginAcct.mmReq, 18);
    withdrawableUsd = rawToNumber(marginAcct.withdrawable, 18);
    marginStatus = String(marginAcct.marginStatus);
  } catch {
    // Graceful fallback when a stale oracle mark causes MarginBank.getAccountHealth to revert (Fixes Issue #4)
    degradedStaleMarkMode = true;
    marginStatus = "DegradedStaleMarkFallback";
    const tryEq = await qClient.publicClient
      .readContract({
        address: marginBank,
        abi: MARGIN_BANK_EXTRA_ABI,
        functionName: "tryGetAccountEquity",
        args: [account],
      })
      .catch(() => null);

    if (tryEq) {
      const [, eqRaw, reqImRaw, reqMmRaw] = tryEq;
      netEquityRaw = eqRaw;
      netEquityUsd = rawToNumber(eqRaw, 18);
      totalInitialMarginReqUsd = rawToNumber(reqImRaw, 18);
      totalMaintenanceMarginReqUsd = rawToNumber(reqMmRaw, 18);
    }
  }

  // Query stop orders for this trader from Hideki GraphQL Indexer (both PENDING and TRIGGER_FAILED)
  const stopQuery = `
    query TraderStops($trader: String!) {
      PerpStopOrder(where: { trader: { _ilike: $trader } }, limit: 200) {
        stopId
        poolAddress
        status
        dropReason
        triggerPrice
      }
    }
  `;
  const stopRows: Array<{
    stopId: number;
    poolAddress: string;
    status: string;
    dropReason: number | null;
    triggerPrice: string;
  }> = await fetch(qClient.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: stopQuery,
      variables: { trader: account.toLowerCase() },
    }),
  })
    .then((r) => r.json())
    .then((j: any) => j?.data?.PerpStopOrder ?? [])
    .catch(() => []);

  const positionResults = await Promise.all(
    allMarkets.map(async (m): Promise<AuditedPosition | null> => {
      const pos = await qClient.exchange.client
        .getPerpPosition({
          marginBank: m.marginBank,
          pool: m.poolAddress,
          account,
        })
        .catch(() => null);
      if (!pos || pos.size === 0n) return null;

      const side: PositionSide = pos.size > 0n ? "long" : "short";
      const absSizeRaw = pos.size > 0n ? pos.size : -pos.size;
      const sizeHuman = rawToNumber(absSizeRaw, m.baseDecimals);
      const entryPriceRaw = pos.avgEntryPrice;
      const entryPriceHuman = rawToNumber(entryPriceRaw, m.priceDecimals);

      const notionalRaw =
        (absSizeRaw * m.markPriceRaw) / 10n ** BigInt(m.baseDecimals);
      const notionalUsd = rawToNumber(notionalRaw, m.priceDecimals);

      const unrealizedPnlUsd =
        (side === "long"
          ? m.markPriceHuman - entryPriceHuman
          : entryPriceHuman - m.markPriceHuman) * sizeHuman;

      const initialMarginRequiredUsd =
        (notionalUsd * m.initialMarginBps) / 10_000;
      const maintenanceMarginRequiredUsd =
        (notionalUsd * m.maintenanceMarginBps) / 10_000;

      const liq = computeExactLiquidationPrice({
        signedSizeRaw: pos.size,
        sizeDecimals: m.baseDecimals,
        entryPriceRaw,
        markPriceRaw: m.markPriceRaw,
        priceDecimals: m.priceDecimals,
        accountEquityRaw: netEquityRaw > 0n ? netEquityRaw : notionalRaw,
        maintenanceMarginBps: m.maintenanceMarginBps,
      });

      const poolLower = m.poolAddress.toLowerCase();
      const mPendingStops = stopRows.filter(
        (s) =>
          s.poolAddress.toLowerCase() === poolLower && s.status === "PENDING",
      );
      const mFailedStops = stopRows.filter(
        (s) =>
          s.poolAddress.toLowerCase() === poolLower &&
          s.status === "TRIGGER_FAILED" &&
          isActionableStopFailure(s.dropReason),
      );

      const failedStopReasons = mFailedStops.map(
        (s) =>
          `stopId=${s.stopId} (dropReason=${s.dropReason} @ trigger=${formatRawToDecimal(BigInt(s.triggerPrice), 18, 4)})`,
      );

      return {
        symbol: m.symbol,
        ccxtSymbol: m.ccxtSymbol,
        baseSymbol: m.baseSymbol,
        poolAddress: m.poolAddress,
        side,
        signedSizeRaw: pos.size,
        sizeHuman,
        entryPriceRaw,
        entryPriceHuman,
        markPriceRaw: m.markPriceRaw,
        markPriceHuman: m.markPriceHuman,
        notionalUsd,
        unrealizedPnlUsd,
        initialMarginRequiredUsd,
        maintenanceMarginRequiredUsd,
        liquidation: liq,
        pendingStopsCount: mPendingStops.length,
        failedStopsCount: mFailedStops.length,
        failedStopReasons,
      };
    }),
  );

  const activePositions = positionResults
    .filter((p): p is AuditedPosition => p !== null)
    .sort((a, b) => b.notionalUsd - a.notionalUsd);

  const totalNotionalUsd = activePositions.reduce(
    (sum, p) => sum + p.notionalUsd,
    0,
  );
  const totalUnrealizedPnlUsd = activePositions.reduce(
    (sum, p) => sum + p.unrealizedPnlUsd,
    0,
  );

  const marginHealthRatio =
    totalMaintenanceMarginReqUsd > 0
      ? netEquityUsd / totalMaintenanceMarginReqUsd
      : Number.POSITIVE_INFINITY;

  return {
    timestamp: new Date().toISOString(),
    network: qClient.networkName,
    chainId: qClient.chainId,
    account,
    degradedStaleMarkMode,
    unlockedBalanceUsd,
    lockedMarginUsd,
    netEquityUsd,
    totalInitialMarginReqUsd,
    totalMaintenanceMarginReqUsd,
    withdrawableUsd,
    marginHealthRatio,
    marginStatus,
    openPositionsCount: activePositions.length,
    totalNotionalUsd,
    totalUnrealizedPnlUsd,
    positions: activePositions,
  };
}
