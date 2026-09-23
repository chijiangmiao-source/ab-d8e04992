// Node worker_threads 垫片：把浏览器 Worker 全局（self.postMessage/onmessage）
// 桥接到 parentPort，从而直接复用未改动的 public/worker.js。
import { parentPort } from 'node:worker_threads';

globalThis.self = {
  postMessage(msg) {
    parentPort.postMessage(msg);
  },
};

await import('../../public/worker.js');

parentPort.on('message', (msg) => {
  globalThis.self.onmessage({ data: msg });
});
