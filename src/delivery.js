import { BridgeError, settings } from './state.js';

// "default" is an API selector, never an agent/account name on this surface.
export const concrete = value => value === undefined || value === '' || value === 'default' ? undefined : value;
export function selectAgent(cfg, args = {}) {
  const known = settings(cfg).agentIds;
  const id = concrete(args.agent) ?? cfg.agents?.defaults?.systemAgent?.agentId ?? 'main';
  if (!known.includes(id)) throw new BridgeError('unknown_agent');
  return id;
}
export function selectSession(cfg, agent, args = {}) {
  const value = concrete(args.session);
  const key = value ? (value.startsWith('agent:') || value === 'global' ? value : `agent:${agent}:${value}`)
    : cfg.session?.scope === 'global' ? 'global' : `agent:${agent}:main`;
  if (key.startsWith('agent:') && key.split(':')[1] !== agent) throw new BridgeError('session_agent_mismatch');
  if (key.length > 256 || /[\x00-\x20]/.test(key)) throw new BridgeError('invalid_session');
  return key;
}
const unique = values => [...new Set(values.filter(Boolean))];
function one(values, error) {
  const ids = unique(values);
  if (ids.length !== 1) throw new BridgeError(error);
  return ids[0];
}
export function resolveDelivery(cfg, args, entryFor, savedRoute) {
  const agentId = selectAgent(cfg, args);
  const sessionKey = selectSession(cfg, agentId, args);
  const entry = entryFor(cfg, agentId, sessionKey);
  const stored = entry?.deliveryContext ?? {};
  const saved = savedRoute?.sessionKey === sessionKey ? savedRoute : {};
  const recent = {
    channel: stored.channel ?? entry?.lastChannel ?? saved.channel,
    accountId: stored.accountId ?? entry?.lastAccountId ?? saved.accountId,
    to: stored.to ?? entry?.lastTo ?? saved.to,
    threadId: stored.threadId ?? entry?.lastThreadId ?? saved.threadId,
  };
  const bindings = (cfg.bindings ?? []).filter(b => b.agentId === agentId && b.match?.channel && !b.match.guildId && !b.match.teamId && !b.match.roles?.length);
  const useLast = args.channel === 'last';
  const defaultAgent = cfg.agents?.defaults?.systemAgent?.agentId ?? 'main';
  const preferred = agentId === defaultAgent ? concrete(settings(cfg).defaultChannel) : undefined;
  const channel = useLast ? recent.channel : concrete(args.channel) ?? preferred ?? one(bindings.map(b => b.match.channel), 'ambiguous_default_channel');
  if (!channel || !cfg.channels?.[channel] || cfg.channels[channel].enabled === false) throw new BridgeError('unknown_channel');
  const channelBindings = bindings.filter(b => b.match.channel === channel);
  const accountBindings = unique(channelBindings.map(b => b.match.accountId).filter(id => id && id !== '*'));
  const channelDefault = cfg.channels[channel].defaultAccount ?? (cfg.channels[channel].accounts?.default ? 'default' : undefined);
  const preferredAccount = channelDefault && accountBindings.includes(channelDefault) ? channelDefault : undefined;
  const accountId = concrete(args.accountId) ?? (useLast ? recent.accountId : undefined) ?? preferredAccount ??
    (accountBindings.length ? one(accountBindings, 'ambiguous_default_account') : channelDefault);
  if (!accountId || (cfg.channels[channel].accounts && !Object.hasOwn(cfg.channels[channel].accounts, accountId)) ||
      cfg.channels[channel].accounts?.[accountId]?.enabled === false) throw new BridgeError('unknown_account');
  const peerTargets = channelBindings.filter(b => (b.match.accountId === accountId || b.match.accountId === '*' || !b.match.accountId) && b.match.peer?.id !== '*')
    .map(b => b.match.peer?.id).filter(Boolean);
  const compatible = recent.channel === channel && recent.accountId === accountId;
  const target = concrete(args.target) ?? (peerTargets.length ? one(peerTargets, 'ambiguous_default_target') : compatible ? recent.to : undefined);
  if (!target) throw new BridgeError('no_default_target');
  const sameTarget = compatible && target === recent.to;
  const threadId = concrete(args.threadId) ?? (sameTarget ? recent.threadId : undefined);
  return { ...(sameTarget ? saved : {}), agentId, channel, accountId, to: target, threadId, sessionKey,
    sessionId: entry?.sessionId, policySessionKey: sameTarget ? saved.policySessionKey ?? sessionKey : sessionKey,
    chatType: sameTarget ? saved.chatType ?? entry?.chatType : undefined };
}
