import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { ID } from '../src/state.js';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
test('selected inbound is captured without a client; unrelated agents are untouched', async () => {
  const f = await fixture();
  assert.equal(f.receive().handled, true);
  assert.equal(f.receive({ sessionKey: 'agent:normal:main' }, { AgentId: 'normal' }), undefined);
  assert.equal(f.bridge.mailbox(f.principal()).count().pending, 1);
  assert.equal(f.bridge.mailbox(f.principal('bob')).count().pending, 0);
  assert.deepEqual(f.captured.hookOptions.eligibleDispatchKinds, ['agent']);
});
test('capture errors and unauthorized delivery fail closed for selected agents', async () => {
  const f = await fixture();
  for (const ctx of [{ InboundAccessAuthorized: false }, { AgentId: 'bob' }]) assert.equal(f.receive({}, ctx).handled, true);
  assert.equal(f.receive({ sendPolicy: 'deny' }).handled, true);
  f.host.getSessionEntry = () => { throw Error('secret upstream error'); };
  assert.equal(f.receive().handled, true);
  assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
  assert(!f.logs.some(m => m.includes('secret upstream')));
});
test('outbound uses the current account/topic; consumption leaves the destination intact', async () => {
  const f = await fixture();
  f.receive({ originatingThreadId: 42 });
  f.bridge.mailbox(f.principal()).consume();
  await assert.rejects(f.bridge.send(f.principal('bob'), { text: 'no' }, new AbortController().signal), /no_return_route/);
  const result = await f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal);
  assert.equal(result.status, 'sent');
  assert.equal(f.sent[0].accountId, 'bot-a'); assert.equal(f.sent[0].threadId, 42); assert.equal(f.sent[0].to, '123');
  assert.equal(f.sent[0].session.agentId, 'alice');
  assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
});
test('all outgoing text follows the latest accepted source, regardless of FIFO position', async () => {
  const f = await fixture();
  f.receive();
  f.receive({ originatingChannel: 'discord', originatingTo: 'discord-room', originatingAccountId: 'discord-bot', originatingThreadId: 'topic' }, { MessageSid: '2' });
  assert.equal(f.bridge.mailbox(f.principal()).consume().messages[0].channel, 'telegram');
  const result = await f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal);
  assert.equal(result.status, 'sent');
  assert.equal(f.sent[0].channel, 'discord');
  assert.equal(f.sent[0].accountId, 'discord-bot');
  assert.equal(f.sent[0].to, 'discord-room');
  assert.equal(f.sent[0].threadId, 'topic');
});
test('removal, token changes, routing changes and session reset revoke access', async () => {
  const f = await fixture(); f.receive();
  const p = f.principal();
  f.config().plugins.entries[ID].config.credentials.alice = 'x'.repeat(43);
  assert.throws(() => f.bridge.mailbox(p), /credential_revoked/);
  f.config().bindings = [{ agentId: 'bob', match: { channel: 'telegram' } }];
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /no_return_route/);
  f.receive(); f.host.getSessionEntry = () => ({ sessionId: 'new-session' });
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /session_changed/);
  f.config().plugins.entries[ID].config.agentIds = [];
  assert.equal(f.bridge.authorize(f.header()), undefined);
});
test('fresh per-session send policy is checked before platform handoff', async () => {
  const f = await fixture(); f.receive();
  f.host.resolveSendPolicy = () => 'deny';
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /send_policy_denied/);
  assert.equal(f.sent.length, 0);
});
test('partial/suppressed/uncertain delivery never becomes success or automatic retry', async () => {
  const f = await fixture(); f.receive();
  for (const status of ['partial_failed', 'suppressed', 'failed']) {
    let calls = 0; f.host.sendDurableMessageBatch = async () => { calls++; return { status, results: [{ messageId: 'a' }] }; };
    const result = await f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal);
    assert.equal(result.retry_safe, false); assert.notEqual(result.status, 'sent'); assert.equal(calls, 1);
  }
});
test('a narrower runtime policy key cannot be bypassed by a broad main session', async () => {
  const f = await fixture();
  f.receive({}, { RuntimePolicySessionKey: 'agent:alice:telegram:group:blocked' });
  f.host.resolveSendPolicy = ({ sessionKey }) => sessionKey.endsWith(':blocked') ? 'deny' : 'allow';
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /send_policy_denied/);
  assert.equal(f.sent.length, 0);
});
test('restart clears queues but preserves the current return route and credentials', async () => {
  const f = await fixture(); f.receive(); const token = f.header();
  await f.captured.service.stop(); await f.captured.service.start();
  assert.equal(f.header(), token); assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
  assert.equal((await f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal)).status, 'sent');
});
test('a new process restores only the latest destination, independently for each agent', async () => {
  const f = await fixture();
  f.receive();
  f.receive({ sessionKey: 'agent:bob:telegram:direct:456', originatingTo: '456', originatingAccountId: 'bot-b' },
    { AgentId: 'bob', SessionKey: 'agent:bob:telegram:direct:456', SenderId: 'bob-sender', MessageSid: '2' });
  f.receive({ originatingChannel: 'discord', originatingTo: 'room', originatingAccountId: 'discord-bot', originatingThreadId: 'thread' },
    { SenderId: 'latest-sender', MessageSid: '3' });
  f.bridge.mailbox(f.principal()).consume(2);
  const file = join(f.stateDir, ID, 'routes.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.routes.alice.senderId, 'latest-sender');
  assert.equal(Object.keys(stored.routes).length, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes(f.header().slice(7)));
  await f.captured.service.stop();
  const fresh = await fixture({ stateDir: f.stateDir });
  assert.equal(fresh.bridge.mailbox(fresh.principal()).count().pending, 0);
  await fresh.bridge.send(fresh.principal(), { text: 'after restart' }, new AbortController().signal);
  assert.equal(fresh.sent[0].channel, 'discord');
  assert.equal(fresh.sent[0].to, 'room');
  assert.equal(fresh.sent[0].threadId, 'thread');
  await fresh.bridge.send(fresh.principal('bob'), { text: 'bob reply' }, new AbortController().signal);
  assert.equal(fresh.sent[1].to, '456');
  // The next sender replaces the persisted route again, without a client reconnect.
  fresh.receive({ originatingTo: '789' }, { SenderId: 'new-sender', MessageSid: '4' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).routes.alice.to, '789');
  await fresh.bridge.send(fresh.principal(), { text: 'latest reply' }, new AbortController().signal);
  assert.equal(fresh.sent[2].to, '789');
});
test('a routing change while stopped cannot restore obsolete destinations', async () => {
  const f = await fixture(); f.receive();
  await f.captured.service.stop();
  const fresh = await fixture({ stateDir: f.stateDir, skipStart: true });
  fresh.config().bindings = [{ agentId: 'bob', match: { channel: 'telegram' } }];
  await fresh.captured.service.start();
  await assert.rejects(fresh.bridge.send(fresh.principal(), { text: 'reply' }, new AbortController().signal), /no_return_route/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateDir, ID, 'routes.json'), 'utf8')).routes, {});
});
test('disabled plugin releases dispatch and broken diagnostics cannot release a selected turn', async () => {
  const f = await fixture({ logger: { warn() { throw Error('logger failed'); } } });
  f.config().plugins.entries[ID].enabled = false;
  assert.equal(f.receive(), undefined);
  f.config().plugins.entries[ID].enabled = true;
  f.host.getSessionEntry = () => { throw Error('read failure'); };
  assert.equal(f.receive().handled, true);
});
