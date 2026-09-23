// 随机小规模交叉验证：对大量播种实例，比较精确求解器与 2^k 暴力穷举在
// 最优权、最优基数、同优计数、每位出现次数、归属、规范位向量上的一致性。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, solveGraph, validateRecords } from '../public/audit.js';
import { bruteForce, randomBarcodes, mulberry32 } from './helpers/brute.js';

function bitCount(mask) {
  let c = 0;
  while (mask) { mask &= mask - 1n; c++; }
  return c;
}

function assertIndependent(model, mask) {
  for (let i = 0; i < model.n; i++) {
    if (mask & model.bits[i]) {
      assert.equal(mask & model.adj[i], 0n, '规范结果含互斥对');
    }
  }
}

function runOne(seed, cfg) {
  const rand = mulberry32(seed);
  const barcodes = randomBarcodes(rand, cfg.n, cfg.length);
  const records = barcodes.map((b) => ({
    barcode: b,
    // 允许权值重复以制造同优
    priority: BigInt(1 + Math.floor(rand() * cfg.maxPriority)),
  }));

  const validation = validateRecords(records, cfg.threshold);
  assert.equal(validation.ok, true, `seed=${seed} 校验意外失败`);
  const model = buildModel(validation);
  const got = solveGraph(model);
  const want = bruteForce(model);

  assert.equal(got.value, want.value, `seed=${seed} 最优权不一致`);
  assert.equal(got.size, want.size, `seed=${seed} 最优基数不一致`);
  assert.equal(got.count, want.count,
    `seed=${seed} 同优计数不一致 got=${got.count} want=${want.count}`);
  for (let i = 0; i < cfg.n; i++) {
    assert.equal(got.occurrence[i], want.occurrence[i],
      `seed=${seed} 记录 ${i} 出现次数不一致`);
    assert.equal(got.statuses[i], want.statuses[i],
      `seed=${seed} 记录 ${i} 归属不一致`);
  }
  assert.equal(got.selectedMask, want.selectedMask,
    `seed=${seed} 规范位向量不一致`);

  // 不变量：各记录出现次数之和 = 最优基数 × 同优方案数
  let sumOcc = 0n;
  for (const o of got.occurrence) sumOcc += o;
  assert.equal(sumOcc, got.count * BigInt(got.size),
    `seed=${seed} 出现次数总和不闭合`);
  assert.equal(bitCount(got.selectedMask), got.size, `seed=${seed} 位向量基数错`);
  assertIndependent(model, got.selectedMask);
}

test('随机实例：求解器 vs 2^k 暴力穷举（多组密度/权值）', () => {
  const configs = [
    { n: 10, length: 6, threshold: 3, maxPriority: 3, cases: 120 },
    { n: 10, length: 7, threshold: 2, maxPriority: 5, cases: 60 },
    { n: 12, length: 6, threshold: 4, maxPriority: 2, cases: 50 },
    { n: 10, length: 8, threshold: 3, maxPriority: 9, cases: 40 },
  ];
  let seed = 1;
  for (const cfg of configs) {
    for (let t = 0; t < cfg.cases; t++) runOne(seed++, cfg);
  }
});
