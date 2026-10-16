# GoShip 生产镜像（基于官方 node:slim）
FROM node:20-slim

ENV NODE_ENV=production \
    GOSHIP_MODE=production \
    PORT=8787 \
    HOST=0.0.0.0

WORKDIR /app

# 仅拷贝运行所需（零依赖，无 npm install）
COPY src ./src
COPY content ./content
COPY package.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
