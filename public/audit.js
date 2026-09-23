// 条码审计核心算法：无依赖、纯函数，Web Worker 与 Node 测试共用。
//
// 目标：在满足“任一正向/反向互补组合下最小汉明距离 >= 阈值”的子集中，
// 1) 优先权总和最大；2) 总和并列时记录数最多（双层最优）。
// 记录规模 n <= 44，位掩码统一使用 BigInt（JS 常规位运算会截断为 32 位），
// 同优方案数同样使用 BigInt，保证任意精度。

const COMPLEMENT = { A: 'T', T: 'A', C: 'G', G: 'C' };
const BARCODE_RE = /^[ACGT]+$/;
const DIGITS_RE = /^\d+$/;

export const MIN_RECORDS = 10;
export const MAX_RECORDS = 44;

/** 反向互补：先互补再反向（等价于先反向再互补）。 */
export function reverseComplement(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) {
    out += COMPLEMENT[seq[i]];
  }
  return out;
}

/** 等长字符串汉明距离。 */
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d += 1;
  }
  return d;
}

/**
 * 两条条码在四种“正向/反向互补”组合中的最小汉明距离。
 * 由对称性 hamming(rc(a),rc(b))=hamming(a,b)、
 * hamming(rc(a),b)=hamming(a,rc(b))，只需计算两项。
 */
export function minOrientedDistance(a, b) {
  const d = hamming(a, b);
  const dRc = hamming(a, reverseComplement(b));
  return d <= dRc ? d : dRc;
}

function fail(error) {
  return { ok: false, error };
}

/**
 * 校验并规范化录入。
 * records: [{ barcode: string, priority: bigint }]
 * threshold: number（正整数）
 */
export function validateRecords(records, threshold) {
  if (!Array.isArray(records)) return fail('记录必须是数组');
  if (records.length < MIN_RECORDS || records.length > MAX_RECORDS) {
    return fail(`记录数须在 ${MIN_RECORDS} 至 ${MAX_RECORDS} 条之间，当前 ${records.length} 条`);
  }
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
    return fail('距离阈值须为正整数');
  }

  const seen = new Set();
  let length = null;
  const normalized = [];

  for (let i = 0; i < records.length; i++) {
    const lineNo = i + 1;
    const r = records[i];
    if (!r || typeof r.barcode !== 'string') {
      return fail(`第 ${lineNo} 行缺少条码`);
    }
    const barcode = r.barcode.trim().toUpperCase();
    if (!BARCODE_RE.test(barcode)) {
      return fail(`第 ${lineNo} 行条码非法：仅允许 A/C/G/T（得到 "${r.barcode}"）`);
    }
    if (length === null) {
      length = barcode.length;
    } else if (barcode.length !== length) {
      return fail(`第 ${lineNo} 行条码长度与其余行不一致（应为 ${length}，实际 ${barcode.length}）`);
    }
    if (seen.has(barcode)) {
      return fail(`第 ${lineNo} 行条码重复：${barcode}`);
    }
    seen.add(barcode);

    const priority = r.priority;
    if (typeof priority !== 'bigint' || priority <= 0n) {
      return fail(`第 ${lineNo} 行优先权须为正整数`);
    }

    normalized.push({ barcode, priority, rc: reverseComplement(barcode) });
  }

  return { ok: true, records: normalized, length, threshold };
}

/** 解析“条码 优先权”文本，返回 { ok, records, threshold }。 */
export function parseLines(text, thresholdText) {
  if (typeof text !== 'string') return fail('录入内容无效');
  const t = (thresholdText ?? '').trim();
  if (!DIGITS_RE.test(t)) return fail('距离阈值须为正整数');
  const threshold = Number(t);
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    return fail('距离阈值须为安全正整数');
  }

  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length !== 2) {
      return fail(`第 ${i + 1} 行格式应为“条码 优先权”`);
    }
    const [barcodeRaw, prioRaw] = parts;
    const barcode = barcodeRaw.toUpperCase();
    if (!BARCODE_RE.test(barcode)) {
      return fail(`第 ${i + 1} 行条码非法：仅允许 A/C/G/T`);
    }
    if (!DIGITS_RE.test(prioRaw)) {
      return fail(`第 ${i + 1} 行优先权须为正整数`);
    }
    // 同时保留十进制原文：BigInt 可结构化克隆，但字符串在所有环境下最稳妥
    records.push({ barcode, priority: BigInt(prioRaw), priorityText: prioRaw });
  }
  return { ok: true, records, threshold };
}

