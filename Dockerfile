FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources \
    && sed -i 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm_config_disturl=https://npmmirror.com/mirrors/node \
    npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com \
      --fetch-retries=8 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000
COPY tsconfig.json vite.config.ts postcss.config.js tailwind.config.js index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3002 \
    DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3002
CMD ["node", "dist-server/index.js"]
