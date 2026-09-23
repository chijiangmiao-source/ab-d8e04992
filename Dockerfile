# 多重测序条码子库审计：零运行时依赖的原生 ESM 静态站点 + Node 静态服务。
FROM node:20-alpine

WORKDIR /app

# 先拷贝清单（便于层缓存），再拷贝源码
COPY package.json ./
COPY public ./public
COPY server.js ./server.js
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# 健康路径 /health（busybox wget 在 alpine 内可用；shell 形式以便展开 $PORT）
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
