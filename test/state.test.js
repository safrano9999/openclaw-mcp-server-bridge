import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, settings, provision, authenticate, ID } from '../src/state.js';
const route = { channel: 'telegram', accountId: 'bot-a', to: '123', chatId: '123', sessionKey: 'agent:alice:main' };
test('FIFO consumes once even when independent clients call concurrently', async () => {
  const box = new Mailbox();
  for (let i = 0; i < 100; i++) box.enqueue(route, { text: `m${i}` }, String(i));
  const result = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => box.consume(10))));
  assert.deepEqual(result.flatMap(r => r.messages.map(m => m.text)), Array.from({ length: 100 }, (_, i) => `m${i}`));
  assert.equal(box.count().pending, 0);
});
test('overflow, expiry, truncation, dedupe and count bounds are explicit', () => {
  let now = 10000; const box = new Mailbox({ queue: 2, text: 4, ttl: 100 }, () => now);
  box.enqueue(route, { text: 'abcdef' }, '1');
  box.enqueue(route, { text: 'ignored' }, '1');
  assert.equal(box.count().duplicates, 1);
  assert.equal(box.consume().messages[0].truncated, true);
  for (let i = 2; i < 5; i++) box.enqueue(route, { text: String(i) }, String(i));
  assert.equal(box.count().dropped, 1);
  assert.deepEqual(box.consume(2).messages.map(m => m.text), ['3', '4']);
  box.enqueue(route, { text: '5' }, '5'); now += 101;
  assert.equal(box.count().expired, 1);
  assert.throws(() => box.resolve(), /unknown_or_expired/);
  for (const n of [0, -1, 101, NaN, 1.5]) assert.throws(() => box.consume(n), /invalid_count/);
});
test('mixed-source FIFO entries never change the latest accepted destination when consumed', () => {
  const box = new Mailbox();
  box.enqueue({ ...route, threadId: 1 }, { text: 'first' });
  box.enqueue({ ...route, channel: 'discord', to: '456', threadId: 2 }, { text: 'second' });
  assert.equal(box.consume().messages[0].channel, 'telegram');
  assert.equal(box.resolve().channel, 'discord');
  assert.equal(box.resolve().threadId, 2);
  const current = box.resolve();
  assert.equal(box.consume().messages[0].text, 'second');
  assert.equal(box.resolve(), current);
});
test('credential provisioning preserves existing tokens, removes retired agents, isolates principals', () => {
  const cfg = { agents: { list: [{ id: 'a' }, { id: 'b' }] }, plugins: { entries: { [ID]: { config: { agentIds: ['a', 'b'] } } } } };
  const first = provision(cfg); cfg.plugins.entries[ID].config = first;
  assert.deepEqual(provision(cfg), first);
  assert.equal(authenticate(`Bearer ${first.credentials.a}`, first), 'a');
  assert.equal(authenticate('Bearer wrong', first), undefined);
  cfg.plugins.entries[ID].config.agentIds = ['a'];
  assert.deepEqual(Object.keys(provision(cfg).credentials), ['a']);
  cfg.plugins.entries[ID].config.agentIds = ['missing'];
  assert.throws(() => settings(cfg), /unknown_agent/);
});
test('a new accepted source replaces the only route without rewriting queued messages', () => {
  const box = new Mailbox();
  box.enqueue({ ...route, senderId: 'one', sessionId: 'old' }, { text: 'old message' });
  const original = box.resolve();
  box.enqueue({ ...route, senderId: 'two', sessionId: 'new' }, { text: 'new message' });
  assert.notEqual(box.resolve().route_id, original.route_id);
  assert.equal(box.resolve().senderId, 'two');
  assert.equal(box.resolve().sessionId, 'new');
  assert.deepEqual(box.consume(2).messages.map(m => m.text), ['old message', 'new message']);
  assert.equal(box.resolve().senderId, 'two');
});
test('duplicates do not replace the current destination', () => {
  const box = new Mailbox();
  box.enqueue(route, { text: 'first' }, '1');
  box.enqueue({ ...route, channel: 'discord' }, { text: 'second' }, '2');
  const current = box.resolve();
  assert.equal(box.enqueue(route, { text: 'duplicate' }, '1'), false);
  assert.equal(box.resolve(), current);
});
test('agent names matching Object prototype fields still receive random credentials', () => {
  const cfg = { agents: { entries: { constructor: {} } }, plugins: { entries: { [ID]: { config: { agentIds: ['constructor'] } } } } };
  const next = provision(cfg);
  assert.match(next.credentials.constructor, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authenticate(`Bearer ${next.credentials.constructor}`, next), 'constructor');
});
