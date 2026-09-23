import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reverseComplement,
  hamming,
  minOrientedDistance,
  validateRecords,
  parseLines,
  buildModel,
  solveGraph,
  audit,
  MIN_RECORDS,
  MAX_RECORDS,
} from '../public/audit.js';

test('reverseComplement 基本性质', () => {
  assert.equal(reverseComplement('ACGT'), 'ACGT'); // 回文
  assert.equal(reverseComplement('AAAA'), 'TTTT');
  assert.equal(reverseComplement('AACC'), 'GGTT');
  assert.equal(reverseComplement(reverseComplement('ACGTTGCA')), 'ACGTTGCA');
});

test('hamming', () => {
  assert.equal(hamming('AAAA', 'AAAA'), 0);
  assert.equal(hamming('AAAA', 'AATA'), 1);
  assert.equal(hamming('ACGT', 'TGCA'), 4);
});

test('minOrientedDistance 同时考虑正向与反向互补', () => {
  // AAAA vs TTTT：正向距离 4，但 AAAA 的反向互补恰为 TTTT，故最小 0
  assert.equal(minOrientedDistance('AAAAAAAA', 'TTTTTTTT'), 0);
  assert.equal(minOrientedDistance('ACGTACGT', 'ACGTACGT'), 0);
});

test('parseLines 与校验：格式、等长、唯一、正整数优先权', () => {
  const text = 'AAAA 1\nCCCC 2\n';
  const p = parseLines(text, '3');
  assert.equal(p.ok, true);
  assert.equal(p.records.length, 2);
  assert.equal(p.records[0].priority, 1n);
  assert.equal(p.records[0].priorityText, '1');

  assert.equal(parseLines('AAAA 1', '0').ok, false);
  assert.equal(parseLines('AAAA 1', 'x').ok, false);
  assert.equal(parseLines('AAAA -1', '3').ok, false);
  assert.equal(parseLines('AAAA 1 2', '3').ok, false);
  assert.equal(parseLines('AAAX 1', '3').ok, false);
});

test('validateRecords 拒绝过短/过长、不等长、重复、非正优先权', () => {
  const mk = (n, mut = {}) => {
    const recs = [];
    const seen = new Set();
    let i = 0;
    while (recs.length < n) {
      const s = ('0000000' + i.toString(4)).slice(-8)
        .replaceAll('0', 'A').replaceAll('1', 'C').replaceAll('2', 'G').replaceAll('3', 'T');
      i += 1;
      if (seen.has(s)) continue;
      seen.add(s);
      recs.push({ barcode: s, priority: BigInt((i % 7) + 1) });
    }
    Object.assign(recs[0], mut);
    return recs;
  };

  assert.equal(validateRecords(mk(MIN_RECORDS - 1), 3).ok, false);
  assert.equal(validateRecords(mk(MAX_RECORDS), 3).ok, true);

  const tooMany = mk(MAX_RECORDS);
  tooMany.push({ barcode: 'AAAAAAAA', priority: 1n });
  // 长度 8 的四进制串共 4^8=65536，取 45 个互不相同可行；再制造重复
  tooMany[44] = { barcode: tooMany[0].barcode, priority: 1n };
  assert.equal(validateRecords(tooMany, 3).ok, false);

  const unequal = mk(MIN_RECORDS, { barcode: 'AAA' });
  assert.equal(validateRecords(unequal, 3).ok, false);

  const dup = mk(MIN_RECORDS);
  dup[5] = { ...dup[5], barcode: dup[0].barcode };
  assert.equal(validateRecords(dup, 3).ok, false);

  const badPrio = mk(MIN_RECORDS, { priority: 0n });
  assert.equal(validateRecords(badPrio, 3).ok, false);

  const badChars = mk(MIN_RECORDS, { barcode: 'AAAAAAAN' });
  assert.equal(validateRecords(badChars, 3).ok, false);
});

test('自身反向互补距离不足的记录被判 never 且不得入选', () => {
  // 构造 10 条 8mer：全部彼此距离足够，仅让其中一条近似其反向互补。
  // 自补距离：seq=AAAA TTTT 形式 hamming(seq,rc)=0；
  const recs = [
    { barcode: 'AAAATTTT', priority: 5n }, // rc = AAAATTTT，自补距离 0
    { barcode: 'CCCCGGGG', priority: 9n }, // 回文，自补距离 0
    { barcode: 'AAAAAAAA', priority: 8n },
    { barcode: 'AAAAAAAC', priority: 7n },
    { barcode: 'AAAAAACA', priority: 6n },
    { barcode: 'AAAACAAA', priority: 4n },
    { barcode: 'AAACAAAA', priority: 3n },
    { barcode: 'AACAAAAA', priority: 2n },
    { barcode: 'ACAAAAAA', priority: 2n },
    { barcode: 'CAAAAAAA', priority: 2n },
  ];
  const res = audit(recs, 3);
  assert.equal(res.ok, true);
  assert.equal(res.model.forbidden[0], true);
  assert.equal(res.model.forbidden[1], true);
  // 被禁记录绝不可能被规范结果选中
  assert.equal(res.solution.selectedMask & 0b11n, 0n);
  // 且必判为从不选
  assert.equal(res.solution.statuses[0], 'never');
  assert.equal(res.solution.statuses[1], 'never');
});

