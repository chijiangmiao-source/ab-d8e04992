// 构建检查（无打包步骤的原生 ESM 静态站点）：
//   1. 对全部 JS 做语法解析（node --check）
//   2. 校验 HTML 引用与 ESM import 图中的本地文件均存在
//   3. 校验 public 资源齐备
// 任一失败以非零退出码结束。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');

const errors = [];
const note = (msg) => console.log(`  · ${msg}`);

function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listJs(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// 1) 语法检查
const targets = [
  ...listJs(publicDir),
  join(root, 'server.js'),
  ...listJs(join(root, 'scripts')),
  ...listJs(join(root, 'test')),
];
console.log(`语法检查：${targets.length} 个 JS 文件`);
for (const file of targets) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    errors.push(`语法错误 ${file}:\n${r.stderr || r.stdout}`);
  }
}
note(`node --check 全部通过`);

// 2) HTML 引用
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
for (const ref of ['app.js', 'styles.css']) {
  const re = new RegExp(`(?:src|href)=["']\\.?/?${ref}["']`);
  if (!re.test(html)) errors.push(`index.html 缺少对 ${ref} 的引用`);
}
// worker.js 由 app.js 以 module worker 动态加载
if (!readFileSync(join(publicDir, 'app.js'), 'utf8').includes("new Worker('./worker.js'")) {
  errors.push('app.js 未以预期方式加载 worker.js');
}
for (const f of ['app.js', 'styles.css', 'worker.js', 'audit.js', 'dispatcher.js']) {
  if (!existsSync(join(publicDir, f))) errors.push(`缺少文件 public/${f}`);
}
note('index.html / worker 资源引用齐备');

// 3) ESM 本地 import 图
const importRe = /from\s+['"](\.[^'"]+)['"]/g;
function checkImports(file, seen = new Set()) {
  const rel = file.replace(root + '/', '');
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const resolved = resolve(dirname(file), m[1]);
    if (!existsSync(resolved)) {
      errors.push(`${rel} 引用了不存在的模块 ${m[1]}`);
      continue;
    }
    if (resolved.endsWith('.js') && resolved.startsWith(publicDir)) {
      checkImports(resolved, seen);
    }
  }
}
checkImports(join(publicDir, 'app.js'));
checkImports(join(publicDir, 'worker.js'));
note('ESM import 图可解析');

// 4) 必需文件
for (const f of ['Dockerfile', 'docker-compose.yml', 'server.js', 'package.json']) {
  if (!existsSync(join(root, f))) errors.push(`缺少 ${f}`);
}

if (errors.length > 0) {
  console.error('\n构建检查失败：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\n构建检查通过。');
