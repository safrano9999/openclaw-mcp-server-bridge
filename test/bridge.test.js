
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { ID } from '../src/state.js';
const signal = () => new AbortController().signal;
test('omitted and explicit defaults resolve the same main session and bound account', async () => {
  const f = await fixture();
  for (const args of [{}, {agent:'default',session:'default',channel:'default',accountId:'default',target:'default'}]) {
    assert.equal((await f.bridge.send(f.principal(), {text:'hello',...args}, signal())).status, 'sent');
    const sent = f.sent.at(-1);
    assert.equal(sent.channel, 'telegram'); assert.equal(sent.accountId, 'bot-a'); assert.equal(sent.to, '123');
    assert.equal(sent.session.sessionKey, 'agent:alice:main');
  }
});
test('explicit agent uses its binding and cannot address another agent session', async () => {
  const f = await fixture();
  await f.bridge.send(f.principal(), {text:'coordinates',agent:'bob'}, signal());
  assert.equal(f.sent[0].accountId, 'bot-b'); assert.equal(f.sent[0].to, '456');
  await assert.rejects(f.bridge.send(f.principal(), {text:'wrong',agent:'bob',session:'agent:alice:main'}, signal()), /session_agent_mismatch/);
});
test('ambiguous channels require preference; another last channel cannot change default', async () => {
  const f = await fixture();
  f.config().bindings.push({agentId:'alice',match:{channel:'discord',accountId:'discord-bot'}});
  await assert.rejects(f.bridge.send(f.principal(), {text:'ambiguous'}, signal()), /ambiguous_default_channel/);
  f.config().plugins.entries[ID].config.defaultChannel = 'telegram';
  f.host.getSessionEntry = () => ({sessionId:'s',deliveryContext:{channel:'discord',accountId:'discord-bot',to:'room'}});
  await assert.rejects(f.bridge.send(f.principal(), {text:'no telegram recipient'}, signal()), /no_default_target/);
  await f.bridge.send(f.principal(), {text:'explicit last',channel:'last'}, signal());
  assert.equal(f.sent[0].channel,'discord');
  await f.bridge.send(f.principal(), {text:'explicit target',target:'123'}, signal());
  assert.equal(f.sent[1].channel,'telegram');
});
test('peer binding supports delivery before first inbound message', async () => {
  const f = await fixture({host:{getSessionEntry:()=>undefined}});
  f.config().bindings[0].match.peer={kind:'direct',id:'peer-1'};
  await f.bridge.send(f.principal(),{text:'hello'},signal());
  assert.equal(f.sent[0].to,'peer-1');
});
test('inbound queues are agent selected and do not suppress normal replies', async () => {
  const f=await fixture();
  assert.equal(f.receive(),undefined);
  assert.equal(f.bridge.mailbox(f.principal()).count().pending,1);
  assert.equal(f.bridge.mailbox(f.principal(),{agent:'bob'}).count().pending,0);
  f.receive({}, {InboundAccessAuthorized:false,MessageSid:'2'});
  assert.equal(f.bridge.mailbox(f.principal()).count().pending,1);
});
test('fresh send policy and credentials are checked before delivery', async () => {
  const f=await fixture(); const principal=f.principal();
  f.config().plugins.entries[ID].config.bearer='b'.repeat(64);
  assert.throws(()=>f.bridge.mailbox(principal),/credential_revoked/);
  f.host.resolveSendPolicy=()=> 'deny';
  await assert.rejects(f.bridge.send(f.principal(),{text:'blocked'},signal()),/send_policy_denied/);
  assert.equal(f.sent.length,0);
});
test('changed route at platform handoff is rejected', async () => {
  const f=await fixture();
  f.host.sendDurableMessageBatch=async params=>{
    f.host.getSessionEntry=()=>({sessionId:'changed',deliveryContext:{channel:'telegram',accountId:'bot-a',to:'different'}});
    params.onPlatformSendDispatch();
  };
  await assert.rejects(f.bridge.send(f.principal(),{text:'race'},signal()),/route_revoked/);
});
test('uncertain and partial sends are never retried automatically', async () => {
  const f=await fixture();
  for(const status of ['partial_failed','suppressed','failed']) {
    let calls=0; f.host.sendDurableMessageBatch=async()=>{calls++;return {status,results:[]};};
    const r=await f.bridge.send(f.principal(),{text:'once'},signal());
    assert.equal(r.retry_safe,false); assert.equal(calls,1);
  }
});
test('restart clears queues and keeps configured default delivery usable', async () => {
  const f=await fixture();f.receive();
  await f.captured.service.stop();await f.captured.service.start();
  assert.equal(f.bridge.mailbox(f.principal()).count().pending,0);
  assert.equal((await f.bridge.send(f.principal(),{text:'restarted'},signal())).status,'sent');
});
