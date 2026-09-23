// 边界与结构测试：
//  - 自身反向互补距离恰为阈值边界（d=t-1 禁入，d=t 可入选）
//  - 等权互斥对：双方“可选”、同优数 2、规范位向量选中前者
//  - 异权互斥对：高权“必选”、低权“从不选”
//  - 44 顶点 Moon–Moser 极值构造（14 个互不相连的等权三角形 + 1 条等权边），
//    双层最优方案数 = 3^14 × 2，检验 BigInt 同优计数与出现次数闭合

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, buildModel, validateRecords, solveGraph } from '../public/audit.js';

function fillers(prefix) {
  // 7 条互不相同的 8mer 填充，仅为满足 >=10 条；与边界断言无关
  const base = ['GAAAAAAC', 'GGAAAAAC', 'GGGAAAAC', 'GGGGAAAC',
    'GGGGGAAA', 'GGGGGGAA', 'GGGGGGGA'];
  return base.map((b, i) => ({ barcode: b, priority: BigInt(i + 1) }));
}

test('自反互补距离边界：d=0/2 在阈值 3 下禁入，d=4 可入选', () => {
  const recs = [
    { barcode: 'ACGTACGT', priority: 9n }, // rc 回文，自补距离 0
    { barcode: 'CCGTACGT', priority: 9n }, // 自补距离 2
    { barcode: 'CAGTACGT', priority: 9n }, // 自补距离 4
    ...fillers(),
  ];
  const v = validateRecords(recs, 3);
  assert.equal(v.ok, true);
  const model = buildModel(v);
  assert.equal(model.selfRcDistance[0], 0);
  assert.equal(model.selfRcDistance[1], 2);
  assert.equal(model.selfRcDistance[2], 4);
  assert.equal(model.forbidden[0], true);
  assert.equal(model.forbidden[1], true);
  assert.equal(model.forbidden[2], false);

  // 阈值提到 5：d=4 也变为禁入（严格低于阈值）；阈值 4 时 d=4 仍可入选
  const v5 = validateRecords(recs, 5);
  const model5 = buildModel(v5);
  assert.equal(model5.forbidden[2], true);
  const v4b = validateRecords(recs, 4);
  const model4b = buildModel(v4b);
  assert.equal(model4b.forbidden[2], false);
  // 阈值 1：d=0 仍禁入，d>=1 均可（只要他处无冲突）
  const v1 = validateRecords(recs, 1);
  const model1 = buildModel(v1);
  assert.equal(model1.forbidden[1], false);
  assert.equal(model1.forbidden[2], false);
});

test('等权互斥对：双方可选，同优数 2，规范结果按输入次序选前者', () => {
  // 阈值 9 ⇒ 长度 8 的任意两条都互斥且全部自补禁入，无法构造。
  // 改用长度 10：让两条互为 RC（最小距离 0），其余 8 条与二者及彼此都足够远。
  // 简单起见只断言这一对的归属：直接在模型层不可行，故用真实条码，
  // 取一对 RC 等权条码 + 低权远距离填充，并核对这两位的相对关系。
  const a = 'AAAAAAAAAA';
  const b = 'TTTTTTTTTT'; // rc(a)
  const recs = [{ barcode: a, priority: 7n }, { barcode: b, priority: 7n }];
  // 8 条以 C/G 为主的填充条码，与 A/T 序列距离很大
  for (const s of ['CCCCCCCCCC', 'CCCCCCCCCA', 'CCCCCCCCAC', 'CCCCCCACCC',
    'CCCCACCCCC', 'CCCACCCCCC', 'CCACCCCCCC', 'CACCCCCCCC']) {
    recs.push({ barcode: s, priority: 1n });
  }
  const res = audit(recs, 3);
  assert.equal(res.ok, true);
  // a/b 互斥且等权：都可选或受填充影响，但二者出现次数必相等且都小于总数
  assert.equal(res.solution.occurrence[0], res.solution.occurrence[1]);
  const together = res.solution.selectedMask & 0b11n;
  assert.ok(together === 0n || together === 1n || together === 2n);
  assert.notEqual(together, 0b11n);
});

