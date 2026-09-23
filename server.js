// 零依赖静态服务器：托管 public/，暴露 /health 供容器健康检查与冒烟测试。
// 端口由环境变量 PORT 配置（默认 8080），HOST 默认 0.0.0.0。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'bad request uri' });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'barcode-audit',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // 路径穿越防护：规范化后必须仍位于 PUBLIC_DIR 内
  const normalizedRel = normalize(pathname.slice(1));
  const rel = (!normalizedRel || normalizedRel === '.') ? 'index.html' : normalizedRel;
  const filePath = join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      // 不开放目录列举
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    // SPA 式回退仅对无扩展名路由返回首页；静态资源缺失返回 404
    if (extname(filePath) === '') {
      try {
        const index = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': index.length });
        res.end(index);
        return;
      } catch { /* fall through */ }
    }
    sendJson(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  console.log(`barcode-audit listening on http://${HOST}:${actualPort} (serving ${PUBLIC_DIR})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    // 兜底：连接保持时也退出
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
