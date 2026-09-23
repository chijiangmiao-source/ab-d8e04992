// HTTP 冒烟测试：启动静态服务器，验证 /health、首页、静态资源、
// 路径穿越防护与 404；若服务器已在运行（如容器内先启动）则直接测。
// 目标基址由环境变量 SMOKE_BASE_URL 或 PORT（默认 8080）决定。

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 默认让操作系统分配空闲端口；从服务器启动日志读取实际端口，
// 避免端口被占用时误测到外部旧服务。可用 PORT 固定、SMOKE_BASE_URL 直连已运行服务。
const FIXED_PORT = process.env.PORT || '';
let baseUrl = process.env.SMOKE_BASE_URL || '';

const checks = [];
let serverProc = null;

function fetchText(url, options = {}) {
  return new Promise((resolvePromise) => {
    const req = request(url, { method: options.method || 'GET', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (err) => resolvePromise({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolvePromise({ error: 'timeout' }); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function check(name, cond, detail = '') {
  checks.push({ name, cond: Boolean(cond), detail });
}

/** 派生临时服务器（PORT=0 → 系统分配端口），从日志解析实际端口。 */
async function spawnServer() {
  const usePort = FIXED_PORT || '0';
  const proc = spawn(process.execPath, [resolve(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: usePort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolvePort, rejectPort) => {
    let buf = '';
    const timer = setTimeout(() => rejectPort(new Error('等待服务器端口超时')), 8000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolvePort(Number(m[1])); }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('error', (err) => { clearTimeout(timer); rejectPort(err); });
    proc.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM') {
        clearTimeout(timer);
        rejectPort(new Error(`服务器提前退出 code=${code} signal=${signal}`));
      }
    });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function main() {
  if (baseUrl) {
    console.log(`使用已运行服务器 ${baseUrl} …`);
  } else {
    const spawned = await spawnServer();
    serverProc = spawned.proc;
    baseUrl = spawned.base;
    console.log(`已启动临时服务器 ${baseUrl}`);
  }

  // /health
  const health = await fetchText(`${baseUrl}/health`);
  check('/health 返回 200', health.status === 200, `got ${health.status}`);
  let healthJson = null;
  try { healthJson = JSON.parse(health.body); } catch { /* below */ }
  check('/health 返回 ok JSON', healthJson && healthJson.status === 'ok', health.body.slice(0, 120));
  check('/health 含 service 字段', healthJson && healthJson.service === 'barcode-audit');

  // 首页
  const index = await fetchText(`${baseUrl}/`);
  check('/ 返回 200', index.status === 200, `got ${index.status}`);
  check('/ 为 HTML（含标题与模块脚本）',
    /条码子库审计/.test(index.body) && /type="module"/.test(index.body) && /app\.js/.test(index.body));

  // 静态资源
  for (const asset of ['/app.js', '/audit.js', '/dispatcher.js', '/worker.js', '/styles.css']) {
    const r = await fetchText(`${baseUrl}${asset}`);
    check(`${asset} 200`, r.status === 200, `got ${r.status}`);
    if (asset.endsWith('.js')) {
      check(`${asset} 正确 MIME`, /javascript/.test(r.headers['content-type']),
        r.headers['content-type']);
    }
  }

  // Worker 模块也可被浏览器以 module worker 加载（内容存在即可）
  const worker = await fetchText(`${baseUrl}/worker.js`);
  check('/worker.js 含审计逻辑', /onmessage/.test(worker.body) && /audit\(/.test(worker.body));

  // 路径穿越
  const traversal = await fetchText(`${baseUrl}/../package.json`);
  check('路径穿越被拦截（403/404，绝不 200）',
    traversal.status === 403 || traversal.status === 404, `got ${traversal.status}`);
  const encoded = await fetchText(`${baseUrl}/%2e%2e/package.json`);
  check('编码穿越被拦截', encoded.status === 403 || encoded.status === 404, `got ${encoded.status}`);

  // 畸形百分号编码：应返回 4xx 而非让进程崩溃
  const malformed = await fetchText(`${baseUrl}/%E0%A4%A`);
  check('畸形百分号编码返回 4xx', malformed.status >= 400 && malformed.status < 500, `got ${malformed.status}`);

  // 404
  const nf = await fetchText(`${baseUrl}/nope-404`);
  check('未知无扩展名路由回退首页（SPA）或 404', nf.status === 200 || nf.status === 404);
  const nfAsset = await fetchText(`${baseUrl}/missing.js`);
  check('缺失静态资源 404', nfAsset.status === 404, `got ${nfAsset.status}`);

  // HEAD
  const head = await fetchText(`${baseUrl}/health`, { method: 'HEAD' });
  check('HEAD /health 可达', head.status === 200);

  report();
}

function report() {
  console.log('');
  for (const c of checks) {
    console.log(`${c.cond ? '✓' : '✗'} ${c.name}${c.cond || !c.detail ? '' : ` —— ${c.detail}`}`);
  }
  const failed = checks.filter((c) => !c.cond);
  console.log(`\n冒烟结果：${checks.length - failed.length}/${checks.length} 通过`);
  serviceCleanup();
  process.exit(failed.length === 0 ? 0 : 1);
}

function serviceCleanup() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

process.on('exit', serviceCleanup);
main().catch((err) => {
  console.error('冒烟脚本异常：', err);
  serviceCleanup();
  process.exit(1);
});
