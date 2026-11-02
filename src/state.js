import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const ID = 'openclaw-mcp-server-bridge';
export const PATH = '/mcp';
export const DIRECT_PATH = '/mcp/direct';
export const LIMITS = Object.freeze({ queue: 1000, bytes: 8 * 1024 * 1024, text: 32768, dedupe: 8192, ttl: 86400000, batch: 100, sends: 8 });
export class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function settings(cfg) {
  const value = cfg.plugins?.entries?.[ID]?.config ?? {};
  const known = new Set([...Object.keys(cfg.agents?.entries ?? {}), ...(cfg.agents?.list ?? []).map(a => a.id)]);
  if (!known.size) known.add('main');
  const bearer = value.bearer ?? '';
  if (typeof bearer !== 'string' || (bearer && !/^[A-Za-z0-9_-]{43,128}$/.test(bearer))) throw new BridgeError('invalid_bearer');
  const defaultChannel = value.defaultChannel ?? '';
  if (typeof defaultChannel !== 'string' || (defaultChannel && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(defaultChannel))) throw new BridgeError('invalid_default_channel');
  const allowedOrigins = value.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 16 || allowedOrigins.some(o => {
    try { return new URL(o).origin !== o || !/^https?:/.test(o) || o.length > 256; } catch { return true; }
  })) throw new BridgeError('invalid_origins');
  const { direct = false, directFifo = false } = value;
  if (typeof direct !== 'boolean' || typeof directFifo !== 'boolean') throw new BridgeError('invalid_direct_settings');
  return { agentIds: [...known], bearer, defaultChannel, allowedOrigins, direct, directFifo };
}
export function authenticate(header, config) {
  if (!config.bearer) return true;
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43,128}$/i.test(header)) return false;
  const supplied = Buffer.from(header.slice(7));
  return supplied.length === Buffer.byteLength(config.bearer) && timingSafeEqual(supplied, Buffer.from(config.bearer));
}
export function routeEpoch(cfg) {
  // Changes to routing/admission configuration revoke all old grants. Never log this input.
  return createHash('sha256').update(JSON.stringify([cfg.bindings, cfg.agents, cfg.channels, cfg.session])).digest('hex');
}
const keyOf = route => JSON.stringify([route.channel, route.accountId, route.to, route.threadId ?? null,
  route.sessionKey, route.sessionId, route.policySessionKey, route.senderId, route.senderName,
  route.senderUsername, route.senderE164, route.chatType]);
export class Mailbox {
  constructor(limits = LIMITS, now = Date.now, saveRoute = () => {}) {
    this.limits = { ...LIMITS, ...limits }; this.now = now;
    this.saveRoute = saveRoute;
    this.queue = []; this.bytes = 0; this.actual_channel = undefined; this.seen = new Map();
    this.dropped = 0; this.expired = 0; this.duplicates = 0; this.sequence = 0;
    this.inflight = 0;
  }
  prune() {
    const cutoff = this.now() - this.limits.ttl;
    while (this.queue.length && this.queue[0].time <= cutoff) { this.remove(1); this.expired++; }
    for (const [id, time] of this.seen) if (time <= cutoff) this.seen.delete(id);
  }
  remove(count) {
    return this.queue.splice(0, count).map(item => { this.bytes -= item.bytes; return item.message; });
  }
  enqueue(route, message, identity, updateRoute = true) {
    this.prune();
    const key = keyOf(route);
    const dedupe = identity ? JSON.stringify([key, identity]) : undefined;
    if (dedupe && this.seen.has(dedupe)) { this.duplicates++; return false; }
    const body = String(message.text ?? '');
    const dto = { ...message, text: body.slice(0, this.limits.text), truncated: body.length > this.limits.text,
      id: randomUUID(), sequence: ++this.sequence, received_at: new Date(this.now()).toISOString(),
      channel: route.channel, account_id: route.accountId, chat_id: route.chatId, thread_id: route.threadId };
    const bytes = Buffer.byteLength(JSON.stringify(dto));
    if (bytes > this.limits.bytes) { this.dropped++; return false; }
    if (updateRoute) {
      const current = { ...route, route_id: randomUUID(), time: this.now() };
      this.saveRoute(current);
      this.actual_channel = current;
    }
    if (dedupe) {
      this.seen.set(dedupe, this.now());
      while (this.seen.size > this.limits.dedupe) this.seen.delete(this.seen.keys().next().value);
    }
    while (this.queue.length >= this.limits.queue || this.bytes + bytes > this.limits.bytes) { this.remove(1); this.dropped++; }
    this.queue.push({ message: dto, bytes, time: this.now() }); this.bytes += bytes;
    return true;
  }
  count() { this.prune(); return { pending: this.queue.length, dropped: this.dropped, expired: this.expired, duplicates: this.duplicates }; }
  consume(count = 1) {
    if (!Number.isInteger(count) || count < 1 || count > this.limits.batch) throw new BridgeError('invalid_count');
    this.prune();
    // No await between selection and removal: concurrent callers cannot consume the same item.
    const messages = this.remove(count);
    return { messages, count: messages.length, ...this.count() };
  }
  resolve() {
    this.prune();
    if (!this.actual_channel) throw new BridgeError('no_return_route');
    return this.actual_channel;
  }
}
