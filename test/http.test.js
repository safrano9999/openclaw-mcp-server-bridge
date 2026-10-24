import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from './fixture.js';
async function listen(t) {
  const f = await fixture();
  const server = createServer((req, res) => { void f.captured.route.handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/telegram-mcp`);
  return { ...f, url };
}
test('real MCP initialize, tool discovery, isolation, consumption, reconnect and native send', async t => {
  const f = await listen(t); f.receive({ originatingThreadId: 99 });
  const connect = async (id = 'alice') => {
    const client = new Client({ name: 'bridge-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(f.url, { requestInit: { headers: { Authorization: f.header(id) } } }));
    t.after(() => client.close()); return client;
  };
  const alice = await connect(); const bob = await connect('bob');
  assert.deepEqual((await alice.listTools()).tools.map(t => t.name).sort(), ['new_message', 'pending_count', 'send_message']);
  assert.equal((await bob.callTool({ name: 'pending_count', arguments: {} })).structuredContent.pending, 0);
  const message = (await alice.callTool({ name: 'new_message', arguments: {} })).structuredContent.messages[0];
  assert.equal(message.text, 'hello');
  const stolen = await bob.callTool({ name: 'send_message', arguments: { route_id: message.route_id, text: 'wrong' } });
  assert.equal(stolen.isError, true);
  const sent = await alice.callTool({ name: 'send_message', arguments: { route_id: message.route_id, text: 'right' } });
  assert.equal(sent.structuredContent.status, 'sent'); assert.equal(f.sent[0].threadId, 99);
  await alice.close(); f.receive({}, { MessageSid: '2' });
  const again = await connect();
  assert.equal((await again.callTool({ name: 'pending_count', arguments: {} })).structuredContent.pending, 1);
});
test('HTTP auth, Origin, methods, content type, size and malformed input checks', async t => {
  const f = await listen(t);
  assert.equal((await fetch(f.url)).status, 401);
  const headers = { Authorization: f.header(), 'content-type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(f.url, { headers })).status, 405);
  assert.equal((await fetch(f.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: 'x'.repeat(131073) })).status, 413);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: 'bad json' })).status, 400);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: '[]' })).status, 400);
});
