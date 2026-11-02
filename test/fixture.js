import { registerBridge } from '../src/bridge.js';
import { ID, PATH } from '../src/state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
const scratch = mkdtempSync(join(tmpdir(), 'bridge-tests-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
export async function fixture(options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(scratch, 'state-'));
  let cfg = { agents: { defaults: { systemAgent: { agentId: 'alice' } }, entries: { alice: {}, bob: {}, normal: {} } },
    channels: { telegram: { defaultAccount: 'bot-a', accounts: { 'bot-a': {}, 'bot-b': {} } },
      discord: { defaultAccount: 'discord-bot', accounts: { 'discord-bot': {} } } },
    bindings: [{ agentId: 'alice', match: { channel: 'telegram', accountId: 'bot-a' } },
      { agentId: 'bob', match: { channel: 'telegram', accountId: 'bot-b' } }],
    plugins: { entries: { [ID]: { enabled: true, config: { bearer: 'a'.repeat(64) } } } } };
  const captured = {}; const sent = []; const logs = [];
  const api = {
    runtime: { state: { resolveStateDir: () => stateDir }, config: { current: () => cfg, mutateConfigFile: async ({ mutate }) => { const next = structuredClone(cfg); await mutate(next); cfg = next; } } },
    logger: { info: m => logs.push(m), warn: m => logs.push(m), ...options.logger },
    on: (name, fn, opts) => { captured.hook = fn; captured.hookOptions = opts; },
    registerHttpRoute: route => { (captured.routes ??= []).push(route); if (route.path === PATH) captured.route = route; },
    registerService: service => { captured.service = service; }, registerCli: fn => { captured.cli = fn; },
  };
  const host = {
    parseAgentSessionKey: key => key.startsWith('agent:') ? { agentId: key.split(':')[1] } : undefined,
    getSessionEntry: ({ agentId }) => ({ sessionId: 'session-1', deliveryContext: {
      channel: 'telegram', accountId: agentId === 'bob' ? 'bot-b' : 'bot-a', to: agentId === 'bob' ? '456' : '123' } }),
    resolveStorePath: () => '/fake/state',
    deliveryContextFromSession: entry => entry.deliveryContext,
    resolveSendPolicy: ({ cfg }) => cfg.session?.sendPolicy?.default ?? 'allow',
    buildOutboundSessionContext: value => value,
    sendDurableMessageBatch: async params => { await params.onPlatformSendDispatch(); sent.push(params); return { status: 'sent', results: [{ messageId: 'sent-1' }] }; },
    ...options.host,
  };
  const bridge = registerBridge(api, host);
  if (!options.skipStart) await captured.service.start();
  const header = () => `Bearer ${cfg.plugins.entries[ID].config.bearer}`;
  const principal = (id = 'alice') => bridge.authorize(header(id));
  const receive = (overrides = {}, ctx = {}) => captured.hook({ sessionKey: 'agent:alice:telegram:direct:123',
    ctx: { SessionKey: 'agent:alice:telegram:direct:123', AgentId: 'alice', InboundAccessAuthorized: true,
      AccountId: 'bot-a', rawText: 'hello', ChatId: '123', MessageSid: '1', SenderId: 'sender', ...ctx },
    originatingChannel: 'telegram', originatingTo: '123', originatingAccountId: 'bot-a', sendPolicy: 'allow', ...overrides,
  }, { recordProcessed() {}, markIdle() {} });
  return { bridge, captured, host, sent, logs, receive, header, principal, stateDir, config: () => cfg, setConfig: next => { cfg = next; } };
}
