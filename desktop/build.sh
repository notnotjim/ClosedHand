#!/bin/sh
# Builds ClosedHand.app: the Swift shell plus everything it runs.
#
#   desktop/build.sh                 ad-hoc signed, for this Mac
#   IDENTITY="Developer ID Application: ..." desktop/build.sh
#                                    signed for distribution (notarise after)
#
# Inputs it fetches or builds once and caches in desktop/.cache:
#   node   the Node 22 runtime for this architecture (official tarball)
#   pg     relocatable Postgres 16 + pgvector (built from source, see pg.sh)
#   app    the repo at HEAD with production node_modules for this architecture
# Output: desktop/dist/ClosedHand.app
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CACHE="$HERE/.cache"
ARCH="${ARCH:-$(uname -m)}"            # arm64 or x86_64
NODE_ARCH="$([ "$ARCH" = "x86_64" ] && echo x64 || echo arm64)"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
VERSION="${VERSION:-2.0.8}"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
DIST="$HERE/dist"
APP="$DIST/ClosedHand.app"
mkdir -p "$CACHE"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# --- node runtime -------------------------------------------------------------
NODE_DIR="$CACHE/node-$NODE_VERSION-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "Fetching Node $NODE_VERSION ($NODE_ARCH)"
  curl -sfL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz" -o "$CACHE/node.tgz"
  rm -rf "$CACHE/node-tmp" && mkdir -p "$CACHE/node-tmp"
  tar xzf "$CACHE/node.tgz" -C "$CACHE/node-tmp"
  mv "$CACHE/node-tmp"/node-* "$NODE_DIR"
  rm -rf "$CACHE/node-tmp" "$CACHE/node.tgz"
fi

# --- postgres -----------------------------------------------------------------
PG_DIR="$CACHE/pg-$ARCH"
if [ ! -x "$PG_DIR/bin/postgres" ]; then
  say "Building Postgres + pgvector ($ARCH), this takes a few minutes"
  PREFIX="$PG_DIR" sh "$HERE/pg.sh"
fi

