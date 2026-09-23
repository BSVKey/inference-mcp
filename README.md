# @bsvkey/inference-mcp

An MCP server that lets any agent buy **Claude & Grok inference metered per token,
settled in BSV**, through the hosted gateway at **inference.bsvkey.com**. Zero
dependencies (Node ≥ 18, uses global `fetch`). It's a thin HTTP client — it never
holds your keys or runs models; every call is billed through the gateway.

Tools: `list_models`, `infer`, `channel_balance`, `open_channel`, `x402_infer`, `xrp_infer`.

Two ways to pay: a **prepaid channel** (`infer`, fund once, draw down per token) or
**per call via x402** (`x402_infer` — no channel; the agent pays each request in BSV
with its own key). `x402_infer` needs a funded WIF (`wif` arg or `BSVKEY_WIF`) and the
optional `@bsvkey/x402-bsv-client` + `@bsv/sdk` packages (installed with this one).

**Pay per call in XRP** with `xrp_infer`: the tool gets a quote in XRP (priced from
the XRP Ledger's own XRP/RLUSD market), signs one XRP Payment for exactly that
locally, and the gateway checks it before broadcasting, waits for validation (a few
seconds), and returns the answer, the settlement tx, and a signed receipt. It needs
a funded XRP seed (`xrpSeed` arg or `BSVKEY_XRP_SEED`; create one at
[xrp.bsvkey.com/wallet](https://xrp.bsvkey.com/wallet)) and the optional `xrpl`
package (installed with this one). The account keeps a 1 XRP reserve that can't be
spent.

**Verifiable metering.** Each `infer` call returns a signed usage receipt, and the
tool auto-verifies it offline (with the optional packages installed): the result
includes `receiptVerified` and `meterVerified` (`true`, `false` + `receiptCheck`,
or `null`). It recovers the broker key (pinned from `GET /v1/receipt-key`); binds
the receipt to **the channel you called** (from your API key, not the receipt's
self-report); checks a monotonic sequence (no replay/gap) and running totals within
the funded amount; **recomputes the charge** from the published rate (you can never
be overcharged); and **recomputes the token count from the exact bytes** of your
messages and the completion, under the pinned `bsvkey-meter/1` tokenizer. So the
channel payment is on-chain and both the meter and the charge are auditable,
without trusting the broker's word.

Four things an unattended client should know:

- **Fails closed.** If the pinned-key endpoint is unreachable, `receiptVerified`
  is `null` (unknown), never `true` — a down pin weakens the check to *unknown*,
  not to *trusted*.
- **Supply your funded amount.** Set `BSVKEY_FUNDED_SATS` (or pass `fundedSats`)
  to the amount you funded on-chain. The receipt's own `fundedSats` is the broker's
  assertion; when you supply yours, a receipt claiming a different amount is
  rejected and totals are checked against what you actually paid.
- **Persist across restarts.** Sequence continuity is in-memory by default (a
  replay before the first receipt this process sees would be invisible). Set
  `BSVKEY_RECEIPT_STATE` to a file path to persist per-channel `seq`/totals so
  replays are caught across restarts.
- **The receipt is the ledger.** The `GET /v1/channels/:id` balance endpoint can
  lag the signed receipt by ~20s; trust the receipt, treat the endpoint as a cache.

Spec: https://inference.bsvkey.com/usage-receipts.md

## Quick start
1. **Fund a channel once** at https://inference.bsvkey.com (BRC-100 wallet, or
   load a key in-page). Copy the key it returns: `channelId:channelSecret`.
2. **Add the MCP server** to your agent host (below), with that key in
   `BSVKEY_API_KEY`.
3. Ask your agent to run inference — it calls `infer` and pays per token.

`list_models` and `open_channel` work with no key; `infer` and `channel_balance`
need a funded channel key.

## Install

Published on npm as **[@bsvkey/inference-mcp](https://www.npmjs.com/package/@bsvkey/inference-mcp)**.

### Claude Code
```bash
claude mcp add bsvkey-inference \
  --env BSVKEY_API_KEY=channelId:channelSecret \
  -- npx -y @bsvkey/inference-mcp
```

### Claude Desktop / Codex / any MCP host (JSON config)
```json
{
  "mcpServers": {
    "bsvkey-inference": {
      "command": "npx",
      "args": ["-y", "@bsvkey/inference-mcp"],
      "env": { "BSVKEY_API_KEY": "channelId:channelSecret" }
    }
  }
}
```
No npm? Grab the single-file server directly (`https://inference.bsvkey.com/mcp/server.js`) and use `"command": "node", "args": ["server.js"]`.

## Configuration (env)
| Var | Default | Meaning |
|---|---|---|
| `BSVKEY_BASE_URL` | `https://inference.bsvkey.com/v1` | Gateway base URL (set to a self-hosted deployment if you run your own). |
| `BSVKEY_API_KEY` | — | `channelId:channelSecret` for a funded channel. Optional; can also be passed per call as `apiKey`. |
| `BSVKEY_FUNDED_SATS` | — | The amount you funded your channel with on-chain. When set, receipts are verified against it instead of the broker-signed `fundedSats`. Optional; per-call `fundedSats`. |
| `BSVKEY_XRP_SEED` | none | An XRP wallet seed for `xrp_infer`. Optional; can also be passed per call as `xrpSeed`. Never leaves this process. |
| `BSVKEY_RECEIPT_STATE` | — | Path to a JSON file for persisting per-channel receipt continuity (seq + totals) across restarts. Optional; in-memory only if unset. |

## Errors

A failed tool call returns `isError: true` with text in one fixed shape, so an
agent can branch on the code without parsing prose:

```
error: <code> (<http status>): <message> [extra=value, ...]
```

| Code | Status | Tool | What it means | What to do |
|---|---|---|---|---|
| `no_channel_key` | | `infer`, `channel_balance` | No `apiKey` and no `BSVKEY_API_KEY` | Open a channel at the site (see `open_channel`) |
| `invalid_channel` | 401 / 404 | `infer`, `channel_balance` | Channel not found, wrong secret, or closed | Open a new channel |
| `insufficient_balance` | 402 | `infer` | The channel can't cover the worst case for this call; extras give `requiredSats` and `balanceSats` | Top up at the site, or lower `maxTokens` / turn off `webSearch` |
| `invalid_request` | 400 | `infer`, `x402_infer` | Unknown model or policy, a model whose provider isn't enabled, or bad input | Call `list_models` |
| `upstream_failed` | 502 | `infer` | The model provider failed | Nothing is charged; retry or pick another model |
| `no_wif` | | `x402_infer` | No `wif` and no `BSVKEY_WIF` | Pass a funded key |
| `verifier_missing` | | `x402_infer` | `@bsvkey/x402-bsv-client` / `@bsv/sdk` not installed | `npm i @bsvkey/x402-bsv-client @bsv/sdk` |
| `payment_failed` | 402 | `x402_infer` | The payment didn't settle (e.g. the key's address is unfunded); extras give the `reason` | Fund the address; nothing was spent |
| `upstream_failed` | 502 | `x402_infer` | The payment **settled** but the provider then failed; extras give `settlementTxid` | No automatic refund: email support@embryospace.com with the txid |
| `no_xrp_seed` | | `xrp_infer` | No `xrpSeed` and no `BSVKEY_XRP_SEED` | Pass a funded XRP seed |
| `xrpl_missing` | | `xrp_infer` | The `xrpl` package isn't installed | `npm i xrpl` |
| `insufficient_xrp` | | `xrp_infer` | The wallet isn't activated, or can't cover the quote above its 1 XRP reserve | Fund it; nothing was spent |
| `payment_failed` | 402 | `xrp_infer` | The payment was refused before broadcast, or didn't settle; extras give the `reason` | Nothing was spent unless a settlement tx is included |
| `upstream_failed` | 502 | `xrp_infer` | The payment **settled** but the provider then failed; extras give the settlement tx | No automatic refund: email support@embryospace.com with the tx |

On a prepaid channel nothing is charged on any error. A successful `infer` can
still report `receiptVerified: false` (the signed receipt didn't check out; see
`receiptCheck`) or `null` (couldn't check: verifier missing, or the receipt-key
endpoint was down).

Thinking models (`claude-sonnet-5`, `claude-opus-5`, `claude-opus-5-5`,
`claude-fable-5-1`) bill their hidden reasoning as output, and `maxTokens` is
raised to at least 1024 for them.

## Verify it's wired (no key needed)
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_models","arguments":{}}}' \
  | node server.js
```

## Marketplace listing blurb
> **BSV Inference** — Pay-per-token Claude & Grok, settled in BSV. Prepay a channel
> once, then meter every token with no subscription, account, or card. OpenAI-
> compatible, optional live web search, on-chain settlement. MCP + portable SKILL.md.

## Publishing (operator)
- Live on npm under the `@bsvkey` org (owner: `interence`). First publish: v1.0.0.
- To ship an update: bump `version` in `package.json`, then
  `npm publish --access public` (2FA/security-key prompt applies).
- Canonical source: https://github.com/BSVKey/inference-mcp
- To list on a skills marketplace (e.g. bopen.ai), submit `SKILL.md` + this README.
