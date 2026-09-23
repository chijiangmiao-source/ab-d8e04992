// verify：单次校验编排（供 docker compose 的 verify 服务使用）。
// 顺序：
//   1) 代码测试（含反向互补自冲突、任意精度同优计数、必选/可选/从不选边界、
//      2^k 暴力穷举随机交叉验证、Worker 协议与取消/迟到裁决）
//   2) 构建检查（语法、资源引用、ESM import 图、容器文件齐备）
//   3) HTTP 冒烟（自带临时服务器：/health、静态资源、穿越防护、404）
// 任一步失败立即以其退出码终止；全部成功退出 0。

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { name: '代码测试', cmd: [process.execPath, '--test', 'test/audit.test.js', 'test/boundary.test.js', 'test/random.test.js', 'test/worker.test.js', 'test/browser.test.js'] },
  { name: '构建检查', cmd: ['npm', 'run', 'build'] },
  { name: 'HTTP 冒烟', cmd: ['npm', 'run', 'smoke'] },
];

function run(step) {
  return new Promise((resolvePromise) => {
    console.log(`\n=== ${step.name} ===`);
    const child = spawn(step.cmd[0], step.cmd.slice(1), {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: step.cmd[0] === 'npm' ? true : false,
    });
    child.on('exit', (code) => resolvePromise(code ?? 1));
    child.on('error', () => resolvePromise(1));
  });
}

for (const step of steps) {
  const code = await run(step);
  if (code !== 0) {
    console.error(`\nverify 失败于「${step.name}」，退出码 ${code}`);
    process.exit(code);
  }
}
console.log('\nverify 全部通过：测试 ✓ 构建 ✓ 冒烟 ✓');
process.exit(0);
