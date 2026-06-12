# VliegmasjienPRO — works on amd64 and arm64 (Raspberry Pi 5).
# Uses Node's built-in SQLite, so there are no native modules to compile.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8390

VOLUME /data
EXPOSE 8390

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8390/api/status >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