# --- uv: Python for the Workspace, fetched on first run by the agent ------------
UV_DIR="$CACHE/uv-$ARCH"
if [ ! -x "$UV_DIR/uv" ]; then
  say "Fetching uv ($ARCH)"
  UV_ASSET="$([ "$ARCH" = "x86_64" ] && echo uv-x86_64-apple-darwin || echo uv-aarch64-apple-darwin)"
  curl -sfL "https://github.com/astral-sh/uv/releases/latest/download/$UV_ASSET.tar.gz" -o "$CACHE/uv.tgz"
  rm -rf "$CACHE/uv-tmp" && mkdir -p "$CACHE/uv-tmp" && tar xzf "$CACHE/uv.tgz" -C "$CACHE/uv-tmp"
  rm -rf "$UV_DIR" && mv "$CACHE/uv-tmp"/* "$UV_DIR" && rm -rf "$CACHE/uv-tmp" "$CACHE/uv.tgz"
fi

# --- app source with production dependencies ---------------------------------
CLOUDFLARED_VERSION="2026.9.1"
CLOUDFLARED_DIR="$CACHE/cloudflared-$CLOUDFLARED_VERSION-$ARCH"
if [ ! -x "$CLOUDFLARED_DIR/cloudflared" ]; then
  case "$ARCH" in
    arm64) CF_ARCH=arm64; CF_SHA=c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe ;;
    x86_64) CF_ARCH=amd64; CF_SHA=ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4 ;;
    *) echo "Unsupported connection runtime architecture"; exit 1 ;;
  esac
  say "Fetching the dashboard connection runtime"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-$CF_ARCH.tgz" -o "$CACHE/cloudflared.tgz"
  printf '%s  %s\n' "$CF_SHA" "$CACHE/cloudflared.tgz" | shasum -a 256 -c -
  mkdir -p "$CLOUDFLARED_DIR"
  tar xzf "$CACHE/cloudflared.tgz" -C "$CLOUDFLARED_DIR"
  chmod +x "$CLOUDFLARED_DIR/cloudflared"
fi

APP_SRC="$CACHE/app"
if [ "${REUSE_APP:-0}" != "1" ] || [ ! -d "$APP_SRC/node_modules" ]; then
  say "Staging the app at $SHA"
  rm -rf "$APP_SRC" && mkdir -p "$APP_SRC"
  if [ "${SOURCE:-head}" = "worktree" ]; then
    # Uncommitted changes included, for trying a fix before it is committed.
    rsync -a --exclude .git --exclude node_modules --exclude 'webapp/node_modules' --exclude desktop --exclude data "$ROOT/" "$APP_SRC/"
  else
    git -C "$ROOT" archive HEAD | tar -x -C "$APP_SRC"
  fi
  rm -rf "$APP_SRC/desktop" "$APP_SRC/bridge-app" "$APP_SRC/.github" "$APP_SRC/install.sh" "$APP_SRC/Dockerfile" "$APP_SRC/docker-compose"*.yml
  # Of the sandbox image only its agent comes along: it runs on the Mac as the Workspace.
  find "$APP_SRC/sandbox-image" -mindepth 1 -maxdepth 1 ! -name agent -exec rm -rf {} +
  say "Installing dependencies"
  export PATH="$NODE_DIR/bin:$PATH" npm_config_cache="$CACHE/npm"
  (cd "$APP_SRC" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  (cd "$APP_SRC/webapp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  (cd "$APP_SRC/sandbox-image/agent" && npm install --omit=dev --no-audit --no-fund --loglevel=error --no-package-lock)
  # Only this platform's native binaries ship; the others are dead weight.
  ONNX="$APP_SRC/node_modules/onnxruntime-node/bin/napi-v6"
  if [ -d "$ONNX" ]; then
    find "$ONNX" -mindepth 1 -maxdepth 1 -type d ! -name darwin -exec rm -rf {} +
    find "$ONNX/darwin" -mindepth 1 -maxdepth 1 -type d ! -name "$NODE_ARCH" -exec rm -rf {} + 2>/dev/null || true
  fi
  for m in "$APP_SRC/node_modules/@img" "$APP_SRC/webapp/node_modules/@img"; do
    # Only the platform packages (sharp-<os>-<arch>, sharp-libvips-<os>-<arch>);
    # @img also holds plain code sharp needs everywhere, like @img/colour.
    [ -d "$m" ] && find "$m" -mindepth 1 -maxdepth 1 -type d -name "sharp-*" ! -name "*darwin-$NODE_ARCH" -exec rm -rf {} +
  done
fi

# --- the shell ----------------------------------------------------------------
say "Building the app"
(cd "$HERE" && swift build -c release --arch "$ARCH")
BIN="$HERE/.build/$ARCH-apple-macosx/release/ClosedHand"
[ -x "$BIN" ] || BIN="$HERE/.build/release/ClosedHand"
[ -x "$BIN" ] || { echo "swift build produced no executable"; exit 1; }
BUNDLE_RES="$(dirname "$BIN")/ClosedHand_ClosedHand.bundle"

# --- assemble -----------------------------------------------------------------
say "Assembling $APP"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ClosedHand"
[ -d "$BUNDLE_RES" ] && cp -R "$BUNDLE_RES" "$APP/Contents/Resources/"
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__SHA__/$SHA/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/node/lib"
cp "$NODE_DIR/bin/node" "$APP/Contents/Resources/node/bin/"
cp -R "$NODE_DIR/lib/node_modules" "$APP/Contents/Resources/node/lib/"   # npm and npx, for MCP servers run by command
ln -sf ../lib/node_modules/npm/bin/npm-cli.js "$APP/Contents/Resources/node/bin/npm"
ln -sf ../lib/node_modules/npm/bin/npx-cli.js "$APP/Contents/Resources/node/bin/npx"
cp -R "$PG_DIR" "$APP/Contents/Resources/pg"
rm -rf "$APP/Contents/Resources/pg/lib/postgresql/pgxs"   # build-time files, with test binaries the notary rejects
mkdir -p "$APP/Contents/Resources/uv" && cp "$UV_DIR/uv" "$UV_DIR/uvx" "$APP/Contents/Resources/uv/"
mkdir -p "$APP/Contents/Resources/bin" && cp "$CLOUDFLARED_DIR/cloudflared" "$APP/Contents/Resources/bin/"
cp -R "$APP_SRC" "$APP/Contents/Resources/app"
rm -rf "$APP/Contents/Resources/app/node_modules/mammoth/test" "$APP/Contents/Resources/app/webapp/node_modules/mammoth/test"

# --- sign ---------------------------------------------------------------------
if [ -n "${IDENTITY:-}" ]; then
  say "Signing with $IDENTITY"
else
  say "Signing ad hoc (this Mac only)"
fi
sign_code() {
  if [ -n "${IDENTITY:-}" ]; then
    codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@"
  else
    codesign --force --sign - "$@"
  fi
}
# Every Mach-O inside gets its own signature first: dylibs, .node addons,
# the Node and Postgres executables. Then the app seals the lot.
find "$APP/Contents/Resources" -type f \( -name "*.dylib" -o -name "*.node" -o -name "*.so" \) -print0 \
  | while IFS= read -r -d '' lib; do
      if file -b "$lib" | grep -q "Mach-O"; then sign_code "$lib"; fi
    done
# Every executable Mach-O anywhere inside (Node, Postgres, uv, Google's gws
# CLI, whatever a dependency ships) is signed with the runtime entitlements;
# one unsigned binary and the notary rejects the whole archive.
find "$APP/Contents/Resources" -type f -perm +111 ! -name "*.dylib" ! -name "*.node" ! -name "*.so" -print0 \
  | while IFS= read -r -d '' exe; do
      if file -b "$exe" | grep -q "Mach-O"; then sign_code --entitlements "$HERE/Runtime.entitlements" "$exe"; fi
    done
sign_code --entitlements "$HERE/ClosedHand.entitlements" "$APP"
codesign --verify --deep --strict "$APP" && say "Signed OK"
du -sh "$APP"
