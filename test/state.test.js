import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, settings, authenticate, ID } from '../src/state.js';
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
  assert.equal(box.resolve().channel, 'telegram');
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
test('one optional bearer protects every agent without generating credentials', () => {
  const cfg = {agents:{entries:{a:{},b:{}}},plugins:{entries:{[ID]:{config:{bearer:'a'.repeat(64)}}}}};
  const before=structuredClone(cfg), conf=settings(cfg);
  assert.deepEqual(cfg,before);
  assert.equal(authenticate('Bearer '+conf.bearer,conf),true);
  assert.equal(authenticate('Bearer wrong',conf),false);
  assert.equal(authenticate(undefined,conf),false);
  cfg.plugins.entries[ID].config.bearer='';
  assert.equal(authenticate(undefined,settings(cfg)),true);
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
test('a failed route write does not acknowledge a message or suppress its retry', () => {
  let fail = true;
  const box = new Mailbox({}, Date.now, () => { if (fail) throw Error('disk unavailable'); });
  assert.throws(() => box.enqueue(route, { text: 'first' }, '1'), /disk unavailable/);
  assert.equal(box.count().pending, 0);
  assert.throws(() => box.resolve(), /no_return_route/);
  fail = false;
  assert.equal(box.enqueue(route, { text: 'first' }, '1'), true);
  assert.equal(box.count().pending, 1);
});
test('agent selection includes only own configured entries',()=>{
 const cfg={agents:{entries:{main:{}}}};
 assert.deepEqual(settings(cfg).agentIds,['main']);
});
