// Offline checks for the MCP JSON-RPC layer and the published metadata.
// No network: only initialize / ping / tools/list and error paths are exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleMessage, TOOLS } from '../server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

test('initialize reports the package version', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.id, 1);
  assert.equal(r.result.serverInfo.name, 'bsvkey-inference');
  assert.equal(r.result.serverInfo.version, pkg.version);
  assert.ok(r.result.capabilities.tools);
});

test('tools/list returns every tool with a name, description and object schema', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(r.result.tools.length, TOOLS.length);
  const names = r.result.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const name of ['list_models', 'infer', 'channel_balance', 'open_channel', 'x402_infer']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  for (const t of r.result.tools) {
    assert.ok(t.description, `${t.name} has a description`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} has an object inputSchema`);
  }
});

test('ping, notifications and unknown methods', async () => {
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'some/notification' }), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601);
  assert.equal((await handleMessage({ id: 5, method: 'ping' })).error.code, -32600);
});

test('an unknown tool is reported as a tool error, not a crash', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown tool/);
});

test('server.json versions match package.json', () => {
  assert.equal(serverJson.version, pkg.version);
  const npm = serverJson.packages.find((p) => p.registryType === 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
});

test('server.json lists the hosted remote and keeps the description within the registry limit', () => {
  assert.ok(serverJson.description.length <= 100, 'registry caps description at 100 characters');
  const remote = (serverJson.remotes || []).find((r) => r.type === 'streamable-http');
  assert.ok(remote, 'a streamable-http remote is listed');
  assert.equal(remote.url, 'https://inference.bsvkey.com/mcp');
  const auth = remote.headers.find((h) => h.name === 'Authorization');
  assert.equal(auth.isSecret, true);
  assert.equal(auth.isRequired, false);
});
