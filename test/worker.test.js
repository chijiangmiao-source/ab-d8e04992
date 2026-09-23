// Worker 端到端协议测试：经 worker_threads 加载未经修改的 public/worker.js，
// 校验成功结果（BigInt 十进制字符串）、非法输入错误、以及重复任务。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunState } from '../public/dispatcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const shimPath = join(here, 'helpers', 'worker-shim.js');

function spawn() {
  const w = new Worker(shimPath);
  after(() => w.terminate().catch(() => {}));
  return w;
}

function roundtrip(worker, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker 响应超时')), 15000);
    worker.once('message', (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    worker.once('error', reject);
    worker.postMessage(msg);
  });
}

function validPayload(id = 1) {
  return {
    type: 'run',
    id,
    threshold: 3,
    records: [
      'AAAAAAAA 10', 'AAAAAAAC 9', 'AAAAAACA 8', 'AAAAACAA 7',
      'AAAACAAA 6', 'AAACAAAA 5', 'AACAAAAA 4', 'ACAAAAAA 3',
      'CAAAAAAA 2', 'AAAAAACG 1',
    ].map((line) => {
      const [barcode, priorityText] = line.split(' ');
      return { barcode, priorityText };
    }),
  };
}

test('Worker 成功返回可结构化克隆的结果（BigInt 为十进制字符串）', async () => {
  const w = spawn();
  const reply = await roundtrip(w, validPayload(1));
  assert.equal(reply.type, 'result');
  assert.equal(reply.id, 1);
  assert.equal(reply.status, 'ok');
  const d = reply.data;
  assert.equal(d.n, 10);
  assert.equal(d.threshold, 3);
  assert.equal(typeof d.bestWeight, 'string');
  assert.equal(typeof d.tieCount, 'string');
  assert.match(d.bestWeight, /^\d+$/);
  assert.match(d.tieCount, /^\d+$/);
  assert.equal(d.bitVector.length, 10);
  assert.match(d.bitVector, /^[01]{10}$/);
  assert.equal(d.rows.length, 10);
  for (const row of d.rows) {
    assert.match(row.priority, /^\d+$/);
    assert.match(row.occurrence, /^\d+$/);
    assert.ok(['mandatory', 'optional', 'never'].includes(row.status));
  }
  // 位向量选中数应等于 bestSize
  assert.equal(d.bitVector.replaceAll('0', '').length, d.bestSize);
});

test('Worker 对非法输入返回 status=error 且带中文错误信息', async () => {
  const w = spawn();
  const reply = await roundtrip(w, {
    type: 'run', id: 2, threshold: 3,
    records: [{ barcode: 'AAAA', priorityText: '1' }], // 不足 10 条
  });
  assert.equal(reply.status, 'error');
  assert.equal(reply.id, 2);
  assert.match(reply.error, /10/);
});

test('Worker 对非数字优先权文本返回错误而非抛出', async () => {
  const w = spawn();
  const payload = validPayload(3);
  payload.records[0].priorityText = 'abc';
  const reply = await roundtrip(w, payload);
  assert.equal(reply.status, 'error');
  assert.ok(reply.error.length > 0);
});

test('dispatcher：迟到消息被丢弃，取消与错误均不覆盖最近成功结论', async () => {
  const state = createRunState();

  // 第一次运行成功
  const id1 = state.begin();
  const r1 = state.acceptResult({
    type: 'result', id: id1, status: 'ok', data: { tag: 'first' },
  });
  assert.equal(r1.kind, 'success');
  assert.deepEqual(state.getLastSuccess(), { tag: 'first' });

  // 第二次运行开始后失败：结论仍是第一次
  const id2 = state.begin();
  const r2 = state.acceptResult({
    type: 'result', id: id2, status: 'error', error: 'boom',
  });
  assert.equal(r2.kind, 'error');
  assert.deepEqual(state.getLastSuccess(), { tag: 'first' });

  // 旧 id（id2 失败前的迟到重复消息等）一律丢弃
  const late = state.acceptResult({
    type: 'result', id: 1, status: 'ok', data: { tag: 'stale' },
  });
  assert.equal(late.kind, 'stale');
  assert.deepEqual(state.getLastSuccess(), { tag: 'first' });

  // 第三次运行被取消：推进 id；其迟到成功消息不能覆盖
  const id3 = state.begin();
  assert.equal(state.isRunning(), true);
  const cancelled = state.cancel();
  assert.equal(cancelled, true);
  const lateAfterCancel = state.acceptResult({
    type: 'result', id: id3, status: 'ok', data: { tag: 'should-not-land' },
  });
  assert.equal(lateAfterCancel.kind, 'stale');
  assert.deepEqual(state.getLastSuccess(), { tag: 'first' });

  // 空闲时再次取消返回 false（无运行中任务）
  assert.equal(state.cancel(), false);

  // Worker 全局异常：failCurrent 复位运行态、作废旧消息、保留结论
  const idX = state.begin();
  assert.equal(state.failCurrent(), true);
  assert.equal(state.isRunning(), false);
  assert.equal(state.acceptResult({
    type: 'result', id: idX, status: 'ok', data: { tag: 'after-error' },
  }).kind, 'stale');
  assert.deepEqual(state.getLastSuccess(), { tag: 'first' });
  assert.equal(state.failCurrent(), false); // 空闲时返回 false

  // 第四次成功：结论正常更新
  const id4 = state.begin();
  const r4 = state.acceptResult({
    type: 'result', id: id4, status: 'ok', data: { tag: 'fourth' },
  });
  assert.equal(r4.kind, 'success');
  assert.deepEqual(state.getLastSuccess(), { tag: 'fourth' });
});

test('Worker 结果经 dispatcher 裁决：真实成功消息被接受', async () => {
  const w = spawn();
  const state = createRunState();
  const id = state.begin();
  const reply = await roundtrip(w, validPayload(id));
  const verdict = state.acceptResult(reply);
  assert.equal(verdict.kind, 'success');
  assert.equal(state.getLastSuccess().n, 10);

  // 同一 worker 再来一个旧 id 消息（模拟迟到）：被拒
  const staleVerdict = state.acceptResult({ ...reply, id: id - 1 });
  assert.equal(staleVerdict.kind, 'stale');
});
