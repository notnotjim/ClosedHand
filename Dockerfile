# Bot service (index.js) — Telegram polling, agents, pulse, data sync, the
# web-chat WebSocket server, and the platform webhook server.
FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
ARG TARGETARCH
# The local-models worker pulls in a machine-learning runtime that ships native
# binaries for macOS, Windows and Linux, on two architectures each. A Linux
# container needs exactly one of them, and the rest are roughly 200MB that
# every self-hoster would otherwise download on their first install. Pruned in
# the same layer as the install, because deleting them in a later one would
# leave them in the image anyway.
#
# Written to be unable to break a build: if the package or its layout is not
# what is expected here, find matches nothing and the image is unchanged. The
# architecture prune only runs when the builder tells us what it is building
# for, so a plain docker build keeps every Linux binary and stays correct.
RUN npm ci --omit=dev \
 && ONNX=node_modules/onnxruntime-node/bin \
 && if [ -d "$ONNX" ]; then \
      find "$ONNX" -mindepth 2 -maxdepth 2 -type d ! -name linux -prune -exec rm -rf {} + ; \
      case "${TARGETARCH:-}" in \
        arm64) find "$ONNX" -mindepth 3 -maxdepth 3 -type d ! -name arm64 -prune -exec rm -rf {} + ;; \
        amd64) find "$ONNX" -mindepth 3 -maxdepth 3 -type d ! -name x64   -prune -exec rm -rf {} + ;; \
      esac; \
    fi

# App source (see .dockerignore for exclusions).
COPY . .

# Boot-with-nothing: the bot starts with no keys into setup mode. The port serves
# /health, the platform webhooks, and the /chat WebSocket (exposed to the host so
# the browser can connect directly).
EXPOSE 3000

CMD ["node", "index.js"]
