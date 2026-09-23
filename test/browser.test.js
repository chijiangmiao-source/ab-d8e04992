// 最小 DOM 垫片 + 真实 worker_threads，端到端驱动未经修改的 public/app.js：
// 模拟点击“填入示例 → 启动审计 → 渲染”、取消、非法输入三类路径。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shimPath = join(here, 'helpers', 'worker-shim.js');

function makeEl(id) {
  const listeners = new Map();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    children: [],
    style: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
  };
}

const els = {};
const ids = ['threshold', 'records', 'runBtn', 'cancelBtn', 'sampleBtn', 'clearBtn',
  'statusLine', 'summary', 'mutexList', 'mutexSummary'];
for (const id of ids) els[id] = makeEl(id);
const tbody = makeEl('tbody');

// 浏览器 Worker 垫片：URL 参数忽略，统一加载与浏览器同构的 worker 模块
class FakeWorker {
  constructor() {
    this.inner = new NodeWorker(shimPath);
    after(() => this.terminate());
  }
  set onmessage(fn) {
    this.inner.on('message', (data) => fn({ data }));
  }
  set onerror(fn) {
    this.inner.on('error', (err) => fn({ message: String(err && err.message || err) }));
  }
  postMessage(msg) { this.inner.postMessage(msg); }
  terminate() { this.inner.terminate(); }
}

globalThis.document = {
  getElementById: (id) => els[id],
  querySelector: () => tbody,
  createElement: (tag) => makeEl(`created:${tag}`),
};
globalThis.Worker = FakeWorker;

await import('../public/app.js');

test('页面接线：填入示例 → 启动 → 渲染最近成功结论', async () => {
  els.sampleBtn.dispatch('click');
  assert.match(els.records.value, /ATGATGAC/);
  assert.equal(els.threshold.value, '3');

  els.runBtn.dispatch('click');
  assert.equal(els.runBtn.disabled, true);
  assert.equal(els.cancelBtn.disabled, false);
  assert.match(els.statusLine.textContent, /进行中/);

  // 等待 worker 真实回包并被 app.js 处理
  await new Promise((resolve) => {
    const tick = () => {
      if (!els.runBtn.disabled) return resolve();
      setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  });

  assert.match(els.statusLine.textContent, /完成/);
  // 汇总区被填充：含同优方案数（示例为 2）与位向量
  const summaryText = collectText(els.summary);
  assert.match(summaryText, /最优优先权总和/);
  assert.match(summaryText, /同优方案数/);
  assert.match(summaryText, /位向量/);
  assert.match(summaryText, /2/);
  // 表格 10 行
  assert.equal(tbody.children.length, 10);
  // 必选/可选/从不选三类都出现（示例 #4/#5 可选、#3 自冲突从不选）
  const tableText = collectText(tbody);
  assert.match(tableText, /必选/);
  assert.match(tableText, /可选/);
  assert.match(tableText, /从不选/);
  assert.match(tableText, /自反互补冲突/);
});

test('页面接线：非法输入不启动任务且不覆盖结论', () => {
  els.records.value = 'BAD INPUT';
  els.runBtn.dispatch('click');
  assert.equal(els.runBtn.disabled, false);
  assert.match(els.statusLine.textContent, /条码|格式/);
  // 结论仍在（汇总仍有内容）
  assert.ok(collectText(els.summary).length > 0);
});

test('页面接线：格式正确但条数不足（<10）在主线程预校验即被拦截', () => {
  els.threshold.value = '3';
  els.records.value = 'AAAAAAAA 1\nCCCCCCCC 2\n';
  els.runBtn.dispatch('click');
  // 不进入运行态
  assert.equal(els.runBtn.disabled, false);
  assert.equal(els.cancelBtn.disabled, true);
  assert.match(els.statusLine.textContent, /10/);
  assert.match(els.statusLine.className, /error/);
});

test('页面接线：取消后状态复位并保留结论', () => {
  els.sampleBtn.dispatch('click');
  els.runBtn.dispatch('click');
  assert.equal(els.runBtn.disabled, true);
  els.cancelBtn.dispatch('click');
  assert.equal(els.runBtn.disabled, false);
  assert.equal(els.cancelBtn.disabled, true);
  assert.match(els.statusLine.textContent, /已取消/);
  // 此前成功结论未被清空
  assert.ok(collectText(els.summary).length > 0);
});

function collectText(el) {
  let out = el.textContent || '';
  for (const c of el.children || []) out += '\n' + collectText(c);
  return out;
}
