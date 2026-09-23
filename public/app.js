// 主线程：解析录入、管理 Worker 生命周期、渲染最近一次成功结论。
//
// 一致性规则：
//   - 审计 id 单调递增；只渲染 id === latestId 的成功结果。
//   - 取消 = terminate() 当前 worker（同步中断其线程）并重建空闲 worker。
//   - 非法输入在主线程预校验，根本不发任务。
//   - 错误 / 取消 / 旧任务迟到消息都不覆盖已有成功结论。

import { parseLines, validateRecords } from './audit.js';
import { createRunState } from './dispatcher.js';

const $ = (id) => document.getElementById(id);
const thresholdEl = $('threshold');
const recordsEl = $('records');
const runBtn = $('runBtn');
const cancelBtn = $('cancelBtn');
const sampleBtn = $('sampleBtn');
const clearBtn = $('clearBtn');
const statusLine = $('statusLine');
const summaryEl = $('summary');
const tableBody = document.querySelector('#resultTable tbody');
const mutexList = $('mutexList');
const mutexSummary = $('mutexSummary');

const runState = createRunState();
let worker = null;
let inputDirty = false; // 上次成功审计后录入是否被改动

function setStatus(text, kind = '') {
  statusLine.textContent = text;
  statusLine.className = 'status' + (kind ? ` ${kind}` : '');
}

function finishRun() {
  runBtn.disabled = false;
  cancelBtn.disabled = true;
}

function createWorker() {
  const w = new Worker('./worker.js', { type: 'module' });
  w.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'result') return;
    // 取消 / 新任务 / 旧线程迟到消息：状态机统一裁决
    const verdict = runState.acceptResult(msg);
    if (verdict.kind === 'stale') return; // 静默丢弃，绝不覆盖结论
    finishRun();
    if (verdict.kind === 'success') {
      inputDirty = false;
      render(verdict.data);
      setStatus('审计完成。', '');
    } else {
      // 当前任务计算错误：不覆盖结论
      setStatus(`任务失败：${verdict.error}（保留上一次成功结论）`, 'error');
    }
  };
  w.onerror = (event) => {
    // 已被取代的旧 worker 异常一律忽略
    if (w !== worker) return;
    runState.failCurrent(); // 复位运行态并作废旧 id（不触碰已保存结论）
    finishRun();
    setStatus(`Worker 异常：${event.message || '未知错误'}（保留上一次成功结论）`, 'error');
  };
  return w;
}

function startRun() {
  const parsed = parseLines(recordsEl.value, thresholdEl.value);
  if (!parsed.ok) {
    // 非法输入：不发任务、不推进任何结论
    setStatus(parsed.error, 'error');
    return;
  }
  // 算法级预校验（条数 10–44、等长、唯一、正优先权、阈值）：
  // 非法输入在主线程即被拦截，绝不创建任务
  const precheck = validateRecords(parsed.records, parsed.threshold);
  if (!precheck.ok) {
    setStatus(precheck.error, 'error');
    return;
  }

  const id = runState.begin();
  worker.terminate(); // 打断可能仍在跑的旧线程（其消息随线程销毁）
  worker = createWorker();
  runBtn.disabled = true;
  cancelBtn.disabled = false;
  setStatus('审计进行中…可取消。', 'running');

  worker.postMessage({
    type: 'run',
    id,
    threshold: parsed.threshold,
    // 优先权以十进制字符串传递，避免 BigInt 结构化克隆的环境差异
    records: parsed.records.map((r) => ({ barcode: r.barcode, priorityText: r.priorityText })),
  });
}

function cancelRun() {
  if (!runState.cancel()) return; // 本就空闲
  worker.terminate(); // 同步终止线程
  worker = createWorker(); // 预备空闲 worker
  finishRun();
  setStatus('已取消；保留上一次成功结论。', 'cancelled');
}

const STATUS_LABEL = { mandatory: '必选', optional: '可选', never: '从不选' };
const SELF_CONFLICT_LABEL = '自反互补冲突';

