import { ID, PATH, DIRECT_PATH, LIMITS, BridgeError, Mailbox, authenticate, settings, routeEpoch } from './state.js';
import { createHttpHandler } from './http.js';
import { ICON_PATH } from './browser.js';
import { RouteStore } from './routes.js';
import { resolveDelivery, selectAgent } from './delivery.js';
import { HandlerRegistry } from './extensions.js';

const bounded = value => typeof value === 'string' ? value.slice(0, 512) : undefined;

// Dependencies are public SDK functions, injected only to test host-boundary behavior.
export function registerBridge(api, host) {
  let ready = false;
  let generation = new AbortController();
  let epoch;
  let routes;
  const boxes = new Map();
  const extensions = new HandlerRegistry(api.runtime.state.resolveStateDir());
  const cfgNow = () => api.runtime.config.current();
  function sync() {
    const cfg = cfgNow();
    const conf = settings(cfg);
    const nextEpoch = routeEpoch(cfg);
    if (epoch && epoch !== nextEpoch) {
      generation.abort(); generation = new AbortController(); boxes.clear();
    }
    epoch = nextEpoch;
    routes ??= new RouteStore(api.runtime.state.resolveStateDir());
    routes.sync(epoch, conf.agentIds);
    for (const id of boxes.keys()) if (!conf.agentIds.includes(id)) boxes.delete(id);
    return { cfg, conf };
  }
  function assertPrincipal(principal) {
    const { cfg, conf } = sync();
    if (!ready || cfg.plugins?.entries?.[ID]?.enabled === false || conf.bearer !== principal.token) throw new BridgeError('credential_revoked');
    return cfg;
  }
  function box(id) {
    if (!boxes.has(id)) {
      const mailbox = new Mailbox(LIMITS, Date.now, route => routes.set(id, route));
      mailbox.actual_channel = routes.get(id);
      boxes.set(id, mailbox);
    }
    return boxes.get(id);
  }
  function authorize(header) {
    if (!ready) throw new BridgeError('not_ready');
    const { cfg, conf } = sync();
    if (cfg.plugins?.entries?.[ID]?.enabled === false) return undefined;
    return authenticate(header, conf) ? { token: conf.bearer } : undefined;
  }
  function entryFor(cfg, agentId, sessionKey) {
    const entry = host.getSessionEntry({ agentId, sessionKey, storePath: host.resolveStorePath(cfg.session?.store, { agentId }) });
    return entry ? { ...entry, deliveryContext: host.deliveryContextFromSession(entry) } : undefined;
  }
  async function send(principal, args, signal, guard = () => {}) {
    let cfg = assertPrincipal(principal);
    if (!args.text?.trim() || args.text.length > LIMITS.text) throw new BridgeError('invalid_text');
    const agentId = selectAgent(cfg, args);
    const mailbox = box(agentId);
    const route = resolveDelivery(cfg, args, entryFor, mailbox.actual_channel);
    const routeKey = value => JSON.stringify([value.channel, value.accountId, value.to, value.threadId, value.sessionKey, value.sessionId]);
    if (mailbox.inflight >= LIMITS.sends) throw new BridgeError('too_many_sends');
    const currentEpoch = epoch;
    const check = () => {
      guard();
      cfg = assertPrincipal(principal);
      if (currentEpoch !== epoch || routeKey(resolveDelivery(cfg, args, entryFor, mailbox.actual_channel)) !== routeKey(route)) throw new BridgeError('route_revoked');
      const entry = entryFor(cfg, agentId, route.sessionKey);
      if (entry?.sessionId !== route.sessionId) throw new BridgeError('session_changed');
      if (host.resolveSendPolicy({ cfg, entry, sessionKey: route.sessionKey, channel: route.channel, chatType: route.chatType }) !== 'allow') throw new BridgeError('send_policy_denied');
      if (route.policySessionKey !== route.sessionKey && host.resolveSendPolicy({ cfg, entry,
        sessionKey: route.policySessionKey, channel: route.channel, chatType: route.chatType }) !== 'allow') throw new BridgeError('send_policy_denied');
    };
    check();
    mailbox.inflight++;
    try {
      const combined = AbortSignal.any([signal, generation.signal]);
      combined.throwIfAborted();
      const response = await host.sendDurableMessageBatch({
        cfg, channel: route.channel, accountId: route.accountId, to: route.to,
        threadId: route.threadId, payloads: args.attachments?.length
          ? args.attachments.map((file, index) => ({ text: index === 0 ? args.text : '', mediaUrl: file }))
          : [{ text: args.text }], signal: combined,
        mediaLocalRoots: [extensions.stateRoot],
        session: host.buildOutboundSessionContext({ cfg, sessionKey: route.sessionKey,
          policySessionKey: route.policySessionKey, agentId,
          conversationType: route.chatType, requesterAccountId: route.accountId,
          requesterSenderId: route.senderId, requesterSenderName: route.senderName,
          requesterSenderUsername: route.senderUsername, requesterSenderE164: route.senderE164 }),
        // Recheck after async planning, immediately before each platform handoff.
        onPlatformSendDispatch: check,
        assertDirectAdapterHandoff: check,
      });
      const ids = response.results?.map(r => r.messageId).filter(id => typeof id === 'string') ?? [];
      if (response.status === 'sent') return { status: 'sent', message_ids: ids };
      if (response.status === 'suppressed') return { status: 'suppressed', message_ids: ids, retry_safe: false };
      return { status: response.status === 'partial_failed' ? 'partial_failed' : 'delivery_unknown', message_ids: ids, retry_safe: false };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // Network/timeout errors may happen after delivery. Never retry automatically.
      return { status: 'delivery_unknown', retry_safe: false };
    } finally { mailbox.inflight--; }
  }
  async function direct(principal, args, signal) {
    const guard = () => {
      assertPrincipal(principal);
      if (!sync().conf.direct) throw new BridgeError('direct_disabled');
    };
    guard();
    if (args.tool) return extensions.invoke(args.tool, args.payload ?? {}, signal,
      prepared => send(principal, { ...args, text: prepared.text, attachments: prepared.attachments }, signal, guard));
    const agentId = selectAgent(assertPrincipal(principal), args);
    let queued = false;
    if (sync().conf.directFifo) {
      // Webhooks are inputs, not channel senders: never replace actual_channel.
      queued = box(agentId).enqueue({ channel: 'webhook', accountId: agentId },
        { text: args.text, payload: args.payload, event_id: args.event_id }, args.event_id, false);
      if (!queued) return { status: 'duplicate_or_overflow', fifo_enqueued: false };
    }
    try { return { ...await send(principal, args, signal, guard), fifo_enqueued: queued }; }
    catch (error) {
      if (!queued) throw error;
      return { status: 'queued', fifo_enqueued: true, delivery_error: error instanceof BridgeError ? error.code : 'delivery_unknown', retry_safe: false };
    }
  }
  const bridge = { authorize, assertPrincipal, direct, directEnabled: () => sync().conf.direct,
    origins: () => sync().conf.allowedOrigins,
    handlers: () => extensions.list(),
    handler: (principal, name, args, signal) => extensions.invoke(name, args.payload ?? {}, signal,
      prepared => send(principal, { ...args, text: prepared.text, attachments: prepared.attachments }, signal)),
    mailbox: (principal, args = {}) => box(selectAgent(assertPrincipal(principal), args)), send };

  const handler = createHttpHandler(bridge);
  for (const path of [PATH, DIRECT_PATH, ICON_PATH]) api.registerHttpRoute({ path, auth: 'plugin', match: 'exact', handler });
  api.on('reply_dispatch', (event, context) => {
    const ctx = event.ctx;
    const sessionKey = event.sessionKey ?? ctx.SessionKey;
    const parsed = sessionKey ? host.parseAgentSessionKey(sessionKey)?.agentId : undefined;
    const agentId = ctx.AgentId ?? parsed;
    const pluginEntry = cfgNow().plugins?.entries?.[ID];
    if (pluginEntry?.enabled === false) return;
    if (ctx.InternalTurnSource) return; // Cron/heartbeat is outside this channel bridge's scope.
    let outcome = 'completed'; let reason = 'mcp_bridge_enqueued';
    try {
      const { cfg, conf } = sync();
      if (!ready) throw new BridgeError('not_ready');
      if (!agentId || !conf.agentIds.includes(agentId) || !sessionKey || (parsed && parsed !== agentId)) throw new BridgeError('ambiguous_agent');
      if (ctx.InboundAccessAuthorized !== true) throw new BridgeError('inbound_not_authorized');
      // Inbound admission is independent of automatic replies and outbound send policy.
      // Explicit MCP sends check the current send policy at platform handoff.
      const channel = event.originatingChannel ?? ctx.OriginatingChannel;
      const to = event.originatingTo ?? ctx.OriginatingTo;
      const accountId = event.originatingAccountId ?? ctx.AccountId;
      if (!channel || !to || !accountId || channel === 'webchat') throw new BridgeError('missing_channel_route');
      const entry = entryFor(cfg, agentId, sessionKey);
      if (!entry?.sessionId) throw new BridgeError('missing_session');
      const route = {
        channel, to, accountId, sessionKey, sessionId: entry.sessionId,
        policySessionKey: ctx.RuntimePolicySessionKey ?? sessionKey,
        threadId: event.originatingThreadId ?? ctx.TransportThreadId ?? ctx.MessageThreadId,
        chatType: event.originatingChatType ?? ctx.ChatType,
        chatId: bounded(ctx.ChatId) ?? bounded(ctx.NativeChannelId) ?? to,
        senderId: bounded(ctx.SenderId),
        senderName: bounded(ctx.SenderName), senderUsername: bounded(ctx.SenderUsername), senderE164: bounded(ctx.SenderE164),
      };
      const accepted = box(agentId).enqueue(route, {
        text: ctx.rawText ?? ctx.RawBody ?? ctx.CommandBody ?? '',
        message_id: bounded(ctx.MessageSidFull ?? ctx.MessageSid), sender_id: bounded(ctx.SenderId),
        sender_name: bounded(ctx.SenderName), timestamp: Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined,
        media: (ctx.media ?? []).slice(0, 16).map(m => ({ kind: bounded(m.kind), content_type: bounded(m.contentType) })),
      }, ctx.ProviderUpdateId ?? ctx.MessageSidFull ?? ctx.MessageSid);
      if (!accepted) reason = 'mcp_bridge_duplicate_or_overflow';
    } catch (error) {
      outcome = 'skipped'; reason = `mcp_bridge_${error instanceof BridgeError ? error.code : 'capture_failed'}`;
      try { api.logger.warn(reason); } catch { /* diagnostics cannot release a claimed turn */ }
    }
    // Observe admitted messages without taking over normal agent replies.
  }, { priority: 1000, eligibleDispatchKinds: ['agent'] });

  api.registerService({
    id: ID,
    reload: { configPrefixes: [`plugins.entries.${ID}`, 'agents', 'bindings', 'channels', 'session'] },
    async start() {
      ready = false;
      sync(); ready = true;
      api.logger.info(`MCP bridge ready at ${PATH}; ${settings(cfgNow()).agentIds.length} agent(s), ${extensions.list().length} handler(s)`);
    },
    stop() { ready = false; generation.abort(); generation = new AbortController(); boxes.clear(); },
  });
  api.registerCli(({ program, config }) => {
    const command = program.command('mcp-bridge').description('Inspect the MCP and notification bridge');
    command.command('status').action(() => {
      const conf = settings(config);
      process.stdout.write(`${JSON.stringify({ path: PATH, authenticated: !!conf.bearer, defaultAgent: selectAgent(config), agents: conf.agentIds, handlers: extensions.list() }, null, 2)}\n`);
    });
    command.command('client-config').option('--url <url>', 'Gateway base URL, including HTTPS proxy if remote').action((options) => {
      const conf = settings(config);
      const url = new URL(PATH, options.url ?? `http://127.0.0.1:${config.gateway?.port ?? 18789}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BridgeError('invalid_gateway_url');
      process.stdout.write(`${JSON.stringify({ mcpServers: { openclaw: { url: url.href, ...(conf.bearer ? { headers: { Authorization: `Bearer ${conf.bearer}` } } : {}) } } }, null, 2)}\n`);
    });
  }, { commands: ['mcp-bridge'] });
  return bridge;
}
