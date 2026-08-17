# Bot service (index.js) — Telegram polling, agents, pulse, data sync, the
# web-chat WebSocket server, and the platform webhook server.
FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for exclusions).
COPY . .

# Boot-with-nothing: the bot starts with no keys into setup mode. The port serves
# /health, the platform webhooks, and the /chat WebSocket (exposed to the host so
# the browser can connect directly).
EXPOSE 3000

CMD ["node", "index.js"]
