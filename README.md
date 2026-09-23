# 多重测序条码子库审计（Barcode Sub-library Audit）

在浏览器内对 10–44 条**等长 ACGT 条码**做精确的子库优选审计：

- 两条记录在**正向 / 反向互补四种组合**下的最小汉明距离 **低于阈值** 时互斥；
- 记录与**自身反向互补**距离不足时，禁止入选；
- 在全部可行子库中精确选出
  1. **优先权总和最大**；
  2. 总和并列时 **记录数最多**（双层最优）；
- 给出**任意精度**的同优方案数（BigInt）、按输入次序**“选中优先”位向量**裁决的规范结果，
  并基于全部双层最优方案把每条记录判为 **必选 / 可选 / 从不选**。

计算全部在浏览器 **Web Worker** 内完成；取消审计会终止 Worker 线程，
非法输入、取消以及旧任务的迟到消息都**不会覆盖最近一次成功结论**。

## 目录结构

```
public/
  audit.js       纯算法核心（反向互补、汉明距离、校验、BigInt 双层次优 MWIS）
  dispatcher.js  运行状态机（id 单调、取消/迟到/错误裁决，无 DOM 依赖）
  worker.js      Module Worker：接收任务 → 计算 → 回传十进制字符串结果
  app.js         页面主线程：录入、Worker 生命周期、渲染
  index.html
  styles.css
server.js        零依赖静态服务器，暴露 /health
scripts/
  build.js       构建检查（语法、资源引用、ESM import 图、容器文件齐备）
  smoke.js       HTTP 冒烟（临时服务器使用系统分配端口）
  verify.js      单次编排：测试 → 构建检查 → HTTP 冒烟，以退出码报告
test/            node:test 单元/随机交叉验证/Worker 协议/页面接线测试
Dockerfile
docker-compose.yml
```

## 本地运行

需要 Node.js ≥ 20（无第三方运行时依赖）。

```bash
npm test          # 代码测试（27 项，含 270 组 2^k 暴力穷举随机交叉验证）
npm run build     # 构建检查
npm start         # 启动页面，默认 http://localhost:8080
npm run smoke     # HTTP 冒烟（自动起停临时服务器）
npm run verify    # 测试 + 构建检查 + 冒烟，一次跑完
```

健康路径：

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"barcode-audit",...}
```

端口可用环境变量配置：`PORT=9090 npm start`。

## 录入格式

页面文本区每行一条：

```
条码 优先权
```

- 条码：仅 `A/C/G/T`，全部记录等长、彼此唯一；
- 优先权：正整数，长度不限（内部以 BigInt 精确处理）；
- 距离阈值：正整数。

## Docker

```bash
# 构建并以可配置宿主端口启动（默认 8080）
docker compose up --build
HOST_PORT=9090 docker compose up --build   # 映射到宿主 9090

# 单次校验服务：代码测试 → 构建检查 → HTTP 冒烟，退出码即成败
docker compose build
docker compose run --rm verify
```

`web` 服务容器内监听 8080 并在 Dockerfile 内声明 `/health` 健康检查；
`verify` 是一次性服务（`restart: "no"`），冒烟在其自身容器内起停临时服务器，
不依赖 `web` 是否发布端口。

## 算法要点

- 距离：`min(hamming(a,b), hamming(a,rc(b)))`，由
  `hamming(rc(a),rc(b))=hamming(a,b)`、`hamming(rc(a),b)=hamming(a,rc(b))`
  覆盖全部四种方向组合。
- 冲突图：顶点为通过自反互补检查的记录，互斥对连边；问题化为
  **最大权独立集**，以记忆化分支搜索精确求解，比较键为字典序 `(权值和, 基数)`。
- 同优计数与每位出现次数均在递归中以 **BigInt** 精确累计；
  出现次数 = 同优总数 → 必选，= 0 → 从不选，其间 → 可选。
- 规范结果：按输入次序逐位贪心，只要当前位存在达成剩余双层最优的完成方案就选入，
  从而唯一确定“选中优先”位向量。
- 44 顶点、多种冲突密度下实测求解均在约 0.5 秒内完成。
