// 审计运行状态机（无 DOM / Worker 依赖，便于测试）：
//   - id 单调递增；开始一次新审计即作废旧 id
//   - 取消同样推进 id，使被终止线程已入队的结果成为迟到消息
//   - 只有“当前 id 的成功结果”能更新最近一次成功结论
//   - 非法输入不进入状态机（调用方预校验）；错误 / 取消 / 迟到均不覆盖结论

export function createRunState() {
  let latestId = 0;
  let running = false;
  let lastSuccess = null;

  return {
    /** 开始一次新运行，返回其 id。 */
    begin() {
      latestId += 1;
      running = true;
      return latestId;
    },

    /** 取消当前运行：推进 id 以作废旧消息。返回是否确实取消了一个运行中任务。 */
    cancel() {
      const wasRunning = running;
      latestId += 1;
      running = false;
      return wasRunning;
    },

    isRunning() {
      return running;
    },

    /**
     * Worker 全局异常等“任务已不可能返回”的情况：
     * 复位运行态并推进 id 作废迟到消息；不触碰 lastSuccess。
     */
    failCurrent() {
      if (!running) return false;
      latestId += 1;
      running = false;
      return true;
    },

    /** Worker 结果消息裁决。 */
    acceptResult(msg) {
      if (!msg || typeof msg.id !== 'number' || msg.id !== latestId) {
        return { kind: 'stale' }; // 旧任务迟到消息：静默丢弃
      }
      running = false;
      if (msg.status === 'ok') {
        lastSuccess = msg.data;
        return { kind: 'success', data: msg.data };
      }
      // 当前任务失败：保留旧结论
      return { kind: 'error', error: msg.error, lastSuccess };
    },

    getLastSuccess() {
      return lastSuccess;
    },

    getLatestId() {
      return latestId;
    },
  };
}