export function bitCountBig(mask) {
  let c = 0;
  while (mask !== 0n) {
    mask &= mask - 1n;
    c += 1;
  }
  return c;
}

/**
 * 构建冲突模型。
 *  forbidden[i]       自身反向互补距离不足（hamming(seq, rc(seq)) < 阈值）
 *  eligibleMask       可入选记录位掩码
 *  adj[i]             与 i 互斥的可入选记录位掩码
 *  mutexPairs         全部互斥对（含被禁记录，供页面展示）
 */
export function buildModel(valid) {
  const { records, length, threshold } = valid;
  const n = records.length;
  const bits = [];
  for (let i = 0; i < n; i++) bits.push(1n << BigInt(i));
  const bitIndex = new Map(bits.map((b, i) => [b, i]));

  const selfRcDistance = new Array(n);
  const forbidden = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    selfRcDistance[i] = hamming(records[i].barcode, records[i].rc);
    if (selfRcDistance[i] < threshold) forbidden[i] = true;
  }

  const adj = new Array(n).fill(0n);
  const minPairDistance = new Array(n).fill(Infinity);
  const mutexPairs = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = hamming(records[i].barcode, records[j].barcode);
      const dRc = hamming(records[i].barcode, records[j].rc);
      const m = d <= dRc ? d : dRc;
      if (m < minPairDistance[i]) minPairDistance[i] = m;
      if (m < minPairDistance[j]) minPairDistance[j] = m;
      if (m < threshold) {
        mutexPairs.push({ a: i, b: j, d, dRc });
        // 被禁记录永不入选，无需进入冲突图
        if (!forbidden[i] && !forbidden[j]) {
          adj[i] |= bits[j];
          adj[j] |= bits[i];
        }
      }
    }
  }

  let eligibleMask = 0n;
  for (let i = 0; i < n; i++) if (!forbidden[i]) eligibleMask |= bits[i];

  return {
    n, length, threshold, records, bits, bitIndex,
    forbidden, selfRcDistance, minPairDistance,
    eligibleMask, adj, mutexPairs,
  };
}

/**
 * 贪心团划分上界：把 mask 内顶点划分为若干团，独立集每团至多取一个，
 * 故最大权 <= 各团最大权之和。仅用于分支剪枝（上界严格更差时剪）。
 */
export function cliquePartitionBound(model, mask) {
  const { adj, bits, records, n } = model;
  const verts = [];
  for (let v = 0; v < n; v++) {
    if (mask & bits[v]) verts.push(v);
  }
  // 按剩余图内度数降序，便于尽早塞满团
  verts.sort((x, y) => bitCountBig(adj[y] & mask) - bitCountBig(adj[x] & mask));

  const cliques = [];
  for (const v of verts) {
    let placed = false;
    for (const c of cliques) {
      let allAdj = true;
      for (const u of c.members) {
        if (!(adj[u] & bits[v])) { allAdj = false; break; }
      }
      if (allAdj) {
        c.members.push(v);
        if (records[v].priority > c.maxWeight) c.maxWeight = records[v].priority;
        placed = true;
        break;
      }
    }
    if (!placed) cliques.push({ members: [v], maxWeight: records[v].priority });
  }
  let bound = 0n;
  for (const c of cliques) bound += c.maxWeight;
  return bound;
}

/**
 * 双层次优最大权独立集（记忆化分支）。
 * 最大化字典序 (权值和, 顶点数)；count 为达到双层最优的方案数（BigInt）。
 * 返回 value/size/count、每位出现次数 occurrence、归属 statuses、
 * 以及按输入次序“选中优先”的规范位向量 selectedMask。
 */
