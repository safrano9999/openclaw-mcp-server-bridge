import { registerBridge } from '../src/bridge.js';
import { ID } from '../src/state.js';
export async function fixture(options = {}) {
  let cfg = { agents: { entries: { alice: {}, bob: {}, normal: {} } },
    plugins: { entries: { [ID]: { enabled: true, config: { agentIds: ['alice', 'bob'] } } } } };
  const captured = {}; const sent = []; const logs = [];
  const api = {
    runtime: { config: { current: () => cfg, mutateConfigFile: async ({ mutate }) => { const next = structuredClone(cfg); await mutate(next); cfg = next; } } },
    logger: { info: m => logs.push(m), warn: m => logs.push(m) },
    on: (name, fn, opts) => { captured.hook = fn; captured.hookOptions = opts; },
    registerHttpRoute: route => { captured.route = route; },
    registerService: service => { captured.service = service; }, registerCli: fn => { captured.cli = fn; },
  };
  const host = {
    parseAgentSessionKey: key => key.startsWith('agent:') ? { agentId: key.split(':')[1] } : undefined,
    getSessionEntry: () => ({ sessionId: 'session-1' }), resolveStorePath: () => '/fake/state',
    resolveSendPolicy: ({ cfg }) => cfg.session?.sendPolicy?.default ?? 'allow',
    buildOutboundSessionContext: value => value,
    sendDurableMessageBatch: async params => { await params.onPlatformSendDispatch(); sent.push(params); return { status: 'sent', results: [{ messageId: 'sent-1' }] }; },
    ...options.host,
  };
  const bridge = registerBridge(api, host);
  if (!options.skipStart) await captured.service.start();
  const header = (id = 'alice') => `Bearer ${cfg.plugins.entries[ID].config.credentials[id]}`;
  const principal = (id = 'alice') => bridge.authorize(header(id));
  const receive = (overrides = {}, ctx = {}) => captured.hook({ sessionKey: 'agent:alice:telegram:direct:123',
    ctx: { SessionKey: 'agent:alice:telegram:direct:123', AgentId: 'alice', InboundAccessAuthorized: true,
      AccountId: 'bot-a', rawText: 'hello', ChatId: '123', MessageSid: '1', SenderId: 'sender', ...ctx },
    originatingChannel: 'telegram', originatingTo: '123', originatingAccountId: 'bot-a', sendPolicy: 'allow', ...overrides,
  }, { recordProcessed() {}, markIdle() {} });
  return { bridge, captured, host, sent, logs, receive, header, principal, config: () => cfg, setConfig: next => { cfg = next; } };
}