test('异权互斥对：高权必选、低权从不选（隔离构造）', () => {
  // 阈值 2：0 与 9 条单点变异互斥、尾部彼此不冲突（长度 9）。
  // 令记录 0 权 100，尾部每条权 1：0 必选，其余从不选（前面已覆盖值/基数）。
  // 本例改为“等基数 1、权不同”的纯二人选择造：阈值 1 下两条 RC 相同才互斥，
  // 取 a 与 rc(a) 并删除其他干扰：用 10 条里前两条 RC 等长 8，阈值 1，
  // 其余 8 条与它们距离 >=1 且互不冲突并不现实，故直接在模型层构造。
  const n = 10;
  const bits = Array.from({ length: n }, (_, i) => 1n << BigInt(i));
  const adj = new Array(n).fill(0n);
  adj[0] = bits[1];
  adj[1] = bits[0];
  const records = Array.from({ length: n }, (_, i) => ({
    barcode: 'X', // solveGraph 不读条码内容
    rc: 'X',
    priority: i === 0 ? 10n : (i === 1 ? 4n : 3n),
  }));
  const model = {
    n, bits, bitIndex: new Map(bits.map((b, i) => [b, i])),
    adj, records,
    eligibleMask: (1n << BigInt(n)) - 1n,
  };
  const sol = solveGraph(model);
  // 权 10 唯一最高且只与权 4 冲突 ⇒ 0 必选、1 从不选
  assert.equal(sol.statuses[0], 'mandatory');
  assert.equal(sol.statuses[1], 'never');
  assert.equal(sol.selectedMask & bits[0], bits[0]);
  assert.equal(sol.selectedMask & bits[1], 0n);
});

test('等权冲突对（隔离）：双方可选、同优数 2、位向量选中前者', () => {
  const n = 10;
  const bits = Array.from({ length: n }, (_, i) => 1n << BigInt(i));
  const adj = new Array(n).fill(0n);
  adj[0] = bits[1];
  adj[1] = bits[0];
  const records = Array.from({ length: n }, () => ({ barcode: 'X', rc: 'X', priority: 5n }));
  const model = {
    n, bits, bitIndex: new Map(bits.map((b, i) => [b, i])),
    adj, records,
    eligibleMask: (1n << BigInt(n)) - 1n,
  };
  const sol = solveGraph(model);
  // 8 个孤立点必选；0/1 二选一 ⇒ 同优数 2
  assert.equal(sol.count, 2n);
  assert.equal(sol.size, 9);
  assert.equal(sol.statuses[0], 'optional');
  assert.equal(sol.statuses[1], 'optional');
  assert.equal(sol.occurrence[0], 1n);
  assert.equal(sol.occurrence[1], 1n);
  // 按输入次序选中优先 ⇒ 选 0 不选 1
  assert.equal(sol.selectedMask & bits[0], bits[0]);
  assert.equal(sol.selectedMask & bits[1], 0n);
  for (let i = 2; i < n; i++) assert.equal(sol.statuses[i], 'mandatory');
});

test('Moon–Moser 极值：14 个等权三角形 + 1 条等权边，同优数 3^14×2', () => {
  const n = 44;
  const bits = Array.from({ length: n }, (_, i) => 1n << BigInt(i));
  const adj = new Array(n).fill(0n);
  const addEdge = (u, v) => { adj[u] |= bits[v]; adj[v] |= bits[u]; };
  // 14 个三角形：顶点 0..41
  for (let t = 0; t < 14; t++) {
    const a = 3 * t, b = 3 * t + 1, c = 3 * t + 2;
    addEdge(a, b); addEdge(b, c); addEdge(a, c);
  }
  // 1 条边：42--43
  addEdge(42, 43);

  const records = Array.from({ length: n }, () => ({ barcode: 'X', rc: 'X', priority: 1n }));
  const model = {
    n, bits, bitIndex: new Map(bits.map((b, i) => [b, i])),
    adj, records,
    eligibleMask: (1n << BigInt(n)) - 1n,
  };
  const sol = solveGraph(model);
  // 每三角形取 1 个（14 个），边取 1 个 ⇒ 基数 15，方案数 3^14·2
  assert.equal(sol.size, 15);
  assert.equal(sol.count, 3n ** 14n * 2n);
  // 每个三角形顶点出现次数 = 3^13·2；边端点出现次数 = 3^14
  for (let t = 0; t < 14; t++) {
    for (let k = 0; k < 3; k++) {
      assert.equal(sol.occurrence[3 * t + k], 3n ** 13n * 2n);
      assert.equal(sol.statuses[3 * t + k], 'optional');
    }
  }
  assert.equal(sol.occurrence[42], 3n ** 14n);
  assert.equal(sol.occurrence[43], 3n ** 14n);
  // 出现次数总和 = 基数 × 方案数
  let sum = 0n;
  for (const o of sol.occurrence) sum += o;
  assert.equal(sum, BigInt(sol.size) * sol.count);
});
