#!/usr/bin/env node
// BSV Inference — remote MCP server (zero dependencies).
//
// A thin Model-Context-Protocol client for the HOSTED broker at
// inference.bsvkey.com. Any MCP-capable agent host (Claude Code, Claude Desktop,
// Codex, OpenCode, custom agents) adds this one command and can then buy Claude
// or Grok inference metered PER TOKEN, settled in BSV — every call is billed
// through the hosted gateway, so usage flows to the operator's wallet.
//
// This is NOT the broker. It never holds keys or runs models; it just talks HTTP
// to the public API. Point it at your own deployment with BSVKEY_BASE_URL.
//
// Config (environment):
//   BSVKEY_BASE_URL  default https://inference.bsvkey.com/v1
//   BSVKEY_API_KEY   "channelId:channelSecret" for a funded channel (optional —
//                    can also be passed per call as `apiKey`). Open + fund a
//                    channel once at the website, then paste the key here.
//
// Run:  node server.js      (Node >= 18 for global fetch)

const BASE = (process.env.BSVKEY_BASE_URL || 'https://inference.bsvkey.com/v1').replace(/\/+$/, '');
const SITE = BASE.replace(/\/v1$/, '');
const ENV_KEY = process.env.BSVKEY_API_KEY || '';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'bsvkey-inference', version: '1.0.0' };

// Resolve a channel API key ("channelId:channelSecret") from arg or env.
function keyParts(apiKey) {
  const k = String(apiKey || ENV_KEY || '').trim();
  const i = k.indexOf(':');
  if (i < 0) return null;
  return { id: k.slice(0, i), secret: k.slice(i + 1), raw: k };
}

async function http(method, path, { headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, json };
}

// Best-effort, offline verification of the broker's signed usage receipt. Local
// only (a secp256k1 recovery + sha256): no payment, no network beyond a one-time
// key fetch, no effect on the x402 path. Gated on the optional
// @bsvkey/x402-bsv-client verifier so the server keeps zero REQUIRED deps: if it
// isn't installed we return verified:null (skipped), never an error.
let _verifier; // module | false | undefined
let _brokerKey; // hex | null | undefined
const _seen = new Map(); // channelId -> { seq, cumSats, cumTokens }  (this session)
async function loadVerifier() {
  if (_verifier !== undefined) return _verifier;
  try { _verifier = await import('@bsvkey/x402-bsv-client/usage-receipt'); } catch { _verifier = false; }
  return _verifier;
}
async function brokerReceiptKey() {
  if (_brokerKey !== undefined) return _brokerKey;
  try { const r = await http('GET', '/receipt-key'); _brokerKey = r.ok ? (r.json.receiptPubKey || null) : null; } catch { _brokerKey = null; }
  return _brokerKey;
}
async function verifyUsageReceipt(receipt, bytes = {}) {
  if (!receipt) return { verified: null, reason: 'no receipt returned' };
  const V = await loadVerifier();
  if (!V) return { verified: null, reason: 'verifier not installed (npm i @bsvkey/x402-bsv-client)' };
  const one = await V.verifyReceipt(receipt);
  if (!one.ok) return { verified: false, reason: one.reason };
  const pinned = await brokerReceiptKey();
  if (pinned && one.signer !== pinned) return { verified: false, reason: 'signer_not_pinned_broker_key' };
  // The charge recomputes from the receipt's own rates (overcharge is a dispute).
  if (typeof V.verifyCharge === 'function') {
    const c = V.verifyCharge(receipt);
    if (!c.ok) return { verified: false, reason: `charge:${c.reason}` };
  }
  // The meter: recompute token counts + byte digests from the exact bytes we hold.
  let meterVerified = null;
  if (typeof V.verifyMeter === 'function' && (bytes.prompt !== undefined || bytes.completion !== undefined)) {
    const mv = V.verifyMeter(receipt, bytes);
    if (!mv.ok) return { verified: false, reason: `meter:${mv.reason}`, meterVerified: false };
    meterVerified = true;
  }
  if (receipt.cumSats > receipt.fundedSats) return { verified: false, reason: 'cumSats_exceeds_funded' };
  const prev = _seen.get(receipt.channelId);
  if (prev) {
    // Continuity across calls this session actually observed.
    if (receipt.seq !== prev.seq + 1) return { verified: false, reason: receipt.seq === prev.seq ? 'replayed_seq' : (receipt.seq < prev.seq ? 'seq_regressed' : 'seq_gap') };
    if (receipt.cumSats !== prev.cumSats + receipt.sats) return { verified: false, reason: 'cumSats_does_not_reconcile' };
    if (receipt.cumTokens !== prev.cumTokens + receipt.inputTokens + receipt.outputTokens) return { verified: false, reason: 'cumTokens_does_not_reconcile' };
  }
  _seen.set(receipt.channelId, { seq: receipt.seq, cumSats: receipt.cumSats, cumTokens: receipt.cumTokens });
  return { verified: true, meterVerified, ...(prev ? {} : { note: 'baseline: signature + funded-conservation checked; seq continuity verified from here' }) };
}

