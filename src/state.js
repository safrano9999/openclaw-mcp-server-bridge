import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const ID = 'openclaw-mcp-server-bridge';
export const PATH = '/telegram-mcp';
export const LIMITS = Object.freeze({ queue: 1000, bytes: 8 * 1024 * 1024, text: 32768, routes: 2048, dedupe: 8192, ttl: 86400000, batch: 100, sends: 8 });
export class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function settings(cfg) {
  const value = cfg.plugins?.entries?.[ID]?.config ?? {};
  const ids = value.agentIds ?? [];
  if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) throw new BridgeError('invalid_agent_ids');
  const known = new Set([...Object.keys(cfg.agents?.entries ?? {}), ...(cfg.agents?.list ?? []).map(a => a.id)]);
  if (!known.size) known.add('main');
  if (ids.some(id => !known.has(id))) throw new BridgeError('unknown_agent');
  const credentials = value.credentials ?? {};
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new BridgeError('invalid_credentials');
  const tokens = Object.values(credentials);
  if (tokens.some(t => typeof t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(t)) || new Set(tokens).size !== tokens.length) throw new BridgeError('invalid_credentials');
  const allowedOrigins = value.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 16 || allowedOrigins.some(o => {
    try { return new URL(o).origin !== o || !/^https?:/.test(o) || o.length > 256; } catch { return true; }
  })) throw new BridgeError('invalid_origins');
  return { agentIds: ids, credentials, allowedOrigins };
}
export function provision(cfg) {
  const value = settings(cfg);
  const credentials = Object.fromEntries(value.agentIds.map(id => [id, value.credentials[id] ?? randomBytes(32).toString('base64url')]));
  return { ...value, credentials };
}
export function authenticate(header, config) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(header)) return undefined;
  const supplied = Buffer.from(header.slice(7));
  let owner;
  for (const id of config.agentIds) {
    const token = config.credentials[id];
    if (token && timingSafeEqual(supplied, Buffer.from(token))) owner = id;
  }
  return owner;
}
export function routeEpoch(cfg) {
  // Changes to routing/admission configuration revoke all old grants. Never log this input.
  return createHash('sha256').update(JSON.stringify([cfg.bindings, cfg.agents, cfg.channels, cfg.session])).digest('hex');
}
const keyOf = route => JSON.stringify([route.channel, route.accountId, route.to, route.threadId ?? null,
  route.sessionKey, route.sessionId, route.policySessionKey, route.senderId, route.senderName,
  route.senderUsername, route.senderE164, route.chatType]);
export class Mailbox {
  constructor(limits = LIMITS, now = Date.now) {
    this.limits = { ...LIMITS, ...limits }; this.now = now;
    this.queue = []; this.bytes = 0; this.routes = new Map(); this.seen = new Map();
    this.dropped = 0; this.expired = 0; this.duplicates = 0; this.sequence = 0; this.last = undefined;
    this.inflight = 0;
  }
  prune() {
    const cutoff = this.now() - this.limits.ttl;
    while (this.queue.length && this.queue[0].time <= cutoff) { this.remove(1); this.expired++; }
    for (const [id, route] of this.routes) if (route.time <= cutoff) this.routes.delete(id);
    for (const [id, time] of this.seen) if (time <= cutoff) this.seen.delete(id);
  }
  remove(count) {
    return this.queue.splice(0, count).map(item => { this.bytes -= item.bytes; return item.message; });
  }
  enqueue(route, message, identity) {
    this.prune();
    const key = keyOf(route);
    const dedupe = identity ? JSON.stringify([key, identity]) : undefined;
    if (dedupe && this.seen.has(dedupe)) { this.duplicates++; return false; }
    if (dedupe) {
      this.seen.set(dedupe, this.now());
      while (this.seen.size > this.limits.dedupe) this.seen.delete(this.seen.keys().next().value);
    }
    const existing = [...this.routes].find(([, r]) => r.key === key);
    const routeId = existing?.[0] ?? randomUUID();
    const grant = existing?.[1] ?? { ...route, key };
    grant.time = this.now();
    this.routes.delete(routeId);
    this.routes.set(routeId, grant);
    while (this.routes.size > this.limits.routes) this.routes.delete(this.routes.keys().next().value);
    this.last = routeId;
    const body = String(message.text ?? '');
    const dto = { ...message, text: body.slice(0, this.limits.text), truncated: body.length > this.limits.text,
      id: randomUUID(), sequence: ++this.sequence, route_id: routeId, received_at: new Date(this.now()).toISOString(),
      channel: route.channel, account_id: route.accountId, chat_id: route.chatId, thread_id: route.threadId };
    const bytes = Buffer.byteLength(JSON.stringify(dto));
    if (bytes > this.limits.bytes) { this.dropped++; return false; }
    while (this.queue.length >= this.limits.queue || this.bytes + bytes > this.limits.bytes) { this.remove(1); this.dropped++; }
    this.queue.push({ message: dto, bytes, time: this.now() }); this.bytes += bytes;
    return true;
  }
  count() { this.prune(); return { pending: this.queue.length, dropped: this.dropped, expired: this.expired, duplicates: this.duplicates }; }
  consume(count = 1) {
    if (!Number.isInteger(count) || count < 1 || count > this.limits.batch) throw new BridgeError('invalid_count');
    this.prune();
    // No await between selection and removal: concurrent callers cannot consume the same item.
    return { messages: this.remove(count), ...this.count() };
  }
  resolve({ route_id, chat_id } = {}) {
    this.prune();
    let id = route_id;
    if (!id && chat_id !== undefined) {
      const matches = [...this.routes].filter(([, r]) => r.chatId === chat_id);
      if (matches.length > 1) throw new BridgeError('ambiguous_chat_use_route_id');
      id = matches[0]?.[0];
    }
    if (!id && chat_id === undefined) id = this.last;
    const route = this.routes.get(id);
    if (!route || (chat_id !== undefined && route.chatId !== chat_id)) throw new BridgeError('unknown_or_expired_route');
    return route;
  }
}
