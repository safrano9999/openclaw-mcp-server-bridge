import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from './fixture.js';
async function listen(t) {
  const f = await fixture();
  const server = createServer((req, res) => { void f.captured.route.handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  return { ...f, url };
}
test('real MCP initialize, tool discovery, isolation, consumption, reconnect and native send', async t => {
  const f = await listen(t); f.receive({ originatingThreadId: 99, suppressUserDelivery: true, sourceReplyDeliveryMode: 'message_tool_only' });
  const connect = async (id = 'alice') => {
    const client = new Client({ name: 'bridge-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(f.url, { requestInit: { headers: { Authorization: f.header(id) } } }));
    t.after(() => client.close()); return client;
  };
  const alice = await connect(); const bob = await connect('bob');
  assert.deepEqual((await alice.listTools()).tools.map(t => t.name).sort(), ['new_message', 'pending_count', 'send_message']);
  assert.deepEqual(Object.keys((await alice.listTools()).tools.find(t => t.name === 'send_message').inputSchema.properties), ['text']);
  assert.equal((await bob.callTool({ name: 'pending_count', arguments: {} })).structuredContent.pending, 0);
  const message = (await alice.callTool({ name: 'new_message', arguments: {} })).structuredContent.messages[0];
  assert.equal(message.text, 'hello');
  const stolen = await bob.callTool({ name: 'send_message', arguments: { text: 'wrong' } });
  assert.equal(stolen.isError, true);
  const sent = await alice.callTool({ name: 'send_message', arguments: { text: 'right' } });
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
test('browser landing and favicon are public; MCP requests still require the assigned bearer', async t => {
  const f = await listen(t);
  assert.deepEqual(f.captured.routes.map(r => r.path).sort(), ['/mcp', '/mcp/favicon.jpeg']);
  const page = await fetch(f.url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /<title>OpenClaw MCP Bridge<\/title>/);
  assert.match(html, /rel="icon" type="image\/jpeg" href="\/mcp\/favicon.jpeg"/);
  assert.ok(!html.includes('telegram-mcp'));
  assert.ok(!html.includes(f.header().slice(7)));
  const head = await fetch(f.url, { method: 'HEAD', headers: { Accept: 'text/html' } });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const iconUrl = new URL('/mcp/favicon.jpeg', f.url);
  const icon = await fetch(iconUrl);
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), await readFile(new URL('../assets/favicon.jpeg', import.meta.url)));
  assert.equal((await fetch(iconUrl, { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.url, { headers: { Accept: 'application/json, text/event-stream' } })).status, 401);
  assert.equal((await fetch(f.url, { method: 'POST', headers: { Accept: 'text/html' }, body: '{}' })).status, 401);
  assert.equal(f.bridge.mailbox(f.principal()).count().pending, 0);
});
