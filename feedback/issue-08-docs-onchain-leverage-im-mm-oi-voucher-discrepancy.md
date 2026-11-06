# Perps documentation misstates max leverage (20x/5x vs 40x/10x on-chain), Initial/Maintenance Margin, Max OI, and Paper USDso voucher eligibility across 13 of 22 markets

Severity: Major
Area: Docs / Smart Contracts

## Severity
Major (Traders and bots relying on documented Initial Margin / Maintenance Margin / Max Leverage / Voucher rules miscalculate liquidation thresholds by 2x and misidentify voucher-eligible markets)

## Area
Docs & Smart Contracts (`https://app.testnet.dreamdex.io/docs/trading/perps-testnet`, `https://app.testnet.dreamdex.io/docs/trading/perps-testnet/margin-and-liquidations`, and on-chain `PerpPool` / `MarginBank` contracts on Hideki `50383`)

## Steps to reproduce
1. Read the official Perps Market Specifications & Margin tables at:
   - `https://app.testnet.dreamdex.io/docs/trading/perps-testnet`
   - `https://app.testnet.dreamdex.io/docs/trading/perps-testnet/margin-and-liquidations`
2. Query the live on-chain parameters for all 22 `PerpPool` contracts on Somnia Tokyo/Hideki Testnet (`chainId: 50383`) using `getPerpPoolParameters()` and `MarginBank.isVoucherMarketAllowed(pool)` (`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`).
3. Compare the documented values against the actual on-chain contract storage across all 22 markets.

## Expected
The Market Specifications and Margin tier tables in the documentation should match the live on-chain `PerpPool` (`initialMarginBps`, `maintenanceMarginBps`, `closeoutMarginBps`, `maxOpenInterest`) and `MarginBank.isVoucherMarketAllowed(pool)` state on Somnia Tokyo/Hideki Testnet.

## Actual
13 of the 22 live markets on Hideki have materially different on-chain risk parameters and voucher rules than documented:

1. **Tier 1 (`BTC-PERP`, `ETH-PERP`, `HYPE-PERP`, `SOL-PERP`) — 40x on-chain vs 20x in docs**:
   - **Docs state**: Max Leverage **20x** (`IM = 5.0%` / `500 bps`, `MM = 2.5%` / `250 bps`, `CM = 1.25%` / `125 bps`), and Max OI = `246.81545 BTC` / `7,376.4337 ETH` / `459,986.57 SOL` / `822,126.92 HYPE`.
   - **On-chain actual**: `initialMarginBps = 250` (**40x max leverage**, `IM = 2.5%`, `MM = 1.25%` / `125 bps`, `CM = 0.62%` / `62 bps`), and `maxOpenInterest` is **2x higher** (`493.6309 BTC`, `14,752.8674 ETH`, `919,973.14 SOL`, `1,644,253.84 HYPE`).
2. **Tier 3 (`1000PEPE-PERP`, `LIT-PERP`, `PUMP-PERP`, `TAO-PERP`, `VVV-PERP`, `WLD-PERP`, `ZEC-PERP`, `ZRO-PERP`) — 10x on-chain vs 5x in docs**:
   - **Docs state**: Max Leverage **5x** (`IM = 20.0%` / `2000 bps`, `MM = 10.0%` / `1000 bps`, `CM = 5.0%` / `500 bps`).
   - **On-chain actual**: `initialMarginBps = 1000` (**10x max leverage**, `IM = 10.0%`, `MM = 5.0%` / `500 bps`, `CM = 2.5%` / `250 bps`), and `maxOpenInterest` is **2x higher** across all 8 pools.
