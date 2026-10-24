import { readFileSync } from 'node:fs';
import { PATH } from './state.js';

export const ICON_PATH = `${PATH}/favicon.jpeg`;
const icon = readFileSync(new URL('../assets/favicon.jpeg', import.meta.url));
const page = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw MCP Bridge</title><meta name="description" content="One MCP endpoint for your OpenClaw channels.">
<link rel="icon" type="image/jpeg" href="${ICON_PATH}"><link rel="apple-touch-icon" href="${ICON_PATH}">
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101d20;color:#f5f0e6}
*{box-sizing:border-box}body{min-height:100svh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top,#274b4b,transparent 65%)}
main{width:min(100%,540px);padding:clamp(28px,7vw,56px);border:1px solid #91b1a633;border-radius:28px;background:#142326e8;box-shadow:0 24px 80px #0004}
img{display:block;width:112px;height:112px;border-radius:24px;margin-bottom:32px;box-shadow:0 12px 30px #0005}
.eyebrow{color:#c5b887;letter-spacing:.16em;font-size:.72rem;font-weight:700;text-transform:uppercase}
h1{font-size:clamp(2rem,8vw,2.8rem);letter-spacing:-.04em;line-height:1.1;margin:12px 0 20px}
p{line-height:1.65;color:#c2d0cb;margin:0 0 20px}code{display:block;padding:16px 20px;border-radius:12px;background:#0b171a;color:#a4dfcd;font-size:1.1rem;border:1px solid #91b1a622}
footer{margin-top:24px;font-size:.8rem;color:#8da8a1;line-height:1.6}
</style></head><body><main><img src="${ICON_PATH}" width="112" height="112" alt="Portrait holding two red lobsters">
<span class="eyebrow">OpenClaw · MCP Bridge</span><h1>Your channels.<br>One connection.</h1>
<p>You’re in the right place. Give this page’s URL to your MCP client and connect with your assigned Bearer token.</p>
<code>${PATH}</code><footer>Streamable HTTP · Bearer authentication<br>Messages and replies across your connected channels.</footer>
</main></body></html>`);

export function serveBrowser(req, res) {
  const path = (req.url ?? '').split('?')[0];
  const favicon = path === ICON_PATH;
  const browser = path === PATH && /(?:^|,)\s*text\/html(?:\s*;|,|$)/i.test(req.headers.accept ?? '');
  if (!favicon && !browser) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!favicon) return false;
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
  }
  const body = favicon ? icon : page;
  res.writeHead(200, {
    'content-type': favicon ? 'image/jpeg' : 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': favicon ? 'public, max-age=86400' : 'no-store',
    'x-content-type-options': 'nosniff',
    ...(favicon ? {} : { Vary: 'Accept', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" }),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
