# Webapp service (server.js) — the dashboard, web chat page, OAuth wizard, and the
# /storage/logos/* public route. Separate service from the bot (shares only the DB).
FROM node:22-slim

WORKDIR /app

# Production deps first for layer caching. `sharp` installs a prebuilt binary — no
# build toolchain needed on slim.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# cloudflared, for "reach your dashboard from your phone" (phone-access.js).
# One static binary for this image's architecture; nothing runs until the
# toggle in Settings is turned on.
# It needs the system CA bundle to reach Cloudflare (Node carries its own
# roots; slim images ship none for other programs).
ARG TARGETARCH
ADD https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-amd64} /usr/local/bin/cloudflared
RUN chmod 755 /usr/local/bin/cloudflared \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# App source (context is webapp/; see webapp/.dockerignore).
COPY . .
ARG GIT_SHA=""
ENV CLOSEDHAND_SHA=$GIT_SHA

EXPOSE 3000

CMD ["node", "server.js"]
