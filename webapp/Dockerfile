# Webapp service (server.js) — the dashboard, web chat page, OAuth wizard, and the
# /storage/logos/* public route. Separate service from the bot (shares only the DB).
FROM node:22-slim

WORKDIR /app

# Production deps first for layer caching. `sharp` installs a prebuilt binary — no
# build toolchain needed on slim.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (context is webapp/; see webapp/.dockerignore).
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
