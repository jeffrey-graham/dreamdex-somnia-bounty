#!/usr/bin/env node
/**
 * @file src/cli.ts
 * @description CLI entrypoint for the Somnia dreamDEX Perps Quantitative Trading,
 * Risk & Funding-Rate Arbitrage Agent (Track 2 MVP).
 *
 * Commands:
 * - `scan`     : Scans all 22 live Somnia Tokyo/Hideki perpetual markets, ranking funding-rate
 *                arbitrage & spread-capture opportunities and verifying on-chain vs documented specs.
 * - `audit`    : Performs a cross-margin & position risk audit on any trader account on Hideki
 *                (defaulting to active whale accounts `0x47537E3A3ea6e9391F3B26Ea45618db6828c8bfF`
 *                and `0x8239544DB8718D75111e4AEedc42036742D22E68`), including exact liquidation
 *                distances and `TRIGGER_FAILED` stop-order diagnostics.
 * - `simulate` : Runs a quantitative funding-carry & bracket execution simulation against live
 *                Hideki pools (`BTC-PERP`, `BNB-PERP`, `HYPE-PERP`, `LIT-PERP`, `ETH-PERP`),
 *                calling on-chain `getMaxPerpOrderSize` & `previewPerpClosePnl` and logging
 *                structured JSONL execution telemetry to `data/execution_telemetry.jsonl`.
 * - `doctor`   : Runs an end-to-end diagnostic check of RPC, GraphQL Indexer, Core Contracts,
 *                and `operatorPermissionsRegistry` / `stopRegistry` health.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, type Address } from "viem";
import { perpPoolWriteAbi } from "@somnia-chain/markets-sdk";
import {
  COMPLETE_HIDEKI_ADDRESSES,
  auditAccountRisk,
  createQuantClient,
  scanAllPerpMarkets,
  type EnrichedPerpMarket,
} from "./client.js";
import {
  alignDirectionalPrice,
  computeBracketPrices,
  computeExactLiquidationPrice,
  computeOptimalPositionSize,
  formatRawToDecimal,
  parseDecimalToRaw,
  type PositionSide,
} from "./quant-math.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function serializeBigInt(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

function pad(str: string, width: number, rightAlign = false): string {
  if (str.length >= width) return str.slice(0, width);
  return rightAlign ? str.padStart(width, " ") : str.padEnd(width, " ");
}

async function runScanCommand(): Promise<void> {
  console.log("================================================================================================");
  console.log("  Somnia dreamDEX Perps Quantitative Market & Funding-Rate Arbitrage Scanner (Hideki 50383)");
  console.log("================================================================================================");

  const qClient = await createQuantClient({ network: "hideki" });
  try {
    const markets = await scanAllPerpMarkets(qClient);

    console.log(
      `Connected to ${qClient.networkName.toUpperCase()} (chainId=${qClient.chainId}) · Discovered ${markets.length} live PerpPools\n`,
    );

    const header = [
      pad("Symbol", 14),
      pad("Mark ($)", 11, true),
      pad("Spread(bps)", 11, true),
      pad("Funding APR", 12, true),
      pad("PaidSide", 9, true),
      pad("Breakeven", 10, true),
      pad("Net 7d(%)", 10, true),
      pad("MaxLev", 7, true),
      pad("Voucher", 8, true),
      pad("StopReg", 8, true),
    ].join(" | ");

    console.log(header);
    console.log("-".repeat(header.length));

    for (const m of markets) {
      const spreadStr =
        m.funding.spreadBps !== null ? m.funding.spreadBps.toFixed(2) : "EMPTY";
      const aprStr = `${m.funding.aprPercent >= 0 ? "+" : ""}${m.funding.aprPercent.toFixed(2)}%`;
      const beStr =
        m.funding.breakevenHours !== null
          ? `${m.funding.breakevenHours.toFixed(1)}h`
          : "N/A";
      const net7dStr = `${m.funding.net7dCarryPct >= 0 ? "+" : ""}${m.funding.net7dCarryPct.toFixed(3)}%`;
      const stopRegStr = m.stopRegistry ? "OK" : "NULL(!)";

      console.log(
        [
          pad(m.symbol, 14),
          pad(m.markPriceHuman.toFixed(m.markPriceHuman < 1 ? 6 : 2), 11, true),
          pad(spreadStr, 11, true),
          pad(aprStr, 12, true),
          pad(m.funding.paidSide.toUpperCase(), 9, true),
          pad(beStr, 10, true),
          pad(net7dStr, 10, true),
          pad(`${m.maxLeverage}x`, 7, true),
          pad(m.voucherAllowed ? "YES" : "NO", 8, true),
          pad(stopRegStr, 8, true),
        ].join(" | "),
      );
    }

    const actionable = markets.filter(
      (m) =>
        m.funding.actionableSide !== null &&
        m.funding.spreadBps !== null &&
        m.stopRegistry !== null &&
        Math.abs(m.funding.aprPercent) >= 12,
    );

    console.log("\nTop High-Conviction Funding-Rate Arbitrage Signals (|APR| >= 12%, Active LOB & StopRegistry):");
    for (const m of actionable) {
      console.log(
        `  -> [${m.symbol}] Action: ${m.funding.actionableSide?.toUpperCase()} · Carry APR: ${m.funding.aprPercent.toFixed(2)}% · Spread: ${m.funding.spreadBps?.toFixed(2)} bps · Breakeven Hold: ${m.funding.breakevenHours?.toFixed(2)}h · 7d Net Yield (1x): +${m.funding.net7dCarryPct.toFixed(3)}% (+${(m.funding.net7dCarryPct * 5).toFixed(2)}% at 5x)`,
      );
    }

    ensureDataDir();
    const outPath = resolve(DATA_DIR, "live_market_scan.json");
    const payload = {
      capturedAt: new Date().toISOString(),
      network: qClient.networkName,
      chainId: qClient.chainId,
      rpcUrl: qClient.rpcUrl,
      indexerUrl: qClient.indexerUrl,
      totalMarkets: markets.length,
      highConvictionSignals: actionable.map((m) => ({
        symbol: m.symbol,
        poolAddress: m.poolAddress,
        recommendedSide: m.funding.actionableSide,
        fundingAprPct: Number(m.funding.aprPercent.toFixed(4)),
        markPriceUsd: m.markPriceHuman,
        bestBidUsd: m.bestBid,
        bestAskUsd: m.bestAsk,
        spreadBps:
          m.funding.spreadBps !== null
            ? Number(m.funding.spreadBps.toFixed(2))
            : null,
        breakevenHours:
          m.funding.breakevenHours !== null
            ? Number(m.funding.breakevenHours.toFixed(2))
            : null,
        net7dCarryPct1x: Number(m.funding.net7dCarryPct.toFixed(4)),
        maxLeverage: m.maxLeverage,
      })),
      markets: markets.map((m) => ({
        symbol: m.symbol,
        ccxtSymbol: m.ccxtSymbol,
        poolAddress: m.poolAddress,
        baseDecimals: m.baseDecimals,
        markPriceUsd: m.markPriceHuman,
        bestBidUsd: m.bestBid,
        bestAskUsd: m.bestAsk,
        spreadBps: m.funding.spreadBps,
        markVsMidBasisBps: m.funding.markVsMidBasisBps,
        fundingRateX18: m.funding.rateX18.toString(),
        fundingAprPercent: m.funding.aprPercent,
        paidSide: m.funding.paidSide,
        breakevenHours: m.funding.breakevenHours,
        net24hCarryBps: m.funding.net24hCarryBps,
        net7dCarryPct: m.funding.net7dCarryPct,
        initialMarginBps: m.initialMarginBps,
        maintenanceMarginBps: m.maintenanceMarginBps,
        closeoutMarginBps: m.closeoutMarginBps,
        maxLeverage: m.maxLeverage,
        maxOpenInterest: m.maxOpenInterestHuman,
        voucherAllowed: m.voucherAllowed,
        stopRegistry: m.stopRegistry,
        stopFeeSomi: m.stopFeeSomi,
        tickSize: m.tickSizeHuman,
        lotSize: m.lotSizeHuman,
        minOrderSize: m.minOrderSizeHuman,
      })),
    };

    writeFileSync(outPath, serializeBigInt(payload));
    console.log(`\nSaved full live market telemetry to ${outPath}`);
  } finally {
    await qClient.close();
  }
}

async function runAuditCommand(targetAddressArg?: string): Promise<void> {
  const accountsToAudit: Address[] = targetAddressArg
    ? [targetAddressArg as Address]
    : [
        "0x47537E3A3ea6e9391F3B26Ea45618db6828c8bfF",
        "0x8239544DB8718D75111e4AEedc42036742D22E68",
      ];

  console.log("================================================================================================");
  console.log("  Somnia dreamDEX Perps Cross-Margin & Liquidation Risk Auditor (Hideki 50383)");
  console.log("================================================================================================");

  const qClient = await createQuantClient({ network: "hideki" });
  try {
    const markets = await scanAllPerpMarkets(qClient);
    const audits = [];

    for (const account of accountsToAudit) {
      const audit = await auditAccountRisk(qClient, account, markets);
      audits.push(audit);

      console.log(`\nAccount: ${audit.account}`);
      console.log(
        `  Equity: $${audit.netEquityUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} · Unlocked: $${audit.unlockedBalanceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} · Locked IM: $${audit.lockedMarginUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} · MM Req: $${audit.totalMaintenanceMarginReqUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      );
      console.log(
        `  Health Ratio: ${Number.isFinite(audit.marginHealthRatio) ? `${audit.marginHealthRatio.toFixed(2)}x` : "INF"} · Status: ${audit.marginStatus} · Open Positions: ${audit.openPositionsCount} · Total Notional: $${audit.totalNotionalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} · Total uPnL: $${audit.totalUnrealizedPnlUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      );

      const posHeader = [
        pad("Symbol", 14),
        pad("Side", 6),
        pad("Size", 13, true),
        pad("Entry ($)", 11, true),
        pad("Mark ($)", 11, true),
        pad("uPnL ($)", 12, true),
        pad("LiqPrice($)", 13, true),
        pad("LiqDist(%)", 11, true),
        pad("Stops", 7, true),
      ].join(" | ");
      console.log("\n  " + posHeader);
      console.log("  " + "-".repeat(posHeader.length));

      for (const p of audit.positions.slice(0, 12)) {
        const dec = p.markPriceHuman < 1 ? 5 : 2;
        const liqStr =
          p.liquidation.liquidationPriceHuman !== null
            ? p.liquidation.liquidationPriceHuman.toFixed(dec)
            : "N/A";
        const distStr =
          p.liquidation.distanceToLiqPct !== null
            ? `${p.liquidation.distanceToLiqPct.toFixed(1)}%`
            : "N/A";
        const stopStr = `${p.pendingStopsCount}P/${p.failedStopsCount}F`;

        console.log(
          "  " +
            [
              pad(p.symbol, 14),
              pad(p.side.toUpperCase(), 6),
              pad(p.sizeHuman.toString(), 13, true),
              pad(p.entryPriceHuman.toFixed(dec), 11, true),
              pad(p.markPriceHuman.toFixed(dec), 11, true),
              pad(
                `${p.unrealizedPnlUsd >= 0 ? "+" : ""}${p.unrealizedPnlUsd.toFixed(2)}`,
                12,
                true,
              ),
              pad(liqStr, 13, true),
              pad(distStr, 11, true),
              pad(stopStr, 7, true),
            ].join(" | "),
        );
      }
      if (audit.positions.length > 12) {
        console.log(
          `  ... and ${audit.positions.length - 12} additional open positions (see data/live_account_risk_audit.json)`,
        );
      }
    }

    ensureDataDir();
    const outPath = resolve(DATA_DIR, "live_account_risk_audit.json");
    writeFileSync(
      outPath,
      serializeBigInt({
        capturedAt: new Date().toISOString(),
        network: qClient.networkName,
        chainId: qClient.chainId,
        auditedAccounts: audits,
      }),
    );
    console.log(`\nSaved cross-margin risk audit telemetry to ${outPath}`);
  } finally {
    await qClient.close();
  }
}

async function runSimulateCommand(): Promise<void> {
  console.log("================================================================================================");
  console.log("  Somnia dreamDEX Perps Quantitative Execution & Bracket Simulation Engine (Hideki 50383)");
  console.log("================================================================================================");

  const qClient = await createQuantClient({ network: "hideki" });
  try {
    const markets = await scanAllPerpMarkets(qClient);
    const marketBySymbol = new Map<string, EnrichedPerpMarket>(
      markets.map((m) => [m.symbol, m]),
    );

    const referenceTrader: Address =
      (process.env.OWNER_ADDRESS as Address | undefined) ??
      "0x47537E3A3ea6e9391F3B26Ea45618db6828c8bfF";

    const targetSymbols = [
      "BTC-PERP",
      "BNB-PERP",
      "HYPE-PERP",
      "LIT-PERP",
      "ETH-PERP",
    ];
    const marginBudgetUsd = Number(process.env.MARGIN_USD ?? "250");
    const targetLeverage = Number(process.env.LEVERAGE ?? "5");
    const tpBps = Number(process.env.TP_BPS ?? "150");
    const slBps = Number(process.env.SL_BPS ?? "100");

    ensureDataDir();
    const telemetryPath = resolve(DATA_DIR, "execution_telemetry.jsonl");
    writeFileSync(telemetryPath, "");

    for (const sym of targetSymbols) {
      const m = marketBySymbol.get(sym);
      if (!m) continue;

      const desiredSide: PositionSide = m.funding.actionableSide ?? "short";
      const touchHuman =
        desiredSide === "long"
          ? (m.bestAsk ?? m.markPriceHuman)
          : (m.bestBid ?? m.markPriceHuman);

      // Exact decimal-string to raw conversion (Fixes Issue #2)
      const rawTouchExact = parseDecimalToRaw(touchHuman, m.priceDecimals);
      const alignedExecPriceRaw = alignDirectionalPrice(
        rawTouchExact,
        m.tickSizeRaw,
        desiredSide,
        false,
      );

      // Compare against buggy Math.round(touch * 1e18) from perp-core
      const buggyFloatRaw = BigInt(Math.round(touchHuman * 1e18));
      const buggyFlooredRaw = (buggyFloatRaw / m.tickSizeRaw) * m.tickSizeRaw;

      // Query live on-chain max order size & existing position on reference trader
      const [maxOrderSize, existingPos] = await Promise.all([
        qClient.exchange.client
          .getMaxPerpOrderSize({
            pool: m.poolAddress,
            marginBank: m.marginBank,
            account: referenceTrader,
            isBid: desiredSide === "long",
            price: alignedExecPriceRaw,
            autoPull: false,
          })
          .catch(() => null),
        qClient.exchange.client
          .getPerpPosition({
            marginBank: m.marginBank,
            pool: m.poolAddress,
            account: referenceTrader,
          })
          .catch(() => null),
      ]);

      const maxChainSideRaw =
        maxOrderSize && maxOrderSize.priceable && maxOrderSize.placeable
          ? maxOrderSize.maxQuantity
          : undefined;

      const sizing = computeOptimalPositionSize({
        marginBudgetUsd,
        targetLeverage,
        initialMarginBps: m.initialMarginBps,
        executionPriceRaw: alignedExecPriceRaw,
        priceDecimals: m.priceDecimals,
        sizeDecimals: m.baseDecimals,
        lotSizeRaw: m.lotSizeRaw,
        minOrderSizeRaw: m.minOrderSizeRaw,
        maxChainSizeRaw: maxChainSideRaw,
      });

      const existingSide: PositionSide | null =
        existingPos && existingPos.size !== 0n
          ? existingPos.size > 0n
            ? "long"
            : "short"
          : null;

      // Compute bracket prices for BOTH fresh entry and existing-position management (Fixes Issue #1)
      const entryBracket = computeBracketPrices({
        configuredSide: desiredSide,
        existingPositionSide: null,
        referencePriceRaw: alignedExecPriceRaw,
        tickSizeRaw: m.tickSizeRaw,
        priceDecimals: m.priceDecimals,
        tpBps,
        slBps,
      });

      const existingPosBracket = computeBracketPrices({
        configuredSide: "long", // Simulate default SIDE="long" when existing position is short
        existingPositionSide: existingSide,
        referencePriceRaw: m.markPriceRaw,
        tickSizeRaw: m.tickSizeRaw,
        priceDecimals: m.priceDecimals,
        tpBps,
        slBps,
      });

      // Compute exact isolated liquidation price for the simulated order
      const simulatedSignedSize =
        desiredSide === "long" ? sizing.alignedSizeRaw : -sizing.alignedSizeRaw;
      const simulatedMarginRaw = parseDecimalToRaw(marginBudgetUsd, 18);
      const liqSim = computeExactLiquidationPrice({
        signedSizeRaw: simulatedSignedSize,
        sizeDecimals: m.baseDecimals,
        entryPriceRaw: alignedExecPriceRaw,
        markPriceRaw: m.markPriceRaw,
        priceDecimals: m.priceDecimals,
        accountEquityRaw: simulatedMarginRaw,
        maintenanceMarginBps: m.maintenanceMarginBps,
      });

      // Encode on-chain PerpPool.placeOrder calldata to verify ABI & parameter readiness
      const orderData = encodeFunctionData({
        abi: perpPoolWriteAbi,
        functionName: "placeOrder",
        args: [
          desiredSide === "long",
          0n, // userData
          alignedExecPriceRaw,
          sizing.alignedSizeRaw,
          0n, // expireTimestampNs
          1, // ORDER_TYPE.MARKET (IOC)
          0, // selfMatchingOption
          "0x0000000000000000000000000000000000000000", // builder
          0n, // builderFeeBpsTimes1k
        ],
      });

      const record = {
        timestamp: new Date().toISOString(),
        chainId: qClient.chainId,
        symbol: m.symbol,
        poolAddress: m.poolAddress,
        strategySignal: {
          recommendedSide: desiredSide,
          fundingAprPct: Number(m.funding.aprPercent.toFixed(4)),
          paidSide: m.funding.paidSide,
          spreadBps:
            m.funding.spreadBps !== null
              ? Number(m.funding.spreadBps.toFixed(2))
              : null,
          breakevenHours:
            m.funding.breakevenHours !== null
              ? Number(m.funding.breakevenHours.toFixed(2))
              : null,
        },
        precisionAudit: {
          touchInput: touchHuman,
          exactAlignedRaw: alignedExecPriceRaw.toString(),
          exactAlignedHuman: formatRawToDecimal(
            alignedExecPriceRaw,
            m.priceDecimals,
            6,
          ),
          buggyPerpCoreFloatRaw: buggyFloatRaw.toString(),
          buggyPerpCoreFlooredHuman: formatRawToDecimal(
            buggyFlooredRaw,
            m.priceDecimals,
            6,
          ),
          weiDriftFixed: (alignedExecPriceRaw - buggyFloatRaw).toString(),
        },
        orderSizing: {
          marginBudgetUsd,
          effectiveLeverage: sizing.effectiveLeverage,
          maxAllowedLeverage: sizing.maxAllowedLeverage,
          targetNotionalUsd: sizing.targetNotionalUsd,
          alignedSizeRaw: sizing.alignedSizeRaw.toString(),
          alignedSizeHuman: sizing.alignedSizeHuman,
          onChainMaxQuantityRaw:
            maxOrderSize && maxOrderSize.priceable
              ? maxOrderSize.maxQuantity.toString()
              : null,
          limitedBy:
            maxOrderSize && maxOrderSize.priceable
              ? maxOrderSize.limitedBy
              : null,
        },
        bracketProtection: {
          entrySide: entryBracket.activeSide,
          stopOrderIsAsk: entryBracket.stopOrderIsAsk,
          takeProfitUsd: entryBracket.takeProfitHuman,
          stopLossUsd: entryBracket.stopLossHuman,
          existingPositionOnAccount: existingSide,
          existingPosManagedSide: existingPosBracket.activeSide,
          existingPosTakeProfitUsd: existingPosBracket.takeProfitHuman,
          existingPosStopLossUsd: existingPosBracket.stopLossHuman,
        },
        liquidationProfile: {
          maintenanceMarginBps: m.maintenanceMarginBps,
          estimatedLiquidationPriceUsd: liqSim.liquidationPriceHuman,
          distanceToLiquidationPct: liqSim.distanceToLiqPct,
        },
        unsignedTxPreview: {
          orderTo: m.poolAddress,
          orderDataPrefix: orderData.slice(0, 18),
          stopRegistry: m.stopRegistry,
          operatorPermissionsRegistry:
            COMPLETE_HIDEKI_ADDRESSES.operatorPermissionsRegistry,
          stopFeeSomi: m.stopFeeSomi,
        },
      };

      appendFileSync(telemetryPath, JSON.stringify(record) + "\n");

      console.log(`\n[${m.symbol}] Pool ${m.poolAddress}`);
      console.log(
        `  Signal       : ${desiredSide.toUpperCase()} (Funding APR: ${m.funding.aprPercent >= 0 ? "+" : ""}${m.funding.aprPercent.toFixed(2)}%, Paid: ${m.funding.paidSide.toUpperCase()}, Breakeven: ${m.funding.breakevenHours?.toFixed(2) ?? "N/A"}h)`,
      );
      console.log(
        `  Exec Price   : $${formatRawToDecimal(alignedExecPriceRaw, m.priceDecimals, 4)} (Exact Raw: ${alignedExecPriceRaw} vs Buggy perp-core: ${buggyFloatRaw})`,
      );
      console.log(
        `  Order Size   : ${sizing.alignedSizeHuman} ${m.baseSymbol} ($${sizing.targetNotionalUsd.toFixed(2)} notional @ ${sizing.effectiveLeverage}x on ${sizing.maxAllowedLeverage}x max pool)`,
      );
      console.log(
        `  Bracket      : TP $${entryBracket.takeProfitHuman.toFixed(4)} | SL $${entryBracket.stopLossHuman.toFixed(4)} (stop isAsk=${entryBracket.stopOrderIsAsk}, fee=${m.stopFeeSomi ?? 0} STT)`,
      );
      console.log(
        `  Existing Pos : ${existingSide ? `Account is ${existingSide.toUpperCase()} -> Managed as ${existingPosBracket.activeSide.toUpperCase()} (TP $${existingPosBracket.takeProfitHuman.toFixed(4)}, SL $${existingPosBracket.stopLossHuman.toFixed(4)})` : "Flat"}`,
      );
      console.log(
        `  Liq Profile  : Est. Liq Price $${liqSim.liquidationPriceHuman?.toFixed(4) ?? "N/A"} (Distance: ${liqSim.distanceToLiqPct?.toFixed(2) ?? "N/A"}%, MM: ${m.maintenanceMarginBps} bps)`,
      );
      console.log(
        `  Calldata     : PerpPool.placeOrder->${m.poolAddress} (${orderData.slice(0, 10)}) | StopRegistry->${m.stopRegistry ?? "NULL"}`,
      );
    }

    console.log(
      `\nAppended ${targetSymbols.length} execution simulation records to ${telemetryPath}`,
    );
  } finally {
    await qClient.close();
  }
}

async function runDoctorCommand(): Promise<void> {
  console.log("================================================================================================");
  console.log("  Somnia dreamDEX Perps Diagnostic Doctor (Hideki 50383)");
  console.log("================================================================================================");

  const qClient = await createQuantClient({ network: "hideki" });
  try {
    const [blockNumber, sysConfig, markets] = await Promise.all([
      qClient.publicClient.getBlockNumber(),
      qClient.exchange.client.getPerpSystemConfig(
        COMPLETE_HIDEKI_ADDRESSES.marginBank,
      ),
      scanAllPerpMarkets(qClient),
    ]);

    console.log(`Network       : ${qClient.networkName} (chainId=${qClient.chainId})`);
    console.log(`RPC           : ${qClient.rpcUrl} (Head Block: ${blockNumber})`);
    console.log(`Indexer       : ${qClient.indexerUrl}`);
    console.log(`MarginBank    : ${COMPLETE_HIDEKI_ADDRESSES.marginBank}`);
    console.log(`Collateral    : ${COMPLETE_HIDEKI_ADDRESSES.collateral}`);
    console.log(
      `OperatorReg   : ${COMPLETE_HIDEKI_ADDRESSES.operatorPermissionsRegistry} (Patched in COMPLETE_HIDEKI_ADDRESSES)`,
    );
    console.log(
      `LiqEngine     : ${sysConfig.liquidationEngine} | InsuranceFund: ${sysConfig.insuranceFund}`,
    );
    console.log(`Live Markets  : ${markets.length} PerpPools`);
    console.log(
      `Null StopRegs : ${markets.filter((m) => m.stopRegistry === null).map((m) => m.symbol).join(", ") || "None"}`,
    );
  } finally {
    await qClient.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "scan";
  const arg = process.argv[3];

  switch (cmd) {
    case "scan":
      await runScanCommand();
      break;
    case "audit":
      await runAuditCommand(arg);
      break;
    case "simulate":
      await runSimulateCommand();
      break;
    case "doctor":
      await runDoctorCommand();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. Use: scan | audit | simulate | doctor`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error in dreamDEX quant CLI:", err);
  process.exit(1);
});
