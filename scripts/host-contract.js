import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { sendDurableMessageBatch, buildOutboundSessionContext } from 'openclaw/plugin-sdk/channel-outbound';
import { getSessionEntry, resolveStorePath, resolveSendPolicy, upsertSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import plugin from '../dist/index.js';
import { ID } from '../src/state.js';

assert.equal(plugin.id, ID);
assert.equal(typeof plugin.register, 'function');
assert.equal(typeof sendDurableMessageBatch, 'function');
assert.equal(parseAgentSessionKey('agent:bridge-test:telegram:direct:123').agentId, 'bridge-test');
const scratch = await mkdtemp(join(tmpdir(), 'bridge-host-contract-'));
try {
  const storePath = resolveStorePath(join(scratch, 'sessions.json'), { agentId: 'bridge-test' });
  const sessionKey = 'agent:bridge-test:telegram:direct:123';
  await upsertSessionEntry({ storePath, agentId: 'bridge-test', sessionKey, entry: { sessionId: 'contract-session', updatedAt: Date.now() } });
  const entry = getSessionEntry({ storePath, agentId: 'bridge-test', sessionKey });
  assert.equal(entry.sessionId, 'contract-session');
  assert.equal(resolveSendPolicy({ cfg: {}, entry, sessionKey, channel: 'telegram', chatType: 'direct' }), 'allow');
  const context = buildOutboundSessionContext({ cfg: {}, sessionKey, agentId: 'bridge-test', conversationType: 'direct' });
  assert.equal(context.key, sessionKey); assert.equal(context.agentId, 'bridge-test');
  let config = { agents: { entries: { 'bridge-test': {} } }, session: { store: join(scratch, 'sessions.json') },
    plugins: { entries: { [ID]: { enabled: true, config: { agentIds: ['bridge-test'], credentials: { 'bridge-test': 'a'.repeat(64) } } } } } };
  let hook, service, route;
  plugin.register({ config, pluginConfig: config.plugins.entries[ID].config,
    runtime: { config: { current: () => config, mutateConfigFile: async ({ mutate }) => { const next = structuredClone(config); await mutate(next); config = next; } } },
    logger: { info() {}, warn: message => { throw Error(message); } },
    on(name, handler) { assert.equal(name, 'reply_dispatch'); hook = handler; },
    registerHttpRoute(value) { route = value; }, registerService(value) { service = value; }, registerCli() {},
  });
  assert.equal(route.auth, 'plugin'); assert.equal(route.path, '/telegram-mcp');
  await service.start();
  const result = await hook({ sessionKey, sendPolicy: 'allow', originatingChannel: 'telegram', originatingTo: '123', originatingAccountId: 'default',
    ctx: { AgentId: 'bridge-test', SessionKey: sessionKey, InboundAccessAuthorized: true, rawText: 'host contract', ChatId: '123', MessageSid: '1' } },
    { recordProcessed(outcome) { assert.equal(outcome, 'completed'); }, markIdle() {} });
  assert.equal(result.handled, true); assert.equal(result.counts.final, 0);
  await service.stop();
  console.log('Public SDK imports, real session access, plugin registration and inbound capture passed.');
} finally { await rm(scratch, { recursive: true, force: true }); }
