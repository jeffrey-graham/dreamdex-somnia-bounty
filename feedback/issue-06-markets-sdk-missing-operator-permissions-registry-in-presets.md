# `@somnia-chain/markets-sdk@0.32.1` omits `operatorPermissionsRegistry` from `SOMNIA_HIDEKI_TESTNET_ADDRESSES`, causing `placePerpStopOrder` to throw `NotConfiguredError`

Severity: Major
Area: SDK

## Severity
Major (Stop order placement via the documented `SOMNIA_HIDEKI_TESTNET_ADDRESSES` preset fails with `NotConfiguredError` unless the caller manually Reverse-Engineers and injects `operatorRegistry`)

## Area
SDK (`@somnia-chain/markets-sdk@0.32.1` — `dist/addresses.js` and `dist/perp/stops.js`) & Docs (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet`)

## Steps to reproduce
1. Install the latest `@somnia-chain/markets-sdk@0.32.1` as instructed on `https://app.testnet.dreamdex.io/docs/developers/perps-testnet` (`npm install @somnia-chain/markets-sdk viem`).
2. Initialize `Markets.connect` using `addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES` exactly as shown in the Quickstart (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet#quickstart`).
3. Call `markets.trader.buildPlacePerpStopOrder(...)` or `markets.trader.placePerpStopOrder(...)` without manually supplying `operatorRegistry` in the call arguments (for example, when placing a stop on on-chain pool discovery or when relying on preset addresses):
   ```bash
   node -e '
   const sdk = require("/tmp/sdk-0.32.1/package/dist/index.cjs");
   console.log("SOMNIA_HIDEKI_TESTNET_ADDRESSES:", sdk.SOMNIA_HIDEKI_TESTNET_ADDRESSES);
   '
   ```
4. Inspect `/tmp/sdk-0.32.1/package/dist/addresses.js` (lines 17–28) and `/tmp/sdk-0.32.1/package/dist/perp/stops.js` (lines 486–494):
   - In `dist/addresses.js`, `SOMNIA_HIDEKI_TESTNET_ADDRESSES` contains `collateral`, `collateralRouter`, `marketCreator`, `tickHelper`, `marginBank`, `perpPoolFactory`, `liquidationEngine`, `insuranceFund`, and `voucherDistributor`, **but omits `operatorPermissionsRegistry`**.
   - In `dist/perp/stops.js:490-494`:
     ```js
     const operatorRegistry = params.operatorRegistry ?? this.addresses.operatorPermissionsRegistry;
     if (!operatorRegistry) {
       throw new NotConfiguredError("a perp stop order requires operatorRegistry or addresses.operatorPermissionsRegistry");
     }
     ```
   - Worse still, in `@dreamdex/perp-core` (`packages/perp-core/src/stops.ts:81-91`), `placePerpStop` passes `operatorRegistry: opts.market.info.operatorRegistry` from the GraphQL Indexer, which can be `null` on newly registered pools (just like `stopRegistry` on `ADLT-PERP`), falling back to `this.addresses.operatorPermissionsRegistry` which is `undefined`!

## Expected
`SOMNIA_HIDEKI_TESTNET_ADDRESSES` in `@somnia-chain/markets-sdk` should include:
```ts
operatorPermissionsRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a"
```
(which is deployed on Somnia Tokyo/Hideki Testnet with `4,366 bytes` of verified contract code and listed in the Developer Docs table at `https://app.testnet.dreamdex.io/docs/developers/perps-testnet#core-contracts`).

## Actual
`SOMNIA_HIDEKI_TESTNET_ADDRESSES` (as well as `SOMNIA_TESTNET_ADDRESSES` and `SOMNIA_MAINNET_ADDRESSES`) omits `operatorPermissionsRegistry`. Calling `buildPlacePerpStopOrder` or `placePerpStopOrder` without explicitly passing `operatorRegistry` on every call throws:
```text
NotConfiguredError: a perp stop order requires operatorRegistry or addresses.operatorPermissionsRegistry
```

## Evidence
1. Inspection of `@somnia-chain/markets-sdk@0.32.1` (`dist/addresses.js`):
```js
export const SOMNIA_HIDEKI_TESTNET_ADDRESSES = {
    collateral: "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72",
    collateralRouter: "0x67085fE935e8FcE3786416cA1b34dbA46b80e9BE",
    marketCreator: "0xde69C803F6d7552B029A4dc4f570dE4152b98df2",
    tickHelper: "0x91908F57ac12B6d92dfe7A3E36a481122e3c82c7",
    marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
    perpPoolFactory: "0xE631fAEE547baeE07353E290f0562ea67d856560",
    liquidationEngine: "0xA66d3C24Ad4a389d863846905D8173e1017e9F4D",
    insuranceFund: "0x50826894D47C6D4f3BeA38BFDC7Dc5c5be171b80",
    voucherDistributor: "0x2ACD9EFdA721450906bfE1bef3edE269636E42C4",
    // BUG: operatorPermissionsRegistry ('0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a') is missing!
};
```

2. Reproduction against `@somnia-chain/markets-sdk@0.32.1`:
```text
$ node -e '
const { MarketsClient, SOMNIA_HIDEKI_TESTNET_ADDRESSES, hidekiTestnet } = require("/tmp/sdk-0.32.1/package/dist/index.cjs");
const { createPublicClient, http } = require("viem");
const client = new MarketsClient({
  publicClient: createPublicClient({ chain: hidekiTestnet, transport: http() }),
  addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
});
client.buildPlacePerpStopOrder({
  stopRegistry: "0xFE4f765A44D73cc55a608dc7531390fb9C3D41c3",
  pool: "0x0db2c07a0dd872fa9fefdf2fc11ab5cc7ef597a7",
  isAsk: true,
  triggerPrice: 70000n * 10n**18n,
  limitPrice: 69500n * 10n**18n,
  quantity: 100000n,
  maxSlippageBps: 100,
}).then(console.log).catch(console.error);
'
NotConfiguredError: a perp stop order requires operatorRegistry or addresses.operatorPermissionsRegistry
    at MarketsClient.requireStopRegistry (/tmp/sdk-0.32.1/package/dist/perp/stops.js:492:19)
    at MarketsClient.buildPlacePerpStopOrder (/tmp/sdk-0.32.1/package/dist/perp/stops.js:272:53) {
  code: 'NOT_CONFIGURED',
  context: undefined
}
```

## Environment
- **Network**: Somnia Tokyo / Hideki Testnet (`chainId: 50383`)
- **Contract**: `OperatorPermissionsRegistry` (`0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a`)
- **SDK Package**: `@somnia-chain/markets-sdk@0.32.1`
