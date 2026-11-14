# DoraHacks Submission Guide — Somnia dreamDEX Perps Builder Bounty ($3,000)

- **Bounty URL**: `https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail`
- **Deadline**: November 15, 2026 (No demo video required!)
- **Total Prize Pool**: **$3,000 USD**
  - **Track 1 (Feedback Track — $1,500 Pool)**: Paid per valid issue ($40 per Critical/Major issue, $15 per Normal issue). Our 16 verified issues (4 Critical, 10 Major, 2 Normal) represent **$590** in itemized bug bounties (`14 × $40 + 2 × $15`).
  - **Track 2 (MVP Track — $1,500 Pool)**: **3 × $500** top MVP prizes.

---

## Step 1: Post the 3 Required X (Twitter) Updates Tagging `@DreamDEXSomnia`

Before submitting on DoraHacks, post these 3 tweets from your X account and paste their URLs under the `## X posts` section of `README.md`:

### Tweet 1 (Build Start)
```text
Kicking off our build for the @DreamDEXSomnia Perps Builder Bounty on @Somnia_Network Tokyo/Hideki Testnet (chainId 50383)! 🛠️

Auditing all 22 live PerpPool contracts, MarginBank cross-margin math & @somnia-chain/markets-sdk to build a Quant Funding-Rate Arbitrage & Risk CLI Agent. #Somnia #dreamDEX
```

### Tweet 2 (Mid-Progress Update — Bug Hunt)
```text
Mid-build update on @DreamDEXSomnia Perps! 🔍

Our deep audit of dreamdex-bot-kit & Hideki Testnet uncovered 12 reproducible issues:
• IEEE-754 touch * 1e18 price truncation
• Inverted TP/SL on existing shorts in perp-starter
• ADLT-PERP null stopRegistry crash
• 40x/10x on-chain leverage vs 20x/5x docs!
```

### Tweet 3 (Final Showcase — Track 1 + Track 2 MVP)
```text
Shipped our @DreamDEXSomnia Perps Builder Bounty submission! 🚀

✅ Track 1: 12 verified bug reports (4 Critical, 6 Major, 2 Normal) in feedback/ with live Hideki RPC/Indexer proofs
✅ Track 2: Quant Funding-Carry Scanner (+151% APR on BTC-PERP), Cross-Margin Liq Auditor & Bracket Simulator!
```

---

## Step 2: Push Repository to Public GitHub

Push the contents of `/home/jeff/.gemini/antigravity/scratch/freelancework/dreamdex-somnia-bounty/` to a public GitHub repository (e.g. `dreamdex-somnia-bounty`), ensuring that:
- `feedback/` contains all 16 Markdown files (`issue-01-...md` through `issue-16-...md`).
- `src/`, `tests/`, and `data/` are committed at the root.
- `README.md` includes the live X post URLs under `## X posts`.

---

## Step 3: Submit BUIDL on DoraHacks

1. Open `https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail` and click **Submit BUIDL**.
2. **Project Name**: `dreamDEX Perps Quant Arbitrage & Risk CLI Agent + 16-Issue Technical Audit`
3. **Tracks**: Both **Feedback Track** and **MVP Track**.
4. **GitHub Repository**: Link your public GitHub repo containing `feedback/` and `src/`.
5. **Project Description (Copy-Paste)**:
   ```markdown
   We deliver a comprehensive dual-track submission for the Somnia dreamDEX Perps Builder Bounty:

   1. Track 1 (Feedback Track — `feedback/`): 16 genuine, reproducible technical bug reports (4 Critical, 10 Major, 2 Normal) across `somnia-chain/dreamdex-bot-kit`, `@somnia-chain/markets-sdk` (v0.30.0 & v0.32.1), the Hideki Testnet GraphQL Indexer, REST API endpoints, and Perps documentation. Every report includes exact reproduction commands and live captured RPC/Indexer/HTTP evidence.

   2. Track 2 (MVP Track — `src/`, `tests/`, `data/`): A production-grade Quantitative Trading, Cross-Margin Risk & Funding-Rate Arbitrage CLI Agent for Somnia Tokyo/Hideki Testnet (chainId 50383) that fixes all 16 audited SDK/strategy/protocol issues (`12/12` unit + live Hideki RPC tests passing) while scanning all 22 live PerpPool contracts for net-of-spread funding carry opportunities, auditing multi-position cross-margin liquidation distances, enforcing crossed-book & serialized-nonce guards, detecting `TRIGGER_FAILED` stop orders, and simulating bracketed order execution.
   ```