3. **Paper USDso Voucher Eligibility (`1000PEPE-PERP`, `LIT-PERP`, `PUMP-PERP`, `VVV-PERP`, `ZEC-PERP`, `ZRO-PERP`)**:
   - **Docs state**: *"Only the 15 markets that have `MarginBank.isVoucherMarketAllowed(pool) = true` can be traded with voucher-backed margin. The six newest 5x markets (`1000PEPE`, `LIT`, `PUMP`, `VVV`, `ZEC`, `ZRO`) require deposited USDso."*
   - **On-chain actual**: `MarginBank.isVoucherMarketAllowed(pool)` returns **`true` for all 21 documented markets** (including `1000PEPE`, `LIT`, `PUMP`, `VVV`, `ZEC`, and `ZRO` — which already have active voucher-backed positions on-chain!). Only the undocumented 22nd market `ADLT-PERP` (`0xe3f6dcda98595764970e5a6ffd167af1d1b35123`, `IM = 500 bps` / 20x) returns `isVoucherMarketAllowed = false`.

## Evidence
On-chain query results from `https://api.hideki2.infra.testnet.somnia.network` (`PerpPool.getParameters()` and `MarginBank.isVoucherMarketAllowed(pool)` at `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`):

| Market | Pool Address | Docs Max Lev (IM / MM) | On-Chain Actual Max Lev (`imBps` / `mmBps` / `cmBps`) | Docs `Paper USDso` | On-Chain `isVoucherMarketAllowed` | Docs Max OI | On-Chain Max OI |
|---|---|---|---|---|---|---|---|
| `BTC-PERP` | `0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7` | 20x (5% / 2.5%) | **40x** (`250` / `125` / `62`) | Yes | `true` | `246.81545` | **`493.6309`** |
| `ETH-PERP` | `0x53a1d281f2ca20a9cfef1dc071f0f5fa4570c175` | 20x (5% / 2.5%) | **40x** (`250` / `125` / `62`) | Yes | `true` | `7,376.4337` | **`14,752.8674`** |
| `HYPE-PERP` | `0x34a7b5d882a0ff3201b527219aa20e4a9dc62780` | 20x (5% / 2.5%) | **40x** (`250` / `125` / `62`) | Yes | `true` | `822,126.92` | **`1,644,253.84`** |
| `SOL-PERP` | `0x0520edaf788688f9e48fb1fbba53f748d855aa89` | 20x (5% / 2.5%) | **40x** (`250` / `125` / `62`) | Yes | `true` | `459,986.57` | **`919,973.14`** |
| `1000PEPE-PERP` | `0x63d61a6760d846c60a725c166a39a5543aa7f0f5` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `726,426,600` | **`1,452,853,200`** |
| `LIT-PERP` | `0x5d11303f14a562d9eb773282849e387a531a53ab` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `261,802.2` | **`523,604.4`** |
| `PUMP-PERP` | `0x628b69103deab48c7a380cf84289f482c8140040` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `1,356,374,900` | **`2,712,749,800`** |
| `TAO-PERP` | `0xbf5ae4553efebff4b4b6069a6133eb322274957c` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | Yes | `true` | `1,568.427` | **`3,136.854`** |
| `VVV-PERP` | `0x2cc8a290b902263864f9f144ff23cf3d74b7ce1c` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `36,681.91` | **`73,363.82`** |
| `WLD-PERP` | `0x5a06613e1de2dc45f97c79a41621d202863b963d` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | Yes | `true` | `2,228,164` | **`4,456,328`** |
| `ZEC-PERP` | `0xcbf84579f326fa8c91592cd5829098f8d88ff076` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `1,150.289` | **`2,300.578`** |
| `ZRO-PERP` | `0xdf283121eb218f82417b18e8fa4491b40d6e5662` | 5x (20% / 10%) | **10x** (`1000` / `500` / `250`) | No | **`true`** | `280,159.1` | **`560,318.2`** |
| `ADLT-PERP` | `0xe3f6dcda98595764970e5a6ffd167af1d1b35123` | *(Unlisted)* | **20x** (`500` / `250` / `125`) | *(Unlisted)* | **`false`** | *(Unlisted)* | **`10,000,000`** |

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **RPC**: `https://api.hideki2.infra.testnet.somnia.network`
- **Contracts**: `MarginBank` (`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`) and all 22 `PerpPool` contracts
- **Docs URLs**:
  - `https://app.testnet.dreamdex.io/docs/trading/perps-testnet`
  - `https://app.testnet.dreamdex.io/docs/trading/perps-testnet/margin-and-liquidations`
