// Run only on the hosted CI runner. Never imports production config or channel credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ID } from '../src/state.js';

if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Gateway smoke runs only on GitHub Actions');
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(await readFile(configPath, 'utf8'));
const available = createServer();
await new Promise(resolve => available.listen(0, '127.0.0.1', resolve));
const port = available.address().port;
await new Promise(resolve => available.close(resolve));
const gatewayToken = randomBytes(32).toString('hex');
const bridgeToken = randomBytes(32).toString('hex');
cfg.gateway = { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: gatewayToken }, controlUi: { enabled: false } };
cfg.agents = { entries: { 'bridge-test': {} } };
cfg.plugins ??= {}; cfg.plugins.entries ??= {};
cfg.plugins.entries[ID] = { enabled: true, config: { agentIds: [] } };
await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
execFileSync('python3', ['image/init/20-openclaw-mcp-bridge.py'], {
  env: { ...process.env, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`,
    OPENCLAW_CONFIG: configPath, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_MCP_BRIDGE_AGENT: 'bridge-test', OPENCLAW_MCP_BRIDGE_BEARER: bridgeToken,
    OPENCLAW_MCP_BRIDGE_AGENT_02: 'missing-agent', OPENCLAW_MCP_BRIDGE_BEARER_02: randomBytes(32).toString('hex') }, stdio: 'inherit',
});
assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).plugins.entries[ID].config.agentIds, ['bridge-test']);
assert.equal(JSON.parse(await readFile(configPath, 'utf8')).plugins.entries[ID].config.credentials['bridge-test'], bridgeToken);
let previousToken;
for (let attempt = 0; attempt < 2; attempt++) {
  const child = spawn('node_modules/.bin/openclaw', ['gateway', 'run', '--allow-unconfigured'], {
    env: { ...process.env, OPENCLAW_DISABLE_BONJOUR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let exit;
  const collect = data => { output = (output + data.toString()).slice(-12000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const exited = new Promise(resolve => child.once('exit', code => { exit = code; resolve(); }));
  let token;
  try {
    const deadline = Date.now() + 75000;
    let success = false;
    while (Date.now() < deadline && exit === undefined) {
      try {
        const current = JSON.parse(await readFile(configPath, 'utf8'));
        token = current.plugins.entries[ID].config.credentials?.['bridge-test'];
        if (token) {
          const res = await fetch(`http://127.0.0.1:${port}/telegram-mcp`, { method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pending_count', arguments: {} } }), signal: AbortSignal.timeout(3000) });
          if (res.ok) { const body = await res.json(); assert.equal(body.result.structuredContent.pending, 0); success = true; break; }
        }
      } catch { /* wait for startup/config transaction */ }
      await delay(500);
    }
    if (!success) throw Error(`Gateway bridge smoke failed (exit ${exit ?? 'running'}).\n${output.replaceAll(gatewayToken, '[redacted]').replaceAll(token ?? 'unlikely-token-placeholder', '[redacted]')}`);
    assert.equal(token, bridgeToken, 'gateway must use the injected bearer');
    if (previousToken) assert.equal(token, previousToken, 'injected bearer must survive restart');
    previousToken = token;
    const denied = await fetch(`http://127.0.0.1:${port}/telegram-mcp`);
    assert.equal(denied.status, 401);
    console.log(`Gateway start ${attempt + 1}: injected config, authenticated MCP request and isolation passed.`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, delay(10000)]);
    if (exit === undefined) { child.kill('SIGKILL'); await exited; }
  }
}
