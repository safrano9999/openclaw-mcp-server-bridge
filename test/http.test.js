
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from './fixture.js';
async function listen(t) {
 const f=await fixture();
 const server=createServer((req,res)=>{void f.captured.route.handler(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {...f,url:new URL('http://127.0.0.1:'+server.address().port+'/mcp')};
}
test('real MCP discovery, per-agent consumption and default native send',async t=>{
 const f=await listen(t); f.receive();
 const c=new Client({name:'test',version:'1'});
 await c.connect(new StreamableHTTPClientTransport(f.url,{requestInit:{headers:{Authorization:f.header()}}}));
 t.after(()=>c.close());
 const tools=(await c.listTools()).tools.map(t=>t.name);
 for(const name of ['new_message','pending_count','send_message']) assert(tools.includes(name));
 assert.equal((await c.callTool({name:'pending_count',arguments:{agent:'bob'}})).structuredContent.pending,0);
 assert.equal((await c.callTool({name:'new_message',arguments:{}})).structuredContent.messages[0].text,'hello');
 assert.equal((await c.callTool({name:'send_message',arguments:{text:'hello'}})).structuredContent.status,'sent');
 assert.equal(f.sent[0].to,'123');
});
test('HTTP rejects missing credentials, foreign origins and malformed bodies',async t=>{
 const f=await listen(t);
 assert.equal((await fetch(f.url)).status,401);
 const headers={Authorization:f.header(),'content-type':'application/json',Accept:'application/json, text/event-stream'};
 const post=(body,h=headers)=>fetch(f.url,{method:'POST',headers:h,body});
 assert.equal((await fetch(f.url,{headers})).status,405);
 assert.equal((await post('{}',{...headers,Origin:'https://evil.example'})).status,403);
 assert.equal((await post('x'.repeat(10*1024*1024+1))).status,413);
 assert.equal((await post('bad json')).status,400);
 assert.equal((await post('[]')).status,400);
});
test('browser landing and favicon are public; MCP requests still require the assigned bearer', async t => {
  const f = await listen(t);
  assert.deepEqual(f.captured.routes.map(r => r.path).sort(), ['/mcp', '/mcp/direct', '/mcp/favicon.jpeg']);
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

test('direct text uses defaults; OwnTracks selects its agent; bearer can be absent',async t=>{
 const f=await listen(t),url=new URL('/mcp/direct',f.url);
 const conf=f.config().plugins.entries['openclaw-mcp-server-bridge'].config;
 const post=(body,token=f.header())=>fetch(url,{method:'POST',headers:{
  ...(token?{Authorization:token}:{}),'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post({text:'off'})).status,404);
 conf.direct=true;
 assert.equal((await post({text:'wrong'},'Bearer invalid')).status,401);
 assert.equal((await post({text:'unknown',to:'bad'})).status,400);
 assert.equal((await post({text:'default'})).status,200);
 assert.equal(f.sent.at(-1).to,'123');
 conf.directFifo=true;
 assert.equal((await post({text:'coordinates',agent:'bob',event_id:'one',payload:{lat:52}})).status,200);
 assert.equal(f.sent.at(-1).accountId,'bot-b');
 assert.equal(f.bridge.mailbox(f.principal(),{agent:'bob'}).count().pending,1);
 assert.equal((await post({text:'coordinates',agent:'bob',event_id:'one'})).status,200);
 assert.equal(f.bridge.mailbox(f.principal(),{agent:'bob'}).count().pending,1);
 conf.bearer='';
 assert.equal((await post({text:'open'},null)).status,200);
});
