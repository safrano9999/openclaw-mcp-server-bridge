import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { ID } from '../src/state.js';
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
test('outbound preserves original account, topic and owner; consumes do not remove route grants', async () => {
  const f = await fixture();
  f.receive({ originatingThreadId: 42 });
  const message = f.bridge.mailbox(f.principal()).consume().messages[0];
  await assert.rejects(f.bridge.send(f.principal('bob'), { text: 'no', route_id: message.route_id }, new AbortController().signal), /unknown_or_expired/);
  const result = await f.bridge.send(f.principal(), { text: 'reply', route_id: message.route_id }, new AbortController().signal);
  assert.equal(result.status, 'sent');
  assert.equal(f.sent[0].accountId, 'bot-a'); assert.equal(f.sent[0].threadId, 42); assert.equal(f.sent[0].to, '123');
  assert.equal(f.sent[0].session.agentId, 'alice');
  assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
});
test('removal, token changes, routing changes and session reset revoke access', async () => {
  const f = await fixture(); f.receive();
  const p = f.principal();
  f.config().plugins.entries[ID].config.credentials.alice = 'x'.repeat(43);
  assert.throws(() => f.bridge.mailbox(p), /credential_revoked/);
  f.config().bindings = [{ agentId: 'bob', match: { channel: 'telegram' } }];
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /unknown_or_expired/);
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
test('restart clears queues and route grants but preserves managed credentials', async () => {
  const f = await fixture(); f.receive(); const token = f.header();
  await f.captured.service.stop(); await f.captured.service.start();
  assert.equal(f.header(), token); assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
  await assert.rejects(f.bridge.send(f.principal(), { text: 'reply' }, new AbortController().signal), /unknown_or_expired/);
});