export const TOOLS = [
  {
    name: 'list_models',
    description:
      'List the models this BSV inference gateway sells, with LIVE retail price (satoshis per 1,000 tokens) at the current BSV/USD rate. No key needed. Call first to choose a model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'infer',
    description:
      'Run one metered inference (OpenAI-compatible), paid per token in BSV from your prepaid channel. Returns the completion plus a receipt: satoshis charged, model routed to, and remaining balance. Requires a funded channel key (apiKey or BSVKEY_API_KEY).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt.' },
        model: { type: 'string', description: 'Model id or policy: auto|cheapest|best, claude-*, grok-*.', default: 'auto' },
        system: { type: 'string', description: 'Optional system prompt.' },
        maxTokens: { type: 'integer', description: 'Max output tokens.', default: 512 },
        webSearch: { type: 'boolean', description: 'Let the model search the live web (adds a per-search fee).', default: false },
        apiKey: { type: 'string', description: 'channelId:channelSecret for a funded channel. Omit to use BSVKEY_API_KEY.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'channel_balance',
    description: 'Check a prepaid channel’s remaining BSV balance, spend, and request count.',
    inputSchema: {
      type: 'object',
      properties: { apiKey: { type: 'string', description: 'channelId:channelSecret. Omit to use BSVKEY_API_KEY.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'open_channel',
    description:
      'Explains how to open + fund a prepaid channel. Funding is a real BSV payment signed by a wallet, so it is done once at the website; you then paste the returned channel key here (or set BSVKEY_API_KEY).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'x402_infer',
    description:
      'Run one inference paid PER CALL in BSV via x402 — no prepaid channel needed. You provide a funded BSV private key (wif or BSVKEY_WIF); the tool fetches the 402 quote, builds + signs a BSV payment, retries with X-PAYMENT, and returns the completion plus the on-chain settlement txid. Non-custodial: signing happens locally in this process, the key never leaves it. Needs @bsvkey/x402-bsv-client + @bsv/sdk (installed with this package).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt.' },
        model: { type: 'string', description: 'Model id or policy: auto|cheapest|best, claude-*, grok-*.', default: 'grok-4.3' },
        system: { type: 'string', description: 'Optional system prompt.' },
        maxTokens: { type: 'integer', description: 'Max output tokens.', default: 512 },
        webSearch: { type: 'boolean', description: 'Let the model search the live web (adds a per-search fee to the quote).', default: false },
        wif: { type: 'string', description: 'A funded BSV private key (WIF) to pay from. Omit to use BSVKEY_WIF. Never leaves this process.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_models': {
      const r = await http('GET', '/pricebook');
      if (!r.ok) throw new Error(`pricebook ${r.status}`);
      const pb = r.json;
      const models = Object.entries(pb.models || {}).map(([id, m]) => ({
        id,
        label: m.label,
        available: m.available !== false,
        provider: m.provider,
        retailInputSatsPer1k: m.retailInputSatsPer1k,
        retailOutputSatsPer1k: m.retailOutputSatsPer1k,
      }));
      return { base: BASE, bsvUsd: pb.bsvUsd, rate: pb.rate, models, webSearch: pb.webSearch };
    }
    case 'infer': {
      const k = keyParts(args.apiKey);
      if (!k) throw new Error('No channel key. Pass apiKey "channelId:channelSecret" or set BSVKEY_API_KEY. Open one via the open_channel tool.');
      const r = await http('POST', '/chat/completions', {
        headers: { authorization: `Bearer ${k.raw}` },
        body: {
          model: args.model || 'auto',
          messages: [
            ...(args.system ? [{ role: 'system', content: args.system }] : []),
            { role: 'user', content: String(args.prompt || '') },
          ],
          max_tokens: args.maxTokens || 512,
          web_search: args.webSearch === true,
        },
      });
      if (!r.ok) {
        const msg = r.json?.error?.message || r.json?.error || `inference failed (${r.status})`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      const x = r.json.x_bsv || {};
      const completion = r.json.choices?.[0]?.message?.content ?? '';
      const rc = await verifyUsageReceipt(x.usageReceipt, { system: args.system, prompt: String(args.prompt || ''), completion });
      return {
        model: r.json.model || args.model,
        completion,
        charge: x.charge,
        routedTo: x.routedTo,
        balanceSatsAfter: x.balanceSatsAfter,
        truncated: x.truncated || false,
        // Offline-verified signed usage receipt (see usage-receipt spec). null =
        // not checked (verifier not installed); false w/ receiptCheck = a real
        // mismatch, treat the meter as untrusted for this call. meterVerified is
        // true when the token count was recomputed from the exact bytes.
        receiptVerified: rc.verified,
        meterVerified: rc.meterVerified,
        ...(rc.reason ? { receiptCheck: rc.reason } : {}),
        usageReceipt: x.usageReceipt,
      };
    }
    case 'channel_balance': {
      const k = keyParts(args.apiKey);
      if (!k) throw new Error('No channel key. Pass apiKey "channelId:channelSecret" or set BSVKEY_API_KEY.');
      const r = await http('GET', `/channels/${encodeURIComponent(k.id)}`, { headers: { 'x-bsv-channel-secret': k.secret } });
      if (!r.ok) {
        const msg = r.json?.error?.message || r.json?.error || `balance check failed (${r.status})`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      return r.json;
    }
    case 'open_channel': {
      return {
        note: 'Funding a channel is a real BSV payment your wallet must sign, so open one at the website (BRC-100 wallet, or load a key in-page), then paste the channel key here / set BSVKEY_API_KEY.',
        fundUrl: SITE,
        accountUrl: `${SITE}/account.html`,
        steps: [
          `Open ${SITE} and use the "Pay with your BSV wallet" widget to fund a channel.`,
          'Copy the channel key it returns (format: channelId:channelSecret).',
          'Set BSVKEY_API_KEY to that value (or pass apiKey to infer), then call infer freely until the balance runs out.',
        ],
      };
    }
    case 'x402_infer': {
      const wif = args.wif || process.env.BSVKEY_WIF || '';
      if (!wif) throw new Error(`No BSV key. Pass wif "<WIF>" or set BSVKEY_WIF — an agent-funded key to pay per call. Fund its address at ${SITE}.`);
      let x402;
      try {
        x402 = await import('@bsvkey/x402-bsv-client');
      } catch {
        throw new Error('Pay-per-call needs @bsvkey/x402-bsv-client and @bsv/sdk. Install them: npm i @bsvkey/x402-bsv-client @bsv/sdk');
      }
      const url = `${BASE}/x402/chat/completions`;
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: args.model || 'grok-4.3',
          messages: [
            ...(args.system ? [{ role: 'system', content: args.system }] : []),
            { role: 'user', content: String(args.prompt || '') },
          ],
          max_tokens: args.maxTokens || 512,
          web_search: args.webSearch === true,
        }),
      };
      const res = await x402.fetchWithX402(url, init, { wif });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error?.message || data?.error || data?.reason || `x402 inference failed (${res.status})`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      const settle = x402.readSettlement(res) || {};
      return {
        model: data.model || args.model,
        completion: data.choices?.[0]?.message?.content ?? '',
        paidSats: data.x_bsv?.paidSats,
        payTo: data.x_bsv?.payTo,
        settlementTxid: settle.transaction,
        network: settle.network,
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// --- MCP JSON-RPC over stdio ------------------------------------------------
function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

export async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return rpcError(msg?.id ?? null, -32600, 'invalid request');
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const value = await callTool(params?.name, params?.arguments || {});
        return result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
      } catch (e) {
        return result(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function runStdio() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n'); continue; }
      const res = await handleMessage(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
  process.stderr.write(`[bsvkey-inference mcp] ready on stdio → ${BASE} (${TOOLS.length} tools)\n`);
}

const invokedDirectly = process.argv[1] && /server\.js$/.test(process.argv[1]);
if (invokedDirectly) runStdio();
