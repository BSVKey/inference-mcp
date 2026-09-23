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
let _brokerKey; // hex | null  (only a REAL key is ever cached)
const _seen = new Map(); // channelId -> { seq, cumSats, cumTokens }

// Optional cross-restart continuity. If BSVKEY_RECEIPT_STATE names a file, the
// observed { seq, cumSats, cumTokens } per channel is loaded on first use and
// saved after each receipt, so a replay BEFORE the first receipt this process
// sees is still caught. Best-effort: any fs error falls back to in-memory.
const STATE_FILE = process.env.BSVKEY_RECEIPT_STATE || '';
let _stateLoaded = false;
async function loadSeen() {
  if (_stateLoaded) return; _stateLoaded = true;
  if (!STATE_FILE) return;
  try { const fs = await import('node:fs'); const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); for (const [k, v] of Object.entries(o)) _seen.set(k, v); } catch {}
}
async function saveSeen() {
  if (!STATE_FILE) return;
  try { const fs = await import('node:fs'); const o = {}; for (const [k, v] of _seen) o[k] = v; fs.writeFileSync(STATE_FILE, JSON.stringify(o)); } catch {}
}
async function loadVerifier() {
  if (_verifier !== undefined) return _verifier;
  try { _verifier = await import('@bsvkey/x402-bsv-client/usage-receipt'); } catch { _verifier = false; }
  return _verifier;
}
// Pin the broker receipt key from GET /v1/receipt-key. Only a real key is cached;
// a failed fetch returns null WITHOUT caching (so it's retried next call) and the
// verifier fails CLOSED — reports verified:null while the endpoint is down, never
// weakening to verified:true just because the pin could not be fetched.
async function brokerReceiptKey() {
  if (_brokerKey) return _brokerKey;
  try { const r = await http('GET', '/receipt-key'); if (r.ok && r.json.receiptPubKey) { _brokerKey = r.json.receiptPubKey; return _brokerKey; } } catch {}
  return null;
}
// Offline verification of a signed usage receipt.
//   opts.expectedChannelId : the channel you called (from your API key). The
//     receipt must be for THIS channel, and continuity is tracked under this id
//     (not the receipt's self-reported channelId), so a receipt for another
//     channel can't be passed off as yours.
//   opts.fundedSats : the amount YOU funded on-chain. cumSats is checked against
//     it, and a receipt claiming a different funded amount is rejected. Omit and
//     the check falls back to the broker-asserted receipt.fundedSats.
// verified: true (checked) | false (a real mismatch — see reason) | null (could
// not check: verifier missing, or the pin endpoint is down — fails closed).
async function verifyUsageReceipt(receipt, bytes = {}, opts = {}) {
  if (!receipt) return { verified: null, reason: 'no receipt returned' };
  const V = await loadVerifier();
  if (!V) return { verified: null, reason: 'verifier not installed (npm i @bsvkey/x402-bsv-client)' };
  const chan = opts.expectedChannelId || receipt.channelId;
  if (opts.expectedChannelId && receipt.channelId !== opts.expectedChannelId) return { verified: false, reason: 'wrong_channel' };
  const one = await V.verifyReceipt(receipt);
  if (!one.ok) return { verified: false, reason: one.reason };
  const pinned = await brokerReceiptKey();
  if (!pinned) return { verified: null, reason: 'receipt_key_unavailable_failed_closed', meterVerified: null };
  if (one.signer !== pinned) return { verified: false, reason: 'signer_not_pinned_broker_key' };
  // The charge recomputes from the receipt's own rates (overcharge is a dispute).
  if (typeof V.verifyCharge === 'function') {
    const c = V.verifyCharge(receipt);
    if (!c.ok) return { verified: false, reason: `charge:${c.reason}` };
  }
  // The meter: recompute token counts + byte digests from the exact bytes we hold.
  let meterVerified = null;
  if (typeof V.verifyMeter === 'function' && (bytes.messages !== undefined || bytes.prompt !== undefined || bytes.completion !== undefined)) {
    const mv = V.verifyMeter(receipt, bytes);
    if (!mv.ok) return { verified: false, reason: `meter:${mv.reason}`, meterVerified: false };
    meterVerified = true;
  }
  // Funded conservation. Prefer the amount the caller actually funded on-chain;
  // the receipt's fundedSats is the broker's assertion (reject if it disagrees).
  const hasFunded = opts.fundedSats !== undefined && opts.fundedSats !== null;
  const funded = hasFunded ? Number(opts.fundedSats) : receipt.fundedSats;
  if (hasFunded && receipt.fundedSats !== funded) return { verified: false, reason: 'funded_mismatch', meterVerified };
  if (receipt.cumSats > funded) return { verified: false, reason: 'cumSats_exceeds_funded', meterVerified };
  await loadSeen();
  const prev = _seen.get(chan);
  if (prev) {
    // Continuity across calls observed on THIS channel (persisted if BSVKEY_RECEIPT_STATE set).
    if (receipt.seq !== prev.seq + 1) return { verified: false, reason: receipt.seq === prev.seq ? 'replayed_seq' : (receipt.seq < prev.seq ? 'seq_regressed' : 'seq_gap'), meterVerified };
    if (receipt.cumSats !== prev.cumSats + receipt.sats) return { verified: false, reason: 'cumSats_does_not_reconcile', meterVerified };
    if (receipt.cumTokens !== prev.cumTokens + receipt.inputTokens + receipt.outputTokens) return { verified: false, reason: 'cumTokens_does_not_reconcile', meterVerified };
  }
  _seen.set(chan, { seq: receipt.seq, cumSats: receipt.cumSats, cumTokens: receipt.cumTokens });
  await saveSeen();
  return { verified: true, meterVerified, ...(prev ? {} : { note: STATE_FILE ? 'continuity checked (persisted across restarts)' : 'baseline: seq continuity verified from here — set BSVKEY_RECEIPT_STATE to persist across restarts' }) };
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
      'Run one metered inference (OpenAI-compatible), paid per token in BSV from your prepaid channel. Returns the completion plus a receipt: satoshis charged, model routed to, and remaining balance. Requires a funded channel key (apiKey or BSVKEY_API_KEY). ' +
      'Thinking models (claude-sonnet-5, claude-opus-5, claude-opus-5-5, claude-fable-5-1) bill their hidden reasoning as output, and maxTokens is raised to at least 1024 for them. ' +
      'On failure the tool returns isError with text "error: <code> (<http status>): <message>". Codes: no_channel_key (no apiKey and no BSVKEY_API_KEY); ' +
      'invalid_channel (401: channel not found, bad secret, or closed; open a new one); ' +
      'insufficient_balance (402: the channel cannot cover the worst case for this call; the text includes requiredSats and balanceSats; top up at the website, or lower maxTokens / turn off webSearch); ' +
      'invalid_request (400: unknown model or policy, a model whose provider is not enabled, or a malformed prompt; call list_models); ' +
      'upstream_failed (502: the model provider failed; nothing is charged, retry or pick another model). ' +
      'Nothing is charged on any error. A successful call can still report receiptVerified:false (the signed receipt did not check out; see receiptCheck) or null (could not check: verifier not installed or the receipt key endpoint was down).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt.' },
        model: { type: 'string', description: 'Model id or policy: auto|cheapest|best, claude-*, grok-*.', default: 'auto' },
        system: { type: 'string', description: 'Optional system prompt.' },
        maxTokens: { type: 'integer', description: 'Max output tokens.', default: 512 },
        webSearch: { type: 'boolean', description: 'Let the model search the live web (adds a per-search fee).', default: false },
        apiKey: { type: 'string', description: 'channelId:channelSecret for a funded channel. Omit to use BSVKEY_API_KEY.' },
        fundedSats: { type: 'integer', description: 'The amount you funded this channel with on-chain. If set, usage receipts are verified against it (and a receipt claiming a different funded amount is rejected) instead of trusting the broker-signed fundedSats. Omit to use BSVKEY_FUNDED_SATS.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'channel_balance',
    description: 'Check a prepaid channel’s remaining BSV balance, spend, and request count. On failure returns isError "error: <code> (<status>): <message>": no_channel_key, or invalid_channel (401/404: not found, bad secret, or closed).',
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
      'Run one inference paid PER CALL in BSV via x402 — no prepaid channel needed. You provide a funded BSV private key (wif or BSVKEY_WIF); the tool fetches the 402 quote, builds + signs a BSV payment, retries with X-PAYMENT, and returns the completion plus the on-chain settlement txid. Non-custodial: signing happens locally in this process, the key never leaves it. Needs @bsvkey/x402-bsv-client + @bsv/sdk (installed with this package). ' +
      'On failure returns isError "error: <code> (<status>): <message>". Codes: no_wif (no key given); verifier_missing (the two packages are not installed); ' +
      'payment_failed (402: the payment did not settle, e.g. the key address is unfunded or too low; nothing is spent); invalid_request (400: unknown model or bad input; nothing is spent); ' +
      'upstream_failed (502: the payment SETTLED but the model provider then failed; the text includes the settlement txid. There is no automatic refund: contact support@embryospace.com with that txid).',
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
  {
    name: 'xrp_infer',
    description:
      'Run one inference paid PER CALL in XRP on the XRP Ledger via x402. No channel needed. You provide an XRP wallet seed (xrpSeed or BSVKEY_XRP_SEED); the tool gets the 402 quote (exact drops, destination tag, signed quote; priced from the XRP Ledger\'s own XRP/RLUSD market), signs one XRP Payment for exactly that locally, and retries with X-PAYMENT. The broker checks the payment before broadcasting it, waits for validation (a few seconds), and returns the completion, the settlement tx hash, and a signed receipt. Non-custodial: the seed never leaves this process. The account keeps a 1 XRP reserve that cannot be spent. Needs the xrpl package (installed with this package). ' +
      'On failure returns isError "error: <code> (<status>): <message>". Codes: no_xrp_seed; xrpl_missing (npm i xrpl); node_too_old (xrp_infer needs Node 20.19+ or 22.12+); insufficient_xrp (the wallet cannot cover the quote above its reserve; nothing is spent); ' +
      'payment_failed (402: the payment was refused before broadcast or did not settle; nothing is spent unless the text includes a settlement tx); invalid_request (400); ' +
      'upstream_failed (502: the payment SETTLED but the model provider then failed; the text includes the settlement tx. No automatic refund: contact support@embryospace.com with it).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt.' },
        model: { type: 'string', description: 'Model id or policy: auto|cheapest|best, claude-*, grok-*.', default: 'claude-haiku-4-5' },
        system: { type: 'string', description: 'Optional system prompt.' },
        maxTokens: { type: 'integer', description: 'Max output tokens.', default: 512 },
        xrpSeed: { type: 'string', description: 'A funded XRP wallet seed (s...). Omit to use BSVKEY_XRP_SEED. Never leaves this process.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

// Turn a broker HTTP error into "<code> (<status>): <message>[ extras]" so an agent
// can branch on the code without parsing prose. Codes match the tool descriptions.
function apiError(status, body, fallback) {
  const e = (body && body.error) || {};
  const msg = (typeof e === 'string' ? e : e.message) || body?.reason || fallback;
  const code = (status === 401 || status === 404) ? 'invalid_channel'
    : status === 402 ? (body?.x402Version ? 'payment_failed' : 'insufficient_balance')
    : status === 400 ? 'invalid_request'
    : status === 502 ? 'upstream_failed'
    : 'error';
  const extras = [];
  const src = typeof e === 'object' ? { ...body, ...e } : body || {};
  if (src.requiredSats !== undefined) extras.push(`requiredSats=${src.requiredSats}`);
  if (src.balanceSats !== undefined) extras.push(`balanceSats=${src.balanceSats}`);
  if (body?.reason && body.reason !== msg) extras.push(`reason=${body.reason}`);
  const settlement = body?.x_bsv?.settlement;
  if (settlement) extras.push(`settlementTxid=${typeof settlement === 'string' ? settlement : JSON.stringify(settlement)} (payment settled; contact support@embryospace.com)`);
  return new Error(`${code} (${status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${extras.length ? ' [' + extras.join(', ') + ']' : ''}`);
}

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
      if (!k) throw new Error('no_channel_key: pass apiKey "channelId:channelSecret" or set BSVKEY_API_KEY. Open one via the open_channel tool.');
      const messages = [
        ...(args.system ? [{ role: 'system', content: args.system }] : []),
        { role: 'user', content: String(args.prompt || '') },
      ];
      const r = await http('POST', '/chat/completions', {
        headers: { authorization: `Bearer ${k.raw}` },
        body: {
          model: args.model || 'auto',
          messages,
          max_tokens: args.maxTokens || 512,
          web_search: args.webSearch === true,
        },
      });
      if (!r.ok) throw apiError(r.status, r.json, `inference failed (${r.status})`);
      const x = r.json.x_bsv || {};
      const completion = r.json.choices?.[0]?.message?.content ?? '';
      // Verify against the channel WE called (not the receipt's self-report) and,
      // when known, the amount WE funded on-chain. Meter over the SAME messages we
      // sent (the OpenAI shim meters the flattened messages; needs verifier >= 0.7.0 for v3 hidden-token receipts).
      const envFunded = process.env.BSVKEY_FUNDED_SATS ? Number(process.env.BSVKEY_FUNDED_SATS) : undefined;
      const rc = await verifyUsageReceipt(x.usageReceipt, { messages, completion }, {
        expectedChannelId: k.id,
        fundedSats: args.fundedSats ?? envFunded,
      });
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
      if (!k) throw new Error('no_channel_key: pass apiKey "channelId:channelSecret" or set BSVKEY_API_KEY.');
      const r = await http('GET', `/channels/${encodeURIComponent(k.id)}`, { headers: { 'x-bsv-channel-secret': k.secret } });
      if (!r.ok) throw apiError(r.status, r.json, `balance check failed (${r.status})`);
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
      if (!wif) throw new Error(`no_wif: no BSV key. Pass wif "<WIF>" or set BSVKEY_WIF — an agent-funded key to pay per call. Fund its address at ${SITE}.`);
      let x402;
      try {
        x402 = await import('@bsvkey/x402-bsv-client');
      } catch {
        throw new Error('verifier_missing: pay-per-call needs @bsvkey/x402-bsv-client and @bsv/sdk. Install them: npm i @bsvkey/x402-bsv-client @bsv/sdk');
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
      if (!res.ok) throw apiError(res.status, data, `x402 inference failed (${res.status})`);
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
    case 'xrp_infer': {
      const seed = args.xrpSeed || process.env.BSVKEY_XRP_SEED || '';
      if (!seed) throw new Error(`no_xrp_seed: pass xrpSeed "s..." or set BSVKEY_XRP_SEED. Create a wallet at https://xrp.bsvkey.com/wallet and fund it.`);
      let xrpl;
      try { xrpl = await import('xrpl'); } catch (e) {
        const msg = String((e && e.message) || e);
        // xrpl's crypto dependencies are ES modules loaded from CommonJS, which
        // needs Node 20.19+ or 22.12+. Say so plainly instead of "not installed".
        if (/ERR_REQUIRE_ESM|require\(\) of ES Module/i.test(msg) || e && e.code === 'ERR_REQUIRE_ESM') {
          throw new Error(`node_too_old: xrp_infer needs Node 20.19+ or 22.12+ (this is ${process.version}). Upgrade Node; the other tools work on Node 18+.`);
        }
        throw new Error('xrpl_missing: pay-per-call in XRP needs the xrpl package. Install it: npm i xrpl');
      }
      const wallet = xrpl.Wallet.fromSeed(seed);
      const url = `${BASE}/x402/xrp/chat/completions`;
      const reqBody = JSON.stringify({
        model: args.model || 'claude-haiku-4-5',
        messages: [
          ...(args.system ? [{ role: 'system', content: args.system }] : []),
          { role: 'user', content: String(args.prompt || '') },
        ],
        max_tokens: args.maxTokens || 512,
      });
      const post = (headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: reqBody });
      const r402 = await post();
      const j402 = await r402.json().catch(() => ({}));
      if (r402.status !== 402 || !j402.accepts) throw apiError(r402.status, j402, `quote failed (${r402.status})`);
      const req = j402.accepts[0];
      const wss = req.network === 'xrpl:1' ? 'wss://s.altnet.rippletest.net:51233' : 'wss://xrplcluster.com';
      const client = new xrpl.Client(wss);
      await client.connect();
      let signed;
      try {
        const info = (await client.request({ command: 'account_info', account: wallet.classicAddress, ledger_index: 'validated' })).result.account_data;
        const led = (await client.request({ command: 'server_info' })).result.info.validated_ledger;
        const reserve = Math.round((Number(led.reserve_base_xrp) + Number(info.OwnerCount || 0) * Number(led.reserve_inc_xrp)) * 1e6);
        const spendable = Number(info.Balance) - reserve - 20;
        if (Number(req.maxAmountRequired) > spendable) throw new Error(`insufficient_xrp: this call costs ${Number(req.maxAmountRequired) / 1e6} XRP; ${wallet.classicAddress} can spend ${Math.max(0, spendable) / 1e6} XRP above its ${reserve / 1e6} XRP reserve. Nothing was spent.`);
        const prepared = await client.autofill({ TransactionType: 'Payment', Account: wallet.classicAddress, Destination: req.payTo, DestinationTag: req.extra.destinationTag, Amount: req.maxAmountRequired });
        signed = wallet.sign(prepared);
      } catch (e) {
        if (/^insufficient_xrp/.test(e.message)) throw e;
        if (/actNotFound|Account not found/i.test(String(e && (e.data && e.data.error) || e.message))) throw new Error(`insufficient_xrp: ${wallet.classicAddress} is not activated. Fund it with at least 1 XRP first. Nothing was spent.`);
        throw e;
      } finally { try { await client.disconnect(); } catch {} }
      const xpay = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: req.network, payload: { txBlob: signed.tx_blob, quote: req.extra.quote } })).toString('base64');
      let res = await post({ 'x-payment': xpay });
      for (let i = 0; i < 3 && res.status === 202; i++) { await new Promise((z) => setTimeout(z, 3000)); res = await post({ 'x-payment': xpay }); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data && data.settlement && !data.x_bsv) data.x_bsv = { settlement: data.settlement };
        if (data && data.x_xrp && data.x_xrp.settlement) data.x_bsv = { settlement: data.x_xrp.settlement };
        throw apiError(res.status, data, `xrp inference failed (${res.status})`);
      }
      return {
        model: data.model || args.model,
        completion: data.choices?.[0]?.message?.content ?? '',
        paidDrops: data.x_xrp?.paidDrops,
        paidXrp: data.x_xrp ? data.x_xrp.paidDrops / 1e6 : undefined,
        priceUsd: data.x_xrp?.priceUsd,
        payTo: data.x_xrp?.payTo,
        payer: data.x_xrp?.payer,
        settlementTx: data.x_xrp?.settlement,
        network: data.x_xrp?.network,
        receipt: data.receipt,
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
