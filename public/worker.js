// 审计 Web Worker：接收录入、调用纯算法模块、回传可结构化克隆的结果。
//
// 协议：
//   主线程 → worker  { type: 'run', id:number, records:[{barcode,priorityText}], threshold:number }
//   worker → 主线程  { type: 'result', id, status:'ok'|'error', ... }
//
// 取消由主线程 terminate() 当前 worker 并重建空闲 worker 实现：
// 同步的组合搜索无法被消息打断，终止线程是唯一可靠的取消方式；
// 旧 worker 的迟到消息随线程销毁，绝不会回到页面。
// 主线程另以 id 单调递增 + 只认最新 id 双重防护。

import { audit } from './audit.js';

function serialize(model, solution) {
  const { n, records } = model;
  const rows = records.map((r, i) => ({
    index: i,
    barcode: r.barcode,
    rc: r.rc,
    priority: r.priority.toString(),
    selfRcDistance: model.selfRcDistance[i],
    minPairDistance: Number.isFinite(model.minPairDistance[i]) ? model.minPairDistance[i] : null,
    forbidden: model.forbidden[i],
    status: solution.statuses[i],
    occurrence: solution.occurrence[i].toString(),
  }));

  // 位向量：按输入次序，第 i 个字符对应该第 i+1 条记录，1 为规范结果选中。
  let bitVector = '';
  const selected = [];
  for (let i = 0; i < n; i++) {
    const hit = (solution.selectedMask & (1n << BigInt(i))) !== 0n;
    bitVector += hit ? '1' : '0';
    if (hit) selected.push(i);
  }

  return {
    n,
    length: model.length,
    threshold: model.threshold,
    bestWeight: solution.value.toString(),
    bestSize: solution.size,
    tieCount: solution.count.toString(),
    selectedMask: solution.selectedMask.toString(),
    bitVector,
    selected,
    rows,
    mutexPairs: model.mutexPairs.map((p) => ({
      a: p.a, b: p.b, d: p.d, dRc: p.dRc,
    })),
  };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') return;
  const { id, records, threshold } = msg;

  try {
    const converted = records.map((r) => ({
      barcode: r.barcode,
      priority: BigInt(r.priorityText),
    }));
    const result = audit(converted, threshold);
    if (!result.ok) {
      self.postMessage({ type: 'result', id, status: 'error', error: result.error });
      return;
    }
    self.postMessage({
      type: 'result', id, status: 'ok',
      data: serialize(result.model, result.solution),
    });
  } catch (err) {
    self.postMessage({
      type: 'result', id, status: 'error',
      error: (err && err.message) ? err.message : String(err),
    });
  }
};
