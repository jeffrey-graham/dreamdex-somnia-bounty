# `dreamdex-bot-kit` pins `@somnia-chain/markets-sdk@0.30.0` and passes Shannon (`50312`) contract addresses on Hideki (`50383`), breaking voucher helpers and `getPerpSystemConfig()`

Severity: Major
Area: SDK / Docs

## Severity
Major (Developer docs code snippets fail with `TypeError` / `undefined` imports inside the official starter repo, and `getPerpSystemConfig()` / `collateral` / `marginBank` calls revert on Hideki)

## Area
SDK & Docs (`somnia-chain/dreamdex-bot-kit` — `package.json`, `packages/perp-core/src/exchange.ts`, and `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`)

## Steps to reproduce
1. Follow the official Developer Docs at `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`:
   > *"Runnable bots — the public [`somnia-chain/dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit) repo ships five strategy templates (`perp-starter`, `perp-maker`, `perp-funding`, `perp-guard`, `perp-liquidator`) plus a `perp:doctor` pre-flight check against `@somnia-chain/markets-sdk`."*
2. Clone `https://github.com/somnia-chain/dreamdex-bot-kit`, run `npm install`, and inspect `package.json` and `packages/perp-core/package.json`:
   - Both pin `"@somnia-chain/markets-sdk": "^0.30.0"` with `package-lock.json` locking `0.30.0` (whereas the Developer Docs target `0.32.1`).
3. Try to run the Paper USDso voucher claim code or `SOMNIA_HIDEKI_TESTNET_ADDRESSES` import from the Developer Docs (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet#claiming-the-paper-usdso-voucher`) inside `dreamdex-bot-kit`:
   ```bash
   npx tsx -e '
   import { connectPerp } from "@dreamdex/perp-core";
   const ctx = connectPerp();
   console.log(typeof (ctx.exchange.client as any).getPerpVoucherEligibility);
   await ctx.exchange.client.getPerpSystemConfig();
   '
   ```
4. Inspect `packages/perp-core/src/exchange.ts` (lines 48–60):
   ```ts
   const exchange = await Exchange.connect({
     rpcUrl: network.rpcUrl,
     chain: somniaChain(network),
     addresses: SOMNIA_TESTNET_ADDRESSES,
     indexerUrl: network.indexerUrl,
     ...
   });
   ```

## Expected
1. `dreamdex-bot-kit` should depend on `@somnia-chain/markets-sdk@^0.32.1` so that `SOMNIA_HIDEKI_TESTNET_ADDRESSES`, `hidekiTestnet`, `getPerpVoucherEligibility`, and `claimPerpVoucher` documented on `https://app.testnet.dreamdex.io/docs/developers/perps-testnet` exist and work out of the box.
2. `packages/perp-core/src/exchange.ts` should select `SOMNIA_HIDEKI_TESTNET_ADDRESSES` when `network.chainId === 50383` (`hideki`) instead of hardcoding `SOMNIA_TESTNET_ADDRESSES` (which are Shannon Testnet `50312` addresses).

## Actual
1. In `@somnia-chain/markets-sdk@0.30.0` (locked in `dreamdex-bot-kit`):
   - `SOMNIA_HIDEKI_TESTNET_ADDRESSES` is `undefined`.
   - `hidekiTestnet` is `undefined`.
   - `getPerpVoucherEligibility` and `claimPerpVoucher` do not exist (`TypeError: ctx.exchange.client.getPerpVoucherEligibility is not a function`).
2. Because `packages/perp-core/src/exchange.ts:56` hardcodes `addresses: SOMNIA_TESTNET_ADDRESSES` on Hideki (`chainId: 50383`), the SDK is configured with Shannon Testnet (`50312`) contract addresses:
   - `collateral: 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` -> **`0 bytes` of bytecode on Hideki** (actual Hideki USDso is `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72`).
   - `collateralRouter: 0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` -> **`0 bytes` of bytecode on Hideki**.
   - `marketCreator: 0x2c6334510BE715E06d8B430b20e2A1f8cA880431` -> **`0 bytes` of bytecode on Hideki**.
   - `marginBank`, `perpPoolFactory`, `liquidationEngine`, `insuranceFund`, and `voucherDistributor` are all `undefined` on `exchange.client.addresses`.
3. Calling `await ctx.exchange.client.getPerpSystemConfig()` on `connectPerp()` immediately throws `ContractRevertError: @somnia-chain/markets-sdk: getPerpSystemConfig reverted` because it queries the non-existent Shannon address on Hideki.

## Evidence
Live output from `/tmp/dreamdex-bot-kit` connected to Hideki (`50383`):

```text
$ npx tsx -e '
import * as sdk from "@somnia-chain/markets-sdk";
import { connectPerp } from "./packages/perp-core/src/index.js";
const ctx = await connectPerp();
console.log("SOMNIA_HIDEKI_TESTNET_ADDRESSES:", (sdk as any).SOMNIA_HIDEKI_TESTNET_ADDRESSES);
console.log("getPerpVoucherEligibility:", typeof (ctx.exchange.client as any).getPerpVoucherEligibility);
console.log("Configured collateral on Hideki:", (ctx.exchange.client as any).addresses);
const code = await ctx.publicClient.getBytecode({ address: sdk.SOMNIA_TESTNET_ADDRESSES.collateral });
console.log("Bytecode at SOMNIA_TESTNET_ADDRESSES.collateral on Hideki:", code);
await ctx.exchange.client.getPerpSystemConfig();
'
SOMNIA_HIDEKI_TESTNET_ADDRESSES: undefined
getPerpVoucherEligibility: undefined
Configured collateral on Hideki: {
  collateral: '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E',
  collateralRouter: '0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C',
  marketCreator: '0x2c6334510BE715E06d8B430b20e2A1f8cA880431',
  tickHelper: '0x4E2832c96783F07a495c2A38C45d952524c283e6'
}
Bytecode at SOMNIA_TESTNET_ADDRESSES.collateral on Hideki: undefined
ContractRevertError: @somnia-chain/markets-sdk: getPerpSystemConfig reverted
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **RPC**: `https://api.hideki2.infra.testnet.somnia.network`
- **Repository**: `https://github.com/somnia-chain/dreamdex-bot-kit` (`@dreamdex/perp-core@0.1.0`, `@somnia-chain/markets-sdk@0.30.0`)
- **Docs URL**: `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`