function render(data) {
  summaryEl.classList.remove('empty');
  summaryEl.innerHTML = '';

  const kv = document.createElement('div');
  kv.className = 'kvline';
  const addKv = (k, v) => {
    const wrap = document.createElement('span');
    wrap.className = 'kv';
    const ke = document.createElement('span');
    ke.className = 'k';
    ke.textContent = k;
    const ve = document.createElement('span');
    ve.className = 'v';
    ve.textContent = v;
    wrap.append(ke, ve);
    kv.appendChild(wrap);
  };
  addKv('最优优先权总和', data.bestWeight);
  addKv('最优记录数', String(data.bestSize));
  addKv('同优方案数（任意精度）', data.tieCount);
  addKv('阈值 / 记录数 / 条码长', `${data.threshold} / ${data.n} / ${data.length}`);
  summaryEl.appendChild(kv);

  const bv = document.createElement('div');
  bv.className = 'bitvector';
  bv.textContent = `选中优先位向量（按输入次序）：${data.bitVector}`;
  summaryEl.appendChild(bv);

  if (inputDirty) {
    const note = document.createElement('div');
    note.className = 'stale-note';
    note.textContent = '提示：当前输入已变更，上述为更早输入的成功结论；重新审计后更新。';
    summaryEl.appendChild(note);
  }

  tableBody.innerHTML = '';
  data.rows.forEach((row) => {
    const tr = document.createElement('tr');

    const td = (text, mono = false) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (mono) cell.className = 'mono';
      return cell;
    };

    tr.appendChild(td(String(row.index + 1)));
    tr.appendChild(td(row.barcode, true));
    tr.appendChild(td(row.rc, true));
    tr.appendChild(td(row.priority, true));
    tr.appendChild(td(String(row.selfRcDistance)));
    tr.appendChild(td(row.minPairDistance === null ? '—' : String(row.minPairDistance)));

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${row.status}`;
    badge.textContent = row.forbidden
      ? `${STATUS_LABEL[row.status]}（${SELF_CONFLICT_LABEL}）`
      : STATUS_LABEL[row.status];
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    const selCell = document.createElement('td');
    if (data.bitVector[row.index] === '1') {
      const mark = document.createElement('span');
      mark.className = 'sel-mark';
      mark.textContent = '✓ 选中';
      selCell.appendChild(mark);
    } else {
      selCell.textContent = '—';
    }
    tr.appendChild(selCell);

    tableBody.appendChild(tr);
  });

  mutexSummary.textContent = `互斥记录对（${data.mutexPairs.length} 对，任一方向最小距离 < ${data.threshold}）`;
  mutexList.innerHTML = '';
  if (data.mutexPairs.length === 0) {
    const li = document.createElement('li');
    li.textContent = '无互斥对。';
    mutexList.appendChild(li);
  } else {
    for (const p of data.mutexPairs) {
      const li = document.createElement('li');
      li.textContent =
        `#${p.a + 1} ${data.rows[p.a].barcode}  ↔  #${p.b + 1} ${data.rows[p.b].barcode}` +
        `　正向 d=${p.d}，反向互补 d=${p.dRc}`;
      mutexList.appendChild(li);
    }
  }
}

// 内置示例：10 条 8mer。
//  #3 GGAATTTC 自身反向互补距离为 2（< 3）→ 不得入选；
//  #4/#5 为等权互斥的一对 → 均为“可选”，同优方案数 2；
//  规范位向量按输入次序“选中优先”在 #4/#5 中选择 #4。
function sampleInput() {
  return {
    threshold: '3',
    text: [
      'ATGATGAC 2',
      'TTTTTGCC 1',
      'GGAATTTC 4',
      'TTGAGCAC 3',
      'AGGCTCAA 3',
      'ACGGAACC 2',
      'CTGCTGGT 3',
      'GGCAGGGC 2',
      'TCGGGGCA 4',
      'GCATAACA 5',
    ].join('\n'),
  };
}

runBtn.addEventListener('click', startRun);
cancelBtn.addEventListener('click', cancelRun);

// 录入变更即标记结论可能过期（仅提示，不覆盖结论本身）
const markDirty = () => { inputDirty = true; };
thresholdEl.addEventListener('input', markDirty);
recordsEl.addEventListener('input', markDirty);

sampleBtn.addEventListener('click', () => {
  const s = sampleInput();
  thresholdEl.value = s.threshold;
  recordsEl.value = s.text;
  inputDirty = true;
  setStatus('已填入示例，点击“启动审计”。', '');
});
clearBtn.addEventListener('click', () => {
  recordsEl.value = '';
  inputDirty = true;
  setStatus('已清空录入。', '');
});

// 预热空闲 worker
worker = createWorker();
