import http from 'node:http';

const pending = new Set();

/** @type {Array<{method: string, path: string, headers: http.IncomingHttpHeaders, body: unknown}>} */
const requests = [];
let mode = 'success';
let redeemed = false;
const jwt = () => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'mock-account' } })).toString('base64url')}.fake`;
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : null;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/control' && req.method === 'POST') {
    mode = body.mode;
    requests.length = 0;
    res.end('{}');
    return;
  }
  if (req.url === '/release') {
    for (const held of pending) held.end('{}');
    pending.clear();
    res.end('{}');
    return;
  }
  if (req.url === '/requests') { res.end(JSON.stringify(requests)); return; }
  requests.push({ method: req.method, path: req.url, headers: req.headers, body });
  if (body?.input === 'hold') {
    pending.add(res);
    res.on('close', () => pending.delete(res));
  } else if (body?.input === 'large-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let count = 0;
    const chunk = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(16384) })}\n\n`;
    const pump = () => {
      while (!res.destroyed && count < 1024) {
        count++;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      if (!res.destroyed) res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
    };
    pump();
  } else if (req.url === '/oauth/token') {
    res.end(JSON.stringify({ access_token: jwt(), refresh_token: 'refreshed-token', expires_in: 3600 }));
  } else if (req.url === '/backend-api/wham/usage') {
    res.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: redeemed ? 10 : 99, reset_after_seconds: 3600 } }, rate_limit_reset_credits: { available_count: redeemed ? 0 : 1 } }));
  } else if (req.url === '/backend-api/wham/rate-limit-reset-credits/consume') {
    redeemed = true;
    res.end(JSON.stringify({ code: 'reset' }));
  } else if (mode === 'all429' || (mode === 'rotate' && req.headers.authorization === 'Bearer first-key')) {
    res.writeHead(429, { 'retry-after': '60' });
    res.end(JSON.stringify({ error: { message: 'mock quota exhausted' } }));
  } else if (mode === 'reject' && req.headers.authorization === 'Bearer first-key') {
    res.writeHead(401);
    res.end(JSON.stringify({ error: { message: 'mock rejected credential' } }));
  } else if (body?.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '900' });
    res.write('data:{"type":"response.output_text.delta","delta":"hello"}\r\n\r\n');
    res.end('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\r\n\r\n');
  } else {
    res.end(JSON.stringify({ id: 'mock-response', output: 'hello', usage: { input_tokens: 7, output_tokens: 3 } }));
  }
}).listen(8080, '0.0.0.0');