test('反向互补互斥：与他条码 RC 过近的对不能同时入选', () => {
  // 10 条；让 b 恰为 a 的反向互补 → 二者最小距离 0
  const recs = [
    { barcode: 'AAAAAACC', priority: 10n },
    { barcode: 'GGTTTTTT', priority: 10n }, // rc(AAAAAACC)=GGTTTTTT
    { barcode: 'CCCCCCCC', priority: 1n },
    { barcode: 'GCCCCCCC', priority: 1n },
    { barcode: 'GGCCCCCC', priority: 1n },
    { barcode: 'GGGCCCCC', priority: 1n },
    { barcode: 'GGGGCCCC', priority: 1n },
    { barcode: 'GGGGGCCC', priority: 1n },
    { barcode: 'GGGGGGCC', priority: 1n },
    { barcode: 'GGGGGGGC', priority: 1n },
  ];
  const res = audit(recs, 3);
  assert.equal(res.ok, true);
  // 无论结果如何，a 与 b 不能同时在规范结果中
  const both = res.solution.selectedMask & (1n | 2n);
  assert.notEqual(both, 1n | 2n);
});

test('第一层（权值）优先于第二层（基数）', () => {
  // 阈值 2：记录 0=AAAAAAAAA 与每条“单点 C 变异”尾部距离 1 → 互斥；
  // 9 条尾部两两距离恰为 2 → 互不冲突。最优为只取 0（权 100）而非 9 条（权 9）。
  const recs = [{ barcode: 'AAAAAAAAA', priority: 100n }];
  for (let p = 0; p < 9; p++) {
    const s = 'AAAAAAAAA'.split('');
    s[p] = 'C';
    recs.push({ barcode: s.join(''), priority: 1n });
  }
  const res = audit(recs, 2);
  assert.equal(res.ok, true);
  assert.equal(res.solution.value, 100n);
  assert.equal(res.solution.size, 1);
  assert.equal(res.solution.selectedMask, 1n);
  assert.equal(res.solution.count, 1n);
  // 除记录 0 外全部为从不选
  for (let i = 1; i < 10; i++) assert.equal(res.solution.statuses[i], 'never');
  assert.equal(res.solution.statuses[0], 'mandatory');
});

test('同优计数与必选/可选/从不选边界：小型手算例', () => {
  // 阈值取极大（例如 9）使任意两条互斥（长度 8 时最大距离 8 < 9），
  // 且自补距离 < 9 全部被禁 → 空解、同优数 1。
  const recs = [];
  const bases = 'ACGT';
  const list = [];
  const seen = new Set();
  while (list.length < 10) {
    let s = '';
    for (let j = 0; j < 8; j++) s += bases[Math.floor(Math.random() * 4)];
    if (!seen.has(s)) { seen.add(s); list.push(s); }
  }
  for (const s of list) recs.push({ barcode: s, priority: 1n });
  const res = audit(recs, 9);
  assert.equal(res.ok, true);
  assert.equal(res.solution.value, 0n);
  assert.equal(res.solution.size, 0);
  // 全部自补冲突（hamming <= 8 < 9）→ 唯一方案为空
  assert.equal(res.solution.count, 1n);
  assert.equal(res.solution.selectedMask, 0n);
});

test('BigInt 优先权：超大权值精确参与比较', () => {
  const huge = 1234567890123456789012345678901234567890n;
  const recs = [{ barcode: 'AAAAAAAAA', priority: huge }];
  for (let p = 0; p < 9; p++) {
    const s = 'AAAAAAAAA'.split('');
    s[p] = 'C';
    recs.push({ barcode: s.join(''), priority: 1n });
  }
  const res = audit(recs, 2);
  assert.equal(res.ok, true);
  assert.equal(res.solution.value, huge);
  assert.equal(res.solution.selectedMask, 1n);
});

test('阈值=1 边界：距离 0（正/反向相同）才互斥；自补距离为 0 才禁入', () => {
  // 用 10 条互不相同且非 RC 关系的条码，阈值 1 时全部可共存
  const recs = [
    'AAAAAAAA', 'AAAAAAAC', 'AAAAAACA', 'AAAAACAA',
    'AAAACAAA', 'AAACAAAA', 'AACAAAAA', 'ACAAAAAA',
    'CAAAAAAA', 'AAAAAACG',
  ].map((barcode, i) => ({ barcode, priority: BigInt(i + 1) }));
  const res = audit(recs, 1);
  assert.equal(res.ok, true);
  // AAAAAAAG 的 RC=CTTTTTTT 等都不等于集合内条码；校验全部合格
  assert.equal(res.model.eligibleMask === (1n << 10n) - 1n, true);
  assert.equal(res.solution.size, 10);
  assert.equal(res.solution.count, 1n);
});

test('MAX_RECORDS=44 时求解在可接受时间内完成（分支搜索）', () => {
  // 44 条 12mer 随机条码、阈值 3，密度适中
  const bases = 'ACGT';
  const seen = new Set();
  const recs = [];
  while (recs.length < MAX_RECORDS) {
    let s = '';
    for (let j = 0; j < 12; j++) s += bases[Math.floor(Math.random() * 4)];
    if (seen.has(s)) continue;
    seen.add(s);
    recs.push({ barcode: s, priority: BigInt(1 + (s.charCodeAt(0) % 9)) });
  }
  const t0 = Date.now();
  const res = audit(recs, 3);
  const ms = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.ok(res.solution.count >= 1n);
  assert.ok(ms < 30000, `solving took ${ms}ms`);
});
