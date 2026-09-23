// 暴力穷举参考实现：枚举全部 2^k 子集，独立计算双层最优、同优计数、
// 每位出现次数，并独立复现“输入次序选中优先”的规范位向量。
// 仅用于小规模随机交叉验证。

export function bruteForce(model) {
  const { n, adj, bits, records, eligibleMask } = model;
  const eligible = [];
  for (let i = 0; i < n; i++) if (eligibleMask & bits[i]) eligible.push(i);
  const k = eligible.length;

  // 局部位序下的邻接：localAdj[t] 的第 u 位 ⇔ eligible[t] 与 eligible[u] 互斥
  const localAdj = new Array(k).fill(0n);
  for (let t = 0; t < k; t++) {
    for (let u = t + 1; u < k; u++) {
      if (adj[eligible[t]] & bits[eligible[u]]) {
        localAdj[t] |= 1n << BigInt(u);
        localAdj[u] |= 1n << BigInt(t);
      }
    }
  }

  const independent = (mask) => {
    let bad = 0n;
    for (let t = 0; t < k; t++) {
      if (mask & (1n << BigInt(t))) bad |= localAdj[t];
    }
    return (mask & bad) === 0n;
  };

  let bestValue = -1n;
  let bestSize = -1;
  let count = 0n;
  const optimal = []; // 全部最优子集（用 eligible 本地位序表示）

  const total = 1 << k;
  for (let m = 0; m < total; m++) {
    const mask = BigInt(m);
    if (!independent(mask)) continue;
    let value = 0n;
    let size = 0;
    for (let t = 0; t < k; t++) {
      if (m & (1 << t)) {
        value += records[eligible[t]].priority;
        size += 1;
      }
    }
    if (value > bestValue || (value === bestValue && size > bestSize)) {
      bestValue = value;
      bestSize = size;
      count = 1n;
      optimal.length = 0;
      optimal.push(mask);
    } else if (value === bestValue && size === bestSize) {
      count += 1n;
      optimal.push(mask);
    }
  }

  if (k === 0) {
    bestValue = 0n;
    bestSize = 0;
    count = 1n;
  }

  const occurrenceLocal = new Array(k).fill(0n);
  for (const m of optimal) {
    for (let t = 0; t < k; t++) if (m & (1n << BigInt(t))) occurrenceLocal[t] += 1n;
  }

  // 独立的规范裁决：按输入次序，只要当前仍存在含 i 的最优完成方案就选 i
  let candidates = optimal.slice();
  const chosenLocal = new Array(k).fill(false);
  for (let t = 0; t < k; t++) {
    const bit = 1n << BigInt(t);
    if (candidates.some((m) => m & bit)) {
      chosenLocal[t] = true;
      candidates = candidates.filter((m) => m & bit);
    } else {
      candidates = candidates.filter((m) => !(m & bit));
    }
  }

  const occurrence = new Array(n).fill(0n);
  const statuses = new Array(n).fill('never');
  let selectedMask = 0n;
  for (let t = 0; t < k; t++) {
    const i = eligible[t];
    occurrence[i] = occurrenceLocal[t];
    if (occurrenceLocal[t] === count) statuses[i] = 'mandatory';
    else if (occurrenceLocal[t] === 0n) statuses[i] = 'never';
    else statuses[i] = 'optional';
    if (chosenLocal[t]) selectedMask |= bits[i];
  }

  return { value: bestValue, size: bestSize, count, occurrence, statuses, selectedMask };
}

/** 生成 n 条互不相同的等长随机 ACGT 条码。 */
export function randomBarcodes(rand, n, length) {
  const alphabet = 'ACGT';
  const seen = new Set();
  const out = [];
  while (out.length < n) {
    let s = '';
    for (let j = 0; j < length; j++) s += alphabet[Math.floor(rand() * 4)];
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** 可播种的确定性 PRNG（mulberry32）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
