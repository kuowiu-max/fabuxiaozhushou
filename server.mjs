import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeInput, buildMessages, templateDraft, validateDraft } from './public/draft.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const providers = {
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', key: 'DEEPSEEK_API_KEY', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY', model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }
};
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/zip.js', ['zip.js', 'text/javascript; charset=utf-8']],
  ['/draft.mjs', ['draft.mjs', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

export function createServer({ fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/api/status') {
        send(200, { providers: Object.entries(providers).filter(([, p]) => !!process.env[p.key]).map(([id, p]) => ({ id, model: p.model })) });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/generate') {
        // Requests must come from the same site. Do not expose the configured AI key to other origins.
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') {
          send(403, { error: '请从本工具页面生成文案。' }); return;
        }
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          send(415, { error: '请求格式需为 JSON。' }); return;
        }
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 100_000) { send(413, { error: '资料太长，请减少文字后重试。' }); return; }
          chunks.push(chunk);
        }
        let raw;
        try { raw = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { send(400, { error: '请求资料格式错误。' }); return; }
        let input;
        try { input = normalizeInput(raw); }
        catch (error) { send(400, { error: error.message }); return; }
        if (!raw.provider || raw.provider === 'template') { send(200, templateDraft(input)); return; }
        const provider = providers[raw.provider];
        if (!provider || !process.env[provider.key]) { send(503, { error: '该 AI 接口尚未配置。可选择资料模板，或复制提示词到 AI 软件。' }); return; }
        let response;
        try {
          response = await fetchImpl(provider.endpoint, {
            method: 'POST', headers: { Authorization: `Bearer ${process.env[provider.key]}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: provider.model, messages: buildMessages(input), response_format: { type: 'json_object' }, max_tokens: 2200 }),
            signal: AbortSignal.timeout(45_000)
          });
        } catch { send(502, { error: '暂时无法连接 AI 服务，请稍后重试或使用资料模板。' }); return; }
        if (!response.ok) {
          send(502, { error: response.status === 429 ? 'AI 服务限流或额度不足，请稍后重试。' : `AI 服务请求失败（${response.status}），请检查服务端配置。` }); return;
        }
        try {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          const draft = validateDraft(JSON.parse(content));
          send(200, { ...draft, provider: raw.provider });
        } catch { send(502, { error: 'AI 返回的文案格式不完整，请重试。' }); }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: '不支持的请求方式。' }); return; }
      const file = staticFiles.get(pathname);
      if (!file) { send(404, { error: '页面不存在。' }); return; }
      const body = await readFile(path.join(root, file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { if (!res.headersSent) send(500, { error: '服务暂时不可用，请重试。' }); else res.end(); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`发布小助手运行于 http://${host}:${port}`));
}