export function solveGraph(model) {
  const { n, adj, bits, bitIndex, records, eligibleMask } = model;
  const weights = records.map((r) => r.priority);
  const memo = new Map();

  function rec(mask) {
    const hit = memo.get(mask);
    if (hit !== undefined) return hit;
    if (mask === 0n) {
      const empty = { value: 0n, size: 0, count: 1n };
      memo.set(0n, empty);
      return empty;
    }

    // 选冲突度数最大的顶点作轴（并列取下标最小，保证确定性）
    let pivot = -1;
    let pivotDeg = -1;
    let m = mask;
    while (m !== 0n) {
      const b = m & -m;
      const v = bitIndex.get(b);
      m -= b;
      const deg = bitCountBig(adj[v] & mask);
      if (deg > pivotDeg) { pivotDeg = deg; pivot = v; }
    }

    // 不含 pivot 的最优
    const without = rec(mask ^ bits[pivot]);
    let bestValue = without.value;
    let bestSize = without.size;
    let count = without.count;

    const includeMask = mask & ~(adj[pivot] | bits[pivot]);
    // 较大的残图才计算团上界，避免小图上的额外开销
    let prune = false;
    if (includeMask !== 0n && bitCountBig(mask) >= 12) {
      const ub = weights[pivot] + cliquePartitionBound(model, includeMask);
      if (ub < bestValue) prune = true;
    }

    if (!prune) {
      const within = rec(includeMask);
      const vValue = weights[pivot] + within.value;
      const vSize = within.size + 1;
      if (vValue > bestValue || (vValue === bestValue && vSize > bestSize)) {
        bestValue = vValue;
        bestSize = vSize;
        count = within.count;
      } else if (vValue === bestValue && vSize === bestSize) {
        count += within.count; // 两支方案集互不相交（一支含 pivot，一支不含）
      }
    }

    const res = { value: bestValue, size: bestSize, count };
    memo.set(mask, res);
    return res;
  }

  const root = rec(eligibleMask);
  const value = root.value;
  const size = root.size;
  const totalCount = root.count;

  // 每条可入选记录出现在多少个双层最优方案中：
  // 含 i 的最优方案 ⇔ {i} ∪ (去掉 i 及其邻域后残图上的最优方案)，
  // 仅当拼接后同时达到最优权与最优基数时计入。
  const occurrence = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) {
    if (!(eligibleMask & bits[i])) continue;
    const sub = eligibleMask & ~(adj[i] | bits[i]);
    const r = rec(sub);
    if (weights[i] + r.value === value && r.size + 1 === size) {
      occurrence[i] = r.count;
    }
  }

  // 归属：必选（出现在全部方案）/ 可选 / 从不选
  const statuses = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!(eligibleMask & bits[i])) {
      statuses[i] = 'never'; // 自身反向互补冲突，或其存在无意义（此处即被禁记录）
    } else if (occurrence[i] === totalCount) {
      statuses[i] = 'mandatory';
    } else if (occurrence[i] === 0n) {
      statuses[i] = 'never';
    } else {
      statuses[i] = 'optional';
    }
  }

  // 规范结果：按输入次序“选中优先”贪心——当前位若存在达成剩余最优的
  // 完成方案，则选入；否则跳过。最终位向量唯一确定。
  let remaining = eligibleMask;
  let targetValue = value;
  let targetSize = size;
  let selectedMask = 0n;
  for (let i = 0; i < n; i++) {
    if (!(remaining & bits[i])) continue;
    const rest = remaining & ~(adj[i] | bits[i]);
    const r = rec(rest);
    if (weights[i] + r.value === targetValue && r.size + 1 === targetSize) {
      selectedMask |= bits[i];
      remaining = rest;
      targetValue -= weights[i];
      targetSize -= 1;
    } else {
      remaining ^= bits[i];
    }
  }

  return { value, size, count: totalCount, selectedMask, occurrence, statuses };
}

/** 端到端：原始记录 + 阈值 → 模型与解。 */
export function audit(records, threshold) {
  const validation = validateRecords(records, threshold);
  if (!validation.ok) return validation;
  const model = buildModel(validation);
  const solution = solveGraph(model);
  return { ok: true, model, solution };
}
