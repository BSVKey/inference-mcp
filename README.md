# @bsvkey/inference-mcp

An MCP server that lets any agent buy **Claude & Grok inference metered per token,
settled in BSV**, through the hosted gateway at **inference.bsvkey.com**. Zero
dependencies (Node ≥ 18, uses global `fetch`). It's a thin HTTP client — it never
holds your keys or runs models; every call is billed through the gateway.

Tools: `list_models`, `infer`, `channel_balance`, `open_channel`, `x402_infer`.

Two ways to pay: a **prepaid channel** (`infer`, fund once, draw down per token) or
**per call via x402** (`x402_infer` — no channel; the agent pays each request in BSV
with its own key). `x402_infer` needs a funded WIF (`wif` arg or `BSVKEY_WIF`) and the
optional `@bsvkey/x402-bsv-client` + `@bsv/sdk` packages (installed with this one).

**Verifiable metering.** Each `infer` call returns a signed usage receipt, and the
tool auto-verifies it offline (with the optional packages installed): the result
includes `receiptVerified` and `meterVerified` (`true`, `false` + `receiptCheck`,
or `null` if the verifier isn't installed). It recovers the broker key (pinned
from `GET /v1/receipt-key`); checks channel binding, a monotonic sequence (no
replay/gap), and running totals within the funded amount; **recomputes the charge**
from the published rate (you can never be overcharged); and **recomputes the token
count from the exact bytes** of your system/prompt and the completion, under the
pinned `bsvkey-meter/1` tokenizer. So the channel payment is on-chain and both the
meter and the charge are auditable, without trusting the broker's word. Spec:
https://inference.bsvkey.com/usage-receipts.md

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
