# Webapp service (server.js) — the dashboard, web chat page, OAuth wizard, and the
# /storage/logos/* public route. Separate service from the bot (shares only the DB).
FROM node:22-slim

WORKDIR /app

# Production deps first for layer caching. `sharp` installs a prebuilt binary — no
# build toolchain needed on slim.
COPY package.json package-lock.json ./
# The file reader (file-reader.js) needs one build of each engine: PDF.js's
# legacy build and Tesseract's plain builds with English. The rest of those
# packages (75MB) and npm's download cache (54MB of copies) go in the same
# layer as the install, so they are not in the image at all; a changed
# layout leaves the image as it is.
RUN npm ci --omit=dev \
 && rm -rf node_modules/pdfjs-dist/build node_modules/pdfjs-dist/web node_modules/pdfjs-dist/image_decoders node_modules/@tesseract.js-data/eng/4.0.0 node_modules/@napi-rs/canvas-*-musl /root/.npm \
 && { find node_modules/pdfjs-dist node_modules/tesseract.js-core -name "*.map" -type f -delete 2>/dev/null; \
      find node_modules/tesseract.js-core -maxdepth 1 -type f \( -name "tesseract-core*-lstm*" -o -name "tesseract-core*.wasm.js" \) -delete 2>/dev/null; true; }


# cloudflared, for "reach your dashboard from your phone" (phone-access.js).
# One static binary for this image's architecture; nothing runs until the
# toggle in Settings is turned on.
# It needs the system CA bundle to reach Cloudflare (Node carries its own
# roots; slim images ship none for other programs). heif-convert turns iPhone
# photos (HEIC) into JPEGs for the file reader.
ARG TARGETARCH
ADD https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-amd64} /usr/local/bin/cloudflared
RUN chmod 755 /usr/local/bin/cloudflared \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates libheif-examples \
 && rm -rf /var/lib/apt/lists/*

# The dashboard starts a command-style MCP server once, to see what it offers,
# before the bot runs it for real, so it needs the same runtimes: npx is here
# with node, uv brings uvx for the Python ones. Same caches as the bot image.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV npm_config_cache=/data/storage/cache/npm \
    UV_CACHE_DIR=/data/storage/cache/uv \
    UV_PYTHON_INSTALL_DIR=/data/storage/cache/uv-python

# App source (context is webapp/; see webapp/.dockerignore).
COPY . .
ARG GIT_SHA=""
ENV CLOSEDHAND_SHA=$GIT_SHA
# Closedhand's own Google app (see lib/google-app.js), passed in by the
# official image build. A build from source leaves both empty and connects
# Google through the person's own project.
ARG CLOSEDHAND_GOOGLE_CLIENT_ID=""
ARG CLOSEDHAND_GOOGLE_CLIENT_SECRET=""
ENV CLOSEDHAND_GOOGLE_CLIENT_ID=$CLOSEDHAND_GOOGLE_CLIENT_ID \
    CLOSEDHAND_GOOGLE_CLIENT_SECRET=$CLOSEDHAND_GOOGLE_CLIENT_SECRET

EXPOSE 3000

CMD ["node", "server.js"]
